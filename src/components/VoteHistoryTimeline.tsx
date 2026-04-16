import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import type { VoteHistoryEntry, AddressStaking } from '../types/blockchain';
import { VOTE_TYPE_NAMES } from '../types/blockchain';
import { Shield, Coins, Clock, CheckCircle, XCircle } from 'lucide-react';
import Pagination from './Pagination';
import StatCard from './StatCard';
import { formatEla, fmtTime } from '../utils/format';
import { cn } from '../lib/cn';

const VOTE_TYPE_STYLES: Record<number, string> = {
  0: 'bg-zinc-500/15 text-zinc-400',
  1: 'bg-violet-500/15 text-violet-400',
  2: 'bg-violet-500/15 text-violet-400',
  3: 'bg-red-500/15 text-red-400',
  4: 'bg-sky-500/15 text-sky-400',
};

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
  const pageSize = 20;

  const isStakeAddress = address.startsWith('S');

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
            <StatCard icon={Coins} label="Total Staked" value={`${fmtELA(staking.totalLocked)} ELA`} color="blue" />
            <StatCard icon={Shield} label="Voting Rights" value={`${fmtELA(staking.totalStakingRights)} ELA`} color="green" />
            <StatCard icon={Coins} label="Claimable" value={`${fmtELA(staking.claimable)} ELA`} color="orange" />
            <StatCard icon={Coins} label="Total Rewards" value={`${fmtELA(staking.totalRewards)} ELA`} color="purple" />
          </div>

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
                        <span className="text-sm font-medium text-primary">{s.producerName || s.candidate}</span>
                        <span className="badge bg-sky-500/15 text-sky-400 text-[10px]">BPoS</span>
                      </div>
                      <Link to={`/tx/${s.txid}`} className="link-blue text-xs font-mono mt-0.5 block truncate">
                        {s.txid.slice(0, 16)}...
                      </Link>
                    </div>
                    <div className="text-right shrink-0 pl-8 sm:pl-0">
                      <p className="text-sm font-semibold text-primary">{fmtELA(s.amount)} ELA</p>
                      <p className="text-[11px] text-muted">
                        Rights: {fmtELA(s.votingRights)} &middot; Lock: {s.lockTime.toLocaleString()} blocks
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
              const isBPoS = v.voteType === 0 || v.voteType === 4;
              return (
              <div key={`${v.txid}-${v.candidate}-${i}`} className="flex flex-col sm:flex-row sm:items-center justify-between px-4 py-3 hover:bg-hover transition-colors gap-2">
                <div className="flex items-start gap-3 min-w-0">
                  <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5', isBPoS && v.isActive ? 'bg-emerald-500/10' : 'bg-zinc-500/10')}>
                    {isBPoS && v.isActive ? <CheckCircle size={16} className="text-accent-green" /> : <XCircle size={16} className="text-muted" />}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded', VOTE_TYPE_STYLES[v.voteType] ?? VOTE_TYPE_STYLES[0])}>
                        {VOTE_TYPE_NAMES[v.voteType] ?? v.voteTypeName}
                      </span>
                      <span className="text-sm text-primary font-medium truncate">
                        {v.candidateName || v.candidate.slice(0, 16) + '...'}
                      </span>
                      {isBPoS && v.isActive && <span className="text-[10px] text-accent-green font-medium">Active</span>}
                      {isBPoS && !v.isActive && <span className="text-[10px] text-muted">Spent</span>}
                    </div>
                    <Link to={`/tx/${v.txid}`} className="link-blue text-xs font-mono mt-0.5 block truncate">
                      {v.txid.slice(0, 20)}...
                    </Link>
                  </div>
                </div>
                <div className="text-right shrink-0 sm:ml-3 pl-11 sm:pl-0">
                  <p className="text-sm font-semibold text-primary">{fmtELA(v.amount)} ELA</p>
                  <div className="flex items-center gap-2 justify-end mt-0.5">
                    <span className="text-[11px] text-secondary">Block #{v.stakeHeight.toLocaleString()}</span>
                    {v.timestamp > 0 && (
                      <span className="text-[11px] text-muted"><Clock size={9} className="inline mr-0.5" />{fmtTime(v.timestamp)}</span>
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
