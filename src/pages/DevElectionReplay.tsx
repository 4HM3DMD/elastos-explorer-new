// DevElectionReplay — fast-forward simulator for the unified Elections
// page. Plays through a real term's voting → claim → duty cycle at
// configurable speed so we can visually verify every phase transition,
// countdown, hero card, and body swap without waiting weeks for the
// real chain.
//
// What it does:
//   - Picks Term 6 (the most recently completed full cycle on mainnet)
//     as the simulation target.
//   - Fetches REAL Term 6 candidates + Term 5 elected from the API so
//     names, votes, and CIDs match what the live page would show.
//   - Maintains a `simulatedHeight` state that advances at N blocks per
//     second (slider: 1, 50, 500, 2000).
//   - Synthesises an `ElectionStatus` for that height and renders the
//     same `<StatusHero>`, `<CandidatesList>`, `<CouncilMembersTable>`
//     components as production. So if the simulator looks right, prod
//     will look right when the real chain arrives at each phase.
//
// What it does NOT do:
//   - Hit the live `/cr/election/status` endpoint (we synthesise it).
//   - Mutate any DB state.
//   - Affect anything outside this page — fully sandboxed.
//
// Mounted at `/dev/elections-replay`. Always on (no env gate) because
// it's useful on the test node too. The yellow banner makes the
// "simulated, not live" framing impossible to miss.

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Pause, Play, RotateCcw, FastForward, AlertTriangle } from 'lucide-react';
import { blockchainApi } from '../services/api';
import type {
  CRMember,
  ElectionCandidate,
  ElectionStatus,
  ElectionPhase,
  ElectionReplayEvent,
} from '../types/blockchain';
import { CouncilMembersTable, CandidatesList, StatusHero } from './Elections';
import SEO from '../components/SEO';
import { cn } from '../lib/cn';

// Term-agnostic chain constants — the same ones the backend uses.
// Source: aggregator.go's CRFirstTermStart / CRTermLength / etc.,
// which mirror Elastos.ELA mainnet config.
const CR_FIRST_TERM_START = 658_930;
const CR_TERM_LENGTH = 262_800;
const CR_VOTING_PERIOD = 21_600;
const CR_CLAIM_PERIOD = 10_080;

// Compute every relevant boundary for an arbitrary term. Pure
// function of `term` — works for T4, T6, T8 in 2028, T42 in 2055,
// without code changes. Mirrors the backend's crElectionWindow().
interface TermBoundaries {
  termStart: number;        // first block of N's duty period
  votingStart: number;      // first block of N's voting window
  votingEnd: number;        // last block of N's voting window (INCLUSIVE)
  claimStart: number;       // first block of N's claim period
  claimEnd: number;         // last block of N's claim period (INCLUSIVE)
  takeover: number;         // == termStart, the handover block
  onDutyEnd: number;        // first block AFTER N's duty (== T_{N+1} termStart)
}
function computeTermBoundaries(term: number): TermBoundaries {
  const termStart = CR_FIRST_TERM_START + (term - 1) * CR_TERM_LENGTH;
  const votingEnd = termStart - 1 - CR_CLAIM_PERIOD;
  const votingStart = votingEnd - CR_VOTING_PERIOD + 1;
  const claimStart = votingEnd + 1;
  const claimEnd = termStart - 1;
  return {
    termStart,
    votingStart,
    votingEnd,
    claimStart,
    claimEnd,
    takeover: termStart,
    onDutyEnd: termStart + CR_TERM_LENGTH,
  };
}

const SPEED_PRESETS = [
  { bps: 1,    label: '1×',     hint: '1 block/sec — real-time feel' },
  { bps: 50,   label: '50×',    hint: '50 blocks/sec — voting in ~7 min' },
  { bps: 500,  label: '500×',   hint: '500 blocks/sec — full cycle in ~10 min' },
  { bps: 2000, label: '2000×',  hint: '2000 blocks/sec — full cycle in ~2.5 min' },
];

// Synthesise an ElectionStatus mirroring what the backend would emit
// at the given simulated chain tip, for any chosen replay term.
// Phase boundaries match the same math the backend uses in
// api/governance.go:getCRElectionStatus(). Term-agnostic.
function synthStatus(height: number, b: TermBoundaries, term: number): ElectionStatus {
  const next = computeTermBoundaries(term + 1);

  let phase: ElectionPhase = 'duty';
  if (height >= b.votingStart && height <= b.votingEnd) phase = 'voting';
  else if (height >= b.claimStart && height <= b.claimEnd) phase = 'claim';
  else if (height >= b.takeover) phase = 'duty';
  else phase = 'duty'; // pre-voting: still in T_{term-1} duty

  // Before takeover the seated council is term-1; after takeover it's `term`.
  const seatedTerm = phase === 'duty' && height >= b.takeover ? term : term - 1;
  const targetTerm = phase === 'duty' && height >= b.takeover ? term + 1 : term;

  // nextVoting* depends on whose duty period contains `height`.
  // If still in T_{term-1} duty pre-voting → next window is T_term's.
  // If in T_term duty post-takeover → next window is T_{term+1}'s.
  const nextVotingStartHeight = seatedTerm === term - 1 ? b.votingStart : next.votingStart;
  const nextVotingEndHeight   = seatedTerm === term - 1 ? b.votingEnd   : next.votingEnd;

  return {
    phase,
    currentHeight: height,
    currentCouncilTerm: seatedTerm,
    targetTerm,
    inVoting: phase === 'voting',
    onDuty: true,
    votingStartHeight: phase === 'voting' || phase === 'claim' ? b.votingStart : 0,
    votingEndHeight:   phase === 'voting' || phase === 'claim' ? b.votingEnd   : 0,
    onDutyStartHeight: phase === 'duty' && height >= b.takeover ? b.takeover  : 0,
    onDutyEndHeight:   phase === 'duty' && height >= b.takeover ? b.onDutyEnd : 0,
    claimStartHeight: b.claimStart,
    claimEndHeight: b.claimEnd,
    newCouncilTakeoverHeight: b.takeover,
    nextVotingStartHeight,
    nextVotingEndHeight,
    failedRestart: false,
    failedRestartReason: null,
  };
}

// Convert an elected ElectionCandidate into the CRMember shape that
// CouncilMembersTable consumes. Every field is real chain data piped
// through from the LEFT JOIN to cr_members in /cr/elections/{term} —
// no synthesis. The fallbacks below trigger only when a candidate's
// CID has no row in cr_members at all (extremely rare; would mean a
// vote was cast for a CID that was never registered — a node-side
// inconsistency).
//
// `state`: cr_members.state is the CURRENT state of the member. For
// past-term councils that's correct context only when paired with
// the headline ("Term 5 council") — they may have rotated to other
// states since (Returned, Unknown). For active simulator phases
// where we render the seated council, the state column reflects
// chain truth as of right now. We don't fake "Elected" anymore.
function candidateToMember(c: ElectionCandidate): CRMember {
  return {
    rank: c.rank,
    cid: c.cid,
    did: c.did ?? '',
    code: '',
    nickname: c.nickname,
    url: c.url ?? '',
    location: c.location ?? 0,
    state: c.state ?? '',
    votes: c.votes,
    depositAmount: c.depositAmount ?? '0',
    impeachmentVotes: '0',
    penalty: '0',
    registerHeight: c.registerHeight ?? 0,
  };
}

const DevElectionReplay = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  // Term to replay — driven by ?term=N URL query. Defaults to the
  // most-recently-completed term (currently T6, will be T7 after May
  // 2026, T8 in 2028, etc.) auto-detected from /cr/elections.
  const urlTerm = Number(searchParams.get('term'));
  const [resolvedTerm, setResolvedTerm] = useState<number | null>(
    Number.isFinite(urlTerm) && urlTerm >= 4 ? urlTerm : null,
  );
  const [availableTerms, setAvailableTerms] = useState<number[]>([]);

  // Auto-pick the most recently completed BPoS-era term if no URL hint.
  useEffect(() => {
    let cancelled = false;
    blockchainApi
      .getCRElections()
      .then((all) => {
        if (cancelled) return;
        // Only BPoS-era terms (4+) have parseable replay events.
        const bposTerms = all
          .map((e) => e.term)
          .filter((t) => t >= 4)
          .sort((a, b) => b - a);
        setAvailableTerms(bposTerms);
        if (resolvedTerm === null && bposTerms.length > 0) {
          setResolvedTerm(bposTerms[0]);
        }
      })
      .catch(() => {
        // Fallback: hardcoded T6 only if the network is fully down at
        // first paint. Once API recovers the picker repopulates.
        if (!cancelled && resolvedTerm === null) setResolvedTerm(6);
      });
    return () => {
      cancelled = true;
    };
  }, [resolvedTerm]);

  // Boundaries for the resolved term — pure formula, no hardcoded
  // term numbers. Derived once per term change. Falls back to T6 only
  // for the very first render before resolvedTerm is set.
  const term = resolvedTerm ?? 6;
  const b = useMemo(() => computeTermBoundaries(term), [term]);
  const SIM_START = b.votingStart - 500;
  const SIM_END = Math.min(b.takeover + 2000, b.onDutyEnd);

  const [simHeight, setSimHeight] = useState(SIM_START);
  const [speed, setSpeed] = useState<number>(50);
  const [playing, setPlaying] = useState(false);
  const [targetCandidates, setTargetCandidates] = useState<ElectionCandidate[]>([]);
  const [prevElectedAsMembers, setPrevElectedAsMembers] = useState<CRMember[]>([]);
  const [targetElectedAsMembers, setTargetElectedAsMembers] = useState<CRMember[]>([]);
  const [replayEvents, setReplayEvents] = useState<ElectionReplayEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Reset simHeight when the chosen term changes — without this the
  // counter stays at the old term's offset and shows nonsense.
  useEffect(() => {
    setSimHeight(SIM_START);
    setPlaying(false);
  }, [SIM_START]);

  const handleTermChange = useCallback(
    (newTerm: number) => {
      setResolvedTerm(newTerm);
      const next = new URLSearchParams(searchParams);
      next.set('term', String(newTerm));
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // Use ref for the interval so the speed slider can re-arm cleanly
  // without losing simHeight across renders.
  const intervalRef = useRef<number | null>(null);

  // Initial fetch — three calls in parallel via allSettled so a
  // partial failure doesn't break the whole simulator:
  //   1. Term `term-1` detail → seed previous-term elected as the
  //      "still-on-duty" council during pre-voting and voting phases.
  //   2. Term `term` detail → final candidate list (cid, did,
  //      nickname), identifies the 12 elected for claim/duty.
  //   3. Term `term` replay events → real per-block vote stream
  //      we replay through to reconstruct live tallies.
  //
  // Term-agnostic: refetches on every term change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.allSettled([
      blockchainApi.getCRElectionByTerm(term - 1),
      blockchainApi.getCRElectionByTerm(term),
      blockchainApi.getCRElectionReplayEvents(term),
    ])
      .then(([prevRes, targetRes, eventsRes]) => {
        if (cancelled) return;
        if (targetRes.status === 'fulfilled') {
          setTargetCandidates(targetRes.value.candidates);
          setTargetElectedAsMembers(
            targetRes.value.candidates.filter((c) => c.elected).map(candidateToMember),
          );
        }
        if (prevRes.status === 'fulfilled') {
          setPrevElectedAsMembers(
            prevRes.value.candidates.filter((c) => c.elected).map(candidateToMember),
          );
        }
        if (eventsRes.status === 'fulfilled') {
          // Defensive: validate shape before trusting. The backend
          // ORDER BY guarantees chronological + tie-broken order, but
          // if the response is somehow missing or malformed (network
          // truncation, mid-deploy schema mismatch), we'd silently
          // crash deep in the replay loop. Reject obviously-bad data.
          const raw = eventsRes.value?.events;
          if (Array.isArray(raw)) {
            // Belt-and-braces: re-sort by (height, address) so the
            // UsedCRVotes-replacement semantic stays correct even if
            // the SQL ORDER BY were ever changed or a future caching
            // layer reshuffled rows. Sort is stable on already-sorted
            // arrays (V8 TimSort) — costs ~0 in the common path.
            const sorted = [...raw].sort((a, b) => {
              if (a.height !== b.height) return a.height - b.height;
              return a.address.localeCompare(b.address);
            });
            setReplayEvents(sorted);
          } else if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.warn('DevElectionReplay: replay events response missing or malformed', eventsRes.value);
          }
        }
        const allFailed =
          prevRes.status === 'rejected' &&
          targetRes.status === 'rejected' &&
          eventsRes.status === 'rejected';
        if (allFailed) {
          setFetchError(`Failed to load Term ${term - 1}/${term} data from API`);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [term]);

  // Tick the simulator. We advance one block per interval, so the
  // interval delay = 1000 / speed. For very high speeds we batch
  // multiple blocks per tick to keep the timer rate sane (browsers
  // throttle setInterval below ~4ms).
  useEffect(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (!playing) return;
    const tickRate = Math.max(20, 1000 / speed); // ms per tick
    const blocksPerTick = Math.max(1, Math.round(speed * (tickRate / 1000)));
    intervalRef.current = window.setInterval(() => {
      setSimHeight((h) => {
        const next = h + blocksPerTick;
        if (next >= SIM_END) {
          setPlaying(false);
          return SIM_END;
        }
        return next;
      });
    }, tickRate);
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [playing, speed]);

  const status = useMemo(() => synthStatus(simHeight, b, term), [simHeight, b, term]);
  const phase = status.phase;

  // Pick the right "live council members" array for the current
  // simulated frame, and derive each member's state from simulated
  // context rather than cr_members.state (which is CURRENT chain
  // state and gives wrong answers during historical replay — e.g.
  // T5 members who've cycled out now show 'Unknown' but were
  // 'Elected' during T5's duty period).
  //
  // Rules:
  //   - simHeight < b.takeover → T5 council is on duty. State = Elected.
  //   - simHeight >= b.takeover → T6 council is on duty. State = Elected.
  //
  // Per-member impeachment / inactive transitions during a term
  // would require a `cr_member_state_history` table we don't have.
  // For T5 and T6 specifically, no impeachments occurred during
  // the simulated window, so flat 'Elected' is accurate.
  const liveMembers = useMemo(() => {
    const source = simHeight >= b.takeover ? targetElectedAsMembers : prevElectedAsMembers;
    return source.map((m) => ({ ...m, state: 'Elected' }));
  }, [simHeight, prevElectedAsMembers, targetElectedAsMembers]);

  // Real event replay. Walk every TxVoting event up to simHeight,
  // applying the node's `UsedCRVotes[stakeAddress]` semantic: each
  // event REPLACES the voter's prior allocation entirely. This
  // produces a tally identical to what the node had at simHeight,
  // which is exactly what we want for verification.
  //
  // Recomputed from scratch every render. With ~906 events for
  // Term 6 this is cheap (<2ms in V8). If a future term blows past
  // 10k events we can switch to an incremental cursor; for now the
  // simplicity wins.
  //
  // Out: { totals: Map<cid, sela>, voters: Map<cid, Set<addr>> }
  // — per-candidate live ELA total and the set of distinct voters
  // currently allocating to them. These feed the table render and
  // (later) the click-to-drilldown view.
  const liveTally = useMemo(() => {
    const voterAllocations = new Map<string, Map<string, number>>();
    const totals = new Map<string, number>();
    const voters = new Map<string, Set<string>>();
    if (replayEvents.length === 0) return { totals, voters, eventCount: 0 };

    let appliedCount = 0;
    for (const ev of replayEvents) {
      if (ev.height > simHeight) break;
      // Drop voter's previous allocation, if any — the new TxVoting
      // is a full replacement.
      const prev = voterAllocations.get(ev.address);
      if (prev) {
        for (const [cand, amt] of prev) {
          totals.set(cand, (totals.get(cand) || 0) - amt);
          voters.get(cand)?.delete(ev.address);
        }
      }
      // Apply new allocation.
      const fresh = new Map<string, number>();
      for (const v of ev.votes) {
        fresh.set(v.candidate, v.amountSela);
        totals.set(v.candidate, (totals.get(v.candidate) || 0) + v.amountSela);
        if (!voters.has(v.candidate)) voters.set(v.candidate, new Set());
        voters.get(v.candidate)!.add(ev.address);
      }
      voterAllocations.set(ev.address, fresh);
      appliedCount++;
    }
    return { totals, voters, eventCount: appliedCount };
  }, [replayEvents, simHeight]);

  // Build a "first vote received" map for every candidate in this
  // term's voting window. This is the most accurate "effective T6
  // entry block" we can derive from chain data: it's the first
  // moment voters could have observed this candidate on the live
  // tally during voting.
  //
  // We CAN'T trust cr_members.register_height alone — for candidates
  // who've been continuously registered across multiple terms (e.g.
  // Sash and Rebecca Zhu, with register_height from the T2 era),
  // that field reflects their original registration, not when they
  // re-entered the race for T6. Their first received vote in T6's
  // voting window is a much truer signal.
  //
  // Candidates with no events in the window simply never appear in
  // this map; they're filtered out of the voting view anyway.
  const firstVoteHeightByCid = useMemo(() => {
    const m = new Map<string, number>();
    for (const ev of replayEvents) {
      for (const v of ev.votes) {
        const prev = m.get(v.candidate);
        if (prev === undefined || ev.height < prev) {
          m.set(v.candidate, ev.height);
        }
      }
    }
    return m;
  }, [replayEvents]);

  // Static eligible-ballot list for T6: vote-getting candidates only,
  // sorted by first-vote-height for stable presentation order.
  const eligibleVotingCandidates = useMemo(
    () =>
      targetCandidates
        .filter((c) => firstVoteHeightByCid.has(c.cid))
        .sort((a, b) => {
          const ah = firstVoteHeightByCid.get(a.cid)!;
          const bh = firstVoteHeightByCid.get(b.cid)!;
          return ah - bh;
        }),
    [targetCandidates, firstVoteHeightByCid],
  );

  // Build the voting-body candidate list — a candidate is on the
  // ballot at simHeight only if they've received their first vote.
  // This matches what voters would have seen on the live tally page
  // on election day: an empty leaderboard at voting open, gradually
  // populated as candidates start receiving support.
  const votingBody = useMemo(() => {
    if (phase !== 'voting' || eligibleVotingCandidates.length === 0) {
      return eligibleVotingCandidates;
    }
    const SELA_PER_ELA = 1e8;
    const visible = eligibleVotingCandidates.filter((c) => {
      const fv = firstVoteHeightByCid.get(c.cid);
      return fv !== undefined && fv <= simHeight;
    });
    const enriched = visible.map((c) => {
      const sela = liveTally.totals.get(c.cid) || 0;
      const ela = sela / SELA_PER_ELA;
      const voterCount = liveTally.voters.get(c.cid)?.size || 0;
      return {
        ...c,
        votes: ela.toFixed(8),
        voterCount,
        elected: false,
      };
    });
    enriched.sort((a, b) => {
      const av = Number(a.votes);
      const bv = Number(b.votes);
      if (av !== bv) return bv - av;
      return a.cid.localeCompare(b.cid);
    });
    return enriched.map((c, i) => ({ ...c, rank: i + 1 }));
  }, [phase, eligibleVotingCandidates, firstVoteHeightByCid, liveTally, simHeight]);

  // Counts for the header readout: how many candidates have made
  // their debut on the live tally so far, out of the eventual total.
  const registeredCount = useMemo(() => {
    let count = 0;
    for (const c of eligibleVotingCandidates) {
      const fv = firstVoteHeightByCid.get(c.cid);
      if (fv !== undefined && fv <= simHeight) count++;
    }
    return count;
  }, [eligibleVotingCandidates, firstVoteHeightByCid, simHeight]);

  // Candidate count drives the voting hero subtitle.
  const targetCandidateCount = votingBody.length;

  // Claim phase shows only the elected 12 (incoming council) with
  // their final tallies — by claim phase votes are locked in.
  const claimBody = useMemo(() => targetCandidates.filter((c) => c.elected), [targetCandidates]);

  const handleJump = useCallback((target: number) => {
    setPlaying(false);
    setSimHeight(target);
  }, []);

  const handleReset = useCallback(() => {
    setPlaying(false);
    setSimHeight(SIM_START);
  }, []);

  const blocksUntilEnd = SIM_END - simHeight;
  const phaseLabel = phase === 'voting'
    ? 'VOTING'
    : phase === 'claim'
    ? 'CLAIM (CRClaimPeriod)'
    : phase === 'duty' && simHeight >= b.takeover
    ? `DUTY (Term ${term} seated)`
    : `DUTY (Term ${term - 1} seated, pre-voting)`;

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO title="Election Replay (Test)" description="Dev simulator" path="/dev/elections-replay" />

      {/* Yellow simulator banner — clarifies this is a time-lapse, not the live chain */}
      <div className="card border border-yellow-500/40 bg-yellow-500/10 p-4 flex items-start gap-3">
        <AlertTriangle size={18} className="text-yellow-400 flex-shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-primary mb-1">
            Election replay — accelerated playback of real Term {term} chain data
          </p>
          <p className="text-xs text-secondary">
            Votes, voter addresses, registration blocks, candidate URLs, and council members
            are all real on-chain data. The active council&apos;s state is derived from the
            simulated block (Term {term - 1} = Elected during pre-takeover frame; Term {term} =
            Elected after handover). Only TIME is accelerated. For the live status, see {' '}
            <Link to="/governance" className="link-blue">/governance</Link>.
          </p>
        </div>
      </div>

      {/* Replay control panel */}
      <div className="card p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] md:text-[11px] text-muted uppercase tracking-[0.18em] mb-1">
              Simulator state
            </p>
            <p className="text-lg md:text-xl font-semibold text-primary">
              <span className="text-brand">{phaseLabel}</span>
            </p>
            <p className="text-xs text-secondary mt-1 font-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
              Block {simHeight.toLocaleString()} ·{' '}
              {phase === 'voting' && `${b.votingEnd - simHeight} blocks until voting close`}
              {phase === 'claim' && `${b.takeover - simHeight} blocks until handover`}
              {phase === 'duty' && simHeight >= b.takeover && `${b.onDutyEnd - simHeight} blocks until next election cycle`}
              {phase === 'duty' && simHeight < b.takeover && `${b.votingStart - simHeight} blocks until voting opens`}
              {phase === 'voting' && replayEvents.length > 0 && (
                <span> · {registeredCount} / {eligibleVotingCandidates.length} on ballot · {liveTally.eventCount} / {replayEvents.length} votes applied</span>
              )}
            </p>
          </div>

          {/* Play / pause / reset */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPlaying((p) => !p)}
              className="btn-primary inline-flex items-center gap-1.5"
              disabled={loading || blocksUntilEnd <= 0}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
              {playing ? 'Pause' : 'Play'}
            </button>
            <button
              onClick={handleReset}
              className="btn-secondary inline-flex items-center gap-1.5"
              disabled={loading}
            >
              <RotateCcw size={14} />
              Reset
            </button>
          </div>
        </div>

        {/* Term selector — choose which past term to replay. List
            populated from /cr/elections (BPoS-era only). New terms
            appear automatically as the chain progresses. */}
        {availableTerms.length > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] md:text-[11px] text-muted uppercase tracking-[0.18em]">Term</span>
            {availableTerms.map((t) => (
              <button
                key={t}
                onClick={() => handleTermChange(t)}
                className={cn(
                  'px-3 py-1 rounded-md text-xs font-medium transition-colors border',
                  t === term
                    ? 'bg-brand/15 text-brand border-brand/40'
                    : 'text-secondary border-[var(--color-border)] hover:text-primary hover:border-[var(--color-border-strong)]',
                )}
              >
                T{t}
              </button>
            ))}
          </div>
        )}

        {/* Speed selector */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] md:text-[11px] text-muted uppercase tracking-[0.18em]">Speed</span>
          {SPEED_PRESETS.map((p) => (
            <button
              key={p.bps}
              onClick={() => setSpeed(p.bps)}
              title={p.hint}
              className={cn(
                'px-3 py-1 rounded-md text-xs font-medium transition-colors border',
                speed === p.bps
                  ? 'bg-brand/15 text-brand border-brand/40'
                  : 'text-secondary border-[var(--color-border)] hover:text-primary hover:border-[var(--color-border-strong)]',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Phase-jump shortcuts */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] md:text-[11px] text-muted uppercase tracking-[0.18em]">Jump to</span>
          <JumpButton label="Pre-voting" onClick={() => handleJump(SIM_START)} />
          <JumpButton label="Voting open" onClick={() => handleJump(b.votingStart)} />
          <JumpButton label="Voting close" onClick={() => handleJump(b.votingEnd - 50)} />
          <JumpButton label="Claim window" onClick={() => handleJump(b.claimStart + 100)} />
          <JumpButton label="Handover − 100" onClick={() => handleJump(b.takeover - 100)} />
          <JumpButton label="Handover" onClick={() => handleJump(b.takeover)} />
          <JumpButton label="Mid-duty" onClick={() => handleJump(b.takeover + 50_000)} />
        </div>
      </div>

      {/* Error / loading guards */}
      {fetchError && (
        <div className="card border border-red-500/30 bg-red-500/5 p-4 text-sm text-accent-red">
          {fetchError}
        </div>
      )}

      {/* Hero — same component as production */}
      {!loading && <StatusHero status={status} targetCandidateCount={targetCandidateCount} />}

      {/* Body — same components as production, swapped by phase */}
      {!loading && phase === 'voting' && (
        <CandidatesList
          candidates={votingBody}
          title={`Term ${status.targetTerm} candidates (live tally)`}
          emptyLabel="No candidate data"
        />
      )}

      {!loading && phase === 'claim' && (
        <>
          {/* Incoming council during the CRClaimPeriod. They've won
              the election (elected=true) but are NOT yet on duty —
              takeover happens at status.newCouncilTakeoverHeight.
              The current Term N council remains seated below until
              that block is crossed. */}
          <CandidatesList
            candidates={claimBody}
            title={`Incoming Term ${status.targetTerm} council — awaiting takeover at block ${status.newCouncilTakeoverHeight.toLocaleString()}`}
            emptyLabel="No incoming-council data"
          />
          <CouncilMembersTable
            members={liveMembers}
            loading={false}
            headline={`Current Term ${status.currentCouncilTerm} council (still on duty until handover)`}
          />
        </>
      )}

      {!loading && phase === 'duty' && (
        <CouncilMembersTable members={liveMembers} loading={false} />
      )}

      {/* Footer hint */}
      <p className="text-[11px] text-muted text-center pt-2">
        Tip: <FastForward size={10} className="inline" /> 2000× → full Term {term} cycle (voting +
        claim + duty) plays in about 2½ minutes. Use jump buttons to skip ahead.
      </p>
    </div>
  );
};

function JumpButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="px-2.5 py-1 rounded-md text-[11px] font-medium text-secondary border border-[var(--color-border)] hover:text-primary hover:border-[var(--color-border-strong)] transition-colors"
    >
      {label}
    </button>
  );
}

export default DevElectionReplay;
