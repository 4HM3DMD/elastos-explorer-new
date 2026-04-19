package aggregator

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	gosync "sync"
	"sync/atomic"
	"time"

	"ela-explorer/internal/db"
	"ela-explorer/internal/node"
	"ela-explorer/internal/proposal"
	"ela-explorer/internal/ws"
)

// Era activation heights (mainnet) -- kept in sync with sync/tx_types.go.
const (
	HeightPublicDPOS  = 402680
	HeightDPoSV2Start = 1405000
)

// CR consensus constants (mainnet).
const (
	CRFirstTermStart = 658930
	CRTermLength     = 262800
	CRVotingPeriod   = 21600
	CRClaimingPeriod = 10080
)

type Aggregator struct {
	db   *db.DB
	node *node.Client
	hub  *ws.Hub

	stakeIdleEnabled bool

	dailyStatsDone atomic.Bool
	earlyVotesDone atomic.Bool
	loopsDone      atomic.Int32 // counts distinct loops that completed at least once
}

func New(database *db.DB, nodeClient *node.Client, hub *ws.Hub) *Aggregator {
	return &Aggregator{db: database, node: nodeClient, hub: hub, stakeIdleEnabled: true}
}

// SetStakeIdleEnabled toggles the voter_rights refresh loop. When false, the
// loop short-circuits and API handlers should omit the new fields.
func (a *Aggregator) SetStakeIdleEnabled(v bool) { a.stakeIdleEnabled = v }

const requiredLoopsForReady = 5

func (a *Aggregator) Run(ctx context.Context) {
	go a.backfillDailyStats(ctx)
	go a.backfillEarlyVotes(ctx)

	go a.runLoop(ctx, "producers", 60*time.Second, a.refreshProducers, true)
	go a.runLoop(ctx, "bpos_stakes", 60*time.Second, a.refreshBPoSStakes, false)
	go a.runLoop(ctx, "bpos_rewards", 120*time.Second, a.refreshBPoSRewards, false)
	go a.runLoop(ctx, "voter_rights", 60*time.Second, a.refreshVoterRights, false)
	go a.runLoop(ctx, "cr_members", 120*time.Second, a.refreshCRMembers, true)
	go a.runLoop(ctx, "cr_elections", 60*time.Second, a.refreshElectionTallies, true)
	go a.runLoop(ctx, "cr_proposals", 120*time.Second, a.refreshProposals, true)
	go a.runLoop(ctx, "proposal_drafts", 60*time.Second, a.refreshProposalDraftData, false)
	go a.runLoop(ctx, "review_comments", 2*time.Minute, a.backfillReviewComments, false)
	go a.runLoop(ctx, "daily_stats", 5*time.Minute, a.refreshDailyStats, false)
	go a.runLoop(ctx, "chain_stats", 30*time.Second, a.refreshChainStats, true)

	<-ctx.Done()
}

func (a *Aggregator) runLoop(ctx context.Context, name string, interval time.Duration, fn func(context.Context) error, critical bool) {
	counted := false
	if err := fn(ctx); err != nil {
		slog.Warn("aggregator initial run failed", "name", name, "error", err)
	} else if critical && !counted {
		counted = true
		a.loopsDone.Add(1)
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := fn(ctx); err != nil {
				slog.Warn("aggregator run failed", "name", name, "error", err)
			} else if critical && !counted {
				counted = true
				a.loopsDone.Add(1)
			}
		}
	}
}

func (a *Aggregator) BackfillStatus() map[string]bool {
	return map[string]bool{
		"dailyStats":          a.dailyStatsDone.Load(),
		"earlyVotes":          a.earlyVotesDone.Load(),
		"aggregatorFirstCycle": a.loopsDone.Load() >= int32(requiredLoopsForReady),
	}
}

func (a *Aggregator) refreshProducers(ctx context.Context) error {
	resp, err := a.node.ListProducers(ctx, 0, 500, "all")
	if err != nil {
		return fmt.Errorf("list producers: %w", err)
	}

	for _, p := range resp.Producers {
		dposv1Sela := parseELAToSela(p.Votes)
		dposv2Sela := parseELAToSela(p.DPoSV2Votes)

		_, err := a.db.Syncer.Exec(ctx, `
			INSERT INTO producers (owner_pubkey, node_pubkey, nickname, url, location, net_address, state, identity,
				register_height, cancel_height, inactive_height, illegal_height, stake_until, index,
				dposv1_votes_sela, dposv2_votes_sela, dposv1_votes_text, dposv2_votes_text, last_updated)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, EXTRACT(EPOCH FROM NOW())::BIGINT)
			ON CONFLICT (owner_pubkey) DO UPDATE SET
				node_pubkey=$2, nickname=$3, url=$4, location=$5, net_address=$6, state=$7, identity=$8,
				register_height=$9, cancel_height=$10, inactive_height=$11,
				illegal_height=$12, stake_until=$13, index=$14,
				dposv1_votes_sela=$15, dposv2_votes_sela=$16, dposv1_votes_text=$17, dposv2_votes_text=$18,
				last_updated=EXTRACT(EPOCH FROM NOW())::BIGINT`,
			p.OwnerPublicKey, p.NodePublicKey, p.NickName, p.URL,
			p.Location, p.NetAddress, p.State, p.Identity,
			p.RegisterHeight, p.CancelHeight, p.InactiveHeight, p.IllegalHeight,
			p.StakeUntil, p.Index,
			dposv1Sela, dposv2Sela, p.Votes, p.DPoSV2Votes,
		)
		if err != nil {
			slog.Warn("upsert producer failed", "owner", safeTruncate(p.OwnerPublicKey, 16), "error", err)
		}
	}

	// Mark producers not returned by RPC as "Unknown" (stale / deregistered)
	if len(resp.Producers) > 0 {
		knownKeys := make([]string, 0, len(resp.Producers))
		for _, p := range resp.Producers {
			knownKeys = append(knownKeys, p.OwnerPublicKey)
		}
		if _, err := a.db.Syncer.Exec(ctx, `
			UPDATE producers SET state = 'Unknown'
			WHERE owner_pubkey != ALL($1) AND state NOT IN ('Unknown')`, knownKeys); err != nil {
			slog.Warn("refreshProducers: mark stale producers failed", "error", err)
		}
	}

	slog.Info("refreshed producers", "count", len(resp.Producers))
	return nil
}

func (a *Aggregator) refreshCRMembers(ctx context.Context) error {
	resp, err := a.node.ListCurrentCRs(ctx)
	if err != nil {
		return fmt.Errorf("list current CRs: %w", err)
	}

	for _, m := range resp.CRMembersInfo {
		impeachSela := parseELAToSela(m.ImpeachmentVotes)
		depositSela := parseELAToSela(m.DepositAmount)
		penaltySela := parseELAToSela(m.Penalty)

		_, err := a.db.Syncer.Exec(ctx, `
			INSERT INTO cr_members (cid, did, code, dpos_pubkey, nickname, url, location, state,
				impeachment_votes, deposit_amount, deposit_address, penalty, index, last_updated)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, EXTRACT(EPOCH FROM NOW())::BIGINT)
			ON CONFLICT (cid) DO UPDATE SET
				did=$2, code=$3, dpos_pubkey=$4, nickname=$5, url=$6, location=$7, state=$8,
				impeachment_votes=$9, deposit_amount=$10, deposit_address=$11, penalty=$12, index=$13,
				last_updated=EXTRACT(EPOCH FROM NOW())::BIGINT`,
			m.CID, m.DID, m.Code, m.DPOSPublicKey,
			m.NickName, m.URL, m.Location, m.State,
			impeachSela, depositSela, m.DepositAddress, penaltySela, m.Index,
		)
		if err != nil {
			slog.Warn("upsert cr member failed", "cid", m.CID, "error", err)
		}
	}

	// Mark CR members not returned by RPC as "Unknown" (stale / termed out)
	if len(resp.CRMembersInfo) > 0 {
		knownCIDs := make([]string, 0, len(resp.CRMembersInfo))
		for _, m := range resp.CRMembersInfo {
			knownCIDs = append(knownCIDs, m.CID)
		}
		if _, err := a.db.Syncer.Exec(ctx, `
			UPDATE cr_members SET state = 'Unknown'
			WHERE cid != ALL($1) AND state NOT IN ('Unknown', 'Returned', 'Terminated')`, knownCIDs); err != nil {
			slog.Warn("refreshCRMembers: mark stale CRs failed", "error", err)
		}
	}

	// Read election votes from the pre-computed cr_election_tallies table.
	// The refreshElectionTallies loop keeps this table up to date.
	stage, stageErr := a.node.GetCRRelatedStage(ctx)
	if stageErr != nil {
		slog.Warn("refreshCRMembers: getcrrelatedstage failed, skipping votes", "error", stageErr)
	}

	if _, err := a.db.Syncer.Exec(ctx, `UPDATE cr_members SET votes_sela = 0`); err != nil {
		slog.Warn("refreshCRMembers: zero votes_sela failed", "error", err)
	}

	if stageErr == nil && stage.OnDutyStartHeight > 0 {
		currentTerm := (stage.OnDutyStartHeight-CRFirstTermStart)/CRTermLength + 1
		if _, err := a.db.Syncer.Exec(ctx, `
			UPDATE cr_members SET votes_sela = et.final_votes_sela
			FROM cr_election_tallies et
			WHERE et.term = $1 AND et.candidate_cid = cr_members.cid`,
			currentTerm,
		); err != nil {
			slog.Warn("refreshCRMembers: votes_sela from tallies failed", "error", err)
		}
	}

	slog.Debug("refreshed CR members", "count", len(resp.CRMembersInfo))
	return nil
}

// electionVotingPeriod returns the narrow voting window (start, end) and the
// term boundary (termStart) for a given CR term. The narrow window is the
// theoretical voting-only period; termStart is when the new council takes over.
func electionVotingPeriod(term int64) (narrowStart, narrowEnd, termStart int64) {
	termStart = CRFirstTermStart + (term-1)*CRTermLength
	narrowEnd = termStart - 1 - CRClaimingPeriod
	narrowStart = narrowEnd - CRVotingPeriod
	return
}

// refreshElectionTallies computes CRC election vote tallies for all terms.
// Past elections are computed once; the active election (if any) is refreshed every cycle.
func (a *Aggregator) refreshElectionTallies(ctx context.Context) error {
	stage, err := a.node.GetCRRelatedStage(ctx)
	if err != nil {
		return fmt.Errorf("getcrrelatedstage: %w", err)
	}
	if stage.OnDutyStartHeight <= 0 {
		return nil
	}

	currentTerm := (stage.OnDutyStartHeight-CRFirstTermStart)/CRTermLength + 1

	// Determine which terms to process: all from 1 to currentTerm.
	// If a voting period is currently active, also include currentTerm+1.
	maxTerm := currentTerm
	if stage.InVoting {
		maxTerm = currentTerm + 1
	}

	// Use the EXPLORER's synced height, not the node's chain height.
	// The votes table only contains data up to the explorer's synced height.
	// Computing tallies against chain height when the DB is still syncing
	// produces empty/wrong results and sentinel rows for terms not yet indexed.
	syncedHeight, err := a.db.GetLastSyncedHeight(ctx)
	if err != nil {
		return fmt.Errorf("get synced height: %w", err)
	}

	for term := int64(1); term <= maxTerm; term++ {
		narrowStart, narrowEnd, termStart := electionVotingPeriod(term)

		// Don't compute tallies for terms the explorer hasn't synced past yet.
		if narrowStart > syncedHeight {
			continue
		}

		// For completed elections, skip if already computed.
		if termStart < syncedHeight {
			var existing int64
			_ = a.db.Syncer.QueryRow(ctx, `SELECT COUNT(*) FROM cr_election_tallies WHERE term = $1`, term).Scan(&existing)
			if existing > 0 {
				continue
			}
		}

		slog.Info("computing election tally", "term", term, "narrowStart", narrowStart, "narrowEnd", narrowEnd, "termStart", termStart)

		if err := a.computeElectionTally(ctx, term, narrowStart, narrowEnd, termStart); err != nil {
			slog.Warn("election tally failed", "term", term, "error", err)
			continue
		}
	}

	return nil
}

// computeElectionTally calculates the vote tally for a single election term.
//
// CRC votes in Elastos are persistent UTXOs: a vote cast in term 1 carries over
// to all future elections until the voter changes it or unstakes. The node counts
// ALL active vote UTXOs at the election snapshot, not just ones created during
// the voting window.
//
// Algorithm:
//  1. Collect ALL CRC votes from the beginning of time up to termStart (when the
//     new council takes over). This captures carry-over votes from previous terms.
//  2. Deduplicate by taking each voter's LATEST vote (max stake_height per address).
//  3. Only include candidates who received at least one vote in the broader period
//     (from previous term's start to current term's start) to filter out stale
//     candidates who aren't running this term.
func (a *Aggregator) computeElectionTally(ctx context.Context, term, narrowStart, narrowEnd, termStart int64) error {
	if _, err := a.db.Syncer.Exec(ctx, `DELETE FROM cr_election_tallies WHERE term = $1`, term); err != nil {
		return fmt.Errorf("delete old tally: %w", err)
	}

	// The effective cutoff is the term start (when new council takes office).
	// All votes up to this point represent the final state of each voter.
	cutoff := termStart - 1

	// Previous term's start determines the "active candidates" window.
	// A candidate must have received at least one vote after the previous term started
	// to be considered a candidate for this election.
	var prevTermStart int64
	if term > 1 {
		prevTermStart = CRFirstTermStart + (term-2)*CRTermLength
	}

	_, err := a.db.Syncer.Exec(ctx, `
		INSERT INTO cr_election_tallies (term, candidate_cid, nickname, final_votes_sela, voter_count,
			voting_start_height, voting_end_height, rank, elected, computed_at)
		SELECT
			$1,
			v.candidate,
			COALESCE(cr.nickname, ''),
			SUM(v.amount_sela),
			COUNT(DISTINCT v.address),
			$3,
			$4,
			0,
			FALSE,
			EXTRACT(EPOCH FROM NOW())::BIGINT
		FROM votes v
		JOIN (
			SELECT address, MAX(stake_height) AS max_h
			FROM votes
			WHERE vote_type = 1 AND stake_height <= $2
			GROUP BY address
		) latest ON v.address = latest.address AND v.stake_height = latest.max_h
		LEFT JOIN cr_members cr ON cr.cid = v.candidate
		WHERE v.vote_type = 1
		  AND v.stake_height <= $2
		  AND v.candidate IN (
			SELECT DISTINCT candidate FROM votes
			WHERE vote_type = 1 AND stake_height > $5 AND stake_height <= $2
		  )
		GROUP BY v.candidate, cr.nickname`,
		term, cutoff, narrowStart, narrowEnd, prevTermStart,
	)
	if err != nil {
		return fmt.Errorf("insert tally: %w", err)
	}

	if _, err := a.db.Syncer.Exec(ctx, `
		UPDATE cr_election_tallies SET rank = sub.rn, elected = (sub.rn <= 12)
		FROM (
			SELECT candidate_cid, ROW_NUMBER() OVER (ORDER BY final_votes_sela DESC) AS rn
			FROM cr_election_tallies
			WHERE term = $1
		) sub
		WHERE cr_election_tallies.term = $1 AND cr_election_tallies.candidate_cid = sub.candidate_cid`,
		term,
	); err != nil {
		return fmt.Errorf("assign ranks: %w", err)
	}

	var count int64
	_ = a.db.Syncer.QueryRow(ctx, `SELECT COUNT(*) FROM cr_election_tallies WHERE term = $1`, term).Scan(&count)

	slog.Info("election tally computed", "term", term, "candidates", count)
	return nil
}

// backfillEarlyVotes scans blocks for CRC vote outputs that were missed during
// the initial sync. This fills the votes table for early election terms (1, 2 & 3).
// Runs once at startup and exits when complete.
func (a *Aggregator) backfillEarlyVotes(ctx context.Context) {
	// Two ranges to scan: term 1 voting period and terms 2-3 voting periods.
	type scanRange struct {
		start, end int64
		label      string
		clearTerms []int
	}
	ranges := []scanRange{
		{620000, 660000, "term1", []int{1}},
		{880000, 1190000, "terms2-3", []int{2, 3}},
		{1180000, 1190000, "term3-gap", nil},
	}

	for _, sr := range ranges {
		var existing int64
		_ = a.db.Syncer.QueryRow(ctx, `
			SELECT COUNT(*) FROM votes WHERE vote_type = 1 AND stake_height >= $1 AND stake_height <= $2`,
			sr.start, sr.end).Scan(&existing)
		if existing > 0 {
			slog.Info("backfillEarlyVotes: already have votes, skipping scan", "range", sr.label, "count", existing)
		} else {
			a.scanBlockRangeForCRCVotes(ctx, sr.start, sr.end, sr.label)
		}
	}

	// Clear ALL election tallies so they recompute with the corrected algorithm
	// that includes carry-over votes from previous terms.
	_, _ = a.db.Syncer.Exec(ctx, `DELETE FROM cr_election_tallies`)
	slog.Info("backfillEarlyVotes: cleared all tallies for full recompute")
	a.earlyVotesDone.Store(true)
}

type voteRow struct {
	txid, address, candidate string
	voutN                    int
	amountSela               int64
	stakeHeight              int64
}

func (a *Aggregator) scanBlockRangeForCRCVotes(ctx context.Context, startHeight, endHeight int64, label string) {
	slog.Info("backfillEarlyVotes: starting parallel scan", "range", label, "from", startHeight, "to", endHeight)

	const workers = 8
	const batchInsertSize = 500

	heights := make(chan int64, workers*2)
	results := make(chan []voteRow, workers*2)

	var wg gosync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for height := range heights {
				if ctx.Err() != nil {
					return
				}
				var block *node.BlockInfo
				var err error
				for attempt := 0; attempt < 3; attempt++ {
					block, err = a.node.GetBlockByHeight(ctx, height)
					if err == nil {
						break
					}
					time.Sleep(time.Duration(attempt+1) * 500 * time.Millisecond)
				}
				if err != nil {
					slog.Warn("backfillEarlyVotes: getblock failed after retries", "height", height, "error", err)
					continue
				}

				var votes []voteRow
				for _, tx := range block.Tx {
					for _, vout := range tx.VOut {
						if vout.Type != 1 || vout.Payload == nil || len(vout.Payload) == 0 {
							continue
						}
						var voteOutput node.VoteOutputInfo
						if err := json.Unmarshal(vout.Payload, &voteOutput); err != nil {
							continue
						}
						outputValue := parseELAToSela(vout.Value)
						for _, content := range voteOutput.Contents {
							if content.VoteType != 1 {
								continue
							}
							allCands := content.AllCandidates()
							candidateCount := int64(len(allCands))
							if candidateCount == 0 {
								continue
							}
							for _, cv := range allCands {
								var amountSela int64
								if voteOutput.Version == 0 {
									amountSela = outputValue / candidateCount
								} else {
									amountSela = parseELAToSela(cv.Votes)
								}
								votes = append(votes, voteRow{
									txid: tx.TxID, voutN: vout.N, address: vout.Address,
									candidate: cv.Candidate, amountSela: amountSela, stakeHeight: height,
								})
							}
						}
					}
				}
				if len(votes) > 0 {
					results <- votes
				}
			}
		}()
	}

	go func() {
		for h := startHeight; h <= endHeight; h++ {
			if ctx.Err() != nil {
				break
			}
			heights <- h
		}
		close(heights)
		wg.Wait()
		close(results)
	}()

	var inserted int64
	var batch []voteRow
	flushBatch := func() {
		if len(batch) == 0 {
			return
		}
		pgxTx, err := a.db.Syncer.Begin(ctx)
		if err != nil {
			slog.Warn("backfillEarlyVotes: begin batch tx failed", "error", err)
			batch = batch[:0]
			return
		}
		for _, v := range batch {
			if _, err := pgxTx.Exec(ctx, `
				INSERT INTO votes (txid, vout_n, address, producer_pubkey, candidate, vote_type, amount_sela, lock_time, stake_height, expiry_height, staking_rights, is_active)
				VALUES ($1, $2, $3, $4, $5, 1, $6, 0, $7, 0, 0, TRUE)
				ON CONFLICT (txid, vout_n, candidate, vote_type) DO NOTHING`,
				v.txid, v.voutN, v.address, v.candidate, v.candidate,
				v.amountSela, v.stakeHeight,
			); err != nil {
				slog.Warn("backfillEarlyVotes: insert failed", "error", err)
			} else {
				inserted++
			}
		}
		if err := pgxTx.Commit(ctx); err != nil {
			pgxTx.Rollback(ctx)
			slog.Warn("backfillEarlyVotes: commit batch failed", "error", err)
		}
		batch = batch[:0]
	}

	for votes := range results {
		batch = append(batch, votes...)
		if len(batch) >= batchInsertSize {
			flushBatch()
		}
		if inserted > 0 && inserted%5000 == 0 {
			slog.Info("backfillEarlyVotes: progress", "range", label, "inserted", inserted)
		}
	}
	flushBatch()

	slog.Info("backfillEarlyVotes: scan complete", "range", label, "inserted", inserted)
}

// refreshProposals fetches the authoritative proposal states from the ELA node
// RPC and updates the cr_proposals table with current status, voter rejection
// amounts, terminated height, tracking count, and per-council-member votes.
func (a *Aggregator) refreshProposals(ctx context.Context) error {
	// Backfill budget_total from budgets_json for proposals that were synced
	// before budget_total was populated during insert.
	if _, err := a.db.Syncer.Exec(ctx, `
		UPDATE cr_proposals
		SET budget_total = sub.total_amount
		FROM (
			SELECT proposal_hash,
			       COALESCE(
				   (SELECT SUM(CASE WHEN elem->>'amount' ~ '^\d+$'
				                    THEN (elem->>'amount')::BIGINT
				                    ELSE 0 END)
				    FROM jsonb_array_elements(budgets_json::jsonb) elem)::TEXT,
				   '0') AS total_amount
			FROM cr_proposals
			WHERE budget_total = '0' AND budgets_json != '[]' AND budgets_json != ''
		) sub
		WHERE cr_proposals.proposal_hash = sub.proposal_hash`); err != nil {
		slog.Warn("refreshProposals: budget_total backfill failed", "error", err)
	}

	resp, err := a.node.ListCRProposalBaseState(ctx, 0, 2000, "all")
	if err != nil {
		return fmt.Errorf("listcrproposalbasestate: %w", err)
	}

	updated := 0
	for _, p := range resp.ProposalBaseStates {
		if p.ProposalHash == "" {
			continue
		}

		voterReject := p.VotersRejectAmount
		if voterReject == "" {
			voterReject = "0"
		}

		var crVotesJSON string
		if len(p.CRVotes) > 0 {
			pairs := make([]string, 0, len(p.CRVotes))
			for did, vote := range p.CRVotes {
				pairs = append(pairs, fmt.Sprintf(`"%s":"%s"`, did, vote))
			}
			crVotesJSON = "{" + joinStrings(pairs, ",") + "}"
		} else {
			crVotesJSON = "{}"
		}

		// Recount approve/reject/abstain from the authoritative crvotes map
		var approveCount, rejectCount, abstainCount int
		for _, vote := range p.CRVotes {
			switch vote {
			case "approve":
				approveCount++
			case "reject":
				rejectCount++
			case "abstain":
				abstainCount++
			}
		}

		tag, err := a.db.Syncer.Exec(ctx, `
			UPDATE cr_proposals SET
				status = $2,
				voter_reject = $3,
				terminated_height = $4,
				tracking_count = $5,
				cr_votes_json = $6,
				vote_count = $7,
				reject_count = $8,
				abstain_count = $9,
				last_updated = EXTRACT(EPOCH FROM NOW())::BIGINT
			WHERE proposal_hash = $1`,
			p.ProposalHash, p.Status,
			voterReject, int64(p.TerminatedHeight), int(p.TrackingCount),
			crVotesJSON, approveCount, rejectCount, abstainCount,
		)
		if err != nil {
			slog.Warn("refreshProposals: update failed", "hash", safeTruncate(p.ProposalHash, 16), "error", err)
			continue
		}
		if tag.RowsAffected() > 0 {
			updated++
		}
	}

	slog.Debug("refreshed proposals", "rpc_count", len(resp.ProposalBaseStates), "updated", updated)

	// Sync available_amount and per-budget-item status from getcrproposalstate.
	// This requires individual RPC calls, so we batch a small set per cycle.
	a.syncProposalDetailedState(ctx)

	return nil
}

// syncProposalDetailedState fetches per-proposal state (availableamount,
// budget item status) via individual getcrproposalstate RPC calls. Limited
// to 20 proposals per cycle to avoid overloading the node.
func (a *Aggregator) syncProposalDetailedState(ctx context.Context) {
	rows, err := a.db.Syncer.Query(ctx, `
		SELECT proposal_hash FROM cr_proposals
		WHERE available_amount = '0' AND budgets_json != '[]' AND budgets_json != ''
		LIMIT 20`)
	if err != nil {
		return
	}
	defer rows.Close()

	var hashes []string
	for rows.Next() {
		var h string
		if err := rows.Scan(&h); err == nil {
			hashes = append(hashes, h)
		}
	}
	if len(hashes) == 0 {
		return
	}

	synced := 0
	for _, h := range hashes {
		if ctx.Err() != nil {
			break
		}
		stateResp, err := a.node.GetCRProposalState(ctx, h)
		if err != nil {
			continue
		}
		ps := stateResp.ProposalState

		availAmount := ps.AvailableAmount
		if availAmount == "" {
			availAmount = "0"
		}

		// Extract budget items with their status from the proposal sub-object
		var proposalData struct {
			Budgets json.RawMessage `json:"budgets"`
		}
		if ps.Proposal != nil {
			_ = json.Unmarshal(ps.Proposal, &proposalData)
		}

		budgetsJSON := ""
		if proposalData.Budgets != nil && len(proposalData.Budgets) > 2 {
			budgetsJSON = string(proposalData.Budgets)
		}

		if budgetsJSON != "" {
			if _, err := a.db.Syncer.Exec(ctx, `
				UPDATE cr_proposals SET available_amount = $2, budgets_json = $3
				WHERE proposal_hash = $1`,
				h, availAmount, budgetsJSON,
			); err != nil {
				slog.Warn("syncProposalDetailedState: update failed", "hash", safeTruncate(h, 16), "error", err)
				continue
			}
		} else {
			if _, err := a.db.Syncer.Exec(ctx, `
				UPDATE cr_proposals SET available_amount = $2
				WHERE proposal_hash = $1`,
				h, availAmount,
			); err != nil {
				slog.Warn("syncProposalDetailedState: update failed", "hash", safeTruncate(h, 16), "error", err)
				continue
			}
		}
		synced++
	}

	if synced > 0 {
		slog.Debug("syncProposalDetailedState: updated", "count", synced)
	}
}

const maxDraftSyncAttempts = 20

// refreshProposalDraftData fetches the full proposal content (title, abstract,
// motivation, goal, plan, team, milestones) from the ELA node's
// getproposaldraftdata RPC. The data is a hex-encoded ZIP containing
// proposal.json. For proposals predating v0.7.0 (no draft data on-chain),
// it falls back to the CyberRepublic API.
func (a *Aggregator) refreshProposalDraftData(ctx context.Context) error {
	rows, err := a.db.Syncer.Query(ctx, `
		SELECT proposal_hash, draft_hash, register_height, draft_sync_attempts
		FROM cr_proposals
		WHERE draft_data_synced = FALSE AND draft_hash != ''
		  AND draft_sync_attempts < $1
		LIMIT 50`, maxDraftSyncAttempts)
	if err != nil {
		return fmt.Errorf("query unsynced proposals: %w", err)
	}
	defer rows.Close()

	type pending struct {
		hash, draftHash string
		height          int64
		attempts        int
	}
	var items []pending
	for rows.Next() {
		var p pending
		if err := rows.Scan(&p.hash, &p.draftHash, &p.height, &p.attempts); err != nil {
			continue
		}
		items = append(items, p)
	}
	if len(items) == 0 {
		a.backfillFromCyberRepublic(ctx)
		return nil
	}

	synced := 0
	for _, p := range items {
		if ctx.Err() != nil {
			break
		}

		hexData, err := a.node.GetProposalDraftData(ctx, p.draftHash)
		if err != nil || hexData == "" {
			a.recordDraftSyncFailure(ctx, p.hash, p.attempts+1, err)
			continue
		}

		draft, parseErr := proposal.ParseDraftZIP(hexData)
		if parseErr != nil {
			slog.Warn("refreshProposalDraftData: parse failed", "hash", safeTruncate(p.hash, 16), "error", parseErr)
			a.recordDraftSyncFailure(ctx, p.hash, p.attempts+1, parseErr)
			continue
		}

		teamJSON := proposal.TeamJSON(draft.ImplementationTeam)
		milestoneStr := proposal.MilestoneJSON(draft.Milestone)
		relevanceStr := proposal.ResolveRelevance(draft.Relevance)

		if _, err := a.db.Syncer.Exec(ctx, `
			UPDATE cr_proposals SET
				title = $2, abstract = $3, motivation = $4, goal = $5,
				plan_statement = $6, implementation_team = $7,
				budget_statement = $8, milestone = $9, relevance = $10,
				draft_data_synced = TRUE, draft_sync_attempts = draft_sync_attempts + 1
			WHERE proposal_hash = $1`,
			p.hash, draft.Title, draft.Abstract, draft.Motivation, draft.Goal,
			draft.PlanStatement, teamJSON,
			draft.BudgetStatement, milestoneStr, relevanceStr,
		); err != nil {
			slog.Warn("refreshProposalDraftData: update failed", "hash", safeTruncate(p.hash, 16), "error", err)
			continue
		}
		synced++
	}

	if synced > 0 {
		slog.Info("refreshProposalDraftData: synced draft content", "count", synced)
	}
	return nil
}

// recordDraftSyncFailure increments the attempt counter for a proposal whose
// draft data could not be fetched. After maxDraftSyncAttempts, marks the
// proposal as synced so old/pre-v0.7.0 proposals stop retrying.
func (a *Aggregator) recordDraftSyncFailure(ctx context.Context, hash string, newAttempts int, cause error) {
	if newAttempts >= maxDraftSyncAttempts {
		slog.Warn("refreshProposalDraftData: giving up after max retries",
			"hash", safeTruncate(hash, 16), "attempts", newAttempts, "lastError", cause)
		if _, err := a.db.Syncer.Exec(ctx,
			"UPDATE cr_proposals SET draft_data_synced = TRUE, draft_sync_attempts = $2 WHERE proposal_hash = $1",
			hash, newAttempts); err != nil {
			slog.Warn("refreshProposalDraftData: mark synced failed", "hash", safeTruncate(hash, 16), "error", err)
		}
		return
	}

	if _, err := a.db.Syncer.Exec(ctx,
		"UPDATE cr_proposals SET draft_sync_attempts = $2 WHERE proposal_hash = $1",
		hash, newAttempts); err != nil {
		slog.Warn("refreshProposalDraftData: increment attempts failed", "hash", safeTruncate(hash, 16), "error", err)
	}
}


// backfillFromCyberRepublic fetches titles for proposals that have no
// on-chain draft data (pre-v0.7.0) from the CyberRepublic public API.
func (a *Aggregator) backfillFromCyberRepublic(ctx context.Context) {
	var count int64
	if err := a.db.Syncer.QueryRow(ctx,
		"SELECT COUNT(*) FROM cr_proposals WHERE draft_data_synced = TRUE AND title = ''",
	).Scan(&count); err != nil || count == 0 {
		return
	}

	rows, err := a.db.Syncer.Query(ctx,
		"SELECT proposal_hash, register_height FROM cr_proposals WHERE draft_data_synced = TRUE AND title = ''")
	if err != nil {
		return
	}
	defer rows.Close()

	type missing struct {
		hash   string
		height int64
	}
	var items []missing
	heightIndex := make(map[int64]string)
	for rows.Next() {
		var m missing
		if err := rows.Scan(&m.hash, &m.height); err != nil {
			continue
		}
		items = append(items, m)
		heightIndex[m.height] = m.hash
	}
	if len(items) == 0 {
		return
	}

	slog.Info("backfillFromCyberRepublic: fetching titles for proposals without draft data", "count", len(items))

	client := &http.Client{Timeout: 30 * time.Second}
	req, err := http.NewRequestWithContext(ctx, "GET",
		"https://api.cyberrepublic.org/api/cvote/list_public?page=1&results=300", nil)
	if err != nil {
		slog.Warn("backfillFromCyberRepublic: create request failed", "error", err)
		return
	}
	resp, err := client.Do(req)
	if err != nil {
		slog.Warn("backfillFromCyberRepublic: request failed", "error", err)
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		slog.Warn("backfillFromCyberRepublic: read body failed", "error", err)
		return
	}

	var crResp struct {
		Data struct {
			List []struct {
				VID            int    `json:"vid"`
				Title          string `json:"title"`
				RegisterHeight int64  `json:"registerHeight"`
			} `json:"list"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &crResp); err != nil {
		slog.Warn("backfillFromCyberRepublic: parse failed", "error", err)
		return
	}

	matched := 0
	for _, p := range crResp.Data.List {
		hash, ok := heightIndex[p.RegisterHeight]
		if !ok || p.Title == "" {
			continue
		}
		if _, err := a.db.Syncer.Exec(ctx,
			"UPDATE cr_proposals SET title = $2 WHERE proposal_hash = $1 AND title = ''",
			hash, p.Title,
		); err != nil {
			slog.Warn("backfillFromCyberRepublic: update failed", "hash", safeTruncate(hash, 16), "error", err)
			continue
		}
		matched++
	}

	if matched > 0 {
		slog.Info("backfillFromCyberRepublic: filled titles", "matched", matched, "total_missing", len(items))
	}
}

func joinStrings(s []string, sep string) string {
	if len(s) == 0 {
		return ""
	}
	result := s[0]
	for i := 1; i < len(s); i++ {
		result += sep + s[i]
	}
	return result
}

func (a *Aggregator) refreshDailyStats(ctx context.Context) error {
	today := time.Now().UTC().Format("2006-01-02")
	todayStart := time.Now().UTC().Truncate(24 * time.Hour).Unix()
	todayEnd := todayStart + 86400

	pgxTx, err := a.db.Syncer.Begin(ctx)
	if err != nil {
		return fmt.Errorf("daily stats: begin tx: %w", err)
	}
	defer pgxTx.Rollback(ctx)

	var txCount int64
	if err := pgxTx.QueryRow(ctx,
		"SELECT COUNT(*) FROM transactions WHERE timestamp >= $1 AND timestamp < $2",
		todayStart, todayEnd,
	).Scan(&txCount); err != nil {
		return fmt.Errorf("daily stats txCount query: %w", err)
	}

	var totalVolume, totalFees int64
	if err := pgxTx.QueryRow(ctx,
		"SELECT COALESCE(SUM(total_value_sela), 0), COALESCE(SUM(total_fees_sela), 0) FROM blocks WHERE timestamp >= $1 AND timestamp < $2",
		todayStart, todayEnd,
	).Scan(&totalVolume, &totalFees); err != nil {
		return fmt.Errorf("daily stats volume/fees query: %w", err)
	}

	var activeAddresses int64
	if err := pgxTx.QueryRow(ctx, `
		SELECT COUNT(DISTINCT address) FROM (
			SELECT address FROM tx_vouts WHERE txid IN (SELECT txid FROM transactions WHERE timestamp >= $1 AND timestamp < $2)
			UNION
			SELECT address FROM tx_vins WHERE txid IN (SELECT txid FROM transactions WHERE timestamp >= $1 AND timestamp < $2)
		) combined WHERE address != ''`,
		todayStart, todayEnd,
	).Scan(&activeAddresses); err != nil {
		return fmt.Errorf("daily stats activeAddresses query: %w", err)
	}

	var blockCount int64
	if err := pgxTx.QueryRow(ctx,
		"SELECT COUNT(*) FROM blocks WHERE timestamp >= $1 AND timestamp < $2",
		todayStart, todayEnd,
	).Scan(&blockCount); err != nil {
		return fmt.Errorf("daily stats blockCount query: %w", err)
	}

	var avgBlockSize int64
	if blockCount > 0 {
		if err := pgxTx.QueryRow(ctx,
			"SELECT COALESCE(AVG(size), 0)::BIGINT FROM blocks WHERE timestamp >= $1 AND timestamp < $2",
			todayStart, todayEnd,
		).Scan(&avgBlockSize); err != nil {
			return fmt.Errorf("daily stats avgBlockSize query: %w", err)
		}
	}

	var avgBlockTime float64
	if blockCount > 1 {
		if err := pgxTx.QueryRow(ctx,
			`SELECT (MAX(timestamp) - MIN(timestamp))::REAL / NULLIF(COUNT(*) - 1, 0)
			 FROM blocks WHERE timestamp >= $1 AND timestamp < $2`,
			todayStart, todayEnd,
		).Scan(&avgBlockTime); err != nil {
			return fmt.Errorf("daily stats avgBlockTime query: %w", err)
		}
	}

	_, err = pgxTx.Exec(ctx, `
		INSERT INTO daily_stats (date, block_count, tx_count, total_volume_sela, total_fees_sela, active_addresses, avg_block_size, avg_block_time)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (date) DO UPDATE SET
			block_count=$2, tx_count=$3, total_volume_sela=$4,
			total_fees_sela=$5, active_addresses=$6, avg_block_size=$7, avg_block_time=$8`,
		today, blockCount, txCount, totalVolume, totalFees, activeAddresses, avgBlockSize, avgBlockTime,
	)
	if err != nil {
		return fmt.Errorf("upsert daily stats: %w", err)
	}

	if err := pgxTx.Commit(ctx); err != nil {
		return fmt.Errorf("daily stats: commit: %w", err)
	}

	slog.Debug("refreshed daily stats", "date", today, "txs", txCount)
	return nil
}

func (a *Aggregator) refreshChainStats(ctx context.Context) error {
	var totalBlocks, totalTxs, totalAddresses int64
	if err := a.db.Syncer.QueryRow(ctx, "SELECT COALESCE(MAX(height)+1, 0) FROM blocks").Scan(&totalBlocks); err != nil {
		return fmt.Errorf("chain stats: total blocks: %w", err)
	}
	if err := a.db.Syncer.QueryRow(ctx, "SELECT COUNT(*) FROM transactions").Scan(&totalTxs); err != nil {
		return fmt.Errorf("chain stats: total txs: %w", err)
	}
	if err := a.db.Syncer.QueryRow(ctx, `
		SELECT COUNT(*) FROM address_balances
		WHERE balance_sela > 0 AND address NOT LIKE 'S%'`).Scan(&totalAddresses); err != nil {
		return fmt.Errorf("chain stats: total addresses: %w", err)
	}

	var totalSupply int64
	if err := a.db.Syncer.QueryRow(ctx, `
		SELECT COALESCE(SUM(balance_sela), 0) FROM address_balances
		WHERE balance_sela > 0
		  AND address NOT IN (
			'ELANULLXXXXXXXXXXXXXXXXXXXXXYvs3rr',
			'CRASSETSXXXXXXXXXXXXXXXXXXXX2qDX5J'
		  )
	`).Scan(&totalSupply); err != nil {
		return fmt.Errorf("chain stats: total supply: %w", err)
	}

	var circulatingSupply int64
	if err := a.db.Syncer.QueryRow(ctx, `
		SELECT COALESCE(SUM(balance_sela), 0) FROM address_balances
		WHERE balance_sela > 0
		  AND address NOT LIKE 'S%'
		  AND address NOT IN (
			'ELANULLXXXXXXXXXXXXXXXXXXXXXYvs3rr',
			'CRASSETSXXXXXXXXXXXXXXXXXXXX2qDX5J',
			'STAKEPooLXXXXXXXXXXXXXXXXXXXpP1PQ2',
			'STAKEREWARDXXXXXXXXXXXXXXXXXFD5SHU'
		  )`).Scan(&circulatingSupply); err != nil {
		return fmt.Errorf("chain stats: circulating supply: %w", err)
	}

	// BPoS staking rights total from node RPC (source of truth).
	// The node's totaldposv2votes is the authoritative logarithmically-weighted sum.
	var totalVoteSela int64
	if prodResp, err := a.node.ListProducers(ctx, 0, 1, "all"); err != nil {
		slog.Warn("chain stats: listproducers RPC failed, using cached value", "error", err)
	} else {
		totalVoteSela = parseELAToSela(prodResp.TotalDPoSV2Votes)
	}

	// Count distinct stakers from bpos_stakes (populated by refreshBPoSStakes)
	var totalVoters int64
	if err := a.db.Syncer.QueryRow(ctx, "SELECT COUNT(DISTINCT stake_address) FROM bpos_stakes").Scan(&totalVoters); err != nil {
		slog.Debug("chain stats: bpos_stakes count (table may not exist yet)", "error", err)
	}

	var latestHeight int64
	if err := a.db.Syncer.QueryRow(ctx, "SELECT COALESCE(MAX(height), 0) FROM blocks").Scan(&latestHeight); err != nil {
		return fmt.Errorf("chain stats: latest height: %w", err)
	}

	consensusMode := "POW"
	currentEra := "auxpow"
	if latestHeight >= HeightPublicDPOS {
		consensusMode = "DPOS"
		currentEra = "dposv1"
	}
	if latestHeight >= HeightDPoSV2Start {
		consensusMode = "BPOS"
		currentEra = "bpos"
	}

	_, err := a.db.Syncer.Exec(ctx, `
		UPDATE chain_stats SET
			total_blocks=$1, total_txs=$2, total_addresses=$3,
			circ_supply_sela=$4, total_vote_sela=$5, total_voters=$6,
			consensus_mode=$7, current_era=$8, total_supply_sela=$9,
			last_updated=EXTRACT(EPOCH FROM NOW())::BIGINT
		WHERE id=1`,
		totalBlocks, totalTxs, totalAddresses, circulatingSupply,
		totalVoteSela, totalVoters, consensusMode, currentEra, totalSupply,
	)
	if err != nil {
		return fmt.Errorf("update chain stats: %w", err)
	}

	if a.hub != nil {
		a.hub.BroadcastStats(map[string]any{
			"totalBlocks": totalBlocks, "totalTransactions": totalTxs,
			"totalAddresses": totalAddresses, "consensusMode": consensusMode,
		})
	}

	return nil
}

// refreshBPoSStakes fetches all active BPoS stake details from the node RPC
// and upserts them into the bpos_stakes table. Stakes no longer returned by the
// node (withdrawn) are deleted. This is the authoritative per-staker data source.
func (a *Aggregator) refreshBPoSStakes(ctx context.Context) error {
	if _, err := a.db.Syncer.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS bpos_stakes (
			refer_key         TEXT PRIMARY KEY,
			stake_address     TEXT NOT NULL,
			producer_key      TEXT NOT NULL,
			transaction_hash  TEXT NOT NULL,
			block_height      BIGINT NOT NULL,
			raw_amount_sela   BIGINT NOT NULL,
			lock_time         BIGINT NOT NULL,
			vote_rights_sela  BIGINT NOT NULL,
			last_updated      BIGINT NOT NULL DEFAULT 0
		)`); err != nil {
		return fmt.Errorf("ensure bpos_stakes table: %w", err)
	}
	if _, err := a.db.Syncer.Exec(ctx, "CREATE INDEX IF NOT EXISTS idx_bpos_stakes_producer ON bpos_stakes(producer_key)"); err != nil {
		slog.Debug("bpos_stakes: producer index", "error", err)
	}
	if _, err := a.db.Syncer.Exec(ctx, "CREATE INDEX IF NOT EXISTS idx_bpos_stakes_address ON bpos_stakes(stake_address)"); err != nil {
		slog.Debug("bpos_stakes: address index", "error", err)
	}

	votes, err := a.node.GetAllDetailedDPoSV2Votes(ctx, 0, 100000)
	if err != nil {
		return fmt.Errorf("getalldetaileddposv2votes: %w", err)
	}

	now := time.Now().Unix()
	activeKeys := make([]string, 0, len(votes))

	for _, v := range votes {
		rawAmountSela := parseELAToSela(v.Info.Votes)
		voteRightsSela := parseELAToSela(v.DPoSV2VoteRights)
		activeKeys = append(activeKeys, v.ReferKey)

		if _, err := a.db.Syncer.Exec(ctx, `
			INSERT INTO bpos_stakes (refer_key, stake_address, producer_key, transaction_hash,
				block_height, raw_amount_sela, lock_time, vote_rights_sela, last_updated)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			ON CONFLICT (refer_key) DO UPDATE SET
				stake_address=$2, producer_key=$3, transaction_hash=$4, block_height=$5,
				raw_amount_sela=$6, lock_time=$7, vote_rights_sela=$8, last_updated=$9`,
			v.ReferKey, v.StakeAddress, v.ProducerOwnerKey, v.TransactionHash,
			int64(v.BlockHeight), rawAmountSela, int64(v.Info.LockTime), voteRightsSela, now,
		); err != nil {
			slog.Warn("upsert bpos_stake failed", "referKey", safeTruncate(v.ReferKey, 16), "error", err)
		}
	}

	if len(activeKeys) > 0 {
		if _, err := a.db.Syncer.Exec(ctx,
			"DELETE FROM bpos_stakes WHERE refer_key != ALL($1)", activeKeys); err != nil {
			slog.Warn("refreshBPoSStakes: cleanup stale stakes failed", "error", err)
		}
	} else {
		if _, err := a.db.Syncer.Exec(ctx, "DELETE FROM bpos_stakes"); err != nil {
			slog.Warn("refreshBPoSStakes: cleanup all stakes failed", "error", err)
		}
	}

	slog.Debug("refreshed BPoS stakes", "count", len(votes))
	return nil
}

// refreshBPoSRewards fetches all BPoS staking reward info from the node RPC
// and caches it in bpos_rewards. Tracks claimable, claiming, and claimed ELA.
func (a *Aggregator) refreshBPoSRewards(ctx context.Context) error {
	if _, err := a.db.Syncer.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS bpos_rewards (
			stake_address     TEXT PRIMARY KEY,
			claimable_sela    BIGINT NOT NULL DEFAULT 0,
			claiming_sela     BIGINT NOT NULL DEFAULT 0,
			claimed_sela      BIGINT NOT NULL DEFAULT 0,
			last_updated      BIGINT NOT NULL DEFAULT 0
		)`); err != nil {
		return fmt.Errorf("ensure bpos_rewards table: %w", err)
	}

	rewards, err := a.node.GetAllDPoSV2RewardInfo(ctx)
	if err != nil {
		return fmt.Errorf("dposv2rewardinfo: %w", err)
	}

	now := time.Now().Unix()
	activeAddrs := make([]string, 0, len(rewards))

	for _, r := range rewards {
		claimableSela := parseELAToSela(r.Claimable)
		claimingSela := parseELAToSela(r.Claiming)
		claimedSela := parseELAToSela(r.Claimed)
		activeAddrs = append(activeAddrs, r.Address)

		if _, err := a.db.Syncer.Exec(ctx, `
			INSERT INTO bpos_rewards (stake_address, claimable_sela, claiming_sela, claimed_sela, last_updated)
			VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (stake_address) DO UPDATE SET
				claimable_sela=$2, claiming_sela=$3, claimed_sela=$4, last_updated=$5`,
			r.Address, claimableSela, claimingSela, claimedSela, now,
		); err != nil {
			slog.Warn("upsert bpos_reward failed", "address", safeTruncate(r.Address, 16), "error", err)
		}
	}

	if len(activeAddrs) > 0 {
		if _, err := a.db.Syncer.Exec(ctx,
			"DELETE FROM bpos_rewards WHERE stake_address != ALL($1)", activeAddrs); err != nil {
			slog.Warn("refreshBPoSRewards: cleanup stale rewards failed", "error", err)
		}
	}

	slog.Debug("refreshed BPoS rewards", "count", len(rewards))
	return nil
}

// isValidStakeAddress performs a cheap pre-RPC sanity check: stake addresses
// start with 'S' and are base58 (no '0', 'O', 'I', 'l'). This filters out
// obviously malformed rows before they reach the node.
func isValidStakeAddress(s string) bool {
	if len(s) < 10 || len(s) > 48 || s[0] != 'S' {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		ok := (c >= '1' && c <= '9') ||
			(c >= 'A' && c <= 'H') || (c >= 'J' && c <= 'N') || (c >= 'P' && c <= 'Z') ||
			(c >= 'a' && c <= 'k') || (c >= 'm' && c <= 'z')
		if !ok {
			return false
		}
	}
	return true
}

// refreshVoterRights enumerates every stake address we've seen pledge to a
// BPoS validator and calls `getvoterights` to snapshot each address's
// total/pledged/idle ELA. The aggregate pool-wide idle stake is already shown
// chain-wide; this loop persists the per-address breakdown that makes it
// possible to render "Pledged / Idle" for an individual staker.
func (a *Aggregator) refreshVoterRights(ctx context.Context) error {
	if !a.stakeIdleEnabled {
		return nil
	}

	if _, err := a.db.Syncer.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS voter_rights (
			stake_address     TEXT PRIMARY KEY,
			total_sela        BIGINT NOT NULL DEFAULT 0,
			pledged_sela      BIGINT NOT NULL DEFAULT 0,
			idle_sela         BIGINT NOT NULL DEFAULT 0,
			last_updated      BIGINT NOT NULL DEFAULT 0
		)`); err != nil {
		return fmt.Errorf("ensure voter_rights table: %w", err)
	}
	if _, err := a.db.Syncer.Exec(ctx,
		"CREATE INDEX IF NOT EXISTS idx_voter_rights_updated ON voter_rights(last_updated)"); err != nil {
		slog.Debug("voter_rights: updated index", "error", err)
	}

	rows, err := a.db.Syncer.Query(ctx, `SELECT DISTINCT stake_address FROM bpos_stakes`)
	if err != nil {
		return fmt.Errorf("select stake addresses: %w", err)
	}
	defer rows.Close()

	var valid []string
	skipped := 0
	for rows.Next() {
		var addr string
		if err := rows.Scan(&addr); err != nil {
			continue
		}
		if !isValidStakeAddress(addr) {
			skipped++
			continue
		}
		valid = append(valid, addr)
	}
	if len(valid) == 0 {
		slog.Debug("refreshVoterRights: no stake addresses to refresh")
		return nil
	}

	started := time.Now()
	results, rpcErr := a.node.GetVoteRights(ctx, valid)
	if rpcErr != nil && len(results) == 0 {
		return fmt.Errorf("getvoterights: %w", rpcErr)
	}

	now := time.Now().Unix()
	processed := 0
	errs := 0
	idleMissingWarned := false

	for _, addr := range valid {
		info := results[addr]
		if info == nil {
			continue
		}
		totalSela := parseELAToSela(info.TotalVotesRight)
		var pledgedSela int64
		for _, entry := range info.UsedVotesInfo.UsedDPoSV2Votes {
			for _, v := range entry.Info {
				pledgedSela += parseELAToSela(v.Votes)
			}
		}
		var idleSela int64
		if len(info.RemainVoteRight) >= 5 {
			idleSela = parseELAToSela(info.RemainVoteRight[4])
		} else if !idleMissingWarned {
			idleMissingWarned = true
			slog.Warn("refreshVoterRights: remainvoteright has fewer than 5 entries",
				"address", safeTruncate(addr, 16), "len", len(info.RemainVoteRight))
		}
		if pledgedSela > totalSela && totalSela > 0 {
			slog.Warn("refreshVoterRights: pledged exceeds total",
				"address", safeTruncate(addr, 16), "pledged", pledgedSela, "total", totalSela)
		}
		if _, err := a.db.Syncer.Exec(ctx, `
			INSERT INTO voter_rights (stake_address, total_sela, pledged_sela, idle_sela, last_updated)
			VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (stake_address) DO UPDATE SET
				total_sela=$2, pledged_sela=$3, idle_sela=$4, last_updated=$5`,
			addr, totalSela, pledgedSela, idleSela, now,
		); err != nil {
			errs++
			slog.Warn("upsert voter_rights failed", "address", safeTruncate(addr, 16), "error", err)
			continue
		}
		processed++
	}

	// Only run stale cleanup when at least one chunk succeeded (results map has
	// entries); otherwise a full RPC outage would nuke our table.
	if len(results) > 0 {
		cutoff := now - 300
		if _, err := a.db.Syncer.Exec(ctx,
			"DELETE FROM voter_rights WHERE last_updated < $1", cutoff); err != nil {
			slog.Warn("refreshVoterRights: stale cleanup failed", "error", err)
		}
	}

	slog.Info("refreshed voter_rights",
		"processed", processed,
		"skipped", skipped,
		"errors", errs,
		"duration_ms", time.Since(started).Milliseconds())
	return nil
}

// backfillDailyStats populates historical daily_stats rows for all calendar days
// with indexed blocks. Uses a single bulk-aggregate query instead of per-day
// queries to avoid N+1 performance issues.
func (a *Aggregator) backfillDailyStats(ctx context.Context) {
	var existingRows int64
	if err := a.db.Syncer.QueryRow(ctx, "SELECT COUNT(*) FROM daily_stats").Scan(&existingRows); err != nil {
		slog.Warn("backfillDailyStats: count failed", "error", err)
		return
	}

	var minTS, maxTS int64
	if err := a.db.Syncer.QueryRow(ctx,
		"SELECT COALESCE(MIN(timestamp),0), COALESCE(MAX(timestamp),0) FROM blocks").Scan(&minTS, &maxTS); err != nil || minTS == 0 {
		slog.Info("backfillDailyStats: no blocks to backfill")
		return
	}

	startDay := time.Unix(minTS, 0).UTC().Truncate(24 * time.Hour)
	endDay := time.Unix(maxTS, 0).UTC().Truncate(24 * time.Hour)
	totalDays := int(endDay.Sub(startDay).Hours()/24) + 1

	if int64(totalDays)-existingRows < 2 {
		slog.Info("backfillDailyStats: already up-to-date", "rows", existingRows, "totalDays", totalDays)
		a.dailyStatsDone.Store(true)
		return
	}

	slog.Info("backfillDailyStats: starting bulk aggregate", "from", startDay.Format("2006-01-02"), "to", endDay.Format("2006-01-02"), "existing", existingRows)
	start := time.Now()

	tag, err := a.db.Syncer.Exec(ctx, `
		INSERT INTO daily_stats (date, block_count, tx_count, total_volume_sela, total_fees_sela, active_addresses, avg_block_size, avg_block_time)
		SELECT
			d.date,
			COALESCE(b.block_count, 0),
			COALESCE(b.tx_count, 0),
			COALESCE(b.total_volume, 0),
			COALESCE(b.total_fees, 0),
			0,
			COALESCE(b.avg_size, 0),
			COALESCE(b.avg_time, 0)
		FROM generate_series($1::date, $2::date, '1 day'::interval) AS d(date)
		JOIN LATERAL (
			SELECT
				COUNT(*) AS block_count,
				COALESCE(SUM(tx_count), 0) AS tx_count,
				COALESCE(SUM(total_value_sela), 0) AS total_volume,
				COALESCE(SUM(total_fees_sela), 0) AS total_fees,
				COALESCE(AVG(size), 0)::BIGINT AS avg_size,
				CASE WHEN COUNT(*) > 1
					THEN (MAX(timestamp) - MIN(timestamp))::REAL / NULLIF(COUNT(*) - 1, 0)
					ELSE 0
				END AS avg_time
			FROM blocks
			WHERE timestamp >= EXTRACT(EPOCH FROM d.date)::BIGINT
			  AND timestamp < EXTRACT(EPOCH FROM d.date + '1 day'::interval)::BIGINT
		) b ON b.block_count > 0
		ON CONFLICT (date) DO NOTHING`,
		startDay.Format("2006-01-02"), endDay.Format("2006-01-02"),
	)
	if err != nil {
		slog.Warn("backfillDailyStats: bulk insert failed, falling back to per-day", "error", err)
		a.backfillDailyStatsFallback(ctx, startDay, endDay)
		return
	}

	filled := tag.RowsAffected()
	slog.Info("backfillDailyStats: complete", "filled", filled, "elapsed", time.Since(start).Round(time.Second))
	a.dailyStatsDone.Store(true)
}

// backfillDailyStatsFallback is the original per-day loop, used only if the
// bulk aggregate fails (e.g. generate_series not available on older PG).
func (a *Aggregator) backfillDailyStatsFallback(ctx context.Context, startDay, endDay time.Time) {
	start := time.Now()
	filled := 0

	for d := startDay; !d.After(endDay); d = d.AddDate(0, 0, 1) {
		if ctx.Err() != nil {
			return
		}
		dayStr := d.Format("2006-01-02")
		dayStart := d.Unix()
		dayEnd := dayStart + 86400

		var exists bool
		if err := a.db.Syncer.QueryRow(ctx,
			"SELECT EXISTS(SELECT 1 FROM daily_stats WHERE date=$1)", dayStr).Scan(&exists); err == nil && exists {
			continue
		}

		var blockCount, txCount, totalVolume, totalFees int64
		var avgBlockSize int64
		var avgBlockTime float64

		_ = a.db.Syncer.QueryRow(ctx,
			"SELECT COUNT(*) FROM blocks WHERE timestamp >= $1 AND timestamp < $2", dayStart, dayEnd).Scan(&blockCount)
		if blockCount == 0 {
			continue
		}

		_ = a.db.Syncer.QueryRow(ctx,
			"SELECT COUNT(*) FROM transactions WHERE timestamp >= $1 AND timestamp < $2", dayStart, dayEnd).Scan(&txCount)
		_ = a.db.Syncer.QueryRow(ctx,
			"SELECT COALESCE(SUM(total_value_sela),0), COALESCE(SUM(total_fees_sela),0) FROM blocks WHERE timestamp >= $1 AND timestamp < $2",
			dayStart, dayEnd).Scan(&totalVolume, &totalFees)
		_ = a.db.Syncer.QueryRow(ctx,
			"SELECT COALESCE(AVG(size),0)::BIGINT FROM blocks WHERE timestamp >= $1 AND timestamp < $2",
			dayStart, dayEnd).Scan(&avgBlockSize)
		if blockCount > 1 {
			_ = a.db.Syncer.QueryRow(ctx,
				`SELECT (MAX(timestamp)-MIN(timestamp))::REAL / NULLIF(COUNT(*)-1, 0)
				 FROM blocks WHERE timestamp >= $1 AND timestamp < $2`,
				dayStart, dayEnd).Scan(&avgBlockTime)
		}

		if _, err := a.db.Syncer.Exec(ctx, `
			INSERT INTO daily_stats (date, block_count, tx_count, total_volume_sela, total_fees_sela, active_addresses, avg_block_size, avg_block_time)
			VALUES ($1, $2, $3, $4, $5, 0, $6, $7)
			ON CONFLICT (date) DO NOTHING`,
			dayStr, blockCount, txCount, totalVolume, totalFees, avgBlockSize, avgBlockTime,
		); err != nil {
			continue
		}
		filled++
		if filled%100 == 0 {
			slog.Info("backfillDailyStats fallback: progress", "filled", filled, "current", dayStr)
		}
	}

	slog.Info("backfillDailyStats fallback: complete", "filled", filled, "elapsed", time.Since(start).Round(time.Second))
	a.dailyStatsDone.Store(true)
}

// tryParseELAToSela converts an ELA string like "1.50000000" to sela (int64)
// using pure integer arithmetic to avoid IEEE 754 float precision loss.
// Returns an error on malformed or overflowing input.
func tryParseELAToSela(elaStr string) (int64, error) {
	if elaStr == "" || elaStr == "0" {
		return 0, nil
	}

	negative := false
	s := elaStr
	if s[0] == '-' {
		negative = true
		s = s[1:]
	}

	intPart := s
	fracPart := ""
	for i := 0; i < len(s); i++ {
		if s[i] == '.' {
			intPart = s[:i]
			fracPart = s[i+1:]
			break
		}
	}

	const decimals = 8
	if len(fracPart) > decimals {
		fracPart = fracPart[:decimals]
	}
	for len(fracPart) < decimals {
		fracPart += "0"
	}

	whole, err := strconv.ParseInt(intPart, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parseELAToSela: malformed integer part %q: %w", elaStr, err)
	}
	frac, err := strconv.ParseInt(fracPart, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parseELAToSela: malformed fractional part %q: %w", elaStr, err)
	}

	const selaPerELA int64 = 1e8
	const maxWhole = (1<<63 - 1) / selaPerELA
	if whole > maxWhole {
		return 0, fmt.Errorf("parseELAToSela: value %q would overflow int64", elaStr)
	}
	result := whole*selaPerELA + frac
	if negative {
		return -result, nil
	}
	return result, nil
}

// parseELAToSela is a convenience wrapper that logs errors and returns 0.
// Use tryParseELAToSela when the error needs to be propagated.
func parseELAToSela(elaStr string) int64 {
	v, err := tryParseELAToSela(elaStr)
	if err != nil {
		slog.Error("parseELAToSela failed", "input", elaStr, "error", err)
		return 0
	}
	return v
}

func safeTruncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}

// backfillReviewComments fetches opinion content for reviews that have an
// empty opinion_message. The opinion data is a ZIP file (containing
// opinion.json with a "content" field) fetched via getproposaldraftdata
// using the review's opinionhash. Processes in batches of 50 per cycle.
func (a *Aggregator) backfillReviewComments(ctx context.Context) error {
	rows, err := a.db.Syncer.Query(ctx, `
		SELECT did, proposal_hash, opinion_hash FROM cr_proposal_reviews
		WHERE opinion_message = '' AND opinion_hash != ''
		LIMIT 50`)
	if err != nil {
		return fmt.Errorf("query reviews without comments: %w", err)
	}
	defer rows.Close()

	type review struct {
		did          string
		proposalHash string
		opinionHash  string
	}
	var pending []review
	for rows.Next() {
		var r review
		if err := rows.Scan(&r.did, &r.proposalHash, &r.opinionHash); err != nil {
			continue
		}
		pending = append(pending, r)
	}

	if len(pending) == 0 {
		return nil
	}

	slog.Info("backfillReviewComments: processing", "count", len(pending))
	updated := 0
	for _, r := range pending {
		msg := a.fetchOpinionContent(ctx, r.opinionHash)
		if msg == "" {
			msg = " "
		}

		if _, err := a.db.Syncer.Exec(ctx, `
			UPDATE cr_proposal_reviews SET opinion_message = $1
			WHERE did = $2 AND proposal_hash = $3`, msg, r.did, r.proposalHash); err != nil {
			slog.Warn("backfillReviewComments: update failed", "opinionHash", safeTruncate(r.opinionHash, 16), "error", err)
			continue
		}
		if msg != " " {
			updated++
		}
	}

	slog.Info("backfillReviewComments: done", "processed", len(pending), "withComments", updated)
	return nil
}

// fetchOpinionContent retrieves the opinion text from a ZIP file stored
// on-chain, referenced by the opinion hash. Returns empty string on failure.
func (a *Aggregator) fetchOpinionContent(ctx context.Context, opinionHash string) string {
	if opinionHash == "" {
		return ""
	}

	hexData, err := a.node.GetProposalDraftData(ctx, opinionHash)
	if err != nil || hexData == "" {
		return ""
	}

	draft, err := proposal.ParseDraftZIP(hexData)
	if err == nil && draft.Abstract != "" {
		return draft.Abstract
	}

	raw, err := hex.DecodeString(hexData)
	if err != nil {
		return ""
	}

	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return ""
	}

	for _, f := range zr.File {
		if f.Name != "opinion.json" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return ""
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return ""
		}
		var opinion struct {
			Content string `json:"content"`
		}
		if err := json.Unmarshal(data, &opinion); err != nil {
			return ""
		}
		return opinion.Content
	}

	return ""
}
