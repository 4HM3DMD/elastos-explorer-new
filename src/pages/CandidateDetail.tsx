// CandidateDetail — full per-candidate council-member profile.
//
// Sections (top → bottom):
//   1. Hero: nickname · country · Elected/State badges · back nav
//   2. Multi-term participation strip (if elected in >1 terms)
//   3. Identity card (CID, DID, DPoS keys, deposit, country, dates)
//   4. Election stats (this term): Rank · Votes · Voters · Register · Deposit · Penalty
//   5. Governance record: tenure summary · OpinionBar · last 10 reviews
//   6. Voters table: full address + copy + collapse multi-tx voters
//
// All data is real. The /cr/members/{cid}/profile endpoint provides
// the full roll-up; per-term voters come from /cr/elections/{term}/
// voters/{cid}; per-voter expand fetches /…/voters/{cid}/{addr}/history.
//
// Term-agnostic — every section reads via formula or by-cid query.
// T7/T8 candidates render identically.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  Activity, ArrowLeft, Coins, ChevronDown, ChevronRight,
  Copy, Check, ExternalLink, Hash, Landmark, ScrollText, ShieldCheck,
  ThumbsUp, ThumbsDown, Scale, Trophy, Users, X, XCircle,
} from 'lucide-react';
import { blockchainApi } from '../services/api';
import type {
  CandidateProfile,
  CandidateProfileTerm,
  CandidateRecentReview,
  CandidateReview,
  CandidateVoter,
  VoterTxHistoryEntry,
} from '../types/blockchain';
import { CR_STATE_COLORS, crStateDisplayLabel } from '../types/blockchain';
import { cn } from '../lib/cn';
import { PageSkeleton, Skeleton } from '../components/LoadingSkeleton';
import SEO from '../components/SEO';
import HashDisplay from '../components/HashDisplay';
import Pagination from '../components/Pagination';
import OpinionBar from '../components/OpinionBar';
import { formatVotes, safeExternalUrl, getLocation } from '../utils/format';
import { copyToClipboard } from '../utils/clipboard';
import { BLOCK_TIME_SECONDS } from '../constants/governance';
import GovernanceBreadcrumb from '../components/GovernanceBreadcrumb';

const PAGE_SIZE = 25;

const CandidateDetail = () => {
  // Two URL shapes both land here:
  //   /governance/candidate/:cid                  (canonical, flat)
  //   /governance/elections/:term/candidate/:cid  (legacy — redirected to flat by App.tsx)
  // The flat URL accepts ?term=N as a query param to highlight a
  // specific term in the multi-term pills. Without one, default to
  // the candidate's most-recent term once their profile loads.
  const { term: termParam, cid } = useParams<{ term?: string; cid: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryTerm = searchParams.get('term');
  const explicitTerm = Number(termParam ?? queryTerm);
  const [resolvedTerm, setResolvedTerm] = useState<number>(
    Number.isFinite(explicitTerm) && explicitTerm > 0 ? explicitTerm : 0,
  );
  const term = resolvedTerm;

  const [profile, setProfile] = useState<CandidateProfile | null>(null);
  const [voters, setVoters] = useState<CandidateVoter[]>([]);
  const [voterTotal, setVoterTotal] = useState(0);
  const [voterPage, setVoterPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [votersLoading, setVotersLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Profile (single roll-up across terms + governance). Keyed on cid
  // ONLY — the term param doesn't change what comes back, so re-firing
  // this effect on every pill click would needlessly cancel-and-restart
  // the same fetch and flash the page skeleton between clicks.
  // We read `resolvedTerm` via ref inside the .then() so the bootstrap
  // path (default to latest term when URL has none) still works without
  // making `resolvedTerm` a dep.
  const resolvedTermRef = useRef(resolvedTerm);
  useEffect(() => {
    resolvedTermRef.current = resolvedTerm;
  }, [resolvedTerm]);

  useEffect(() => {
    if (!cid) {
      setError('Invalid candidate');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    blockchainApi
      .getCandidateProfile(cid)
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        // If the URL didn't carry an explicit term (flat URL with no
        // ?term= query param), default to the candidate's most-recent
        // participation. The terms array comes back ASC-sorted from
        // the backend, so the last element is the latest. This makes
        // /governance/candidate/{cid} a useful entry point on its own.
        if (!resolvedTermRef.current && p.terms.length > 0) {
          const latest = p.terms[p.terms.length - 1].term;
          setResolvedTerm(latest);
        }
      })
      .catch(() => {
        if (!cancelled) setError('Candidate profile unavailable');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cid]);

  // Sync the URL's `?term=` (or legacy `:term` segment) BACK into
  // local state when it changes. Without this, clicking a TermPill
  // updates the URL but `useState` only ran once on mount, so the
  // page stays stuck on whatever term it first resolved to.
  useEffect(() => {
    if (!Number.isFinite(explicitTerm) || explicitTerm <= 0) return;
    if (explicitTerm === resolvedTerm) return;
    setResolvedTerm(explicitTerm);
  }, [explicitTerm, resolvedTerm]);

  // BOOTSTRAP-ONLY URL writer. When the user lands on the flat URL
  // /governance/candidate/{cid} with no ?term=, the profile-fetch
  // effect picks the candidate's latest term and stores it in state.
  // We mirror that into the URL once so the page is bookmarkable,
  // but ONLY in the bootstrap case (queryTerm absent). If we ran
  // unconditionally, every pill click would race: the user navigates
  // to ?term=3, this effect reads stale resolvedTerm=6, writes URL
  // back to ?term=6, undoing the click. Past test sessions hit
  // exactly that infinite-loading-loop.
  useEffect(() => {
    if (!resolvedTerm) return;
    if (queryTerm) return;        // URL already has a term — never overwrite
    if (termParam) return;        // legacy URL — App.tsx already redirected
    const next = new URLSearchParams(searchParams);
    next.set('term', String(resolvedTerm));
    setSearchParams(next, { replace: true });
  }, [resolvedTerm, queryTerm, termParam, searchParams, setSearchParams]);

  // Voters for THIS term
  const fetchVoters = useCallback(
    async (page: number) => {
      if (!cid || !Number.isFinite(term) || term < 1) return;
      try {
        setVotersLoading(true);
        const res = await blockchainApi.getCRCandidateVoters(term, cid, page, PAGE_SIZE);
        setVoters(res.data);
        setVoterTotal(res.total);
      } catch {
        /* keep page useful even if voter list fails */
      } finally {
        setVotersLoading(false);
      }
    },
    [term, cid],
  );

  useEffect(() => {
    fetchVoters(voterPage);
  }, [fetchVoters, voterPage]);

  // Reset to page 1 when term changes
  useEffect(() => {
    setVoterPage(1);
  }, [term]);

  const voterTotalPages = Math.max(1, Math.ceil(voterTotal / PAGE_SIZE));

  // The term being VIEWED — find its row in the cross-term list, if any
  const thisTerm: CandidateProfileTerm | null = useMemo(() => {
    if (!profile) return null;
    return profile.terms.find((t) => t.term === term) ?? null;
  }, [profile, term]);

  if (loading) return <PageSkeleton />;
  if (error || !profile) {
    // The back link can't always say "Back to Term N" — if the URL had
    // no `?term=` and the profile fetch failed before we could pick a
    // default, `term` is still 0. Fall back to the governance landing
    // in that case so the user has a working escape route.
    const backTo = term > 0 ? `/governance/elections/${term}` : '/governance';
    const backLabel = term > 0 ? `Back to Term ${term}` : 'Back to governance';
    return (
      <div className="px-4 lg:px-6 py-6 text-center">
        <p className="text-accent-red mb-4">{error || 'Profile unavailable'}</p>
        <Link to={backTo} className="btn-primary inline-block">
          {backLabel}
        </Link>
      </div>
    );
  }

  const m = profile.member;
  const externalUrl = safeExternalUrl(m.url);
  const country = m.location > 0 ? getLocation(m.location) : null;
  const stateBadgeColor = m.state ? CR_STATE_COLORS[m.state] ?? 'bg-gray-500/20 text-gray-400' : '';

  const penaltyEla = Number(m.penalty || 0);
  const impeachmentEla = Number(m.impeachmentVotes || 0);
  const showPenalty = penaltyEla > 0;
  const showImpeachment = impeachmentEla > 0;

  return (
    <div className="px-4 lg:px-6 py-6 space-y-6">
      <SEO
        title={`${m.nickname || 'Candidate'} · Term ${term}`}
        description={`Council member ${m.nickname} — Term ${term} stats, governance record, and voter list.`}
        path={`/governance/candidate/${cid}`}
      />

      <GovernanceBreadcrumb
        items={[
          { label: `Term ${term}`, to: `/governance/elections/${term}` },
          { label: m.nickname || 'Candidate' },
        ]}
      />

      {/* 1. HERO */}
      <div className="card relative overflow-hidden p-4 sm:p-5 md:p-6">
        <div className="absolute left-0 top-[15%] bottom-[15%] w-[3px] rounded-r-full bg-brand" />
        <div className="relative flex flex-wrap items-start justify-between gap-3 pl-2">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-[40px] h-[40px] md:w-[48px] md:h-[48px] rounded-[10px] flex items-center justify-center shrink-0"
              style={{ background: 'rgba(255, 159, 24, 0.12)' }}
            >
              {thisTerm?.elected ? (
                <Trophy size={20} className="text-brand" />
              ) : (
                <Landmark size={20} className="text-brand" />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-0.5">
                <h1 className="text-xl md:text-2xl font-[200] text-white tracking-[0.04em] truncate">
                  {m.nickname || 'Unnamed candidate'}
                </h1>
                {country && (
                  <span className="text-sm" title={country.name}>
                    {country.flag} <span className="text-xs text-secondary">{country.name}</span>
                  </span>
                )}
                {thisTerm?.elected && (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-brand font-medium px-2 py-0.5 rounded-full bg-brand/10"
                    title={`Won the Term ${term} election`}
                  >
                    <ShieldCheck size={10} /> Elected
                  </span>
                )}
                {/* Two badges used to render side-by-side: the Trophy
                    "Elected" pill above (term-specific: won this term)
                    and a `cr_members.state` pill (chain-current node
                    state). When both happened to read "Elected" the
                    page had two identical-looking labels meaning two
                    different things; "Unknown" surfaced on retired
                    members with no useful signal. Show the chain-state
                    badge only for NOTABLE states — when it actually
                    tells the reader something the Trophy pill doesn't. */}
                {m.state && m.state !== 'Elected' && m.state !== 'Unknown' && (
                  <span
                    className={cn('badge whitespace-nowrap', stateBadgeColor)}
                    title={chainStateLabel(m.state)}
                  >
                    {chainStateBadge(m.state)}
                  </span>
                )}
              </div>
              <p className="text-[11px] md:text-xs text-muted tracking-[0.04em]">
                Term {term}
                {/* Suppress "Rank N" for pre-BPoS terms — the stored rank
                    is synthetic chronological order, not vote-based. */}
                {thisTerm && !thisTerm.legacyEra && ` · Rank ${thisTerm.rank}`}
                {thisTerm?.legacyEra && ' · Pre-BPoS council member'}
                {externalUrl && (
                  <>
                    {' · '}
                    <a
                      href={externalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand hover:underline inline-flex items-center gap-1"
                    >
                      {m.url} <ExternalLink size={10} />
                    </a>
                  </>
                )}
              </p>
            </div>
          </div>
          <Link
            to={`/governance/elections/${term}`}
            className="text-xs text-muted hover:text-brand transition-colors flex items-center gap-1 shrink-0"
          >
            <ArrowLeft size={12} /> Term {term}
          </Link>
        </div>
      </div>

      {/* If the URL term has no real participation row after the
          noise-filter (e.g., a 0-vote / not-elected ghost row that
          got filtered out), surface that explicitly so the empty
          stats don't read as "we lost the data". */}
      {!thisTerm && profile.terms.length > 0 && (
        <div className="card p-3 text-xs text-secondary flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-muted">
            No on-chain participation for this candidate in Term {term}.
          </span>
          <Link
            to={`/governance/candidate/${cid}?term=${profile.terms[profile.terms.length - 1].term}`}
            className="text-brand hover:underline"
          >
            View their most recent term →
          </Link>
        </div>
      )}

      {/* 2. MULTI-TERM PARTICIPATION STRIP */}
      {profile.terms.length > 1 && (
        <TermPills cid={cid!} terms={profile.terms} activeTerm={term} />
      )}

      {/* 3. IDENTITY CARD */}
      <div className="card p-3 md:p-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <IdentityRow label="CID">
            <HashDisplay hash={m.cid} size="standard" showCopyButton />
          </IdentityRow>
          <IdentityRow label="DID">
            {m.did ? <HashDisplay hash={m.did} size="standard" showCopyButton /> : <Muted>Not set</Muted>}
          </IdentityRow>
          <IdentityRow label="DPoS pubkey">
            {m.dposPubkey ? (
              <HashDisplay hash={m.dposPubkey} size="standard" showCopyButton />
            ) : (
              <Muted>Not set</Muted>
            )}
          </IdentityRow>
          <IdentityRow label="Claimed node">
            {m.claimedNode ? (
              <HashDisplay hash={m.claimedNode} size="standard" showCopyButton />
            ) : (
              <Muted>Not claimed</Muted>
            )}
          </IdentityRow>
          <IdentityRow label="Deposit address">
            {m.depositAddress ? (
              <Link
                to={`/address/${encodeURIComponent(m.depositAddress)}`}
                className="text-brand hover:text-brand-200"
              >
                <HashDisplay hash={m.depositAddress} size="standard" showCopyButton isClickable={false} />
              </Link>
            ) : (
              <Muted>Not set</Muted>
            )}
          </IdentityRow>
          <IdentityRow label="Country">
            {country ? (
              <span className="text-xs text-primary">
                <span className="text-base mr-1.5">{country.flag}</span>
                {country.name}
              </span>
            ) : (
              <Muted>Not specified</Muted>
            )}
          </IdentityRow>
          <IdentityRow label="Member since block">
            <span className="text-xs text-primary font-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {m.registerHeight > 0 ? `#${m.registerHeight.toLocaleString()}` : '—'}
            </span>
          </IdentityRow>
          <IdentityRow label="Last updated">
            <LastUpdatedValue value={m.lastUpdated} kind={m.lastUpdatedKind} />
          </IdentityRow>
        </div>
      </div>

      {/* 4. STATS GRID — this term + lifetime member metadata.
          For pre-BPoS terms (T1-T3) the per-term tiles show 0/N/A
          because the legacy fallback can't reconstruct vote counts —
          we replace those three tiles with one honest banner instead
          of three lying zeros. Lifetime tiles (Register, Deposit,
          Penalty, Impeachment) still render since they're cumulative
          member-state, not per-term. */}
      {thisTerm?.legacyEra ? (
        <div className="card p-3 sm:p-4 relative overflow-hidden flex items-start gap-3">
          <div className="absolute left-0 top-[20%] bottom-[20%] w-[2px] rounded-r-full bg-brand/40" />
          <Trophy size={16} className="text-brand mt-0.5 ml-1.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-primary mb-1">
              Pre-BPoS council member · Term {term}
            </p>
            <p className="text-xs text-secondary">
              Vote counts and per-candidate rankings can&apos;t be reconstructed for terms 1-3
              (pre-DPoSv2 OTVote consensus). The 12 elected members are sourced from the
              proposal-review record.
            </p>
          </div>
        </div>
      ) : null}

      <div className={cn(
        'grid grid-cols-2 sm:grid-cols-3 gap-2 md:gap-3',
        showPenalty || showImpeachment ? 'lg:grid-cols-6' : 'lg:grid-cols-5',
      )}>
        {!thisTerm?.legacyEra && (
          <>
            <MiniStat icon={ScrollText} label="Rank" value={thisTerm ? `#${thisTerm.rank}` : '—'} />
            <MiniStat
              icon={Coins}
              label="Total Votes"
              value={thisTerm ? `${formatVotes(thisTerm.votes)} ELA` : '—'}
            />
            <MiniStat
              icon={Users}
              label="Voter Count"
              value={thisTerm ? thisTerm.voterCount.toLocaleString() : '—'}
            />
          </>
        )}
        <MiniStat
          icon={Hash}
          label="Register"
          value={m.registerHeight > 0 ? `#${m.registerHeight.toLocaleString()}` : 'N/A'}
        />
        <MiniStat
          icon={ShieldCheck}
          label="Deposit"
          value={Number(m.depositAmount) > 0 ? `${formatVotes(m.depositAmount)} ELA` : 'N/A'}
        />
        {showPenalty && (
          <MiniStat
            icon={Scale}
            label="Lifetime penalty"
            value={`${formatVotes(m.penalty)} ELA`}
            tone="red"
          />
        )}
        {showImpeachment && (
          <MiniStat
            icon={Scale}
            label="Lifetime impeachment"
            value={`${formatVotes(m.impeachmentVotes)} ELA`}
            tone="red"
          />
        )}
      </div>

      {/* 5. GOVERNANCE RECORD */}
      <GovernanceCard governance={profile.governance} cid={cid!} />

      {/* 6. VOTERS TABLE — this term. Pre-BPoS terms have no parseable
          per-voter data so we skip the empty card; the legacy banner
          already explains why. */}
      {!thisTerm?.legacyEra && (
        <VotersCard
          voters={voters}
          loading={votersLoading}
          total={voterTotal}
          page={voterPage}
          totalPages={voterTotalPages}
          onPageChange={setVoterPage}
          term={term}
          cid={cid!}
        />
      )}
    </div>
  );
};

/* ─── Sub-components ─────────────────────────────────────────────── */

function IdentityRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] text-muted uppercase tracking-wider">{label}</span>
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-muted">{children}</span>;
}

// Short, scannable label for a `cr_members.state` value when it's
// being shown as a standalone badge. The protocol values are
// terse and a casual reader can't tell "Returned" means
// "deposit returned" or that "Inactive" is a node-offline signal —
// we expand them where it helps without losing the canonical name.
//
// "Elected" never reaches this function (it's filtered out at the
// caller because the term-specific Trophy badge already covers it),
// but if a future caller passes it, we route through the shared
// display-label helper so frontend terminology stays consistent.
function chainStateBadge(state: string): string {
  switch (state) {
    case 'Inactive':  return 'Inactive · node offline';
    case 'Impeached': return 'Impeached';
    case 'Illegal':   return 'Illegal · slashed';
    case 'Pending':   return 'Pending registration';
    case 'Returned':  return 'Deposit returned';
    case 'Canceled':  return 'Canceled';
    case 'Terminated':return 'Terminated';
    default:          return crStateDisplayLabel(state);
  }
}

// Long-form description used as the title= tooltip so a hover
// gives the reader the full meaning even when the badge text is
// abbreviated for layout. Falls through to a generic phrasing for
// any state value we haven't seen on mainnet yet.
function chainStateLabel(state: string): string {
  switch (state) {
    case 'Inactive':
      return 'Seated council member whose node has been marked offline by the protocol';
    case 'Impeached':
      return 'Removed from the council by community impeachment vote';
    case 'Illegal':
      return 'Slashed for protocol-level misbehaviour';
    case 'Pending':
      return 'Registration submitted, not yet seated';
    case 'Returned':
      return 'Candidate deposit returned after term end';
    case 'Canceled':
      return 'Candidacy cancelled by the registrant';
    case 'Terminated':
      return 'Candidacy terminated by the protocol';
    default:
      return `Current chain state: ${state}`;
  }
}

// Convert a block-height span into a human-friendly tenure label.
// Returns empty string when span is 0 (single review, no real tenure
// to summarize) so the caller can omit the chip entirely.
function formatTenureSpan(blockSpan: number): string {
  if (blockSpan <= 0) return '';
  const days = (blockSpan * BLOCK_TIME_SECONDS) / 86400;
  if (days < 1) return '< 1 day tenure';
  if (days < 7) {
    const d = Math.round(days);
    return `~${d} day${d === 1 ? '' : 's'} tenure`;
  }
  if (days < 30) return `~${Math.round(days / 7)} weeks tenure`;
  if (days < 365) return `~${Math.round(days / 30)} months tenure`;
  const years = days / 365;
  return `~${years.toFixed(1)} year${years >= 1.5 ? 's' : ''} tenure`;
}

// `cr_members.last_updated` is dual-purpose in the indexer (tx_processor
// writes block heights; the aggregator writes Unix epochs). The backend
// now tags the value with `lastUpdatedKind` so we can render the right
// thing without re-deriving the heuristic. We still keep a fallback
// numeric guard for older API versions that don't ship the kind field.
function LastUpdatedValue({
  value,
  kind,
}: {
  value: number;
  kind?: 'epoch' | 'block' | 'unknown';
}) {
  if (!value || value <= 0 || kind === 'unknown') return <Muted>—</Muted>;
  const resolvedKind = kind ?? (value >= 1_000_000_000 ? 'epoch' : 'block');
  if (resolvedKind === 'block') {
    return (
      <span
        className="text-xs text-secondary font-mono"
        style={{ fontVariantNumeric: 'tabular-nums' }}
        title="Indexer wrote registration block height; this row hasn't been refreshed by the aggregator since."
      >
        Block #{value.toLocaleString()}
      </span>
    );
  }
  return (
    <span className="text-xs text-secondary">
      {new Date(value * 1000).toUTCString().slice(5, 22)}
    </span>
  );
}

function MiniStat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  tone?: 'red';
}) {
  const accent = tone === 'red' ? 'bg-red-500/40' : 'bg-brand/40';
  const iconBg = tone === 'red' ? 'rgba(239, 68, 68, 0.1)' : 'rgba(255, 159, 24, 0.1)';
  const iconColor = tone === 'red' ? 'text-red-400' : 'text-brand';
  return (
    <div className="card p-2.5 md:p-3 relative">
      <div className="absolute inset-0 rounded-[inherit] overflow-hidden pointer-events-none">
        <div className={cn('absolute left-0 top-[20%] bottom-[20%] w-[2px] rounded-r-full', accent)} />
      </div>
      <div className="flex items-center gap-2 pl-1.5 relative">
        <div
          className="w-[22px] h-[22px] md:w-[28px] md:h-[28px] rounded-[5px] flex items-center justify-center shrink-0"
          style={{ background: iconBg }}
        >
          <Icon size={13} className={iconColor} />
        </div>
        <div className="min-w-0">
          <p className="text-[9px] md:text-[11px] text-muted tracking-[0.3px] md:tracking-[0.48px] truncate">
            {label}
          </p>
          <p
            className="text-[11px] md:text-sm font-semibold text-primary truncate"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {value}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * TermPills — horizontal strip of pills, one per term this candidate
 * ran in. Each pill links to that term's candidate-detail page.
 * Active term is highlighted with brand fill + outline.
 */
function TermPills({
  cid,
  terms,
  activeTerm,
}: {
  cid: string;
  terms: CandidateProfileTerm[];
  activeTerm: number;
}) {
  const electedTerms = terms.filter((t) => t.elected);
  const nomineeTerms = terms.filter((t) => !t.elected);
  const electedCount = electedTerms.length;
  const nomineeCount = nomineeTerms.length;
  // "Council since" must be the first ELECTED term, not the first
  // term they ran. A nominee who lost T2 then was elected T3 joined
  // council at T3 — saying "since T2" would be wrong.
  const firstElectedTerm = electedTerms[0]?.term;
  const labelText = (() => {
    if (!firstElectedTerm) {
      return `Ran in ${terms.length} term${terms.length === 1 ? '' : 's'} · Never elected`;
    }
    const base = `Council since Term ${firstElectedTerm} · ${electedCount} term${electedCount === 1 ? '' : 's'} elected`;
    if (nomineeCount === 0) return base;
    return `${base} · ${nomineeCount} unsuccessful nomination${nomineeCount === 1 ? '' : 's'}`;
  })();

  return (
    <div className="card p-3 sm:p-4 relative overflow-hidden">
      <div className="absolute left-0 top-[20%] bottom-[20%] w-[2px] rounded-r-full bg-brand/40" />
      <div className="pl-2 space-y-2.5">
        <p className="text-[11px] text-muted tracking-[0.04em]">{labelText}</p>
        <div className="flex flex-wrap gap-2">
          {terms.map((t) => {
            const isActive = t.term === activeTerm;
            return (
              <Link
                key={t.term}
                to={`/governance/candidate/${cid}?term=${t.term}`}
                className={cn(
                  'group relative flex flex-col items-center min-w-[64px] px-3 pt-2 pb-1.5 rounded-md text-xs transition-all border',
                  // Active term: brand fill regardless of elected/not
                  // — user is INSPECTING this term, so it gets focus.
                  isActive && 'bg-brand/15 text-brand border-brand/40',
                  // Inactive elected: subtle emerald accent border
                  // bottom + brand-on-hover. Confirms "this counted."
                  !isActive && t.elected &&
                    'text-secondary border-[var(--color-border)] hover:text-primary hover:border-brand/50 hover:bg-brand/[0.04]',
                  // Inactive nominee: muted styling, dotted border
                  // hint, dimmer background. Reads as "tried, didn't
                  // make it" without being graphically aggressive.
                  !isActive && !t.elected &&
                    'text-muted/80 border-dashed border-[var(--color-border)]/60 hover:text-secondary hover:border-[var(--color-border-strong)]',
                )}
                title={(() => {
                  if (t.legacyEra) return `Term ${t.term} · Pre-BPoS council member`;
                  if (t.elected) return `Term ${t.term} · Rank #${t.rank} · Elected`;
                  return `Term ${t.term} · Rank #${t.rank} · Did not win election`;
                })()}
              >
                {/* Status corner glyph — Trophy for elected, X for
                    non-elected. Always rendered so the row reads as
                    a key visually scannable column rather than an
                    arbitrary mix of pills. Legacy elected shows a
                    half-opacity Trophy (still elected, just no
                    rank to display). */}
                <span className="absolute top-1 right-1 inline-flex items-center justify-center">
                  {t.elected ? (
                    <Trophy size={10} className={cn('text-brand', t.legacyEra && 'opacity-70')} />
                  ) : (
                    <XCircle size={10} className="text-red-400/70" />
                  )}
                </span>
                <span className="font-semibold tracking-wider">T{t.term}</span>
                <span
                  className="text-[10px] mt-0.5 inline-flex items-center gap-1"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {/* Pre-BPoS terms have no vote-based ranks. Modern
                      terms always show #N — for non-elected we add
                      "ran" small caps so the rank doesn't read as
                      a winning placement. */}
                  {t.legacyEra ? (
                    <span className="text-muted/70 text-[9px] uppercase tracking-wider">
                      pre-BPoS
                    </span>
                  ) : t.elected ? (
                    <span className="text-muted group-hover:text-secondary">#{t.rank}</span>
                  ) : (
                    <>
                      <span className="text-muted/80">#{t.rank}</span>
                      <span className="text-[8px] uppercase tracking-wider text-red-400/60 ml-0.5">
                        ran
                      </span>
                    </>
                  )}
                </span>
              </Link>
            );
          })}
        </div>
        {/* Compact legend so the icon language is obvious. Hidden when
            the candidate has only one status type — no need to label
            the only thing on screen. */}
        {electedCount > 0 && nomineeCount > 0 && (
          <div className="flex flex-wrap items-center gap-3 pt-1 text-[10px] text-muted">
            <span className="inline-flex items-center gap-1">
              <Trophy size={9} className="text-brand" /> elected
            </span>
            <span className="inline-flex items-center gap-1">
              <XCircle size={9} className="text-red-400/70" /> ran · not elected
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * GovernanceCard — proposal-review record. Tenure summary +
 * OpinionBar + recent reviews + "View all N reviews" expandable
 * paginated full list. Empty state if no reviews.
 */
function GovernanceCard({
  governance,
  cid,
}: {
  governance: CandidateProfile['governance'];
  cid: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const [allReviews, setAllReviews] = useState<CandidateReview[]>([]);
  const [allTotal, setAllTotal] = useState(0);
  const [allPage, setAllPage] = useState(1);
  const [allLoading, setAllLoading] = useState(false);
  const ALL_PAGE_SIZE = 25;

  useEffect(() => {
    if (!showAll) return;
    setAllLoading(true);
    blockchainApi
      .getCandidateReviews(cid, allPage, ALL_PAGE_SIZE)
      .then((res) => {
        setAllReviews(res.data);
        setAllTotal(res.total);
      })
      .catch(() => {
        setAllReviews([]);
      })
      .finally(() => setAllLoading(false));
  }, [showAll, cid, allPage]);

  const allTotalPages = Math.max(1, Math.ceil(allTotal / ALL_PAGE_SIZE));

  if (governance.totalReviews === 0) {
    return (
      <div className="card p-4 sm:p-5 relative overflow-hidden">
        <div className="absolute left-0 top-[20%] bottom-[20%] w-[2px] rounded-r-full bg-brand/40" />
        <div className="pl-2">
          <h2 className="text-sm font-medium text-primary mb-2 flex items-center gap-2">
            <ScrollText size={14} className="text-brand" /> Governance record
          </h2>
          <p className="text-xs text-muted">No proposal reviews recorded yet for this member.</p>
        </div>
      </div>
    );
  }

  const span = Math.max(0, governance.lastReviewHeight - governance.firstReviewHeight);
  const tenureNote = formatTenureSpan(span);

  return (
    <section className="card overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex flex-wrap items-center gap-2">
        <ScrollText size={14} className="text-brand" />
        <h2 className="text-sm font-medium text-primary">Governance record</h2>
        {tenureNote && (
          <span className="text-[10px] uppercase tracking-wider text-muted ml-auto">
            {tenureNote}
          </span>
        )}
      </div>

      <div className="p-4 sm:p-5 space-y-4">
        <p className="text-xs text-secondary">
          Reviewed{' '}
          <span className="text-primary font-semibold">{governance.totalReviews}</span>{' '}
          proposal{governance.totalReviews === 1 ? '' : 's'} from block{' '}
          <span className="font-mono text-primary">{governance.firstReviewHeight.toLocaleString()}</span>{' '}
          to{' '}
          <span className="font-mono text-primary">{governance.lastReviewHeight.toLocaleString()}</span>.
        </p>

        <OpinionBar
          approve={governance.approve}
          reject={governance.reject}
          abstain={governance.abstain}
        />

        {governance.recentReviews.length > 0 && (
          <div className="pt-3 border-t border-[var(--color-border)]/40 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] uppercase tracking-wider text-muted">
                {showAll ? `All ${governance.totalReviews} reviews` : 'Most recent reviews'}
              </p>
              {governance.totalReviews > governance.recentReviews.length && (
                <button
                  onClick={() => setShowAll((v) => !v)}
                  className="text-[11px] text-brand hover:underline"
                >
                  {showAll
                    ? 'show recent only'
                    : `view all ${governance.totalReviews} reviews →`}
                </button>
              )}
            </div>
            <ul className="space-y-1.5">
              {showAll && allReviews.length > 0
                ? allReviews.map((rv) => (
                    <ReviewRow
                      key={rv.proposalHash + rv.reviewHeight}
                      review={{
                        proposalHash: rv.proposalHash,
                        title: rv.title,
                        opinion: rv.opinion,
                        reviewHeight: rv.reviewHeight,
                        txid: rv.txid,
                      }}
                    />
                  ))
                : governance.recentReviews.map((rv) => (
                    <ReviewRow key={rv.proposalHash + rv.reviewHeight} review={rv} />
                  ))}
            </ul>
            {showAll && allLoading && (
              <p className="text-[11px] text-muted text-center py-2">Loading…</p>
            )}
            {showAll && allTotalPages > 1 && (
              <Pagination
                page={allPage}
                totalPages={allTotalPages}
                total={allTotal}
                label="reviews"
                onPageChange={(p) => {
                  if (p >= 1 && p <= allTotalPages) setAllPage(p);
                }}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function ReviewRow({ review }: { review: CandidateRecentReview }) {
  const opinionMeta = (() => {
    if (review.opinion === 'approve')
      return { Icon: ThumbsUp, label: 'Approve', cls: 'text-emerald-400 bg-emerald-500/10' };
    if (review.opinion === 'reject')
      return { Icon: ThumbsDown, label: 'Reject', cls: 'text-red-400 bg-red-500/10' };
    return { Icon: Scale, label: 'Abstain', cls: 'text-amber-400 bg-amber-500/10' };
  })();
  const O = opinionMeta.Icon;
  return (
    <li className="flex items-baseline justify-between gap-2 text-xs py-1">
      <Link
        to={`/governance/proposal/${review.proposalHash}`}
        className="text-secondary hover:text-brand transition-colors truncate min-w-0"
      >
        {review.title || `Proposal ${review.proposalHash.slice(0, 8)}…`}
      </Link>
      <div className="shrink-0 flex items-center gap-2">
        <span className={cn('badge whitespace-nowrap inline-flex items-center gap-1', opinionMeta.cls)}>
          <O size={10} />
          {opinionMeta.label}
        </span>
        <span
          className="font-mono text-[10px] text-muted hidden sm:inline"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          #{review.reviewHeight.toLocaleString()}
        </span>
      </div>
    </li>
  );
}

/**
 * VotersCard — paginated voter table for THIS term.
 * - Address shown via HashDisplay with copy button (length=18).
 * - Voters with txCount > 1 get a "voted N times · expand" toggle
 *   that fetches /voters/{cid}/{addr}/history and shows all
 *   attempts with the latest marked "counted".
 * - Mobile: compresses to 2-line layout.
 */
function VotersCard({
  voters,
  loading,
  total,
  page,
  totalPages,
  onPageChange,
  term,
  cid,
}: {
  voters: CandidateVoter[];
  loading: boolean;
  total: number;
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
  term: number;
  cid: string;
}) {
  return (
    <section className="card overflow-hidden relative">
      <div
        className="absolute top-0 left-0 right-0 h-[6px]"
        style={{
          background:
            'radial-gradient(ellipse 40% 100% at 15% 0%, rgba(246,146,26,0.15) 0%, transparent 100%)',
        }}
      />
      <div className="px-3 py-2.5 sm:px-5 sm:py-3 border-b border-[var(--color-border)] flex items-center justify-between gap-2">
        <h2 className="text-sm md:text-base font-medium text-primary flex items-center gap-2">
          <Activity size={15} className="text-brand" /> Voters this term
          <span
            className="text-[10px] font-semibold text-brand bg-brand/10 px-2 py-0.5 rounded-full"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {total.toLocaleString()}
          </span>
        </h2>
        <Link
          to={`/governance/elections/${term}/voters`}
          className="text-[11px] text-muted hover:text-brand transition-colors inline-flex items-center gap-1"
        >
          all term voters →
        </Link>
      </div>
      <div className="overflow-x-auto">
        <table className="table-clean w-full">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Voter</th>
              <th style={{ textAlign: 'right' }}>Amount</th>
              <th className="hidden sm:table-cell" style={{ textAlign: 'right' }}>Block</th>
              <th className="hidden md:table-cell" style={{ textAlign: 'right' }}>Tx</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 4 }).map((_, j) => (
                    <td key={j}>
                      <Skeleton className="h-3 w-20" />
                    </td>
                  ))}
                </tr>
              ))
            ) : voters.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-12 text-center text-muted">
                  No voters recorded for this candidate
                </td>
              </tr>
            ) : (
              voters.map((v) => <VoterRow key={`${v.txid}-${v.address}`} voter={v} term={term} cid={cid} />)
            )}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <Pagination
          page={page}
          totalPages={totalPages}
          total={total}
          label="voters"
          onPageChange={(p) => {
            if (p >= 1 && p <= totalPages) onPageChange(p);
          }}
        />
      )}
    </section>
  );
}

function VoterRow({
  voter,
  term,
  cid,
}: {
  voter: CandidateVoter;
  term: number;
  cid: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory] = useState<VoterTxHistoryEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const hasMultiple = (voter.txCount ?? 1) > 1;

  const toggle = () => {
    if (!hasMultiple) return;
    setExpanded((e) => !e);
    if (!history && !historyLoading) {
      setHistoryLoading(true);
      blockchainApi
        .getVoterTxHistory(term, cid, voter.address)
        .then(setHistory)
        .catch(() => setHistory([]))
        .finally(() => setHistoryLoading(false));
    }
  };

  return (
    <>
      <tr>
        <td className="align-top" style={{ textAlign: 'left' }}>
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <Link to={`/address/${encodeURIComponent(voter.address)}`} className="min-w-0">
                <HashDisplay
                  hash={voter.address}
                  size="standard"
                  showCopyButton={false}
                  isClickable={false}
                />
              </Link>
              {/* Copy button is a small detached icon next to the link
                  so the link covers only the hash text. */}
              <CopyAddressButton address={voter.address} />
            </div>
            {hasMultiple && (
              <button
                onClick={toggle}
                className="inline-flex items-center gap-1 text-[10px] text-amber-400 hover:text-amber-300 transition-colors"
                aria-expanded={expanded}
              >
                {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                voted {voter.txCount} times during voting · only latest counted
              </button>
            )}
          </div>
        </td>
        <td className="align-top" style={{ textAlign: 'right' }}>
          <span
            className="font-mono text-xs text-primary whitespace-nowrap"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {formatVotes(voter.ela)} ELA
          </span>
        </td>
        <td className="hidden sm:table-cell align-top" style={{ textAlign: 'right' }}>
          <span
            className="font-mono text-xs text-secondary"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {voter.voteHeight.toLocaleString()}
          </span>
        </td>
        <td className="hidden md:table-cell align-top" style={{ textAlign: 'right' }}>
          <Link
            to={`/tx/${voter.txid}`}
            className="text-brand/70 hover:text-brand text-xs font-mono"
          >
            {voter.txid.slice(0, 10)}…{voter.txid.slice(-4)}
          </Link>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={4} className="bg-[var(--color-surface)]/50 px-4 py-3">
            {historyLoading ? (
              <div className="text-xs text-muted">Loading history…</div>
            ) : !history || history.length === 0 ? (
              <div className="text-xs text-muted">No additional vote history</div>
            ) : (
              <div className="space-y-1">
                {history.map((h) => (
                  <div
                    key={h.txid}
                    className="flex items-baseline justify-between gap-2 text-[11px]"
                  >
                    <span className={cn('inline-flex items-center gap-1', h.counted ? 'text-emerald-400' : 'text-muted')}>
                      {h.counted ? (
                        <Check size={11} className="text-emerald-400" />
                      ) : (
                        <X size={11} className="text-muted" />
                      )}
                      {h.counted ? 'Counted' : 'Superseded'}
                      <span className="font-mono ml-2" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        block {h.voteHeight.toLocaleString()}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span
                        className="font-mono text-primary"
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                      >
                        {formatVotes(h.ela)} ELA
                      </span>
                      <Link
                        to={`/tx/${h.txid}`}
                        className="text-brand/70 hover:text-brand font-mono"
                      >
                        {h.txid.slice(0, 8)}…
                      </Link>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * CopyAddressButton — standalone copy icon next to a HashDisplay
 * (where the hash itself is wrapped in a Link to the address page,
 * so the link covers the hash text and copy is a separate action).
 *
 * Uses the same Copy / Check icons + colour treatment as
 * HashDisplay (`src/components/HashDisplay.tsx:65-77`) so the
 * platform's copy affordance is visually consistent everywhere.
 */
function CopyAddressButton({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyToClipboard(address);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };
  return (
    <button
      onClick={onClick}
      className="p-1 rounded-md hover:bg-hover transition-colors shrink-0"
      title={copied ? 'Copied!' : 'Copy to clipboard'}
      aria-label={copied ? 'Copied' : 'Copy address to clipboard'}
    >
      {copied ? (
        <Check size={13} className="text-accent-green" />
      ) : (
        <Copy size={13} className="text-muted hover:text-secondary" />
      )}
    </button>
  );
}

export default CandidateDetail;
