import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import type { VoteHistoryEntry, AddressStaking } from '../types/blockchain';
import { VOTE_TYPE_NAMES } from '../types/blockchain';
import { Shield, Coins, CheckCircle, XCircle, ArrowRight, Lock, ExternalLink } from 'lucide-react';
import Pagination from './Pagination';
import StakeBar from './StakeBar';
import StatCard from './StatCard';
import RelativeTime from './RelativeTime';
import { formatEla } from '../utils/format';
import { getTermFromHeight, getElectionTargetTerm } from '../constants/governance';
import { cn } from '../lib/cn';

/** voteType 0 = Delegate (legacy DPoS), 1 = DAO Council, 2 = DAO Proposal, 3 = Council Impeachment, 4 = BPoS */
const VOTE_TYPE_STYLES: Record<number, string> = {
  0: 'bg-zinc-500/15 text-zinc-400',
  1: 'bg-violet-500/15 text-violet-400',
  2: 'bg-violet-500/15 text-violet-400',
  3: 'bg-red-500/15 text-red-400',
  4: 'bg-sky-500/15 text-sky-400',
};

const STAKING_VOTE_TYPES = new Set([0, 4]);
const GOVERNANCE_VOTE_TYPES = new Set([1, 2, 3]);

interface Props {
  address: string;
}

const VoteHistoryTimeline = ({ address }: Props) => {
  const [staking, setStaking] = useState<AddressStaking | null>(null);
  const [votes, setVotes] = useState<VoteHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [votesLoading, setVotesLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  // chainTip lets us render "Expired" for rows whose UTXO is still
  // unspent on-chain (is_active=TRUE) but whose lockTime has already
  // passed — a stake in that state still exists but no longer votes
  // for the validator, so calling it "Active" is misleading.
  const [chainTip, setChainTip] = useState(0);
  const pageSize = 20;

  const isStakeAddress = address.startsWith('S');

  useEffect(() => {
    let cancelled = false;
    blockchainApi.getStats()
      .then((s) => { if (!cancelled) setChainTip(s.latestHeight ?? 0); })
      .catch(() => { /* chainTip stays 0 → treat every lockTime as not-yet-expired */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    // Always fetch getAddressStaking — even for wallet (non-S) addresses.
    // For S-prefix addresses the response drives the stats grid / breakdown
    // / active-stakes list. For wallet addresses it drives the new
    // stake-address callout (via staking.stakeAddresses), which resolves
    // an E-wallet to its derived S-prefix stake identity so users can
    // reach /staking/{S-addr} from their wallet page. The existing
    // conditional guards below (`isStakeAddress && !loading && staking`)
    // still scope the stats sections to S-prefix pages, so nothing
    // irrelevant leaks into the wallet view.
    setLoading(true);
    blockchainApi.getAddressStaking(address)
      .then(setStaking)
      .catch(() => setStaking(null))
      .finally(() => setLoading(false));
  }, [address, isStakeAddress]);

  // Votes are stored against the origin wallet address, not the staking address
  const voteAddress = (isStakeAddress && staking?.originAddress) ? staking.originAddress : address;

  const fetchVotes = useCallback(async (p: number) => {
    setVotesLoading(true);
    try {
      const result = await blockchainApi.getAddressVoteHistory(voteAddress, p, pageSize, 'staking');
      setVotes(result.data ?? []);
      setTotal(result.total);
      setPage(p);
    } catch {
      setVotes([]);
    } finally {
      setVotesLoading(false);
    }
  }, [voteAddress]);

  // Fire votes fetch as soon as voteAddress is resolved, instead of
  // waiting for the staking fetch to complete. For wallet (E-prefix)
  // pages voteAddress === address from the first render, so votes
  // fetch IN PARALLEL with staking — two concurrent round-trips
  // instead of two sequential ones. For S-prefix pages we still need
  // staking.originAddress to resolve before we know which E-address
  // owns the votes, so we gate on `staking` there.
  useEffect(() => {
    if (isStakeAddress && !staking) return;
    fetchVotes(1);
  }, [fetchVotes, isStakeAddress, staking]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const fmtELA = (v: string | undefined) => formatEla(v ?? '0');

  // Truncate a stake address for inline display. Matches the
  // truncHash style used elsewhere on the page (first 10 chars …
  // last 6) so the branding feels uniform.
  const truncStake = (a: string) => `${a.slice(0, 10)}…${a.slice(-6)}`;

  return (
    <div className="space-y-6">
      {/* Stake-address callout — shown only on WALLET address pages
          (not on S-prefix pages, which ARE the staker) and only when
          the backend has derived at least one stake address from
          tx_vins for this wallet. One clickable row per address so a
          wallet with multiple stake identities renders cleanly.
          Mirrors the StakerDetail identity card's Wallet Address
          block, inverted: orange Lock tint + S-address, link routes
          to /staking/{S-addr}. Minimal on-brand, no duplicated data. */}
      {!isStakeAddress && !loading && staking?.stakeAddresses?.length ? (
        <div className="card p-3 sm:p-4 md:p-5 space-y-3">
          {staking.stakeAddresses.map((sa) => (
            <Link
              key={sa}
              to={`/staking/${encodeURIComponent(sa)}`}
              className="flex items-center gap-3 group"
            >
              <div
                className="w-[28px] h-[28px] md:w-[32px] md:h-[32px] rounded-[6px] flex items-center justify-center shrink-0"
                style={{ background: 'rgba(255, 159, 24, 0.12)' }}
              >
                <Lock size={14} className="text-brand" />
              </div>
              <div className="min-w-0 flex-1">
                <span className="text-[10px] uppercase tracking-wider text-muted block">
                  Stake Address
                </span>
                <span className="text-brand group-hover:text-brand-200 text-sm font-mono truncate block transition-colors">
                  {truncStake(sa)}
                </span>
              </div>
              <span
                className="text-[11px] text-muted group-hover:text-brand inline-flex items-center gap-1 shrink-0 transition-colors"
                aria-label={`View staker portfolio for ${sa}`}
              >
                <span className="hidden sm:inline">View portfolio</span>
                <ExternalLink size={12} />
              </span>
            </Link>
          ))}
        </div>
      ) : null}

      {isStakeAddress && !loading && staking && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              icon={Coins}
              label="Total Staked"
              value={`${fmtELA(staking.totalStaked || staking.totalLocked)} ELA`}
              color="blue"
            />
            <StatCard icon={Shield} label="Voting Rights" value={`${fmtELA(staking.totalStakingRights)} ELA`} color="green" />
            <StatCard icon={Coins} label="Claimable" value={`${fmtELA(staking.claimable)} ELA`} color="orange" />
            <StatCard icon={Coins} label="Total Rewards" value={`${fmtELA(staking.totalRewards)} ELA`} color="purple" />
          </div>

          {/* Pledged / Idle breakdown — matches the row in StakerDetail.
              Absent when voter_rights has no data for this address.
              Adds the shared StakeBar visual underneath the label row so
              the three places that show this data (Staking leaderboard,
              StakerDetail, here) all read the same. */}
          {staking.totalIdle && (
            <div className="surface-inset px-3 py-2.5 sm:px-4 sm:py-3 rounded-lg space-y-2">
              <div className="flex items-center gap-x-3 gap-y-1 text-xs flex-wrap">
                <span className="text-muted">Breakdown</span>
                <span className="text-muted opacity-40">&bull;</span>
                <span className="text-secondary">Pledged</span>
                <span
                  className="text-primary font-semibold font-mono"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {fmtELA(staking.totalPledged || staking.totalLocked)} ELA
                </span>
                <span className="text-muted opacity-40">&bull;</span>
                <span className="text-secondary">Idle</span>
                <span
                  className="text-accent-blue font-semibold font-mono"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                  title="Stake deposited but not currently pledged to a validator. Earns no rewards until voted."
                >
                  {fmtELA(staking.totalIdle)} ELA
                </span>
              </div>
              <StakeBar
                size="inline"
                pledged={staking.totalPledged || staking.totalLocked}
                idle={staking.totalIdle}
              />
            </div>
          )}

          {staking.stakes && staking.stakes.length > 0 && (
            <div className="card overflow-hidden">
              <div className="p-4 border-b border-[var(--color-border)]">
                <h3 className="text-sm font-semibold text-primary">
                  Active Stakes ({staking.activeVotes})
                </h3>
              </div>
              <div className="divide-y divide-[var(--color-border)]">
                {staking.stakes.map((s) => (
                  <div key={s.txid + s.candidateFull} className="flex flex-col sm:flex-row sm:items-center justify-between px-4 py-3 hover:bg-hover transition-colors gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {s.producerName ? (
                          <Link to={`/validator/${s.candidateFull}`} className="text-sm font-medium text-primary hover:text-brand">
                            {s.producerName}
                          </Link>
                        ) : (
                          <Link to={`/validator/${s.candidateFull}`} className="text-sm font-mono text-primary hover:text-brand">
                            {s.candidate}
                          </Link>
                        )}
                        <span className="badge bg-sky-500/15 text-sky-400 text-[10px]">BPoS</span>
                        <span className="text-[10px] text-accent-green font-medium inline-flex items-center gap-0.5">
                          <CheckCircle size={10} /> Counting
                        </span>
                      </div>
                      <Link to={`/tx/${s.txid}`} className="link-blue text-xs font-mono mt-0.5 block truncate">
                        {s.txid.slice(0, 16)}...
                      </Link>
                    </div>
                    <div className="text-right shrink-0 pl-8 sm:pl-0">
                      <p className="text-sm font-semibold text-primary" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtELA(s.amount)} ELA</p>
                      <p className="text-[11px] text-muted flex items-center justify-end gap-2">
                        <span>Rights: {fmtELA(s.votingRights)}</span>
                        <span className="inline-flex items-center gap-0.5"><Lock size={9} /> Unlocks #{s.lockTime.toLocaleString()}</span>
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <div className="card overflow-hidden">
        <div className="p-4 border-b border-[var(--color-border)] flex items-center justify-between">
          <h3 className="text-sm font-semibold text-primary">Vote History</h3>
          <span className="text-xs text-muted">{total.toLocaleString()} total</span>
        </div>

        {votesLoading ? (
          <div className="p-6 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-12 rounded bg-white/5 animate-pulse" />
            ))}
          </div>
        ) : votes.length === 0 ? (
          <p className="text-center text-muted py-8 text-sm">No vote history found for this address</p>
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {votes.map((v, i) => {
              const isStaking = STAKING_VOTE_TYPES.has(v.voteType);
              const isGovernance = GOVERNANCE_VOTE_TYPES.has(v.voteType);
              // voteType 1 = DAO Council election (elects UPCOMING term → offset formula)
              // voteType 2 = DAO Proposal review, voteType 3 = Council Impeachment (both during term)
              const term = v.voteType === 1
                ? getElectionTargetTerm(v.stakeHeight)
                : isGovernance ? getTermFromHeight(v.stakeHeight) : 0;
              // Two BPoS vote states on the UI (per operator rule):
              //   active — the stake (by original tx identity) is STILL live on-chain
              //            AND its current locktime is in the future
              //   ended  — everything else (either no longer on-chain, or locktime passed)
              //
              // For BPoSv2, the node treats renewals as preserving the original
              // tx's stake identity — so we ask bpos_stakes (refreshed from
              // the node every 60s) whether this txid is still an active
              // stake and, if so, use the CURRENT locktime (post renewals)
              // rather than the original one recorded in the votes row.
              // If currentLockTime is absent, fall back to v.lockTime and
              // v.isActive for the legacy check.
              const effectiveLockTime = v.currentLockTime ?? v.lockTime;
              const stillOnChain = v.currentLockTime !== undefined || v.isActive;
              const lockReached = chainTip > 0 && effectiveLockTime > 0 && chainTip >= effectiveLockTime;
              const showActiveBadge = isStaking && stillOnChain && !lockReached;
              const showEndedBadge  = isStaking && !showActiveBadge;

              return (
                <div key={`${v.txid}-${v.candidate}-${i}`} className="flex flex-col sm:flex-row sm:items-center justify-between px-4 py-3 hover:bg-hover transition-colors gap-2">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className={cn(
                      'w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5',
                      showActiveBadge ? 'bg-emerald-500/10'
                        : isGovernance ? 'bg-violet-500/10' : 'bg-zinc-500/10',
                    )}>
                      {showActiveBadge ? (
                        <CheckCircle size={16} className="text-accent-green" />
                      ) : showEndedBadge ? (
                        <XCircle size={16} className="text-muted" />
                      ) : (
                        <Shield size={14} className="text-violet-400" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded', VOTE_TYPE_STYLES[v.voteType] ?? VOTE_TYPE_STYLES[0])}>
                          {VOTE_TYPE_NAMES[v.voteType] ?? v.voteTypeName}
                        </span>
                        {term > 0 && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400">
                            Term {term}
                          </span>
                        )}
                        <span className="text-sm text-primary font-medium truncate">
                          {v.candidateName || v.candidate.slice(0, 16) + '...'}
                        </span>
                        {showActiveBadge && (
                          <span className="text-[10px] text-accent-green font-medium inline-flex items-center gap-0.5">
                            <CheckCircle size={10} /> Active
                          </span>
                        )}
                        {showEndedBadge && (
                          <span className="text-[10px] text-muted font-medium">Ended</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-wrap mt-0.5">
                        <Link to={`/tx/${v.txid}`} className="link-blue text-xs font-mono truncate">
                          {v.txid.slice(0, 20)}...
                        </Link>
                        {showEndedBadge && v.spentTxid && (
                          <Link
                            to={`/tx/${v.spentTxid}`}
                            className="text-[11px] text-secondary hover:text-brand inline-flex items-center gap-0.5 transition-colors"
                            title="View the withdrawal transaction that ended this vote"
                          >
                            Withdrawn{v.spentHeight ? ` at #${v.spentHeight.toLocaleString()}` : ''} <ArrowRight size={10} />
                          </Link>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="text-right shrink-0 sm:ml-3 pl-11 sm:pl-0">
                    <p className="text-sm font-semibold text-primary" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtELA(v.amount)} ELA</p>
                    <div className="flex items-center gap-2 justify-end mt-0.5 flex-wrap">
                      <span className="text-[11px] text-secondary">Block #{v.stakeHeight.toLocaleString()}</span>
                      {v.timestamp > 0 && (
                        <RelativeTime ts={v.timestamp} className="text-[11px] text-muted" />
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {totalPages > 1 && (
          <Pagination page={page} totalPages={totalPages} total={total} label="votes" onPageChange={(p) => { if (p >= 1 && p <= totalPages) fetchVotes(p); }} />
        )}
      </div>
    </div>
  );
};

export default VoteHistoryTimeline;
