package aggregator

// State-machine replay for CR election tallies.
//
// This is the authoritative tally path. It reproduces the algorithm the
// ELA node uses internally — `processVoteCRC` (add) and `processVoteCancel`
// (subtract) applied to a running per-candidate counter, with an
// Active-candidate + non-empty-DID filter at query time. Verified against
// github.com/elastos/Elastos.ELA (`cr/state/state.go:453-466`,
// `cr/state/committee.go:1846-1865`).
//
// Why replay instead of pure SQL: the node's state transitions
// (registration, cancellation, vote UTXO lineage) only make sense in
// chronological transaction order. SQL is set-based; we kept producing
// wrong tallies because no combination of window/spent/active filters
// captures the temporal ordering correctly. Replay does.
//
// Data sources (all from our own DB, no node RPC):
//   - `votes` table for vote creation + consumption events
//     (every row carries stake_height = add, spent_height = sub if set)
//   - `transactions` table for CR state events (types 0x21/0x22/0x23/0x24)
//     in (block_height, tx_index) order
//
// Output shape matches what `cr_election_tallies` rows look like, so the
// aggregator can write replay output to that table without any schema
// churn.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"time"
)

// CR state-change transaction types (chain protocol constants, mirror
// the canonical values in internal/sync/tx_types.go). Duplicated here
// to keep this package dependency-free from the sync package — which
// already imports aggregator indirectly via other paths.
const (
	txTypeRegisterCR         = 0x21
	txTypeUnregisterCR       = 0x22
	txTypeUpdateCR           = 0x23
	txTypeReturnCRDepositCoin = 0x24
)

// ReplayCandidate is one row in a replay tally: a single CR candidate's
// standing at the snapshot height, after the state machine has replayed
// every event up to that height.
type ReplayCandidate struct {
	CID         string
	DID         string
	Nickname    string
	VotesSela   int64 // running counter, in sela
	VoterCount  int   // unique addresses still voting for this cid at snapshot
	Rank        int   // assigned after sort; 1 = highest votes
	Elected     bool  // Rank <= 12
	LastRegHeight int64 // most recent TxRegisterCR for this cid
}

// TallyResult is the full output of a single term's replay.
type TallyResult struct {
	Term           int64
	NarrowStart    int64
	NarrowEnd      int64
	SnapshotHeight int64 // = NarrowEnd; the moment the committee is selected
	Candidates     []ReplayCandidate
	TotalCandidates int
	TotalVotersDistinct int
	ComputedAt     time.Time
}

// event is one state transition in chronological order.
type event struct {
	height     int64
	subOrder   int    // secondary sort: state events before votes within a block
	kind       int    // evKind* constants
	cid        string // candidate (for register/unregister/vote events)
	voter      string // for vote events
	amount     int64  // sela (vote amount)
	did        string // for register events
	nickname   string // for register/update events
	stakeHeight int64 // for vote events: the original vote-creation block
	                  // (for evVoteAdd this equals `height`; for evVoteSub
	                  //  it's the creation height of the UTXO being consumed)
}

const (
	evRegister       = 1 // TxRegisterCR: candidate enters Active state
	evUpdate         = 2 // TxUpdateCR: metadata change
	evUnregister     = 3 // TxUnregisterCR: candidate canceled, votes zeroed
	evReturnDeposit  = 4 // TxReturnCRDepositCoin: candidate returned
	evVoteAdd        = 5 // vote cast — add to candidate.Votes
	evVoteSub        = 6 // vote consumed — subtract from candidate.Votes
)

// candidateState is the in-memory state maintained during replay.
type candidateState struct {
	cid               string
	did               string
	nickname          string
	firstRegHeight    int64
	lastRegHeight     int64
	lastRegisterState int // 0=never, 1=registered, 2=canceled, 3=returned
	votes             int64
	// voter address → refcount. A voter counts for a candidate as long as
	// they have ≥1 unspent vote slice pointing at that candidate. Refcount
	// increments on evVoteAdd, decrements on evVoteSub; at 0 the voter is
	// removed. This mirrors COUNT(DISTINCT address) correctly even when a
	// voter has multiple vote slices for the same candidate across txs.
	voters map[string]int
}

// ReplayTermTally walks all CR-relevant events from block 0 to the
// term's voting-close height and returns the authoritative tally.
//
// The algorithm is deterministic: same DB state → same output. Safe to
// re-run; idempotent. Typical runtime for mainnet is ~5-15s per term.
func (a *Aggregator) ReplayTermTally(ctx context.Context, term int64) (*TallyResult, error) {
	narrowStart, narrowEnd, _ := electionVotingPeriod(term)
	if narrowEnd <= 0 {
		return nil, fmt.Errorf("replay: invalid term %d (narrowEnd=%d)", term, narrowEnd)
	}

	slog.Info("vote replay: starting", "term", term, "narrowStart", narrowStart, "narrowEnd", narrowEnd)
	started := time.Now()

	// Each term's tally is built purely from CRC votes cast within THAT
	// term's voting window [narrowStart, narrowEnd]. No cross-term
	// carry-over. This matches the operator's observed ground truth:
	// every CR election is a fresh race, votes cast in Term N do not
	// count toward Term N+1 even if the candidate runs again. Rebecca
	// Zhu (ran T2-T6, never seated) was the smoking gun — her unspent
	// Term 5 votes were inflating her Term 6 tally until we removed
	// the cross-term carry-over.

	// 1. Load all events in one pass, sort by height + subOrder.
	events, err := a.loadReplayEvents(ctx, narrowEnd)
	if err != nil {
		return nil, fmt.Errorf("replay: load events: %w", err)
	}
	slog.Info("vote replay: events loaded", "term", term, "count", len(events), "elapsed", time.Since(started).Round(time.Millisecond))

	sort.Slice(events, func(i, j int) bool {
		if events[i].height != events[j].height {
			return events[i].height < events[j].height
		}
		return events[i].subOrder < events[j].subOrder
	})

	// 2. Replay each event in order, maintaining candidate state.
	candidates := map[string]*candidateState{}

	getOrCreate := func(cid string) *candidateState {
		c, ok := candidates[cid]
		if !ok {
			c = &candidateState{cid: cid, voters: map[string]int{}}
			candidates[cid] = c
		}
		return c
	}

	for _, ev := range events {
		if ev.height > narrowEnd {
			// Events loader shouldn't give us anything past narrowEnd,
			// but belt-and-suspenders.
			break
		}
		switch ev.kind {
		case evRegister:
			c := getOrCreate(ev.cid)
			if c.firstRegHeight == 0 {
				c.firstRegHeight = ev.height
			}
			// Per Elastos `cr/state/state.go`, when a candidate
			// previously Unregistered or Returned comes back with a new
			// RegisterCR, the node replaces their state machine with a
			// fresh entry at Votes=0. Match that here: reset only when
			// the prior state was Canceled (2) or Returned (3). For a
			// first-time register (state 0) or an in-flight re-register
			// without a prior unregister (state 1, which shouldn't occur
			// on mainnet but does show up in edge cases), keep the
			// running counter untouched.
			//
			// Without this reset, a candidate who unregistered in an
			// earlier term and re-registered in this one would carry
			// ghost votes across the gap — see Rebecca Zhu's inflated
			// Term 6 tally before this fix.
			if c.lastRegisterState == 2 || c.lastRegisterState == 3 {
				c.votes = 0
				c.voters = map[string]int{}
			}
			c.lastRegHeight = ev.height
			c.did = ev.did
			c.nickname = ev.nickname
			c.lastRegisterState = 1

		case evUpdate:
			if c, ok := candidates[ev.cid]; ok {
				if ev.nickname != "" {
					c.nickname = ev.nickname
				}
				// TxUpdateCR can set or change the DID. Early-era CR
				// registrations (Term 1 / pre-DID era) often had empty
				// DID at initial RegisterCR time and acquired one via a
				// later UpdateCR. Our snapshot filter requires non-empty
				// DID, so missing this update meant those candidates
				// were filtered out of the final elected-list even
				// though they eventually held valid DIDs.
				if ev.did != "" {
					c.did = ev.did
				}
			}

		case evUnregister:
			if c, ok := candidates[ev.cid]; ok {
				c.lastRegisterState = 2
				c.votes = 0
				c.voters = map[string]int{}
			}

		case evReturnDeposit:
			if c, ok := candidates[ev.cid]; ok {
				c.lastRegisterState = 3
				c.votes = 0
				c.voters = map[string]int{}
			}

		case evVoteAdd:
			// Pure window-bounded tallying — a vote counts for THIS
			// term's election only if it was cast within THIS term's
			// voting window [narrowStart, narrowEnd]. Each term is a
			// fresh election; votes cast in earlier terms do NOT carry
			// over to a later term's tally, regardless of whether the
			// candidate was previously seated.
			//
			// Also requires the candidate to be currently Active
			// (not Canceled/Returned) at the time of the vote —
			// mirrors node's `processVoteCRC` GetCandidate() check.
			if ev.stakeHeight < narrowStart {
				continue
			}
			c, ok := candidates[ev.cid]
			if !ok || c.lastRegisterState != 1 {
				continue
			}
			c.votes += ev.amount
			c.voters[ev.voter]++

		case evVoteSub:
			// Mirror the window filter on the SUB side using the
			// original vote's stakeHeight. If the add was out-of-window
			// (skipped), the sub must also be skipped — otherwise the
			// running counter goes negative and gets clamped to 0,
			// under-reporting seated candidates whose prior-term votes
			// happen to be consumed inside the current term's window.
			if ev.stakeHeight < narrowStart {
				continue
			}
			c, ok := candidates[ev.cid]
			if !ok {
				continue
			}
			c.votes -= ev.amount
			if c.votes < 0 {
				c.votes = 0
			}
			if c.voters[ev.voter] > 0 {
				c.voters[ev.voter]--
				if c.voters[ev.voter] == 0 {
					delete(c.voters, ev.voter)
				}
			}
		}
	}

	// 3. Snapshot at narrowEnd — produce the tally.
	//
	// Filter matches the node's `getActiveAndExistDIDCRCandidatesDesc`:
	//   - Currently registered (state == 1 = Active)
	//   - Non-empty DID
	//   - Registered in THIS term's voting window (per-term candidacy
	//     requirement — mid-term registrations don't count for past terms)
	//
	// Ranked by votes DESC; top 12 get elected=true.
	var result TallyResult
	result.Term = term
	result.NarrowStart = narrowStart
	result.NarrowEnd = narrowEnd
	result.SnapshotHeight = narrowEnd
	result.ComputedAt = time.Now()

	distinctVoters := map[string]struct{}{}
	// Candidate filter — matches Elastos `cr/state/committee.go:1846-1865`
	// (`getActiveAndExistDIDCRCandidatesDesc`):
	//   1. State must be Active (lastRegisterState == 1). Canceled (2)
	//      and Returned (3) are excluded.
	//   2. DID must be non-empty. Early-era (pre-DID) registrations had
	//      empty DID at RegisterCR; our handler for TxUpdateCR now
	//      picks up DIDs added later via metadata updates.
	//   3. lastRegHeight <= narrowEnd — a registration after the voting
	//      window closes doesn't retroactively make the candidate
	//      eligible for that election.
	//
	// NOTE: we do NOT filter by a lower registration-height bound. In
	// Elastos, a candidate's Active state persists across terms unless
	// they explicitly Unregister/ReturnDeposit. A T1 candidate who
	// never unregistered is still Active in T2, T3, etc. and is on
	// the ballot if voters cast CRC votes for their CID. An earlier
	// version filtered with `c.lastRegHeight > prevTermStart`, which
	// incorrectly dropped recurring-active candidates who never
	// re-registered (e.g. Strawberry Council in Term 2 — registered
	// once at T1 era, remained Active, received 507K T2 votes, but
	// was absent from our T2 tally entirely).
	for _, c := range candidates {
		if c.lastRegisterState != 1 {
			continue
		}
		if c.did == "" {
			continue
		}
		if c.lastRegHeight > narrowEnd {
			continue
		}
		rc := ReplayCandidate{
			CID:           c.cid,
			DID:           c.did,
			Nickname:      c.nickname,
			VotesSela:     c.votes,
			VoterCount:    len(c.voters),
			LastRegHeight: c.lastRegHeight,
		}
		result.Candidates = append(result.Candidates, rc)
		for voter := range c.voters {
			distinctVoters[voter] = struct{}{}
		}
	}

	sort.Slice(result.Candidates, func(i, j int) bool {
		// Primary: votes desc. Secondary: CID asc (deterministic tie-break).
		if result.Candidates[i].VotesSela != result.Candidates[j].VotesSela {
			return result.Candidates[i].VotesSela > result.Candidates[j].VotesSela
		}
		return result.Candidates[i].CID < result.Candidates[j].CID
	})
	for i := range result.Candidates {
		result.Candidates[i].Rank = i + 1
		result.Candidates[i].Elected = i < 12
	}
	result.TotalCandidates = len(result.Candidates)
	result.TotalVotersDistinct = len(distinctVoters)

	slog.Info("vote replay: complete",
		"term", term,
		"candidates", result.TotalCandidates,
		"distinct_voters", result.TotalVotersDistinct,
		"elapsed", time.Since(started).Round(time.Millisecond))

	return &result, nil
}

// loadReplayEvents returns every event type the replay cares about,
// bounded by `maxHeight`. Unsorted; the caller sorts by (height, subOrder).
//
// Three source queries, unioned in Go (not SQL) to keep the shape simple:
//   1. CR state-change txs (types Register/Update/Unregister/ReturnDeposit)
//      — parse payload_json inline to extract CID + metadata.
//   2. Vote-creation events from `votes` (one per row, vote_type=1).
//   3. Vote-consumption events from `votes` (where spent_height <= maxHeight).
func (a *Aggregator) loadReplayEvents(ctx context.Context, maxHeight int64) ([]event, error) {
	var events []event

	// --- CR state events ---
	// Walk transactions table for the four CR-state tx types, in
	// (block_height, tx_index) order. Parse payload_json inline.
	//
	// subOrder = 1 for register/update, 2 for unregister, 3 for returnDeposit.
	// This ordering within a block doesn't matter much in practice (it
	// would only matter if two CR state changes for the same CID landed
	// in the same block, which is rare/impossible by protocol).
	stateRows, err := a.db.Syncer.Query(ctx, `
		SELECT type, block_height, tx_index, payload_json
		FROM transactions
		WHERE type IN ($1, $2, $3, $4)
		  AND block_height <= $5
		ORDER BY block_height, tx_index`,
		txTypeRegisterCR,
		txTypeUpdateCR,
		txTypeUnregisterCR,
		txTypeReturnCRDepositCoin,
		maxHeight,
	)
	if err != nil {
		return nil, fmt.Errorf("load cr state events: %w", err)
	}
	defer stateRows.Close()

	for stateRows.Next() {
		var txType int
		var height int64
		var txIndex int
		var payloadJSON string
		if err := stateRows.Scan(&txType, &height, &txIndex, &payloadJSON); err != nil {
			slog.Warn("replay: scan state row", "error", err)
			continue
		}
		ev := event{height: height, subOrder: 1}
		switch txType {
		case txTypeRegisterCR:
			var p struct {
				CID      string `json:"cid"`
				DID      string `json:"did"`
				NickName string `json:"nickname"`
			}
			if err := json.Unmarshal([]byte(payloadJSON), &p); err != nil || p.CID == "" {
				continue
			}
			ev.kind = evRegister
			ev.cid = p.CID
			ev.did = p.DID
			ev.nickname = p.NickName
		case txTypeUpdateCR:
			var p struct {
				CID      string `json:"cid"`
				DID      string `json:"did"`
				NickName string `json:"nickname"`
			}
			if err := json.Unmarshal([]byte(payloadJSON), &p); err != nil || p.CID == "" {
				continue
			}
			ev.kind = evUpdate
			ev.cid = p.CID
			ev.did = p.DID
			ev.nickname = p.NickName
		case txTypeUnregisterCR:
			var p struct {
				CID string `json:"cid"`
			}
			if err := json.Unmarshal([]byte(payloadJSON), &p); err != nil || p.CID == "" {
				continue
			}
			ev.kind = evUnregister
			ev.cid = p.CID
			ev.subOrder = 2
		case txTypeReturnCRDepositCoin:
			var p struct {
				CID string `json:"cid"`
			}
			if err := json.Unmarshal([]byte(payloadJSON), &p); err != nil || p.CID == "" {
				continue
			}
			ev.kind = evReturnDeposit
			ev.cid = p.CID
			ev.subOrder = 3
		default:
			continue
		}
		events = append(events, ev)
	}
	stateRows.Close()

	// --- Vote ADD events ---
	// Every CRC vote slice (vote_type=1) the indexer has seen. One event
	// per row. subOrder = 5 to process after state events in the same block.
	// For adds, stake_height == height by definition.
	addRows, err := a.db.Syncer.Query(ctx, `
		SELECT candidate, address, amount_sela, stake_height
		FROM votes
		WHERE vote_type = 1
		  AND stake_height <= $1`,
		maxHeight,
	)
	if err != nil {
		return nil, fmt.Errorf("load vote-add events: %w", err)
	}
	defer addRows.Close()

	for addRows.Next() {
		var candidate, address string
		var amount, height int64
		if err := addRows.Scan(&candidate, &address, &amount, &height); err != nil {
			slog.Warn("replay: scan vote-add row", "error", err)
			continue
		}
		events = append(events, event{
			height:      height,
			subOrder:    5,
			kind:        evVoteAdd,
			cid:         candidate,
			voter:       address,
			amount:      amount,
			stakeHeight: height, // for adds, creation height == event height
		})
	}
	addRows.Close()

	// --- Vote SUB events ---
	// Every spent vote (spent_height <= maxHeight). subOrder = 6 to process
	// after adds in the same block — if a vote is created and spent in the
	// same block (possible via TxVoting + TxReturnVotes), we add first.
	//
	// Carry stake_height along so the state-machine walker can apply the
	// same per-term window filter to subs that it applies to adds. Without
	// this, a T5-cast vote consumed during T6's voting window would
	// subtract from the T6 running counter even though its original add
	// was (correctly) skipped as out-of-window. Net: tally drifts
	// negative, capped at 0 → seated candidates under-reported.
	subRows, err := a.db.Syncer.Query(ctx, `
		SELECT candidate, address, amount_sela, spent_height, stake_height
		FROM votes
		WHERE vote_type = 1
		  AND spent_height IS NOT NULL
		  AND spent_height <= $1`,
		maxHeight,
	)
	if err != nil {
		return nil, fmt.Errorf("load vote-sub events: %w", err)
	}
	defer subRows.Close()

	for subRows.Next() {
		var candidate, address string
		var amount, height, stakeH int64
		if err := subRows.Scan(&candidate, &address, &amount, &height, &stakeH); err != nil {
			slog.Warn("replay: scan vote-sub row", "error", err)
			continue
		}
		events = append(events, event{
			height:      height,
			subOrder:    6,
			kind:        evVoteSub,
			cid:         candidate,
			voter:       address,
			amount:      amount,
			stakeHeight: stakeH,
		})
	}
	subRows.Close()

	return events, nil
}
