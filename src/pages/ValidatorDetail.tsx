import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import type { Producer, ProducerDetail, ProducerStaker } from '../types/blockchain';
import { PRODUCER_STATE_COLORS } from '../types/blockchain';
import {
  Globe, ExternalLink, Users, Shield, ArrowLeft, Hash,
  Layers, Lock, Activity,
} from 'lucide-react';
import HashDisplay from '../components/HashDisplay';
import NodeAvatar from '../components/NodeAvatar';
import Pagination from '../components/Pagination';
import { PageSkeleton } from '../components/LoadingSkeleton';
import { getLocation, formatVotes, fmtEla, safeExternalUrl } from '../utils/format';
import { cn } from '../lib/cn';
import SEO from '../components/SEO';
import Breadcrumb from '../components/Breadcrumb';
import { getRegistrationBadge } from '../utils/validatorBadge';

function getStateDisplay(p: Pick<Producer, 'registrationType' | 'isCouncil' | 'state'>): { label: string; cls: string } {
  if (p.registrationType === 'Council Node') {
    return { label: 'Elected', cls: 'bg-green-500/20 text-green-400' };
  }
  if (p.isCouncil && p.state === 'Inactive') {
    return { label: 'Council', cls: 'bg-purple-500/20 text-purple-400' };
  }
  const cls = PRODUCER_STATE_COLORS[p.state] || 'bg-gray-500/20 text-gray-400';
  return { label: p.state, cls };
}

const STAKERS_PAGE_SIZE = 50;

const ValidatorDetail = () => {
  const { ownerPubKey } = useParams<{ ownerPubKey: string }>();
  const [producer, setProducer] = useState<ProducerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stakerPage, setStakerPage] = useState(1);
  const [paginatedStakers, setPaginatedStakers] = useState<ProducerStaker[]>([]);
  const [stakerTotal, setStakerTotal] = useState(0);
  const [stakersLoading, setStakersLoading] = useState(false);
  const [stakerError, setStakerError] = useState<string | null>(null);

  useEffect(() => {
    if (!ownerPubKey) { setLoading(false); setError('Invalid validator key'); return; }
    const controller = new AbortController();
    setLoading(true); setError(null); setProducer(null);
    blockchainApi.getProducerDetail(ownerPubKey)
      .then(data => { if (!controller.signal.aborted) setProducer(data); })
      .catch(() => { if (!controller.signal.aborted) setError('Failed to load validator details'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [ownerPubKey]);

  const fetchStakers = useCallback(async (page: number) => {
    if (!ownerPubKey) return;
    try {
      setStakersLoading(true);
      setStakerError(null);
      const res = await blockchainApi.getProducerStakers(ownerPubKey, page, STAKERS_PAGE_SIZE);
      setPaginatedStakers(res.data);
      setStakerTotal(res.total);
    } catch {
      setPaginatedStakers([]);
      setStakerTotal(0);
      setStakerError('Failed to load stakers');
    } finally {
      setStakersLoading(false);
    }
  }, [ownerPubKey]);

  useEffect(() => { if (producer) fetchStakers(stakerPage); }, [producer, stakerPage, fetchStakers]);

  const stakerTotalPages = Math.max(1, Math.ceil(stakerTotal / STAKERS_PAGE_SIZE));

  if (loading) return <PageSkeleton />;

  if (error || !producer) {
    return (
      <div className="px-4 lg:px-6 py-8 text-center">
        <p className="text-accent-red mb-4">{error ?? 'Validator not found'}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/validators" className="text-xs text-muted hover:text-brand transition-colors flex items-center gap-1">
            <ArrowLeft size={12} /> Back to Validators
          </Link>
          <button onClick={() => window.location.reload()} className="btn-primary">Retry</button>
        </div>
      </div>
    );
  }

  const loc = getLocation(producer.location);
  const badge = getRegistrationBadge(producer);
  const stateDisplay = getStateDisplay(producer);

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO
        title={producer ? `Validator ${producer.nickname || 'Details'}` : 'Validator Details'}
        description={producer ? `${producer.nickname || 'Validator'} on the Elastos (ELA) network with ${formatVotes(producer.dposV2Votes)} ELA in votes.` : 'Validator details on the Elastos network.'}
        path={`/validator/${ownerPubKey}`}
      />
      <Breadcrumb
        root={{ label: 'Validators', to: '/validators' }}
        rootIcon={Shield}
        items={[{ label: producer?.nickname || 'Validator' }]}
      />
      {/* Page header card */}
      <div className="card relative overflow-hidden p-4 md:p-6">
        <div className="absolute top-0 left-0 right-0 h-[6px] md:h-[8px]" style={{ background: 'radial-gradient(ellipse 40% 100% at 15% 0%, rgba(246,146,26,0.25) 0%, transparent 100%)' }} />
        <div className="absolute top-0 left-0 w-[40%] h-[1px]" style={{ background: 'linear-gradient(90deg, rgba(246,146,26,0.7) 0%, rgba(246,146,26,0.15) 100%)' }} />
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3 sm:gap-4">
            <NodeAvatar ownerPubKey={producer.ownerPublicKey} nickname={producer.nickname || 'Unnamed'} size={44} />
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em]">
                  {producer.nickname || 'Unnamed Validator'}
                </h1>
                <span className={cn('badge', stateDisplay.cls)}>{stateDisplay.label}</span>
                <span className={badge.cls}>{badge.label}</span>
              </div>
              <div className="flex items-center gap-2 mt-0.5 text-[11px] md:text-xs text-muted tracking-[0.48px]">
                <span>Rank #{producer.rank}</span>
                <span>&middot;</span>
                <span>{loc.flag} {loc.name}</span>
                {safeExternalUrl(producer.url) && (
                  <>
                    <span>&middot;</span>
                    <a href={safeExternalUrl(producer.url)!} target="_blank" rel="noopener noreferrer" className="text-brand hover:text-brand-200 inline-flex items-center gap-1">
                      {producer.url} <ExternalLink size={10} />
                    </a>
                  </>
                )}
              </div>
            </div>
          </div>
          <Link to="/validators" className="text-xs text-muted hover:text-brand transition-colors flex items-center gap-1">
            <ArrowLeft size={12} /> All Validators
          </Link>
        </div>
      </div>

      {/* Public keys */}
      <div className="card p-3 md:p-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-muted uppercase tracking-wider">Owner Public Key</span>
            <HashDisplay hash={producer.ownerPublicKey} length={14} showCopyButton />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-muted uppercase tracking-wider">Node Public Key</span>
            <HashDisplay hash={producer.nodePublicKey} length={14} showCopyButton />
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 md:gap-3">
        <MiniStat icon={Hash} label="Register Height" value={producer.registerHeight.toLocaleString()} />
        <MiniStat icon={Shield} label="BPoS Staking Rights" value={formatVotes(producer.dposV2Votes)} />
        <MiniStat icon={Layers} label="BPoS Legacy Votes" value={`${formatVotes(producer.dposV1Votes)} ELA`} />
        <MiniStat icon={Users} label="Staker Count" value={producer.stakerCount.toLocaleString()} />
        <MiniStat icon={Lock} label="Stake Until" value={producer.stakeUntil > 0 ? `#${producer.stakeUntil.toLocaleString()}` : 'N/A'} />
      </div>

      {/* Stakers table */}
      <div className="card overflow-hidden relative">
        <div className="absolute top-0 left-0 right-0 h-[6px]" style={{ background: 'radial-gradient(ellipse 40% 100% at 15% 0%, rgba(246,146,26,0.15) 0%, transparent 100%)' }} />
        <div className="absolute top-0 left-0 w-[30%] h-[1px]" style={{ background: 'linear-gradient(90deg, rgba(246,146,26,0.5) 0%, transparent 100%)' }} />
        <div className="px-3 py-2.5 sm:px-5 sm:py-3 border-b border-[var(--color-border)] flex items-center justify-between">
          <h2 className="text-sm md:text-base font-medium text-primary flex items-center gap-2">
            <Activity size={15} className="text-brand" /> Stakers
            <span className="text-[10px] font-semibold text-brand bg-brand/10 px-2 py-0.5 rounded-full" style={{ fontVariantNumeric: 'tabular-nums' }}>{stakerTotal.toLocaleString()}</span>
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="table-clean w-full">
            <thead>
              <tr>
                <th>Address</th>
                <th>Staked ELA</th>
                <th className="hidden sm:table-cell">Voting Rights</th>
                <th className="hidden md:table-cell">Expiry Height</th>
                <th className="hidden lg:table-cell">Txid</th>
              </tr>
            </thead>
            <tbody>
              {stakersLoading ? (
                Array.from({ length: STAKERS_PAGE_SIZE }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 5 }).map((_, j) => (
                      <td key={j}><div className="h-3 w-20 animate-shimmer rounded" /></td>
                    ))}
                  </tr>
                ))
              ) : stakerError ? (
                <tr><td colSpan={5} className="py-12 text-center"><span className="text-accent-red text-sm">{stakerError}</span><button onClick={() => fetchStakers(stakerPage)} className="ml-3 text-sm text-brand hover:text-brand-200">Retry</button></td></tr>
              ) : paginatedStakers.length === 0 ? (
                <tr><td colSpan={5} className="py-12 text-center text-muted">No stakers found</td></tr>
              ) : (
                paginatedStakers.map((staker) => (
                  <tr key={`${staker.txid}-${staker.address}`}>
                    <td>
                      <Link to={`/staking/${encodeURIComponent(staker.address)}`} className="text-brand hover:text-brand-200 text-xs font-mono truncate block max-w-[180px]">
                        {staker.address}
                      </Link>
                    </td>
                    <td><span className="font-mono text-xs text-primary" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtEla(staker.amount, { compact: true })} ELA</span></td>
                    <td className="hidden sm:table-cell"><span className="font-mono text-xs text-accent-blue" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtEla(staker.stakingRights, { compact: true })}</span></td>
                    <td className="hidden md:table-cell"><span className="text-xs text-secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>{staker.expiryHeight > 0 ? staker.expiryHeight.toLocaleString() : 'N/A'}</span></td>
                    <td className="hidden lg:table-cell">
                      <Link to={`/tx/${staker.txid}`} className="text-brand/70 hover:text-brand text-xs font-mono">
                        {staker.txid.slice(0, 10)}…{staker.txid.slice(-4)}
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {stakerTotalPages > 1 && (
          <Pagination page={stakerPage} totalPages={stakerTotalPages} total={stakerTotal} label="stakers" onPageChange={(p) => { if (p >= 1 && p <= stakerTotalPages) setStakerPage(p); }} />
        )}
      </div>
    </div>
  );
};

function MiniStat({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="card p-2 md:p-3 relative overflow-hidden">
      <div className="absolute left-0 top-[20%] bottom-[20%] w-[2px] rounded-r-full bg-brand/40" />
      <div className="flex items-center gap-2 pl-1.5">
        <div className="w-[22px] h-[22px] md:w-[28px] md:h-[28px] rounded-[5px] flex items-center justify-center shrink-0" style={{ background: 'rgba(255, 159, 24, 0.1)' }}>
          <Icon size={13} className="text-brand" />
        </div>
        <div className="min-w-0">
          <p className="text-[9px] md:text-[11px] text-muted tracking-[0.3px] md:tracking-[0.48px]">{label}</p>
          <p className="text-[11px] md:text-sm font-semibold text-primary truncate" style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</p>
        </div>
      </div>
    </div>
  );
}

export default ValidatorDetail;
