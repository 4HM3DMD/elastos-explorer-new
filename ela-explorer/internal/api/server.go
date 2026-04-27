package api

import (
	"crypto/subtle"
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
	db               *db.DB
	node             *node.Client
	syncer           *syncer.Syncer
	aggregator       *aggregator.Aggregator
	wsHub            *ws.Hub
	cache            *cache.TTLCache[string, any]
	router           chi.Router
	exportCSVEnabled bool
}

type ServerConfig struct {
	CORSOrigins      []string
	LRUSize          int
	CacheTTL         time.Duration
	MetricsAuthToken string
	ExportCSVEnabled bool
}

func NewServer(database *db.DB, nodeClient *node.Client, syncr *syncer.Syncer, cfg ServerConfig) *Server {
	s := &Server{
		db:               database,
		node:             nodeClient,
		syncer:           syncr,
		cache:            cache.NewTTLCache[string, any](cfg.LRUSize, cfg.CacheTTL),
		exportCSVEnabled: cfg.ExportCSVEnabled,
	}

	r := chi.NewRouter()

	// Middleware ordering note: Timeout and Compress are scoped to a
	// Group below, NOT applied at the root. The streaming tax-export
	// endpoint (registered outside that group) needs to bypass both —
	// the 10s timeout would kill a 50K-row export mid-flush, and the
	// gzip compressor buffers internally which breaks Flusher.Flush()
	// semantics on long responses. Every other endpoint still gets
	// Timeout + Compress unchanged.
	r.Use(middleware.RealIP)
	r.Use(middleware.RequestID)
	r.Use(corsMiddleware(cfg.CORSOrigins))
	r.Use(securityHeaders)
	// Count panics BEFORE chi's Recoverer swallows them, so /metrics
	// and tg-monitor can alert on code bugs even though chi suppresses
	// the panic from reaching the process.
	r.Use(panicCountMiddleware)
	r.Use(middleware.Recoverer)
	r.Use(accessLogMiddleware)
	r.Use(metricsMiddleware)
	r.Use(rateLimitMiddleware(rate.Limit(60), 120))

	// Streaming endpoints registered first, before the Timeout/Compress
	// group is opened. They inherit every middleware above this line
	// (security, logging, metrics, rate limit) but skip the request-
	// timeout cap and the response gzip layer.
	r.Get("/api/v1/address/{address}/export.csv", s.getAddressExport)

	r.Group(func(r chi.Router) {
		r.Use(middleware.Timeout(10 * time.Second))
		r.Use(middleware.Compress(5))

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
		r.Get("/address/{address}/cr-votes", s.getAddressCRVotes)
		// Public address-label lookup. Always 200 — empty fields if
		// the address has no platform-known label. Lets third-party
		// portals overlay their own labels on top of the canonical
		// platform set without rebuilding the list themselves.
		r.Get("/address/{address}/label", s.getAddressLabel)

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
		// Live (cache-bypassing) variant of the term endpoint. Same
		// payload shape; no 60s server cache, no intermediate caching
		// (Cache-Control: no-store). Built for third-party portals
		// that need sub-second freshness during live voting.
		r.Get("/cr/elections/{term}/live-tally", s.getCRElectionByTermLive)
		r.Get("/cr/elections/{term}/replay-events", s.getCRElectionReplayEvents)
		r.Get("/cr/elections/{term}/voters", s.getCRElectionVoters)
		// Bulk dump of every voter + their full slice breakdown for
		// the term, capped at 5000. One call instead of paginating
		// /voters and then per-voter follow-ups.
		r.Get("/cr/elections/{term}/voters/bulk", s.getCRElectionVotersBulk)
		// Last N TxVotings for the term, in reverse-chronological
		// order. Powers live activity-feed UX.
		r.Get("/cr/elections/{term}/recent-events", s.getCRElectionRecentEvents)
		r.Get("/cr/elections/{term}/voters/{cid}", s.getCRCandidateVoters)
		r.Get("/cr/elections/{term}/voters/{cid}/{address}/history", s.getVoterTxHistory)
		r.Get("/cr/members/{cid}/profile", s.getCandidateProfile)
		r.Get("/cr/members/{cid}/reviews", s.getCandidateReviews)
		r.Get("/cr/election/status", s.getCRElectionStatus)
		r.Get("/cr/proposals", s.getCRProposals)
		r.Get("/cr/proposal/{hash}", s.getCRProposalDetail)
		r.Get("/cr/proposal-image/{draftHash}/{filename}", s.getProposalImage)

		r.Get("/search", s.search)

		// Self-describing OpenAPI 3.0 spec covering every public
		// endpoint + WebSocket events. Lets third-party consumers
		// (the unofficial elections portal, partner integrations)
		// generate typed clients automatically.
		r.Get("/openapi.json", s.getOpenAPISpec)
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

	// Defense-in-depth: rate-limit admin endpoints even with bearer
	// auth. A single replay call costs ~5–15s of CPU (full event scan
	// + state machine across all CR events for a term). A leaked
	// METRICS_AUTH_TOKEN must not enable trivial CPU DoS — cap at
	// 2 req/s with burst 5 across all admin verbs combined.
	adminLimiter := rateLimitMiddleware(rate.Limit(2), 5)
	adminGroup := metricsGroup.With(adminLimiter)

	// Election-tally replay diagnostics — R1/R2 of the CR election plan.
	// Bearer-auth gated because these are operator tools during validation
	// and calibration, not public endpoints. They're read-only: they run
	// the replay engine and return the computed tally, but they DO NOT
	// write anything to cr_election_tallies (until R3 lands).
	adminGroup.Get("/api/v1/admin/replay/tally/{term}", s.replayTermTally)
	adminGroup.Get("/api/v1/admin/replay/validate/{term}", s.replayValidateTerm)

	// Governance-data block refill — re-ingest a block range directly
	// from the node. Use this to repair gaps in `transactions` /
	// `votes` tables suspected of causing vote-tally mismatches (e.g.
	// Term 6's seated council didn't appear in top-12 of replay). All
	// writes are idempotent; safe to re-run. POST is async (starts a
	// goroutine); poll status via the GET endpoint.
	adminGroup.Post("/api/v1/admin/refill/governance", s.refillGovernanceRange)
	adminGroup.Get("/api/v1/admin/refill/status", s.refillStatus)
	adminGroup.Post("/api/v1/admin/refill/cancel", s.refillCancel)
	// NOTE: validator-logo admin upload endpoints were removed (2026-04)
	// pending a redesign where the validator's own node operator can
	// submit a logo via a signed message, instead of an operator-bearer-token
	// upload path. Security audit flagged the upload path as an
	// authenticated write surface with client-supplied MIME type / no image
	// decode validation — all deemed acceptable behind bearer auth but
	// the feature was only used by hand and not depended on.
	//
	// Until the signed-submission flow exists, validator logos remain
	// served as static files via nginx from /static/validator-logos/
	// (populated by scripts/download-validator-logos.mjs on deploy).

		r.With(rateLimitMiddleware(rate.Limit(10), 20)).Post("/ela", s.walletRPC)

		r.Get("/sitemap.xml", s.serveSitemap)
		r.NotFound(s.serveSEO)
	})

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

	// The /ws path bypasses chi's middleware chain (we intercept before
	// s.router.ServeHTTP fires), so chi's middleware.RealIP — which
	// rewrites r.RemoteAddr from the trusted proxy headers — never runs.
	// Wrap the WS path in the same middleware so:
	//   1. extractClientIP() sees the real client IP, not nginx's 127.0.0.1
	//      (otherwise wsRateLimiter below effectively rate-limits GLOBALLY)
	//   2. ws/hub.go's clientIP() (which we also hardened in this commit
	//      to use only r.RemoteAddr) returns the real client, not whatever
	//      a malicious client put in X-Real-IP / X-Forwarded-For
	// chi's middleware.RealIP reads X-Real-IP and X-Forwarded-For but only
	// after the TCP peer is a trusted proxy; since nginx is the only peer
	// this backend ever sees (listen on 127.0.0.1:8339 behind nginx) this
	// is safe.
	wsHandler := middleware.RealIP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := extractClientIP(r)
		if !wsRateLimiter.getLimiter(ip).Allow() {
			http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		s.wsHub.ServeWS(w, r)
	}))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ws" && s.wsHub != nil {
			wsHandler.ServeHTTP(w, r)
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

// panicCountMiddleware increments the panic counter on any panic and re-raises
// so chi's Recoverer can take over (log + HTTP 500 response). Placed BEFORE
// Recoverer in the chain so our deferred recover runs LAST on panic unwind,
// which is when we actually see the panic value. If we placed this after
// Recoverer, chi would swallow the panic and we'd never increment.
func panicCountMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				metrics.IncPanic()
				// Re-raise so chi's Recoverer handles the response + logging.
				// This is the normal way to chain recoverers — we only
				// observe; chi decides the response.
				panic(rec)
			}
		}()
		next.ServeHTTP(w, r)
	})
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
	// Defensive: a wildcard (`*`) in the configured origins list is
	// almost never what we want. With our auth model (Bearer tokens
	// in headers) `*` would let any origin issue authenticated calls
	// from a victim's browser via Access-Control-Allow-Origin: *.
	// Strip any wildcard entry at startup; logged so deployment
	// catches the misconfiguration before it ships.
	cleaned := origins[:0]
	for _, o := range origins {
		if o == "*" {
			slog.Warn("corsMiddleware: ignoring wildcard origin '*' — unsafe with bearer auth; configure explicit origins")
			continue
		}
		cleaned = append(cleaned, o)
	}
	origins = cleaned

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			allowed := false
			for _, o := range origins {
				if o == origin {
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

		// Content Security Policy — defence-in-depth against XSS.
		//
		// MarkdownContent sanitises user-controlled proposal drafts with
		// DOMPurify before any dangerouslySetInnerHTML path fires; CSP
		// caps the blast radius if a future XSS bypasses sanitisation.
		//
		// Directives, left→right:
		//   default-src 'self'          — same-origin only for everything not
		//                                  otherwise specified
		//   script-src 'self'           — no inline scripts; no eval.
		//                                  Vite production bundles do not need
		//                                  either. A breakage here means we
		//                                  accidentally shipped an inline
		//                                  <script> and should fix the source,
		//                                  not the CSP.
		//   style-src 'self' 'unsafe-inline'
		//                                — Tailwind + recharts emit inline
		//                                  style= attributes at runtime; the
		//                                  unsafe-inline is for STYLE only,
		//                                  not script (unlike the far-riskier
		//                                  script-src 'unsafe-inline').
		//   img-src 'self' data: https: — data: for the inline SVG fallbacks
		//                                  we render for missing logos; https:
		//                                  for the externally-hosted proposal
		//                                  draft images we proxy via
		//                                  /api/v1/cr/proposal-image/...
		//   font-src 'self' data:       — data: for base64-inlined font glyphs
		//                                  in some icon packs
		//   connect-src 'self' https:   — XHR/fetch/WebSocket: same-origin for
		//                                  our own API; https: so CoinGecko
		//                                  price fetches still work
		//   frame-ancestors 'none'      — pairs with X-Frame-Options: DENY
		//                                  (modern browsers prefer this)
		//   base-uri 'self'             — blocks <base href="//evil"> rewrites
		//   form-action 'self'          — no forms today but cheap to enforce
		//   object-src 'none'           — no Flash / legacy plugin loading
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; "+
				"script-src 'self'; "+
				"style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' data: https:; "+
				"font-src 'self' data:; "+
				"connect-src 'self' https:; "+
				"frame-ancestors 'none'; "+
				"base-uri 'self'; "+
				"form-action 'self'; "+
				"object-src 'none'")

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
		// chi's middleware.RequestID populates a UUID/random ID on every
		// request and writes it back as X-Request-Id. Surfacing it in
		// access logs lets ops correlate "this 500 in user-reported
		// trace abc-123" to the exact server-side log line + any
		// downstream warnings during that request.
		slog.Info("http request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"duration_ms", time.Since(start).Milliseconds(),
			"ip", extractClientIP(r),
			"request_id", middleware.GetReqID(r.Context()),
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
			expected := "Bearer " + token
			// crypto/subtle.ConstantTimeCompare avoids the early-return
			// timing channel that string equality has — the latter
			// returns as soon as the first differing byte is found,
			// leaking which prefix matched. With the admin endpoint
			// rate-limited to 2 req/s + 5 burst, even a leaky compare
			// would take centuries to brute-force, but constant-time
			// is the right primitive and adds nothing.
			if subtle.ConstantTimeCompare([]byte(auth), []byte(expected)) != 1 {
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
		// Detailed progress for the address_transactions backfill.
		// The boolean in `backfills.addressTransactions` only answers
		// "is it done?" — this object answers "how far along?" while
		// it's mid-pass. Shape is stable:
		//   { running: bool, currentBlock: int, totalBlocks: int, percentDone: 0-100 }
		"backfillProgress": map[string]any{
			"addressTransactions": s.syncer.AddressTxBackfillProgress(),
		},
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
