import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import type { VoteHistoryEntry, AddressStaking } from '../types/blockchain';
import { VOTE_TYPE_NAMES } from '../types/blockchain';
import { Shield, Coins, CheckCircle, XCircle, ArrowRight, Lock } from 'lucide-react';
import Pagination from './Pagination';
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
    if (!isStakeAddress) {
      setStaking(null);
      setLoading(false);
      return;
    }
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

  useEffect(() => { if (!loading) fetchVotes(1); }, [fetchVotes, loading]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const fmtELA = (v: string | undefined) => formatEla(v ?? '0');

  return (
    <div className="space-y-6">
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
              Absent when voter_rights has no data for this address. */}
          {staking.totalIdle && (
            <div className="surface-inset px-3 py-2.5 sm:px-4 sm:py-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs rounded-lg">
              <span className="text-muted">Breakdown</span>
              <span className="text-muted opacity-40">&bull;</span>
              <span className="text-secondary">Pledged</span>
              <span className="text-primary font-semibold font-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
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
              // Three BPoS vote states on the UI:
              //   active   — UTXO unspent AND lockTime still in the future → counts for validator
              //   expired  — UTXO unspent BUT lockTime has passed         → no longer counting, withdrawable
              //   ended    — UTXO spent by a later tx (renewal or return) → vote is historically done
              // The backend's v.isActive tracks UTXO spent state only; combining it with chainTip vs
              // lockTime gives the three-way split the user actually cares about.
              const lockExpired = chainTip > 0 && v.lockTime > 0 && chainTip >= v.lockTime;
              const showActiveBadge  = isStaking && v.isActive && !lockExpired;
              const showExpiredBadge = isStaking && v.isActive && lockExpired;
              const showEndedBadge   = isStaking && !v.isActive;

              return (
                <div key={`${v.txid}-${v.candidate}-${i}`} className="flex flex-col sm:flex-row sm:items-center justify-between px-4 py-3 hover:bg-hover transition-colors gap-2">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className={cn(
                      'w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5',
                      showActiveBadge ? 'bg-emerald-500/10'
                        : showExpiredBadge ? 'bg-amber-500/10'
                        : isGovernance ? 'bg-violet-500/10' : 'bg-zinc-500/10',
                    )}>
                      {showActiveBadge ? (
                        <CheckCircle size={16} className="text-accent-green" />
                      ) : showExpiredBadge ? (
                        <Lock size={14} className="text-amber-400" />
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
                        {showExpiredBadge && (
                          <span
                            className="text-[10px] text-amber-400 font-medium inline-flex items-center gap-0.5"
                            title={`Lock expired at block #${v.lockTime.toLocaleString()} — UTXO still unspent, withdrawable`}
                          >
                            <Lock size={10} /> Expired
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
