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

	// Heal #3 (2026-04 voter_rights permission bug) — voter_rights is
	// created lazily by refreshVoterRights (aggregator startup), NOT by
	// schema.sql, so on first deployment the "GRANT SELECT ON ALL TABLES
	// TO ela_api" at the bottom of schema.sql runs BEFORE the table
	// exists and misses it. Result: the API pool (ela_api, read-only)
	// gets pgx ErrNoRows when querying voter_rights, the Scan fails
	// silently, and totalStaked/totalPledged/totalIdle are absent from
	// the /address/{addr}/staking response.
	//
	// Fix is re-running the grant on every startup. Idempotent (DO block
	// skips if the role or table doesn't exist yet; PostgreSQL's GRANT
	// is also idempotent — re-granting what's already granted is a no-op).
	// Scoped only to voter_rights for minimal surface; the bulk
	// GRANT ... ON ALL TABLES in schema.sql covers everything else.
	_, err = pool.Exec(ctx, `
		DO $$
		BEGIN
			IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ela_api')
			   AND EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'voter_rights')
			THEN
				EXECUTE 'GRANT SELECT ON voter_rights TO ela_api';
			END IF;
		END $$`)
	if err != nil {
		// Non-fatal: if the role doesn't exist, the DO block's IF guards
		// already skipped the GRANT. This only fires on real DB errors.
		return fmt.Errorf("heal #3 (voter_rights grant): %w", err)
	}
	slog.Debug("data-heal: voter_rights SELECT grant ensured for ela_api")

	// Heal #4 (2026-04 CRC-vote consumption bug) — CR election vote rows
	// (vote_type=1) inserted by the early-term backfill path
	// (aggregator.scanBlockRangeForCRCVotes) were never marked is_active=FALSE
	// when consumed by a later TxVoting / TxReturnVotes / TxExchangeVotes.
	// Root cause: the backfill scan only inserts vote OUTPUT rows — it never
	// runs the vin-consumption step that lives in handleVoting. Meanwhile
	// handleVoting's consumption SQL matches on (txid, vout_n=vin.VOut),
	// which misses rows stored with the virtual vout_n=-1 used for the
	// composite CRC/DPoSv1 vote-output format (multiple candidates share
	// one on-chain output).
	//
	// Effect on the UI: cr_election_tallies over-counts every voter who
	// ever withdrew votes (TxReturnVotes) without re-voting — their
	// withdrawn row still carries is_active=TRUE and the tally picks it up.
	// Voters who CHANGED their vote are rescued by the tally's
	// MAX(stake_height) dedupe, but the pollution of is_active also breaks
	// any other query that filters on it (e.g. per-address vote-history
	// UI, future voter-list endpoints, etc).
	//
	// Fix approach: tx_vins is the authoritative consumer record (populated
	// during bulk sync and always accurate). Re-derive is_active for CRC
	// vote rows from it. The match condition is the direct UTXO identity:
	//   (tv.prev_txid = v.txid AND tv.prev_vout = v.vout_n)
	//
	// This correctly handles legacy pre-TxVoting CRC votes inserted by
	// handleVoteOutput, where `vout_n` holds the real on-chain output
	// index. Those rows ARE tied to a real vote UTXO, so consumption of
	// that UTXO cancels the vote — matching Elastos `processVoteCancel`.
	//
	// History note: a prior version of this heal also ran `(v.vout_n = -1
	// AND tv.prev_vout = 0)` to "catch" TxVoting-era CRC rows stored with
	// the virtual `vout_n = -1`. That branch was WRONG: CRC votes cast via
	// TxVoting are tracked by stakeAddress in the node's
	// `UsedCRVotes[stakeAddress]` map, not by UTXO. The `vout=0` of a
	// TxVoting is a regular transfer/change output (output_type=0), not a
	// vote UTXO — consuming it does NOT cancel a CRC vote. That branch
	// was over-deactivating CRC rows every time anyone touched a
	// TxVoting's change output (TxTransferAsset, TxRegisterCR funded from
	// change, TxDposV2ClaimReward, another TxVoting spending the change).
	// It caused the Term 6 4HM3D-below-j-z-007 tally bug. Fixed here;
	// Heal #7 below restores the falsely-deactivated rows.
	//
	// Idempotent: a second run finds zero is_active=TRUE rows with a
	// matching tx_vins consumer — all the work the first pass needed to
	// do is already done.
	//
	// Paired with Heal #5 (below) which forces a tally recompute if this
	// heal touched any rows, because cached cr_election_tallies rows were
	// computed against the bad is_active state.
	res, err = pool.Exec(ctx, `
		UPDATE votes v
		SET is_active    = FALSE,
		    spent_txid   = tv.txid,
		    spent_height = NULLIF(COALESCE(t.block_height, 0), 0)
		FROM tx_vins tv
		LEFT JOIN transactions t ON t.txid = tv.txid
		WHERE v.vote_type = 1
		  AND v.is_active = TRUE
		  AND tv.prev_txid = v.txid
		  AND tv.prev_vout = v.vout_n`)
	if err != nil {
		return fmt.Errorf("heal #4 (CRC vote consumption): %w", err)
	}
	crcHealed := res.RowsAffected()
	if crcHealed > 0 {
		slog.Warn("data-heal applied: deactivated CRC vote rows consumed per tx_vins",
			"heal", "crc-vote-consumption",
			"rows_corrected", crcHealed,
			"note", "use tx_vins as authoritative consumer record")
	}

	// Heal #5 — if Heal #4 touched anything, the cached cr_election_tallies
	// rows are stale (they were computed against the over-inflated is_active
	// set). Clearing them triggers the aggregator's critical loop to
	// re-compute on its next cycle (~60s). Skipped entirely when Heal #4 was
	// a no-op, so steady-state boots don't needlessly churn the tally table.
	if crcHealed > 0 {
		res, err := pool.Exec(ctx, `DELETE FROM cr_election_tallies`)
		if err != nil {
			// Non-fatal: aggregator will still re-compute if it finds
			// the data wrong; the DELETE just speeds up convergence.
			slog.Warn("heal #5 (tally invalidation) skipped", "error", err)
		} else if n := res.RowsAffected(); n > 0 {
			slog.Warn("data-heal applied: cleared cr_election_tallies to force recompute",
				"heal", "tally-recompute",
				"rows_cleared", n,
				"note", "aggregator will rebuild next cycle")
		}
	}

	// Heal #6 (2026-04 CRC tally semantic change) — cr_election_tallies
	// rows were previously built with a "persistent-UTXO" model that
	// summed every vote a candidate had ever received up to termStart,
	// deduped per-voter by latest vote. That model inflated every
	// candidate's total by carrying old votes across terms (verified
	// on live data: Sash had 118 "term 6 voters" but only 37 actually
	// voted in term 6's voting window).
	//
	// The aggregator now uses a window-bounded model: each term's tally
	// is built only from votes cast in that term's voting window.
	//
	// Existing rows in cr_election_tallies carry the old semantics. This
	// heal clears them ONCE, gated by a sync_state key, so the aggregator
	// rebuilds them under the new semantics on its next cycle.
	// Key survives future deploys — subsequent boots no-op unless the
	// key string changes (i.e. we intentionally want another rebuild).
	const tallySemanticVersion = "window-bounded-v1"
	var currentVersion string
	_ = pool.QueryRow(ctx, `SELECT value FROM sync_state WHERE key = 'tally_semantic_version'`).Scan(&currentVersion)
	if currentVersion != tallySemanticVersion {
		res, err := pool.Exec(ctx, `DELETE FROM cr_election_tallies`)
		if err != nil {
			slog.Warn("heal #6 (tally semantic clear) failed", "error", err)
		} else {
			n := res.RowsAffected()
			if _, err := pool.Exec(ctx,
				`INSERT INTO sync_state (key, value) VALUES ('tally_semantic_version', $1)
				 ON CONFLICT (key) DO UPDATE SET value = $1`,
				tallySemanticVersion,
			); err != nil {
				slog.Warn("heal #6 (tally semantic version flag) write failed", "error", err)
			}
			if n > 0 {
				slog.Warn("data-heal applied: cleared cr_election_tallies for semantic upgrade",
					"heal", "tally-semantic-upgrade",
					"from", currentVersion,
					"to", tallySemanticVersion,
					"rows_cleared", n,
					"note", "aggregator will rebuild under window-bounded semantics next cycle")
			}
		}
	}

	// Heal #9 (2026-04 replay-backed tally rebuild) — one-shot clear of
	// cr_election_tallies so the aggregator repopulates every term's row
	// from the new replay-based path. Previous rows were written by the
	// legacy window-bounded SQL path that couldn't distinguish recurring
	// incumbents (carry prior-term votes) from recurring non-seated
	// candidates (don't). Result: Term 6 had Rebecca Zhu at rank 1 or
	// missed 4HM3D below j-z-007, depending on the specific bug.
	//
	// Replay reads (term-1)'s top-12 from cr_election_tallies to decide
	// which candidates' prior-term unspent votes carry forward. The
	// aggregator already iterates terms in order (1→N), so after this
	// clear the first refresh cycle will replay term 1 (no prior, empty
	// seated set), write it, then replay term 2 reading term 1's fresh
	// top-12, and so on up to the current on-duty term.
	//
	// Gated by a sync_state key so it runs exactly once per deploy of
	// this fix. Subsequent boots no-op unless the key value changes.
	const tallyReplayVersion = "replay-backed-v3-active-persists-across-terms"
	var replayVer string
	_ = pool.QueryRow(ctx, `SELECT value FROM sync_state WHERE key = 'tally_replay_version'`).Scan(&replayVer)
	if replayVer != tallyReplayVersion {
		res9, err := pool.Exec(ctx, `DELETE FROM cr_election_tallies`)
		if err != nil {
			slog.Warn("heal #9 (replay-backed tally rebuild) failed", "error", err)
		} else {
			n := res9.RowsAffected()
			if _, err := pool.Exec(ctx,
				`INSERT INTO sync_state (key, value) VALUES ('tally_replay_version', $1)
				 ON CONFLICT (key) DO UPDATE SET value = $1`,
				tallyReplayVersion,
			); err != nil {
				slog.Warn("heal #9 (version flag) write failed", "error", err)
			}
			if n > 0 {
				slog.Warn("data-heal applied: cleared cr_election_tallies for replay rebuild",
					"heal", "replay-backed-rebuild",
					"rows_cleared", n,
					"note", "aggregator will replay all terms in order next cycle")
			}
		}
	}

	// Heal #7 (2026-04 TxVoting CRC over-deactivation rollback) — undo the
	// damage done by a prior version of Heal #4 that matched
	// `(v.vout_n = -1 AND tv.prev_vout = 0)` and thus marked CRC vote rows
	// as spent every time ANY tx consumed the change output of their
	// original TxVoting. CRC votes cast via TxVoting aren't tied to a
	// UTXO — they're tracked by stakeAddress in the node's
	// `UsedCRVotes[stakeAddress]` map. Consuming a TxVoting's `vout=0`
	// (a regular transfer output, output_type=0) does NOT cancel a CRC
	// vote per Elastos `processVoteCancel` semantics.
	//
	// Restore target: CRC rows (vote_type=1) stored with vout_n=-1 where:
	//   - the row is currently marked spent (spent_txid NOT NULL), AND
	//   - the original TxVoting's vout=0 is NOT a vote UTXO (output_type
	//     is NOT OTVote=1 or OTDposV2Vote=6 — it's a regular transfer).
	//
	// The `NOT EXISTS` clause ensures we don't touch rows that were
	// correctly deactivated because vout=0 actually IS a vote UTXO
	// (legacy OTVote-style TxVoting, rare but legal).
	//
	// Gated by a sync_state key so it runs exactly once per deploy of the
	// fix. Paired with cr_election_tallies clear below to force an
	// immediate aggregator rebuild under corrected is_active state.
	const crcRestoreVersion = "heal-7-crc-utxo-deactivation-rollback-v1"
	var crcRestoreDone string
	_ = pool.QueryRow(ctx, `SELECT value FROM sync_state WHERE key = 'heal_7_version'`).Scan(&crcRestoreDone)
	if crcRestoreDone != crcRestoreVersion {
		res, err := pool.Exec(ctx, `
			UPDATE votes v
			SET is_active    = TRUE,
			    spent_txid   = NULL,
			    spent_height = NULL
			WHERE v.vote_type = 1
			  AND v.vout_n    = -1
			  AND v.spent_txid IS NOT NULL
			  AND NOT EXISTS (
			    SELECT 1 FROM tx_vouts ov
			    WHERE ov.txid = v.txid
			      AND ov.n = 0
			      AND ov.output_type IN (1, 6)
			  )`)
		if err != nil {
			slog.Warn("heal #7 (CRC UTXO-deactivation rollback) failed", "error", err)
		} else {
			n := res.RowsAffected()
			if _, err := pool.Exec(ctx,
				`INSERT INTO sync_state (key, value) VALUES ('heal_7_version', $1)
				 ON CONFLICT (key) DO UPDATE SET value = $1`,
				crcRestoreVersion,
			); err != nil {
				slog.Warn("heal #7 (version flag) write failed", "error", err)
			}
			if n > 0 {
				slog.Warn("data-heal applied: restored CRC vote rows falsely marked spent",
					"heal", "crc-utxo-deactivation-rollback",
					"rows_restored", n,
					"note", "TxVoting CRC votes are stakeAddress-tracked, not UTXO-tracked — "+
						"prior Heal #4 branch over-deactivated them")
			}
			// Heal #8 — force tally rebuild if rollback touched anything.
			if n > 0 {
				if res2, err := pool.Exec(ctx, `DELETE FROM cr_election_tallies`); err != nil {
					slog.Warn("heal #8 (tally invalidation) skipped", "error", err)
				} else if cleared := res2.RowsAffected(); cleared > 0 {
					slog.Warn("data-heal applied: cleared cr_election_tallies to force recompute",
						"heal", "tally-recompute-post-rollback",
						"rows_cleared", cleared,
						"note", "aggregator will rebuild with corrected is_active state next cycle")
				}
			}
		}
	}

	return nil
}
