package api

import (
	"context"
	"encoding/csv"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
)

// Hard limits for the streaming tax-export endpoint. These are not
// adjustable per-request: relaxing them risks DB-pool starvation on
// high-volume exchange addresses or write-deadline truncation on slow
// clients. Adjust in code with intent if the chain's transaction
// volume profile shifts materially.
const (
	exportMaxRows         = 50_000
	exportMaxRangeDays    = 366
	exportFlushEvery      = 500
	exportStmtTimeout     = "90s"
	exportRequestDeadline = 120 * time.Second
)

// getAddressExport streams a tax-export CSV for a single address. The
// route is registered OUTSIDE chi's middleware.Timeout group so that
// the 10s per-request timeout does not abort a 50K-row stream; per-
// request safety is enforced by (a) the context deadline below,
// (b) SET LOCAL statement_timeout on the DB transaction, and
// (c) http.ResponseController.SetWriteDeadline overriding the global
// http.Server WriteTimeout for this response only.
//
// See plan: /Users/ahmedibrahim/.claude/plans/functional-finding-squirrel.md
func (s *Server) getAddressExport(w http.ResponseWriter, r *http.Request) {
	if !s.exportCSVEnabled {
		writeError(w, http.StatusServiceUnavailable, "tax export is disabled")
		return
	}

	address := chi.URLParam(r, "address")
	if !isAddress(address) {
		writeError(w, http.StatusBadRequest, "invalid address")
		return
	}

	q := r.URL.Query()
	format := exportFormatFromString(q.Get("format"))
	includeCounterparties := q.Get("include_counterparties") == "true"

	fromTS, toTS, err := parseExportDateRange(q.Get("from"), q.Get("to"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Override the server-level WriteTimeout (30s) so a legitimate
	// large export can complete. ResponseController is the supported
	// post-Go-1.20 way to do this without leaking goroutines.
	rc := http.NewResponseController(w)
	if err := rc.SetWriteDeadline(time.Now().Add(exportRequestDeadline)); err != nil {
		// SetWriteDeadline is unsupported only if the underlying writer
		// doesn't expose it; that should not happen in production but
		// the export still works (subject to the 30s default). Log and
		// continue rather than failing the whole request.
		slog.Debug("getAddressExport: SetWriteDeadline unsupported", "error", err)
	}

	ctx, cancel := context.WithTimeout(r.Context(), exportRequestDeadline)
	defer cancel()

	// Pre-flight count: reject 413 before opening a streaming response.
	// Once we've written the first byte we can no longer change the
	// status code, so the cap check has to live up here.
	var rowCount int64
	if err := s.db.API.QueryRow(ctx, `
		SELECT COUNT(*) FROM address_transactions
		WHERE address = $1 AND timestamp BETWEEN $2 AND $3`,
		address, fromTS, toTS,
	).Scan(&rowCount); err != nil {
		slog.Warn("getAddressExport: count failed", "address", address, "error", err)
		writeError(w, http.StatusInternalServerError, "count query failed")
		return
	}
	if rowCount > exportMaxRows {
		writeError(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("date range yields %d rows; max %d. Narrow the range and retry.", rowCount, exportMaxRows))
		return
	}

	// Read-only transaction lets us scope statement_timeout without
	// leaking the setting back into the pool's connection.
	tx, err := s.db.API.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "db txn failed")
		return
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	if _, err := tx.Exec(ctx, "SET LOCAL statement_timeout = '"+exportStmtTimeout+"'"); err != nil {
		writeError(w, http.StatusInternalServerError, "db set timeout failed")
		return
	}

	rows, err := tx.Query(ctx, `
		SELECT txid, height, direction, value_sela, fee_sela, timestamp, tx_type, memo
		FROM address_transactions
		WHERE address = $1 AND timestamp BETWEEN $2 AND $3
		ORDER BY height ASC, direction ASC`,
		address, fromTS, toTS)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "query failed")
		return
	}
	defer rows.Close()

	// All preflight checks passed; commit to the streaming response.
	filename := fmt.Sprintf("ela-%s-%s-%s-%s.csv",
		safeFilenameSegment(address),
		string(format),
		time.Unix(fromTS, 0).UTC().Format("20060102"),
		time.Unix(toTS, 0).UTC().Format("20060102"),
	)
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")

	cw := csv.NewWriter(w)
	if err := cw.Write(headersFor(format)); err != nil {
		slog.Warn("getAddressExport: header write failed", "error", err)
		return
	}

	// Counterparty resolution is opt-in. When on, we resolve in chunks
	// equal to flushEvery so the per-tx vins/vouts join doesn't issue
	// 50K small queries; instead it issues 100 batched queries of 500
	// txids each.
	pendingCP := make([]ExportRow, 0, exportFlushEvery)

	flushBatch := func() {
		if includeCounterparties && len(pendingCP) > 0 {
			resolveExportCounterparties(ctx, s, address, pendingCP)
		}
		for _, row := range pendingCP {
			if err := cw.Write(buildRow(format, row)); err != nil {
				return
			}
		}
		cw.Flush()
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		pendingCP = pendingCP[:0]
	}

	// Dedup state: when both 'sent' and 'received' rows exist for the
	// same txid (rare, but seen in self-transfer / migration paths),
	// keep the 'sent' row because value_sela on it is the net debit.
	seenSent := make(map[string]struct{})
	dropQueued := func(txid string) {
		// Walk back through pendingCP and remove any 'received' row for
		// this txid that has not yet been flushed.
		for i := len(pendingCP) - 1; i >= 0; i-- {
			if pendingCP[i].Txid == txid && pendingCP[i].Direction == "received" {
				pendingCP = append(pendingCP[:i], pendingCP[i+1:]...)
			}
		}
	}

	streamed := 0
	for rows.Next() {
		var er ExportRow
		if err := rows.Scan(
			&er.Txid, &er.Height, &er.Direction,
			&er.ValueSela, &er.FeeSela, &er.Timestamp,
			&er.TxType, &er.Memo,
		); err != nil {
			slog.Warn("getAddressExport: scan failed", "error", err)
			continue
		}

		if er.Direction == "sent" {
			seenSent[er.Txid] = struct{}{}
			dropQueued(er.Txid)
		} else if _, sentSeen := seenSent[er.Txid]; sentSeen {
			// Already emitted the sent row for this txid; skip the dup.
			continue
		}

		er.Bucket = classifyTaxBucket(er.TxType, er.Direction)
		pendingCP = append(pendingCP, er)
		streamed++

		if len(pendingCP) >= exportFlushEvery {
			flushBatch()
			if ctx.Err() != nil {
				return
			}
		}
	}
	if err := rows.Err(); err != nil {
		slog.Warn("getAddressExport: rows iter failed", "address", address, "error", err)
	}

	flushBatch()
	cw.Flush()
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}

	slog.Info("tax-export complete",
		"address", address, "format", string(format),
		"from", fromTS, "to", toTS,
		"rows", streamed, "include_counterparties", includeCounterparties,
	)
}

// exportFormatFromString resolves the ?format= query param to one of
// the supported formats. Unknown values fall back to Koinly because
// it is the most lenient importer; an unspecified format should never
// silently fail the request.
func exportFormatFromString(s string) ExportFormat {
	switch s {
	case "cointracking":
		return FormatCoinTracking
	case "raw":
		return FormatRaw
	default:
		return FormatKoinly
	}
}

// parseExportDateRange validates the from/to date params, expressed as
// YYYY-MM-DD in UTC, and converts them to inclusive Unix-second bounds.
// Enforces the exportMaxRangeDays cap to protect the DB from
// pathological full-history scans.
func parseExportDateRange(fromStr, toStr string) (int64, int64, error) {
	if fromStr == "" || toStr == "" {
		return 0, 0, fmt.Errorf("from and to (YYYY-MM-DD) are required")
	}
	from, err := time.Parse("2006-01-02", fromStr)
	if err != nil {
		return 0, 0, fmt.Errorf("invalid from date; expected YYYY-MM-DD")
	}
	to, err := time.Parse("2006-01-02", toStr)
	if err != nil {
		return 0, 0, fmt.Errorf("invalid to date; expected YYYY-MM-DD")
	}
	if !to.After(from) {
		return 0, 0, fmt.Errorf("to date must be after from date")
	}
	if to.Sub(from).Hours() > 24*float64(exportMaxRangeDays) {
		return 0, 0, fmt.Errorf("date range exceeds %d days; narrow the range and retry", exportMaxRangeDays)
	}
	// Inclusive end-of-day for the to bound so a query "ending 2024-12-31"
	// captures every tx on Dec 31 UTC.
	toEnd := to.Add(24*time.Hour - time.Second)
	return from.UTC().Unix(), toEnd.UTC().Unix(), nil
}

// safeFilenameSegment strips characters that would break Content-Disposition
// header parsing in some browsers. Addresses are alphanumeric so this is
// belt-and-braces.
func safeFilenameSegment(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') {
			out = append(out, c)
		}
	}
	return string(out)
}

// resolveExportCounterparties batch-resolves counterparty addresses for
// up to exportFlushEvery rows in one shot. Reuses the same join shape
// as resolveCounterpartiesForPage but adapted to write directly into
// the ExportRow slice. Skipped entirely when ?include_counterparties=false.
func resolveExportCounterparties(ctx context.Context, s *Server, selfAddr string, batch []ExportRow) {
	if len(batch) == 0 {
		return
	}
	txids := make([]string, len(batch))
	for i := range batch {
		txids[i] = batch[i].Txid
	}

	// Output addresses per tx (for the counterparty on the sent side)
	sentTo := make(map[string][]string, len(batch))
	if rows, err := s.db.API.Query(ctx, `
		SELECT txid, address FROM tx_vouts
		WHERE txid = ANY($1) AND address != '' AND address != $2
		  AND (asset_id = '' OR asset_id = $3)
		ORDER BY txid, n`, txids, selfAddr, elaAssetID); err == nil {
		for rows.Next() {
			var txid, addr string
			if rows.Scan(&txid, &addr) == nil {
				if !containsStr(sentTo[txid], addr) {
					sentTo[txid] = append(sentTo[txid], addr)
				}
			}
		}
		rows.Close()
	}

	// Input addresses per tx (for the counterparty on the received side)
	recvFrom := make(map[string][]string, len(batch))
	if rows, err := s.db.API.Query(ctx, `
		SELECT vi.txid, COALESCE(vo.address, '') FROM tx_vins vi
		LEFT JOIN tx_vouts vo ON vo.txid = vi.prev_txid AND vo.n = vi.prev_vout
		WHERE vi.txid = ANY($1) AND vi.prev_txid != ''
		ORDER BY vi.txid, vi.n`, txids); err == nil {
		for rows.Next() {
			var txid, addr string
			if rows.Scan(&txid, &addr) == nil {
				if addr != "" && addr != selfAddr && !containsStr(recvFrom[txid], addr) {
					recvFrom[txid] = append(recvFrom[txid], addr)
				}
			}
		}
		rows.Close()
	}

	for i := range batch {
		if batch[i].Direction == "sent" {
			batch[i].From = selfAddr
			batch[i].To = joinComma(sentTo[batch[i].Txid])
		} else {
			batch[i].From = joinComma(recvFrom[batch[i].Txid])
			batch[i].To = selfAddr
		}
	}
}

func joinComma(addrs []string) string {
	if len(addrs) == 0 {
		return ""
	}
	out := addrs[0]
	for _, a := range addrs[1:] {
		out += "," + a
	}
	return out
}
