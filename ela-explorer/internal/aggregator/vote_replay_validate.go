package aggregator

// Hard-fail validation for the state-machine replay (per the plan's
// approved requirement). Before any replay output is allowed to
// overwrite `cr_election_tallies`, the Term 6 top-12 set MUST equal
// the 12 currently-seated council members.
//
// This is the safety gate that prevents us from shipping another
// incorrect tally — which has happened six times while we iterated
// SQL approaches. The replay is the only path that can match the
// node's algorithm bit-for-bit; this gate proves it has done so.
//
// Only Term 6 is validated (not past terms) because it's the only
// term for which we have an authoritative external reference:
//   - `cr_members` is kept in sync with `listcurrentcrs` by
//     `refreshCRMembers` (runs every 120s)
//   - Members with state IN ('Elected', 'Inactive', 'Impeached') are
//     the 12 currently seated — authoritative per the node
//
// For past terms (1-5) we have no reference. They're written with
// `validation_source = 'historical-best-effort'` so the UI can flag
// them; Term 6+ gets 'council-match' when this gate passes.

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
)

// ValidateTermAgainstSeatedCouncil runs the replay for `term` and asserts
// that the top-12 CIDs by votes exactly equal the currently-seated
// council CIDs. Returns nil on match, a descriptive error on mismatch.
//
// Intended to be called ONLY for the currently on-duty term (typically
// term 6). For past or future terms, there's no seated-council reference
// to compare against, so callers should skip validation.
func (a *Aggregator) ValidateTermAgainstSeatedCouncil(ctx context.Context, term int64) error {
	result, err := a.ReplayTermTally(ctx, term)
	if err != nil {
		return fmt.Errorf("validation: replay failed: %w", err)
	}

	if len(result.Candidates) < 12 {
		return fmt.Errorf("validation: term %d has only %d candidates in replay, need ≥12 to compare", term, len(result.Candidates))
	}

	// The authoritative set: 12 CIDs currently seated per cr_members
	// (sourced from listcurrentcrs). 'Inactive' means the member's node
	// is offline but they're still on the council. 'Impeached' may be
	// retained by the node in the council listing. All count as seated.
	seatedRows, err := a.db.API.Query(ctx, `
		SELECT cid FROM cr_members
		WHERE state IN ('Elected', 'Inactive', 'Impeached')
		ORDER BY cid`)
	if err != nil {
		return fmt.Errorf("validation: query seated council: %w", err)
	}
	defer seatedRows.Close()

	seated := map[string]bool{}
	for seatedRows.Next() {
		var cid string
		if err := seatedRows.Scan(&cid); err != nil {
			continue
		}
		seated[cid] = true
	}
	seatedRows.Close()

	if len(seated) == 0 {
		return fmt.Errorf("validation: no seated council members found in cr_members (aggregator hasn't synced listcurrentcrs yet?)")
	}

	// Replay's top-N where N = len(seated) — usually 12 but could be less
	// during mid-term transition windows.
	topReplay := map[string]bool{}
	for i := 0; i < len(seated) && i < len(result.Candidates); i++ {
		topReplay[result.Candidates[i].CID] = true
	}

	// Exact set equality required.
	var missingFromReplay []string // seated but not in top-N of replay
	var extraInReplay []string     // in top-N of replay but not seated
	for cid := range seated {
		if !topReplay[cid] {
			missingFromReplay = append(missingFromReplay, cid)
		}
	}
	for cid := range topReplay {
		if !seated[cid] {
			extraInReplay = append(extraInReplay, cid)
		}
	}
	sort.Strings(missingFromReplay)
	sort.Strings(extraInReplay)

	if len(missingFromReplay) == 0 && len(extraInReplay) == 0 {
		slog.Info("vote replay validation: PASS",
			"term", term,
			"seated_cids", len(seated),
			"top_n_replay", len(topReplay))
		return nil
	}

	// Build a readable diff for the logs.
	var diff strings.Builder
	fmt.Fprintf(&diff, "term %d validation FAILED: replay top-%d does NOT equal seated council\n", term, len(seated))
	fmt.Fprintf(&diff, "  seated-but-missing-from-replay-top-%d (%d):\n", len(seated), len(missingFromReplay))
	for _, cid := range missingFromReplay {
		nick := "?"
		for _, c := range result.Candidates {
			if c.CID == cid {
				nick = c.Nickname
				break
			}
		}
		fmt.Fprintf(&diff, "    - %s (%s)\n", cid, nick)
	}
	fmt.Fprintf(&diff, "  extra-in-replay-top-%d-not-seated (%d):\n", len(seated), len(extraInReplay))
	for _, cid := range extraInReplay {
		nick := "?"
		for _, c := range result.Candidates {
			if c.CID == cid {
				nick = c.Nickname
				break
			}
		}
		fmt.Fprintf(&diff, "    - %s (%s)\n", cid, nick)
	}
	fmt.Fprintf(&diff, "  replay top-%d (by votes desc):\n", len(seated))
	for i := 0; i < len(seated) && i < len(result.Candidates); i++ {
		c := result.Candidates[i]
		marker := "  "
		if seated[c.CID] {
			marker = "✓ "
		}
		fmt.Fprintf(&diff, "    %s#%d  %s  %s  votes=%d voters=%d\n",
			marker, c.Rank, c.Nickname, c.CID[:16]+"…", c.VotesSela, c.VoterCount)
	}

	slog.Warn(diff.String())
	return fmt.Errorf("replay term %d failed validation (%d missing, %d extra)", term, len(missingFromReplay), len(extraInReplay))
}
