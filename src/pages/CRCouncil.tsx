import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { blockchainApi } from '../services/api';
import type { CRMember } from '../types/blockchain';
import { CR_STATE_COLORS } from '../types/blockchain';
import { ExternalLink, FileText, ChevronDown, Users } from 'lucide-react';
import HashDisplay from '../components/HashDisplay';
import { formatVotes, safeExternalUrl } from '../utils/format';
import { cn } from '../lib/cn';
import { PageSkeleton } from '../components/LoadingSkeleton';
import SEO from '../components/SEO';

const NAV_TABS = [
  { label: 'Council Members', path: '/governance', active: true },
  { label: 'Proposals', path: '/governance/proposals', active: false },
] as const;

interface ElectionSummary {
  term: number;
  candidates: number;
  electedCount: number;
  totalVotes: string;
}

interface ElectionCandidate {
  rank: number;
  cid: string;
  did?: string;
  nickname: string;
  votes: string;
  voterCount: number;
  elected: boolean;
}

const CRCouncil = () => {
  const [members, setMembers] = useState<CRMember[]>([]);
  const [elections, setElections] = useState<ElectionSummary[]>([]);
  const [historicalCandidates, setHistoricalCandidates] = useState<ElectionCandidate[]>([]);
  const [selectedTerm, setSelectedTerm] = useState<number | null>(null);
  const [currentTerm, setCurrentTerm] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const fetchMembers = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [membersData, electionsData] = await Promise.all([
        blockchainApi.getCRMembers(),
        blockchainApi.getCRElections(),
      ]);
      setMembers(membersData);
      setElections(electionsData);
      if (electionsData.length > 0) {
        const latest = electionsData[0].term;
        setCurrentTerm(latest);
        if (selectedTerm === null) {
          setSelectedTerm(latest);
        }
      }
    } catch {
      setError('Failed to fetch Elastos DAO Council members');
    } finally {
      setLoading(false);
    }
  }, [selectedTerm]);

  const fetchHistoricalTerm = useCallback(async (term: number) => {
    try {
      setLoading(true);
      setError(null);
      const data = await blockchainApi.getCRElectionByTerm(term);
      setHistoricalCandidates(data.candidates.filter((c) => c.elected));
    } catch {
      setError(`Failed to fetch Term ${term} data`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMembers();
  }, [fetchMembers]);

  useEffect(() => {
    if (selectedTerm !== null && currentTerm !== null && selectedTerm !== currentTerm) {
      fetchHistoricalTerm(selectedTerm);
    }
  }, [selectedTerm, currentTerm, fetchHistoricalTerm]);

  const handleTermSelect = useCallback((term: number) => {
    setSelectedTerm(term);
    setDropdownOpen(false);
  }, []);

  const isCurrentTerm = selectedTerm === currentTerm;
  const termLabel = selectedTerm !== null ? `Term ${selectedTerm} Council` : 'Council';

  if (loading && members.length === 0 && historicalCandidates.length === 0) return <PageSkeleton />;

  if (error) {
    return (
      <div className="px-4 lg:px-6 py-6 text-center">
        <p className="text-accent-red mb-4">{error}</p>
        <button onClick={fetchMembers} className="btn-primary">Retry</button>
      </div>
    );
  }

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO title="Elastos DAO Council" description="Elastos DAO council members governing the Elastos network. View council terms, elected members, and voting data." path="/governance" />
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-[30px] h-[30px] md:w-[36px] md:h-[36px] rounded-[8px] flex items-center justify-center" style={{ background: 'rgba(255, 159, 24, 0.1)' }}>
            <Users size={16} className="text-brand" />
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em]">Elastos DAO Council</h1>
            <p className="text-[11px] md:text-xs text-muted tracking-[0.48px]">
              {isCurrentTerm ? members.length : historicalCandidates.length} {isCurrentTerm ? 'council members' : 'elected members'} &middot; {termLabel}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg p-0.5 border border-[var(--color-border)]">
            {NAV_TABS.map((tab) =>
              tab.active ? (
                <Link key={tab.path} to={tab.path} className="px-3 py-1.5 rounded-md text-xs font-medium bg-white text-black" aria-current="page">
                  {tab.label}
                </Link>
              ) : (
                <Link
                  key={tab.path}
                  to={tab.path}
                  className="px-3 py-1.5 rounded-md text-xs font-medium text-secondary hover:text-brand transition-colors inline-flex items-center gap-1.5"
                >
                  <FileText size={12} />
                  {tab.label}
                </Link>
              ),
            )}
          </div>
        </div>
      </div>

      {/* Table card */}
      <div className="card overflow-hidden">
        {/* Term selector */}
        {elections.length > 1 && (
          <div className="px-3 py-2.5 sm:px-5 sm:py-3 border-b border-[var(--color-border)] flex items-center justify-between">
            <span className="text-sm font-medium text-primary">{termLabel}</span>
            <div className="relative">
              <button
                onClick={() => setDropdownOpen(!dropdownOpen)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-muted hover:text-primary border border-[var(--color-border)] hover:border-[var(--color-border-hover)] transition-colors"
              >
                Term {selectedTerm}
                <ChevronDown size={12} className={cn('transition-transform', dropdownOpen && 'rotate-180')} />
              </button>
              {dropdownOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setDropdownOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 z-20 min-w-[140px] rounded-lg border border-[var(--color-border)] shadow-lg overflow-hidden" style={{ background: 'var(--color-surface)' }}>
                    {elections.map((e) => (
                      <button
                        key={e.term}
                        onClick={() => handleTermSelect(e.term)}
                        className={cn(
                          'w-full text-left px-3 py-2 text-xs transition-colors',
                          e.term === selectedTerm
                            ? 'bg-brand/10 text-brand font-medium'
                            : 'text-secondary hover:text-primary hover:bg-[var(--color-surface-hover)]',
                        )}
                      >
                        <span className="block">Term {e.term}</span>
                        <span className="block text-[10px] text-muted">{e.electedCount} elected · {Number(e.totalVotes).toLocaleString(undefined, { maximumFractionDigits: 0 })} ELA</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="table-clean w-full">
            <thead>
              <tr>
                <th className="w-16">#</th>
                <th>Member</th>
                {isCurrentTerm && <th className="hidden sm:table-cell">DID</th>}
                {isCurrentTerm && <th className="hidden md:table-cell">State</th>}
                <th>Elected By</th>
                {!isCurrentTerm && <th>Voters</th>}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 12 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: isCurrentTerm ? 5 : 4 }).map((_, j) => (
                      <td key={j}><div className="h-3 w-16 animate-shimmer rounded" /></td>
                    ))}
                  </tr>
                ))
              ) : isCurrentTerm ? (
                members.length === 0 ? (
                  <tr><td colSpan={5} className="py-12 text-center text-muted">No council members found</td></tr>
                ) : (
                  members.map((m) => {
                    const stateColor = CR_STATE_COLORS[m.state] || 'bg-gray-500/20 text-gray-400';
                    return (
                      <tr key={m.cid || m.did || `cr-${m.rank}`}>
                        <td>
                          <span className="font-bold text-xs text-secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>{m.rank}</span>
                        </td>
                        <td>
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-primary text-xs">{m.nickname || 'Unnamed'}</span>
                            {safeExternalUrl(m.url) && (
                              <a href={safeExternalUrl(m.url)!} target="_blank" rel="noopener noreferrer" className="text-muted hover:text-brand transition-colors">
                                <ExternalLink size={11} />
                              </a>
                            )}
                          </div>
                        </td>
                        {isCurrentTerm && (
                          <td className="hidden sm:table-cell">
                            <HashDisplay hash={m.did} length={10} showCopyButton={true} isClickable={false} />
                          </td>
                        )}
                        {isCurrentTerm && (
                          <td className="hidden md:table-cell">
                            <span className={cn('badge', stateColor)}>{m.state}</span>
                          </td>
                        )}
                        <td>
                          <span className="font-mono text-xs text-primary" style={{ fontVariantNumeric: 'tabular-nums' }}>{formatVotes(m.votes)} ELA</span>
                        </td>
                      </tr>
                    );
                  })
                )
              ) : (
                historicalCandidates.length === 0 ? (
                  <tr><td colSpan={4} className="py-12 text-center text-muted">No election data for this term</td></tr>
                ) : (
                  historicalCandidates.map((c) => (
                    <tr key={c.cid}>
                      <td>
                        <span className="font-bold text-xs text-secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>{c.rank}</span>
                      </td>
                      <td>
                        <span className="font-semibold text-primary text-xs">{c.nickname || 'Unnamed'}</span>
                      </td>
                      <td>
                        <span className="font-mono text-xs text-primary" style={{ fontVariantNumeric: 'tabular-nums' }}>{formatVotes(c.votes)} ELA</span>
                      </td>
                      <td>
                        <span className="font-mono text-xs text-muted" style={{ fontVariantNumeric: 'tabular-nums' }}>{c.voterCount} voters</span>
                      </td>
                    </tr>
                  ))
                )
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default CRCouncil;
