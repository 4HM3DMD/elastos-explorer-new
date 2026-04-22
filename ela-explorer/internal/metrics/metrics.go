package metrics

import (
	"fmt"
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
)

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
	}
}
