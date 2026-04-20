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

	return nil
}
