package api

import (
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"ela-explorer/internal/aggregator"
	"ela-explorer/internal/cache"
	"ela-explorer/internal/db"
	"ela-explorer/internal/metrics"
	"ela-explorer/internal/node"
	syncer "ela-explorer/internal/sync"
	"ela-explorer/internal/ws"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"golang.org/x/time/rate"
)

type Server struct {
	db         *db.DB
	node       *node.Client
	syncer     *syncer.Syncer
	aggregator *aggregator.Aggregator
	wsHub      *ws.Hub
	cache      *cache.TTLCache[string, any]
	router     chi.Router
}

type ServerConfig struct {
	CORSOrigins      []string
	LRUSize          int
	CacheTTL         time.Duration
	MetricsAuthToken string
}

func NewServer(database *db.DB, nodeClient *node.Client, syncr *syncer.Syncer, cfg ServerConfig) *Server {
	s := &Server{
		db:     database,
		node:   nodeClient,
		syncer: syncr,
		cache:  cache.NewTTLCache[string, any](cfg.LRUSize, cfg.CacheTTL),
	}

	r := chi.NewRouter()

	r.Use(middleware.RealIP)
	r.Use(middleware.RequestID)
	r.Use(middleware.Timeout(10 * time.Second))
	r.Use(middleware.Compress(5))
	r.Use(corsMiddleware(cfg.CORSOrigins))
	r.Use(securityHeaders)
	r.Use(middleware.Recoverer)
	r.Use(accessLogMiddleware)
	r.Use(metricsMiddleware)
	r.Use(rateLimitMiddleware(rate.Limit(60), 120))

	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/blocks/latest", s.getLatestBlocks)
		r.Get("/blocks", s.getBlocks)
		r.Get("/block/{heightOrHash}", s.getBlock)
		r.Get("/block/{heightOrHash}/txs", s.getBlockTransactions)

		r.Get("/tx/{txid}", s.getTransaction)
		r.Get("/transactions", s.getTransactions)

		r.Get("/address/{address}", s.getAddress)
		r.Get("/address/{address}/staking", s.getAddressStaking)
		r.Get("/address/{address}/balance-history", s.getAddressBalanceHistory)
		r.Get("/address/{address}/vote-history", s.getAddressVoteHistory)
		r.Get("/address/{address}/governance", s.getAddressGovernanceActivity)

		r.Get("/richlist", s.getRichList)
		r.Get("/stats", s.getStats)
		r.Get("/supply", s.getSupply)
		r.Get("/supply/circulating", s.getSupplyCirculating)
		r.Get("/supply/total", s.getSupplyTotal)
		r.Get("/supply/max", s.getSupplyMax)

		r.Get("/producers", s.getProducers)
		r.Get("/producer/{ownerPubKey}", s.getProducerDetail)
		r.Get("/producer/{ownerPubKey}/stakers", s.getProducerStakers)

		r.Get("/cr/members", s.getCRMembers)
		r.Get("/cr/elections", s.getCRElections)
		r.Get("/cr/elections/{term}", s.getCRElectionByTerm)
		r.Get("/cr/proposals", s.getCRProposals)
		r.Get("/cr/proposal/{hash}", s.getCRProposalDetail)
		r.Get("/cr/proposal-image/{draftHash}/{filename}", s.getProposalImage)

		r.Get("/search", s.search)
		r.Get("/mempool", s.getMempool)
		r.Get("/charts/{metric}", s.getChart)
		r.Get("/tx/{txid}/trace", s.traceTransaction)

		r.Get("/widgets", s.getWidgets)
		r.Get("/hashrate", s.getHashrate)
		r.Get("/stakers", s.getTopStakers)
		r.Get("/ela-price", s.getELAPrice)
		r.Get("/sync-status", s.getSyncStatus)
	})
	r.Get("/health", s.healthCheck)

	metricsGroup := r.With(bearerAuthMiddleware(cfg.MetricsAuthToken))
	metricsGroup.Get("/health/detailed", s.healthDetailed)
	metricsGroup.Get("/metrics", metrics.Handler())
	metricsGroup.Post("/cr/proposal/{hash}/resync", s.resyncProposalDraft)
	metricsGroup.Get("/api/v1/admin/validators/logo.json", s.getValidatorLogos)
	metricsGroup.Post("/api/v1/admin/validators/logo", s.uploadValidatorLogo)

	r.With(rateLimitMiddleware(rate.Limit(10), 20)).Post("/ela", s.walletRPC)

	r.Get("/sitemap.xml", s.serveSitemap)
	r.NotFound(s.serveSEO)

	s.router = r
	return s
}

func (s *Server) AttachWebSocket(hub *ws.Hub) {
	s.wsHub = hub
}

func (s *Server) AttachAggregator(agg *aggregator.Aggregator) {
	s.aggregator = agg
}

func (s *Server) Handler() http.Handler {
	wsRateLimiter := newPerIPRateLimiter(rate.Limit(5), 10)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ws" && s.wsHub != nil {
			ip := extractClientIP(r)
			if !wsRateLimiter.getLimiter(ip).Allow() {
				http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
				return
			}
			s.wsHub.ServeWS(w, r)
			return
		}
		s.router.ServeHTTP(w, r)
	})
}

type APIResponse struct {
	Data    any            `json:"data,omitempty"`
	Total   int64          `json:"total,omitempty"`
	Page    int            `json:"page,omitempty"`
	Size    int            `json:"pageSize,omitempty"`
	Error   string         `json:"error,omitempty"`
	Summary map[string]any `json:"summary,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Warn("failed to encode JSON response", "error", err)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, APIResponse{Error: msg})
}

func parseInt(s string, fallback int) int {
	if s == "" {
		return fallback
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 {
		return fallback
	}
	if n > 1_000_000 {
		return 1_000_000
	}
	return n
}

func clampPageSize(size, max int) int {
	if size < 1 {
		return 10
	}
	if size > max {
		return max
	}
	return size
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func metricsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		metrics.IncHTTPRequests()
		start := time.Now()

		next.ServeHTTP(rec, r)

		if rec.status >= 400 {
			metrics.IncHTTPErrors()
		}

		// Record per-endpoint latency using chi's route template (NOT the
		// concrete URL). RoutePattern returns e.g.
		// "/api/v1/address/{address}/staking", never the real address, so
		// our histogram label cardinality stays bounded. If the router
		// never matched (404), RoutePattern is empty — we bucket those as
		// "unmatched" rather than skip so ops still sees 404 volume.
		route := chi.RouteContext(r.Context()).RoutePattern()
		if route == "" {
			route = "unmatched"
		}
		metrics.ObserveHTTPLatency(route, r.Method, rec.status, time.Since(start))
	})
}

func corsMiddleware(origins []string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			allowed := false
			for _, o := range origins {
				if o == origin || o == "*" {
					allowed = true
					break
				}
			}
			if allowed {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
				w.Header().Set("Access-Control-Max-Age", "86400")
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		next.ServeHTTP(w, r)
	})
}

type ipLimiterEntry struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

type perIPRateLimiter struct {
	mu      sync.Mutex
	entries map[string]*ipLimiterEntry
	rps     rate.Limit
	burst   int
}

func newPerIPRateLimiter(rps rate.Limit, burst int) *perIPRateLimiter {
	rl := &perIPRateLimiter{
		entries: make(map[string]*ipLimiterEntry),
		rps:     rps,
		burst:   burst,
	}
	go rl.cleanup()
	return rl
}

func (rl *perIPRateLimiter) getLimiter(ip string) *rate.Limiter {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	entry, ok := rl.entries[ip]
	if !ok {
		entry = &ipLimiterEntry{limiter: rate.NewLimiter(rl.rps, rl.burst)}
		rl.entries[ip] = entry
	}
	entry.lastSeen = time.Now()
	return entry.limiter
}

func (rl *perIPRateLimiter) cleanup() {
	const staleAfter = 5 * time.Minute
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		rl.mu.Lock()
		cutoff := time.Now().Add(-staleAfter)
		for ip, entry := range rl.entries {
			if entry.lastSeen.Before(cutoff) {
				delete(rl.entries, ip)
			}
		}
		rl.mu.Unlock()
	}
}

func extractClientIP(r *http.Request) string {
	// chi middleware.RealIP already sets RemoteAddr from X-Real-IP/X-Forwarded-For
	// when behind a reverse proxy. Prefer the resolved RemoteAddr directly to avoid
	// double-parsing spoofable headers.
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil && host != "" {
		return host
	}
	return r.RemoteAddr
}

func rateLimitMiddleware(rps rate.Limit, burst int) func(http.Handler) http.Handler {
	rl := newPerIPRateLimiter(rps, burst)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := extractClientIP(r)
			if !rl.getLimiter(ip).Allow() {
				writeError(w, http.StatusTooManyRequests, "rate limit exceeded")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func accessLogMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		slog.Info("http request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"duration_ms", time.Since(start).Milliseconds(),
			"ip", extractClientIP(r),
		)
	})
}

func bearerAuthMiddleware(token string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if token == "" {
				writeError(w, http.StatusForbidden, "endpoint disabled: METRICS_AUTH_TOKEN not configured")
				return
			}
			auth := r.Header.Get("Authorization")
			if auth != "Bearer "+token {
				writeError(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func (s *Server) getSyncStatus(w http.ResponseWriter, r *http.Request) {
	lastSynced := s.syncer.LastHeight()
	chainTip := s.syncer.ChainTip()
	isLive := s.syncer.IsLive()

	var progress float64
	if chainTip > 0 {
		progress = float64(lastSynced) / float64(chainTip) * 100
		if progress > 100 {
			progress = 100
		}
	}

	syncerBackfills := s.syncer.BackfillStatus()

	backfills := map[string]bool{
		"postSync":            syncerBackfills["postSync"],
		"governance":          syncerBackfills["governance"],
		"addressTransactions": syncerBackfills["addressTransactions"],
	}

	if s.aggregator != nil {
		for k, v := range s.aggregator.BackfillStatus() {
			backfills[k] = v
		}
	}

	allDone := true
	for _, v := range backfills {
		if !v {
			allDone = false
			break
		}
	}

	blocksCaughtUp := chainTip > 0 && (chainTip-lastSynced) < 10

	// Check if the local node itself is behind the network
	nodeBehind := false
	if s.aggregator != nil {
		nodeBehind = s.aggregator.NodeBehind()
	}

	phase := "syncing"
	if isLive && allDone && !nodeBehind {
		phase = "ready"
	} else if isLive && allDone && nodeBehind {
		phase = "node-syncing"
	} else if isLive || blocksCaughtUp {
		phase = "backfilling"
	}

	resp := map[string]any{
		"phase": phase,
		"blockSync": map[string]any{
			"currentHeight": lastSynced,
			"chainTip":      chainTip,
			"progress":      progress,
			"isLive":        isLive,
		},
		"backfills": backfills,
	}

	if s.aggregator != nil {
		vs := s.aggregator.ValidationStatus()
		resp["nodeHealth"] = vs["nodeHealth"]
		resp["validation"] = vs["validation"]
	}

	writeJSON(w, http.StatusOK, resp)
}

func isHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func isAddress(s string) bool {
	if len(s) < 20 || len(s) > 34 {
		return false
	}
	prefix := s[0]
	if prefix != 'E' && prefix != '8' && prefix != 'S' && prefix != 'D' && prefix != 'X' && prefix != 'C' {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
			return false
		}
	}
	return true
}

func isHexPubKey(s string) bool {
	if len(s) != 66 && len(s) != 130 {
		return false
	}
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func safeTruncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
