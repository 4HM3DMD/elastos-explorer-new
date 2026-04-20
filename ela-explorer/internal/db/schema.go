package db

import (
	"context"
	_ "embed"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed sql/schema.sql
var schemaDDL string

func InitSchema(ctx context.Context, pool *pgxpool.Pool) error {
	slog.Info("initializing database schema")

	_, err := pool.Exec(ctx, schemaDDL)
	if err != nil {
		return fmt.Errorf("failed to execute schema DDL: %w", err)
	}

	slog.Info("database schema initialized successfully")

	if err := runDataHeals(ctx, pool); err != nil {
		// Heals are best-effort — don't block startup on a transient DB
		// hiccup. They'll retry on the next restart, and the runtime is
		// already protected against re-introducing the bug they fix.
		slog.Warn("data-heal pass reported an issue", "error", err)
	}

	return nil
}

// runDataHeals applies idempotent post-DDL data corrections that can't be
// expressed as schema changes. Each heal is tightly scoped (WHERE clause
// matches only the exact anomaly) so running repeatedly is a no-op after
// the first successful pass. Add new heals below; never modify an existing
// heal's WHERE clause — introduce a replacement and leave the old one.
func runDataHeals(ctx context.Context, pool *pgxpool.Pool) error {
	// Heal #1 (2026-04 renewal-deactivation bug) — restore BPoSv2 vote rows
	// that were marked is_active=FALSE with spent_txid=txid. This state is
	// physically impossible on-chain (a UTXO can't be spent by the same
	// transaction that created it) — it's the unique fingerprint of the
	// handleVoting renewalcontents re-processing bug (fixed in the same
	// release). Safe on clean DBs (zero rows match) and idempotent.
	res, err := pool.Exec(ctx, `
		UPDATE votes
		SET is_active = TRUE,
		    spent_txid = NULL,
		    spent_height = NULL
		WHERE spent_txid = txid
		  AND vote_type = 4
		  AND is_active = FALSE`)
	if err != nil {
		return fmt.Errorf("heal #1 (renewal self-spent): %w", err)
	}
	if n := res.RowsAffected(); n > 0 {
		slog.Warn("data-heal applied: restored renewal votes wrongly marked ended",
			"heal", "renewal-self-spent",
			"rows_restored", n,
			"note", "one-time correction for tx_processor.go bug prior to this release")
	}

	// Heal #2 (2026-04 renewal-resurrection bug in Heal #1) — Heal #1 was
	// too permissive: it restored every self-spent row to is_active=TRUE,
	// but ~90% of those rows had legitimately been consumed by a LATER
	// renewal tx. The bug had overwritten their correct spent_txid with
	// self-txid; restoring them to active erased the real consumer.
	//
	// Fix by cross-checking tx_vins, the authoritative consumer record:
	//   - If a later tx's vin references (prev_txid=vote.txid, prev_vout=0),
	//     the row's correct state is is_active=FALSE with spent_txid set
	//     to that consumer. Re-apply the correct state.
	//   - If no consumer exists in tx_vins, Heal #1's restoration was
	//     correct — leave it alone.
	//
	// Scope: BPoSv2 votes (vote_type=4) that currently look truly-active
	// (is_active=TRUE, spent_txid=NULL, renewal_ref NOT NULL) AND have a
	// matching consumer in tx_vins. This combination only occurs on rows
	// Heal #1 touched in error; a naturally-active unspent row has no
	// tx_vins consumer. Idempotent: zero rows match after the first pass.
	res, err = pool.Exec(ctx, `
		WITH consumers AS (
			SELECT v.txid                  AS vote_txid,
			       tv.txid                 AS consumer_txid,
			       COALESCE(t.block_height, 0) AS consumer_block
			FROM votes v
			JOIN tx_vins tv
			  ON tv.prev_txid = v.txid
			 AND tv.prev_vout = 0
			LEFT JOIN transactions t ON t.txid = tv.txid
			WHERE v.vote_type = 4
			  AND v.is_active = TRUE
			  AND v.spent_txid IS NULL
			  AND v.renewal_ref IS NOT NULL
		)
		UPDATE votes v
		SET is_active    = FALSE,
		    spent_txid   = c.consumer_txid,
		    spent_height = NULLIF(c.consumer_block, 0)
		FROM consumers c
		WHERE v.txid = c.vote_txid`)
	if err != nil {
		return fmt.Errorf("heal #2 (renewal resurrection correction): %w", err)
	}
	if n := res.RowsAffected(); n > 0 {
		slog.Warn("data-heal applied: corrected rows Heal #1 wrongly resurrected",
			"heal", "renewal-resurrection-correction",
			"rows_corrected", n,
			"note", "set is_active=FALSE + real spent_txid from tx_vins")
	}

	return nil
}
