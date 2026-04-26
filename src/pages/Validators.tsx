import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import type { Producer } from '../types/blockchain';
import { PRODUCER_STATE_COLORS } from '../types/blockchain';
import { Globe, Shield } from 'lucide-react';
import { PageSkeleton } from '../components/LoadingSkeleton';
import NodeAvatar from '../components/NodeAvatar';
import { getLocation, formatVotes } from '../utils/format';
import { cn } from '../lib/cn';
import SEO from '../components/SEO';
import { getRegistrationBadge } from '../utils/validatorBadge';

const PRODUCER_TABS = [
  { label: 'Active', value: 'Active' },
  { label: 'Inactive', value: 'Inactive' },
  { label: 'Illegal', value: 'Illegal' },
  { label: 'All', value: 'all' },
] as const;

const VISIBLE_STATES = new Set(['Active', 'Inactive', 'Illegal']);

// Badge logic moved to `src/utils/validatorBadge.ts` so the list and
// detail pages render the same producer with the same label. See the
// note there for the historical drift this removes.

const Validators = () => {
  const [producers, setProducers] = useState<Producer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>('Active');

  const fetchProducers = useCallback(async (state: string) => {
    try {
      setLoading(true);
      setError(null);
      const data = await blockchainApi.getProducers(state);
      const filtered = state === 'all'
        ? data.filter((p: Producer) => VISIBLE_STATES.has(p.state))
        : data;
      setProducers(filtered);
    } catch {
      setError('Failed to fetch validators');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProducers(activeTab);
  }, [activeTab, fetchProducers]);

  if (loading && producers.length === 0) return <PageSkeleton />;

  if (error) {
    return (
      <div className="px-4 lg:px-6 py-6 text-center">
        <p className="text-accent-red mb-4">{error}</p>
        <button onClick={() => fetchProducers(activeTab)} className="btn-primary">Retry</button>
      </div>
    );
  }

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO title="Validators" description="BPoS validators securing the Elastos (ELA) network. View active, inactive, and illegal validators with their vote counts." path="/validators" />
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-[30px] h-[30px] md:w-[36px] md:h-[36px] rounded-[8px] flex items-center justify-center" style={{ background: 'rgba(255, 159, 24, 0.1)' }}>
            <Shield size={16} className="text-brand" />
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em]">BPoS Validators</h1>
            <p className="text-[11px] md:text-xs text-muted tracking-[0.48px]">{producers.length} validators &middot; Ranked by BPoS votes</p>
          </div>
        </div>
        <div className="flex items-center gap-1 rounded-lg p-0.5 border border-[var(--color-border)]" role="tablist" aria-label="Validator state filter">
          {PRODUCER_TABS.map((tab) => (
            <button
              key={tab.value}
              role="tab"
              aria-selected={activeTab === tab.value}
              onClick={() => setActiveTab(tab.value)}
              className={cn(
                'px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-200',
                activeTab === tab.value
                  ? 'bg-white text-black'
                  : 'text-secondary hover:text-primary'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table card */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-clean w-full">
            <thead>
              <tr>
                <th className="w-16">Rank</th>
                <th>Nickname</th>
                <th className="hidden sm:table-cell">Type</th>
                <th>BPoS Votes</th>
                <th className="hidden md:table-cell">State</th>
                <th className="hidden lg:table-cell"><div className="flex items-center gap-1"><Globe size={13} />Location</div></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 20 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 6 }).map((_, j) => (
                      <td key={j}><div className="h-3 w-20 animate-shimmer rounded" /></td>
                    ))}
                  </tr>
                ))
              ) : producers.length === 0 ? (
                <tr><td colSpan={6} className="py-12 text-center text-muted">No validators found</td></tr>
              ) : (
                producers.map((p) => {
                  const loc = getLocation(p.location);
                  const badge = getRegistrationBadge(p);
                  const stateColor = PRODUCER_STATE_COLORS[p.state] || 'bg-gray-500/20 text-gray-400';

                  return (
                    <tr key={p.ownerPublicKey}>
                      <td>
                        <span className={`font-bold text-xs ${p.rank <= 3 ? 'text-brand' : 'text-secondary'}`} style={{ fontVariantNumeric: 'tabular-nums' }}>#{p.rank}</span>
                      </td>
                      <td>
                        <div className="flex items-center gap-2.5">
                          <NodeAvatar ownerPubKey={p.ownerPublicKey} nickname={p.nickname || 'Unnamed'} size={28} />
                          <Link to={`/validator/${encodeURIComponent(p.ownerPublicKey)}`} className="text-brand hover:text-brand-200 font-semibold text-xs">
                            {p.nickname || 'Unnamed'}
                          </Link>
                        </div>
                      </td>
                      <td className="hidden sm:table-cell">
                        <span className={badge.cls}>{badge.label}</span>
                      </td>
                      <td>
                        <span className="font-mono text-xs text-primary" style={{ fontVariantNumeric: 'tabular-nums' }}>{formatVotes(p.dposV2Votes)} ELA</span>
                      </td>
                      <td className="hidden md:table-cell">
                        <span className={cn('badge', stateColor)}>{p.state}</span>
                      </td>
                      <td className="hidden lg:table-cell">
                        <span className="text-secondary text-xs" title={loc.name}>
                          {loc.flag} {loc.name}
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default Validators;
