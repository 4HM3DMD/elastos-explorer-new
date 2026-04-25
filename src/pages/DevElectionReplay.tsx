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

// Convert an elected ElectionCandidate (from the past-term endpoint)
// into the shape CouncilMembersTable expects (CRMember). Only the
// fields actually rendered by the table need to be real; the rest get
// safe defaults so TypeScript stops complaining and the JSX doesn't
// crash on missing optionals.
function candidateToMember(c: ElectionCandidate): CRMember {
  return {
    rank: c.rank,
    cid: c.cid,
    did: c.did ?? '',
    code: '',
    nickname: c.nickname,
    url: '',
    location: 0,
    state: 'Elected',
    votes: c.votes,
    depositAmount: '0',
    impeachmentVotes: '0',
    penalty: '0',
    registerHeight: 0,
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

  // Pick the right "live council members" array for the current phase:
  // - voting / claim / pre-voting (height < takeover) → Term 5 elected
  //   are still on duty.
  // - duty (height >= takeover) → Term 6 elected are now seated.
  const liveMembers = simHeight >= T6_TAKEOVER ? t6ElectedAsMembers : t5ElectedAsMembers;

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

  // Build the voting-body candidate list with real numbers from the
  // tally above. We start from the full Term 6 candidate roster (so
  // the table layout is stable), then overlay live votes/voterCount.
  // No "Elected" badges during voting — the node only locks elected
  // status when the voting window closes.
  const votingBody = useMemo(() => {
    if (phase !== 'voting' || t6Candidates.length === 0) return t6Candidates;
    const SELA_PER_ELA = 1e8;
    const enriched = t6Candidates.map((c) => {
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
    // Re-rank by current votes — the leaderboard reorders as
    // events arrive. Candidates with 0 votes drop to the bottom by
    // CID ASC tie-break.
    enriched.sort((a, b) => {
      const av = Number(a.votes);
      const bv = Number(b.votes);
      if (av !== bv) return bv - av;
      return a.cid.localeCompare(b.cid);
    });
    return enriched.map((c, i) => ({ ...c, rank: i + 1 }));
  }, [phase, t6Candidates, liveTally]);

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

      {/* Yellow simulator banner — make it impossible to mistake this for live data */}
      <div className="card border border-yellow-500/40 bg-yellow-500/10 p-4 flex items-start gap-3">
        <AlertTriangle size={18} className="text-yellow-400 flex-shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-primary mb-1">
            Election replay simulator — synthetic data
          </p>
          <p className="text-xs text-secondary">
            Replays Term 6's full lifecycle (voting → claim → duty) at accelerated speed using
            real candidate data fetched from the API. Nothing here reflects the live chain. For the
            real status, see <Link to="/governance" className="link-blue">/governance</Link>.
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
                <span> · {liveTally.eventCount} / {replayEvents.length} TxVoting events applied</span>
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
          <CandidatesList
            candidates={claimBody}
            title={`Incoming Term ${status.targetTerm} council`}
            emptyLabel="No incoming-council data"
          />
          <CouncilMembersTable
            members={liveMembers}
            loading={false}
            headline={`Current Term ${status.currentCouncilTerm} council (active until handover)`}
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
