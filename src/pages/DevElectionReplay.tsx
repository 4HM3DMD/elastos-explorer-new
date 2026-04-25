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
import { Link } from 'react-router-dom';
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

// Term 6's real chain boundaries (from CRFirstTermStart=658930,
// CRTermLength=262800, CRVotingPeriod=21600, CRClaimPeriod=10080).
const T6_TERM = 6;
const T6_TERM_START = 658_930 + (T6_TERM - 1) * 262_800;            // 1972930
const T6_VOTING_END = T6_TERM_START - 1 - 10_080;                   // 1962849
const T6_VOTING_START = T6_VOTING_END - 21_600 + 1;                 // 1941250
const T6_CLAIM_START = T6_VOTING_END + 1;                           // 1962850
const T6_CLAIM_END = T6_TERM_START - 1;                             // 1972929
const T6_TAKEOVER = T6_TERM_START;                                  // 1972930
const T6_ON_DUTY_END = T6_TERM_START + 262_800;                     // 2235730

// We always simulate Term 6's window, regardless of where mainnet is
// today. Pre-voting starts ~1000 blocks before voting open so the
// "duty (Term 5 still seated)" frame is visible first.
const SIM_START = T6_VOTING_START - 500;
const SIM_END = Math.min(T6_TAKEOVER + 2_000, T6_ON_DUTY_END);

const SPEED_PRESETS = [
  { bps: 1,    label: '1×',     hint: '1 block/sec — real-time feel' },
  { bps: 50,   label: '50×',    hint: '50 blocks/sec — voting in ~7 min' },
  { bps: 500,  label: '500×',   hint: '500 blocks/sec — full cycle in ~10 min' },
  { bps: 2000, label: '2000×',  hint: '2000 blocks/sec — full cycle in ~2.5 min' },
];

// Synthesise an ElectionStatus mirroring what the backend would emit
// at the given simulated chain tip. Phase boundaries match the same
// math the backend uses in api/governance.go:getCRElectionStatus().
function synthStatus(height: number): ElectionStatus {
  let phase: ElectionPhase = 'duty';
  if (height >= T6_VOTING_START && height <= T6_VOTING_END) phase = 'voting';
  else if (height >= T6_CLAIM_START && height <= T6_CLAIM_END) phase = 'claim';
  else if (height >= T6_TAKEOVER) phase = 'duty';
  else phase = 'duty'; // pre-voting: still in Term 5 duty

  // While in voting/claim, the seated council is Term 5 ("currentCouncilTerm").
  // Once height crosses T6_TAKEOVER, Term 6 takes over.
  const currentCouncilTerm = phase === 'duty' && height >= T6_TAKEOVER ? 6 : 5;
  const targetTerm = phase === 'duty' && height >= T6_TAKEOVER ? 7 : 6;

  // For Term 5 duty (pre-voting), nextVoting* points at Term 6's voting window.
  // For Term 6 duty (post-takeover), point at a fictional Term 7 window.
  const nextVotingStartHeight =
    currentCouncilTerm === 5 ? T6_VOTING_START : T6_TAKEOVER + 262_800 - 10_080 - 21_600;
  const nextVotingEndHeight =
    currentCouncilTerm === 5 ? T6_VOTING_END : T6_TAKEOVER + 262_800 - 10_080 - 1;

  return {
    phase,
    currentHeight: height,
    currentCouncilTerm,
    targetTerm,
    inVoting: phase === 'voting',
    onDuty: true,
    votingStartHeight: phase === 'voting' || phase === 'claim' ? T6_VOTING_START : 0,
    votingEndHeight: phase === 'voting' || phase === 'claim' ? T6_VOTING_END : 0,
    onDutyStartHeight: phase === 'duty' && height >= T6_TAKEOVER ? T6_TAKEOVER : 0,
    onDutyEndHeight: phase === 'duty' && height >= T6_TAKEOVER ? T6_ON_DUTY_END : 0,
    claimStartHeight: T6_CLAIM_START,
    claimEndHeight: T6_CLAIM_END,
    newCouncilTakeoverHeight: T6_TAKEOVER,
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
  const [simHeight, setSimHeight] = useState(SIM_START);
  const [speed, setSpeed] = useState<number>(50);
  const [playing, setPlaying] = useState(false);
  const [t6Candidates, setT6Candidates] = useState<ElectionCandidate[]>([]);
  const [t5ElectedAsMembers, setT5ElectedAsMembers] = useState<CRMember[]>([]);
  const [t6ElectedAsMembers, setT6ElectedAsMembers] = useState<CRMember[]>([]);
  const [replayEvents, setReplayEvents] = useState<ElectionReplayEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Use ref for the interval so the speed slider can re-arm cleanly
  // without losing simHeight across renders.
  const intervalRef = useRef<number | null>(null);

  // Initial fetch — three calls in parallel:
  //   1. Term 5 detail → seed Term 5 elected as the "still-on-duty"
  //      council during the simulator's pre-voting and voting phases.
  //   2. Term 6 detail → final candidate list (cid, did, nickname),
  //      lets us identify the 12 elected for claim/duty rendering.
  //   3. Term 6 replay events → the real per-block vote stream we
  //      replay through to reconstruct live tallies.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      blockchainApi.getCRElectionByTerm(5),
      blockchainApi.getCRElectionByTerm(6),
      blockchainApi.getCRElectionReplayEvents(6),
    ])
      .then(([t5, t6, events]) => {
        if (cancelled) return;
        setT6Candidates(t6.candidates);
        setT5ElectedAsMembers(
          t5.candidates.filter((c) => c.elected).map(candidateToMember),
        );
        setT6ElectedAsMembers(
          t6.candidates.filter((c) => c.elected).map(candidateToMember),
        );
        setReplayEvents(events.events);
      })
      .catch(() => {
        if (!cancelled) setFetchError('Failed to load Term 5/6 data from API');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const status = useMemo(() => synthStatus(simHeight), [simHeight]);
  const phase = status.phase;

  // Pick the right "live council members" array for the current
  // simulated frame, and derive each member's state from simulated
  // context rather than cr_members.state (which is CURRENT chain
  // state and gives wrong answers during historical replay — e.g.
  // T5 members who've cycled out now show 'Unknown' but were
  // 'Elected' during T5's duty period).
  //
  // Rules:
  //   - simHeight < T6_TAKEOVER → T5 council is on duty. State = Elected.
  //   - simHeight >= T6_TAKEOVER → T6 council is on duty. State = Elected.
  //
  // Per-member impeachment / inactive transitions during a term
  // would require a `cr_member_state_history` table we don't have.
  // For T5 and T6 specifically, no impeachments occurred during
  // the simulated window, so flat 'Elected' is accurate.
  const liveMembers = useMemo(() => {
    const source = simHeight >= T6_TAKEOVER ? t6ElectedAsMembers : t5ElectedAsMembers;
    return source.map((m) => ({ ...m, state: 'Elected' }));
  }, [simHeight, t5ElectedAsMembers, t6ElectedAsMembers]);

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
  const t6FirstVoteHeight = useMemo(() => {
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
      t6Candidates
        .filter((c) => t6FirstVoteHeight.has(c.cid))
        .sort((a, b) => {
          const ah = t6FirstVoteHeight.get(a.cid)!;
          const bh = t6FirstVoteHeight.get(b.cid)!;
          return ah - bh;
        }),
    [t6Candidates, t6FirstVoteHeight],
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
      const fv = t6FirstVoteHeight.get(c.cid);
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
  }, [phase, eligibleVotingCandidates, t6FirstVoteHeight, liveTally, simHeight]);

  // Counts for the header readout: how many candidates have made
  // their debut on the live tally so far, out of the eventual total.
  const registeredCount = useMemo(() => {
    let count = 0;
    for (const c of eligibleVotingCandidates) {
      const fv = t6FirstVoteHeight.get(c.cid);
      if (fv !== undefined && fv <= simHeight) count++;
    }
    return count;
  }, [eligibleVotingCandidates, t6FirstVoteHeight, simHeight]);

  // Candidate count drives the voting hero subtitle.
  const targetCandidateCount = votingBody.length;

  // Claim phase shows only the elected 12 (incoming council) with
  // their final tallies — by claim phase votes are locked in.
  const claimBody = useMemo(() => t6Candidates.filter((c) => c.elected), [t6Candidates]);

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
    : phase === 'duty' && simHeight >= T6_TAKEOVER
    ? 'DUTY (Term 6 seated)'
    : 'DUTY (Term 5 seated, pre-voting)';

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO title="Election Replay (Test)" description="Dev simulator" path="/dev/elections-replay" />

      {/* Yellow simulator banner — clarifies this is a time-lapse, not the live chain */}
      <div className="card border border-yellow-500/40 bg-yellow-500/10 p-4 flex items-start gap-3">
        <AlertTriangle size={18} className="text-yellow-400 flex-shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-primary mb-1">
            Election replay — accelerated playback of real Term 6 chain data
          </p>
          <p className="text-xs text-secondary">
            Votes, voter addresses, registration blocks, candidate URLs, council members, and
            per-member claimed-node blocks are all real on-chain data. The active council&apos;s
            state is derived from the simulated block (Term 5 = Elected during pre-T6 frame;
            Term 6 = Elected after handover). During the claim period, &quot;Node claimed&quot;
            status comes from each member&apos;s real <code>cr_members.register_height</code> —
            the block of their most recent TxRegisterCR/TxUpdateCR (which is the transaction
            that sets <code>claimed_node</code>). Only TIME is accelerated. For the live
            status, see <Link to="/governance" className="link-blue">/governance</Link>.
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
              {phase === 'voting' && `${T6_VOTING_END - simHeight} blocks until voting close`}
              {phase === 'claim' && `${T6_TAKEOVER - simHeight} blocks until handover`}
              {phase === 'duty' && simHeight >= T6_TAKEOVER && `${T6_ON_DUTY_END - simHeight} blocks until next election cycle`}
              {phase === 'duty' && simHeight < T6_TAKEOVER && `${T6_VOTING_START - simHeight} blocks until voting opens`}
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
          <JumpButton label="Voting open" onClick={() => handleJump(T6_VOTING_START)} />
          <JumpButton label="Voting close" onClick={() => handleJump(T6_VOTING_END - 50)} />
          <JumpButton label="Claim window" onClick={() => handleJump(T6_CLAIM_START + 100)} />
          <JumpButton label="Handover − 100" onClick={() => handleJump(T6_TAKEOVER - 100)} />
          <JumpButton label="Handover" onClick={() => handleJump(T6_TAKEOVER)} />
          <JumpButton label="Mid-duty" onClick={() => handleJump(T6_TAKEOVER + 50_000)} />
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

              "Node claimed" tracking: cr_members.register_height is
              the block of each member's most recent TxRegisterCR /
              TxUpdateCR — which is the transaction that sets
              claimed_node. So register_height IS effectively "node
              claimed at block X". A member is "ready to take office"
              once register_height ≤ simHeight AND they have a
              non-zero registerHeight from the API. */}
          <ClaimNodeTracker
            claimBody={claimBody}
            simHeight={simHeight}
            takeoverHeight={status.newCouncilTakeoverHeight}
          />
          <CandidatesList
            candidates={claimBody}
            title={`Incoming Term ${status.targetTerm} council — final tally`}
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
        Tip: <FastForward size={10} className="inline" /> 2000× → full Term 6 cycle (voting + claim
        + duty) plays in about 2½ minutes. Use jump buttons to skip ahead.
      </p>
    </div>
  );
};

/**
 * ClaimNodeTracker — shows per-councilor node operational status
 * derived from real chain data:
 *
 *   - "Claimed" timestamp = `cr_members.register_height`. Block of
 *     the most recent TxRegisterCR/TxUpdateCR, which sets
 *     claimed_node. Tells us when the member declared which DPoS
 *     pubkey they'll run.
 *
 *   - "Online" timestamp = `firstActiveHeight`. First block at
 *     which their pubkey appeared in arbiter_turns.cr_pubkeys
 *     after voting closed. Tells us when their server actually
 *     came online and joined the consensus rotation.
 *
 * Status at simHeight:
 *   - simHeight < registerHeight  → Pending claim (rare; usually
 *                                    declared during voting)
 *   - registerHeight ≤ simHeight < firstActiveHeight (or no online
 *                                    yet) → Claimed but server offline
 *   - simHeight ≥ firstActiveHeight → Server live (in rotation)
 *
 * For T6: at simHeight = takeover, only ~2 of 12 are server-live;
 * the rest take days/weeks to come online (real chain history,
 * not approximation).
 */
function ClaimNodeTracker({
  claimBody,
  simHeight,
  takeoverHeight,
}: {
  claimBody: ElectionCandidate[];
  simHeight: number;
  takeoverHeight: number;
}) {
  const onlineCount = claimBody.filter(
    (c) => c.firstActiveHeight && c.firstActiveHeight <= simHeight,
  ).length;
  const claimedCount = claimBody.filter(
    (c) => (c.registerHeight ?? 0) > 0 && (c.registerHeight ?? 0) <= simHeight,
  ).length;

  // Sort by online-first then claimed-first so the "what's ready
  // now" rows surface to the top.
  const sorted = [...claimBody].sort((a, b) => {
    const aOn = a.firstActiveHeight && a.firstActiveHeight <= simHeight ? 0 : 1;
    const bOn = b.firstActiveHeight && b.firstActiveHeight <= simHeight ? 0 : 1;
    if (aOn !== bOn) return aOn - bOn;
    return (a.firstActiveHeight ?? Infinity) - (b.firstActiveHeight ?? Infinity);
  });

  return (
    <div className="card overflow-hidden">
      <div className="px-3 py-2.5 sm:px-5 sm:py-3 border-b border-[var(--color-border)] flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-primary">
          Node operational status &middot; {onlineCount} live / {claimedCount} claimed / {claimBody.length} elected
        </span>
        <span className="text-xs text-muted">
          Handover at block <span className="font-mono text-secondary">{takeoverHeight.toLocaleString()}</span>
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="table-clean w-full">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Councilor</th>
              <th style={{ textAlign: 'left' }}>Status</th>
              <th style={{ textAlign: 'right' }}>Claimed at</th>
              <th style={{ textAlign: 'right' }}>Server online at</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => {
              const claimed =
                (c.registerHeight ?? 0) > 0 && (c.registerHeight ?? 0) <= simHeight;
              const online =
                c.firstActiveHeight !== undefined && c.firstActiveHeight <= simHeight;
              let statusBadge: { label: string; cls: string };
              if (online) {
                statusBadge = { label: 'Server live', cls: 'bg-green-500/20 text-green-400' };
              } else if (claimed) {
                statusBadge = {
                  label: 'Claimed · server offline',
                  cls: 'bg-yellow-500/20 text-yellow-400',
                };
              } else {
                statusBadge = { label: 'Not yet claimed', cls: 'bg-muted/20 text-muted' };
              }
              return (
                <tr key={c.cid}>
                  <td style={{ textAlign: 'left' }}>
                    <span className="font-semibold text-primary text-xs">{c.nickname}</span>
                  </td>
                  <td style={{ textAlign: 'left' }}>
                    <span className={`badge whitespace-nowrap ${statusBadge.cls}`}>
                      {statusBadge.label}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {(c.registerHeight ?? 0) > 0 ? (
                      <span
                        className="font-mono text-xs text-secondary"
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                      >
                        block {(c.registerHeight ?? 0).toLocaleString()}
                      </span>
                    ) : (
                      <span className="text-muted text-xs">—</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {c.firstActiveHeight ? (
                      <span
                        className={`font-mono text-xs ${
                          online ? 'text-green-400' : 'text-muted'
                        }`}
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                      >
                        block {c.firstActiveHeight.toLocaleString()}
                      </span>
                    ) : (
                      <span className="text-muted text-xs">never</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

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
