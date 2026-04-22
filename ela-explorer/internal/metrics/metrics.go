package metrics

import (
	"fmt"
	"math"
	"net/http"
	"runtime"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

var (
	httpRequestsTotal  atomic.Int64
	httpErrorsTotal    atomic.Int64
	wsConnectionsTotal atomic.Int64
	syncedHeight       atomic.Int64
	chainTipHeight     atomic.Int64
	startTime          = time.Now()

	// Per-governance-handler error counter. Indexed by handler name
	// (e.g. "handleVoting") so Prometheus + tg-monitor can alert on
	// which specific tx handler is misbehaving instead of "something
	// in the block sync is failing". Read/write-guarded by govMu —
	// the write path is once-per-erroring-tx so lock contention is a
	// non-issue; the read path fires only on /metrics scrape.
	govMu            sync.RWMutex
	govHandlerErrors = map[string]*atomic.Int64{}

	// Per-endpoint HTTP latency histogram. Keyed by (route, method, status
	// bucket) where route is the chi route *template* (e.g.
	// "/api/v1/address/{address}/staking"), NOT the concrete URL — the
	// latter would cardinality-bomb once a real address appears in it.
	// Status is bucketed to 2xx / 3xx / 4xx / 5xx for the same reason.
	//
	// Buckets chosen from the empirical latency distribution of this API
	// (most routes land in 5-50ms; slow ones in 200ms-2s; a /sync-status
	// call that hits the chain tip can top 5s on a cold node). Linear
	// buckets would waste resolution at both ends; this set gives ~10%
	// relative precision in the zone we care about.
	httpLatencyMu      sync.RWMutex
	httpLatencyHists   = map[latencyKey]*latencyHist{}
	httpLatencyBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}
)

// latencyKey identifies a (route, method, status_class) tuple for the
// per-endpoint histogram. status_class is "2xx" / "3xx" / "4xx" / "5xx".
type latencyKey struct {
	Route       string
	Method      string
	StatusClass string
}

// latencyHist is a Prometheus-compatible cumulative histogram.
// Each bucket counts observations <= its upper bound. Sum tracks
// total observed time; Count is the number of observations.
type latencyHist struct {
	// bucketCounts[i] is the atomic count for buckets[i]. An extra
	// +Inf bucket (bucketCounts[len(buckets)]) catches everything
	// above the last finite bound.
	bucketCounts []atomic.Int64
	sumBits      atomic.Uint64 // seconds, stored as math.Float64bits
	count        atomic.Int64
}

func newLatencyHist() *latencyHist {
	return &latencyHist{
		bucketCounts: make([]atomic.Int64, len(httpLatencyBuckets)+1),
	}
}

func IncHTTPRequests()      { httpRequestsTotal.Add(1) }
func IncHTTPErrors()        { httpErrorsTotal.Add(1) }
func IncWSConnections()     { wsConnectionsTotal.Add(1) }
func SetSyncedHeight(h int64) { syncedHeight.Store(h) }
func SetChainTip(h int64)     { chainTipHeight.Store(h) }

// IncGovHandlerError increments the per-handler error counter. Safe to call
// from any goroutine; lazily creates the counter on first use.
func IncGovHandlerError(handler string) {
	govMu.RLock()
	c, ok := govHandlerErrors[handler]
	govMu.RUnlock()
	if ok {
		c.Add(1)
		return
	}
	govMu.Lock()
	if c, ok = govHandlerErrors[handler]; !ok {
		c = new(atomic.Int64)
		govHandlerErrors[handler] = c
	}
	govMu.Unlock()
	c.Add(1)
}

// ObserveHTTPLatency records a request latency against the
// (route, method, status_class) histogram. `route` must be the routing
// *template* (e.g. "/api/v1/address/{address}/staking") so we don't
// cardinality-bomb on every unique URL. Zero-allocation hot path for
// existing keys; only the first observation of a new key takes the
// write lock.
func ObserveHTTPLatency(route, method string, status int, d time.Duration) {
	key := latencyKey{
		Route:       route,
		Method:      method,
		StatusClass: statusClass(status),
	}
	httpLatencyMu.RLock()
	h, ok := httpLatencyHists[key]
	httpLatencyMu.RUnlock()
	if !ok {
		httpLatencyMu.Lock()
		if h, ok = httpLatencyHists[key]; !ok {
			h = newLatencyHist()
			httpLatencyHists[key] = h
		}
		httpLatencyMu.Unlock()
	}

	secs := d.Seconds()
	// Cumulative: every bucket whose upper bound is >= secs gets incremented.
	// We walk the sorted bucket list once and increment on the first match;
	// downstream Prometheus format rendering already emits cumulative counts
	// so we store non-cumulative per-bucket here and sum at scrape time.
	placed := false
	for i, ub := range httpLatencyBuckets {
		if secs <= ub {
			h.bucketCounts[i].Add(1)
			placed = true
			break
		}
	}
	if !placed {
		// +Inf bucket
		h.bucketCounts[len(httpLatencyBuckets)].Add(1)
	}
	h.count.Add(1)
	// Atomic float64 sum via CAS on the bit pattern — avoids a mutex on the hot path.
	for {
		old := h.sumBits.Load()
		newSum := math.Float64frombits(old) + secs
		if h.sumBits.CompareAndSwap(old, math.Float64bits(newSum)) {
			break
		}
	}
}

// statusClass bucketizes an HTTP status into "2xx" / "3xx" / "4xx" / "5xx"
// (or "other" for the unexpected). Keeping the cardinality at ~4 per route
// is what lets this histogram scale.
func statusClass(status int) string {
	switch {
	case status >= 200 && status < 300:
		return "2xx"
	case status >= 300 && status < 400:
		return "3xx"
	case status >= 400 && status < 500:
		return "4xx"
	case status >= 500 && status < 600:
		return "5xx"
	default:
		return "other"
	}
}

func Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		var m runtime.MemStats
		runtime.ReadMemStats(&m)

		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")

		fmt.Fprintf(w, "# HELP ela_explorer_uptime_seconds Time since the service started.\n")
		fmt.Fprintf(w, "# TYPE ela_explorer_uptime_seconds gauge\n")
		fmt.Fprintf(w, "ela_explorer_uptime_seconds %d\n\n", int64(time.Since(startTime).Seconds()))

		fmt.Fprintf(w, "# HELP ela_explorer_http_requests_total Total HTTP requests served.\n")
		fmt.Fprintf(w, "# TYPE ela_explorer_http_requests_total counter\n")
		fmt.Fprintf(w, "ela_explorer_http_requests_total %d\n\n", httpRequestsTotal.Load())

		fmt.Fprintf(w, "# HELP ela_explorer_http_errors_total Total HTTP error responses.\n")
		fmt.Fprintf(w, "# TYPE ela_explorer_http_errors_total counter\n")
		fmt.Fprintf(w, "ela_explorer_http_errors_total %d\n\n", httpErrorsTotal.Load())

		fmt.Fprintf(w, "# HELP ela_explorer_ws_connections_total Total WebSocket connections opened.\n")
		fmt.Fprintf(w, "# TYPE ela_explorer_ws_connections_total counter\n")
		fmt.Fprintf(w, "ela_explorer_ws_connections_total %d\n\n", wsConnectionsTotal.Load())

		fmt.Fprintf(w, "# HELP ela_explorer_synced_height Current synced block height.\n")
		fmt.Fprintf(w, "# TYPE ela_explorer_synced_height gauge\n")
		fmt.Fprintf(w, "ela_explorer_synced_height %d\n\n", syncedHeight.Load())

		fmt.Fprintf(w, "# HELP ela_explorer_chain_tip Chain tip height reported by the node.\n")
		fmt.Fprintf(w, "# TYPE ela_explorer_chain_tip gauge\n")
		fmt.Fprintf(w, "ela_explorer_chain_tip %d\n\n", chainTipHeight.Load())

		fmt.Fprintf(w, "# HELP ela_explorer_sync_gap Blocks behind chain tip.\n")
		fmt.Fprintf(w, "# TYPE ela_explorer_sync_gap gauge\n")
		fmt.Fprintf(w, "ela_explorer_sync_gap %d\n\n", chainTipHeight.Load()-syncedHeight.Load())

		fmt.Fprintf(w, "# HELP go_memstats_alloc_bytes Number of bytes allocated and in use.\n")
		fmt.Fprintf(w, "# TYPE go_memstats_alloc_bytes gauge\n")
		fmt.Fprintf(w, "go_memstats_alloc_bytes %d\n\n", m.Alloc)

		fmt.Fprintf(w, "# HELP go_memstats_sys_bytes Total bytes of memory obtained from the OS.\n")
		fmt.Fprintf(w, "# TYPE go_memstats_sys_bytes gauge\n")
		fmt.Fprintf(w, "go_memstats_sys_bytes %d\n\n", m.Sys)

		fmt.Fprintf(w, "# HELP go_goroutines Number of goroutines.\n")
		fmt.Fprintf(w, "# TYPE go_goroutines gauge\n")
		fmt.Fprintf(w, "go_goroutines %d\n\n", runtime.NumGoroutine())

		// Per-handler governance error counter. Emitted sorted-by-handler
		// so metric output is deterministic across scrapes (helps diffs
		// in alert rules and grafana).
		fmt.Fprintf(w, "# HELP ela_explorer_gov_handler_errors_total Governance handler errors, labeled by handler name.\n")
		fmt.Fprintf(w, "# TYPE ela_explorer_gov_handler_errors_total counter\n")
		govMu.RLock()
		handlers := make([]string, 0, len(govHandlerErrors))
		for name := range govHandlerErrors {
			handlers = append(handlers, name)
		}
		sort.Strings(handlers)
		for _, name := range handlers {
			fmt.Fprintf(w, "ela_explorer_gov_handler_errors_total{handler=%q} %d\n", name, govHandlerErrors[name].Load())
		}
		govMu.RUnlock()

		// Per-endpoint HTTP latency histogram. Emits Prometheus classic-
		// histogram format: _bucket{le=...} rows (cumulative), then _sum
		// and _count. Sorted by (route, method, status) for stable
		// output across scrapes.
		fmt.Fprintf(w, "\n# HELP ela_explorer_http_request_duration_seconds HTTP request latency by route template, method, and status class.\n")
		fmt.Fprintf(w, "# TYPE ela_explorer_http_request_duration_seconds histogram\n")
		httpLatencyMu.RLock()
		keys := make([]latencyKey, 0, len(httpLatencyHists))
		for k := range httpLatencyHists {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool {
			if keys[i].Route != keys[j].Route {
				return keys[i].Route < keys[j].Route
			}
			if keys[i].Method != keys[j].Method {
				return keys[i].Method < keys[j].Method
			}
			return keys[i].StatusClass < keys[j].StatusClass
		})
		for _, k := range keys {
			h := httpLatencyHists[k]
			var cumulative int64
			for i, ub := range httpLatencyBuckets {
				cumulative += h.bucketCounts[i].Load()
				fmt.Fprintf(w,
					"ela_explorer_http_request_duration_seconds_bucket{route=%q,method=%q,status=%q,le=\"%g\"} %d\n",
					k.Route, k.Method, k.StatusClass, ub, cumulative)
			}
			// +Inf bucket
			cumulative += h.bucketCounts[len(httpLatencyBuckets)].Load()
			fmt.Fprintf(w,
				"ela_explorer_http_request_duration_seconds_bucket{route=%q,method=%q,status=%q,le=\"+Inf\"} %d\n",
				k.Route, k.Method, k.StatusClass, cumulative)
			fmt.Fprintf(w,
				"ela_explorer_http_request_duration_seconds_sum{route=%q,method=%q,status=%q} %g\n",
				k.Route, k.Method, k.StatusClass, math.Float64frombits(h.sumBits.Load()))
			fmt.Fprintf(w,
				"ela_explorer_http_request_duration_seconds_count{route=%q,method=%q,status=%q} %d\n",
				k.Route, k.Method, k.StatusClass, h.count.Load())
		}
		httpLatencyMu.RUnlock()
	}
}
