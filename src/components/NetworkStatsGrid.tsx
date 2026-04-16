import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getHalvingInfo, MAX_SUPPLY } from '../utils/halvingUtils';
import { blockchainApi } from '../services/api';
import type { HashrateData } from '../types/blockchain';

interface NetworkStatsGridProps {
  totalBlocks: number;
  totalTransactions: number;
  totalAddresses: number;
  totalSupply: string;
  totalIndexedSupply: string;
  totalStaked: string;
  totalLocked: string;
  totalVoters: number;
  totalVotingRights: string;
  avgBlockTime: number;
}

const TABULAR = { fontVariantNumeric: 'tabular-nums' } as const;

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtSupply(val: string): string {
  const n = parseFloat(val);
  if (isNaN(n)) return '--';
  return Math.floor(n).toLocaleString('en-US');
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString('en-US');
}

function InfoTip({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <span className="relative group cursor-help">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="text-muted opacity-50 group-hover:opacity-80 transition-opacity">
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 7v4M8 5.5v-.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-3 py-2 rounded-lg bg-surface-secondary border border-[var(--color-border-strong)] text-[10px] text-secondary opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity z-10 w-52 shadow-lg">
        {text}
        {children}
      </span>
    </span>
  );
}

function StatRow({ label, value, sub, tip, tipChildren }: {
  label: string;
  value: string;
  sub?: string;
  tip?: string;
  tipChildren?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-1">
      <div className="flex items-center gap-1 min-w-0">
        <span className="text-[9px] md:text-[12px] text-muted tracking-[0.3px] md:tracking-[0.48px] truncate">{label}</span>
        {tip && <InfoTip text={tip}>{tipChildren}</InfoTip>}
      </div>
      <span className="text-[9px] md:text-[12px] text-primary font-medium whitespace-nowrap" style={TABULAR}>
        {value}
        {sub && <span className="text-muted text-[9px] md:text-[12px] font-normal ml-1">({sub})</span>}
      </span>
    </div>
  );
}

function LayersIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="M7 1.16667L1.16667 4.08333L7 7L12.8333 4.08333L7 1.16667Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M1.16667 9.91667L7 12.8333L12.8333 9.91667" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M1.16667 7L7 9.91667L12.8333 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function ZapIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="M7.58333 1.16667L1.75 8.16667H7L6.41667 12.8333L12.25 5.83333H7L7.58333 1.16667Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function GlobeIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="M7 12.8333C10.2217 12.8333 12.8333 10.2217 12.8333 7C12.8333 3.77834 10.2217 1.16667 7 1.16667C3.77834 1.16667 1.16667 3.77834 1.16667 7C1.16667 10.2217 3.77834 12.8333 7 12.8333Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M1.16667 7H12.8333" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M7 1.16667C8.45908 2.76404 9.28827 4.83702 9.33333 7C9.28827 9.16298 8.45908 11.236 7 12.8333C5.54092 11.236 4.71173 9.16298 4.66667 7C4.71173 4.83702 5.54092 2.76404 7 1.16667Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function CoinsIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14.4 13.23" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="M4.29983 8.19965C6.45364 8.19965 8.19966 6.45364 8.19966 4.29982C8.19966 2.14601 6.45364 0.4 4.29983 0.4C2.14601 0.4 0.4 2.14601 0.4 4.29982C0.4 6.45364 2.14601 8.19965 4.29983 8.19965Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M9.36965 4.27911C9.83476 4.28137 10.3073 4.36746 10.7666 4.54652C12.7733 5.32891 13.7657 7.58991 12.9834 9.59659C12.201 11.6033 9.93996 12.5958 7.93328 11.8134C6.72654 11.3429 5.88658 10.3377 5.5788 9.1746" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M4.34924 2.769L4.34924 5.88886" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M4.18952 2.7399L3.52 3.12988" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M10.1058 6.9681L8.97247 9.87483" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M9.96749 6.88294L9.20204 7.00308" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function AccentLine({ delay = 0 }: { delay?: number }) {
  return (
    <>
      <div className="absolute top-0 left-0 right-0 h-[6px] md:h-[8px]" style={{ background: 'radial-gradient(ellipse 40% 100% at 15% 0%, rgba(246,146,26,0.25) 0%, transparent 100%)' }} />
      <div className="absolute top-0 left-0 w-[60%] h-[1px]" style={{ background: 'linear-gradient(90deg, rgba(246,146,26,0.7) 0%, rgba(246,146,26,0.15) 100%)' }} />
      <div className="absolute top-0 left-0 w-[60%] h-[1px] pointer-events-none overflow-hidden">
        <div
          className="absolute top-0 h-full"
          style={{
            width: '30%',
            background: 'linear-gradient(90deg, transparent 0%, rgba(255,200,100,0.9) 50%, transparent 100%)',
            animation: `accentShimmer 8s ${delay}s ease-in-out infinite`,
          }}
        />
      </div>
    </>
  );
}

function PanelHeader({ icon: Icon, title }: { icon: React.ComponentType<{ size?: number; className?: string }>; title: string }) {
  return (
    <div className="flex items-center gap-1.5 md:gap-2 mb-0.5 md:mb-1">
      <div className="w-[20px] h-[20px] md:w-[26px] md:h-[26px] rounded-[4px] md:rounded-[6px] flex items-center justify-center" style={{ background: 'rgba(255, 159, 24, 0.1)' }}>
        <Icon size={14} className="text-brand" />
      </div>
      <p className="text-[9px] md:text-[12px] text-muted tracking-[0.3px] md:tracking-[0.48px]">{title}</p>
    </div>
  );
}

/* ── Supply Panel ── */
function SupplyPanel({ totalBlocks, totalSupply }: {
  totalBlocks: number;
  totalSupply: string;
}) {
  const halving = useMemo(() => getHalvingInfo(totalBlocks), [totalBlocks]);
  const supply = parseFloat(totalSupply) || 0;
  const issuedPct = ((supply / MAX_SUPPLY) * 100).toFixed(2);

  const estYear = halving.estimatedDate.getFullYear();
  const estMonth = halving.estimatedDate.toLocaleString('en-US', { month: 'short' });

  return (
    <div className="card p-2 md:p-5 relative overflow-hidden">
      <AccentLine delay={0} />
      <img
        src="/images/panel-supply-deco.png"
        alt=""
        aria-hidden="true"
        className="absolute top-0 right-0 w-20 sm:w-32 md:w-40 pointer-events-none select-none"
        style={{ opacity: 0.63 }}
      />
      <PanelHeader icon={LayersIcon} title="Max Supply" />
      <p className="text-[16px] md:text-[26px] lg:text-[28px] font-bold text-primary mt-0.5 md:mt-1" style={TABULAR}>
        {fmtNum(MAX_SUPPLY)}
      </p>

      <div className="surface-inset p-1.5 md:p-3.5 mt-2 md:mt-4 space-y-1.5 md:space-y-3">
        <StatRow label="Total Supply to Date" value={fmtSupply(totalSupply)} sub={`${issuedPct}%`} />

        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[9px] md:text-[12px] text-muted tracking-[0.3px] md:tracking-[0.48px]">Halving Progress</span>
            <span className="text-[9px] md:text-[12px] text-brand font-semibold" style={TABULAR}>
              {halving.progressPercent.toFixed(2)}%
            </span>
          </div>
          <div className="h-1.5 md:h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255, 255, 255, 0.1)' }}>
            <div
              className="h-full rounded-full bg-gradient-to-r from-brand to-brand-200"
              style={{ width: `${Math.min(halving.barPercent, 100)}%`, transition: 'width 0.5s ease' }}
            />
          </div>
          <p className="text-[8px] md:text-[12px] text-muted mt-1 md:mt-1.5 tracking-[0.3px] md:tracking-[0.48px]">
            {halving.eraLabel} &middot; {halving.currentReward.toFixed(3)} ELA/block &middot; Next: ~{estMonth} {estYear}
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── Hashrate Panel ── */
function HashratePanel() {
  const [data, setData] = useState<HashrateData | null>(null);

  useEffect(() => {
    let cancelled = false;
    blockchainApi.getHashrate()
      .then((res) => { if (!cancelled) setData(res); })
      .catch(() => { /* graceful */ });
    return () => { cancelled = true; };
  }, []);

  const mergePct = data?.mergeMiningPct != null ? `${data.mergeMiningPct}%` : '--';
  const elaHash = data ? `${data.elaHashrate} EH/s` : '-- EH/s';
  const btcHash = data?.btcHashrate != null ? `${data.btcHashrate} EH/s` : '-- EH/s';

  return (
    <div className="card p-2 md:p-5 relative overflow-hidden">
      <AccentLine delay={2} />
      <img
        src="/images/panel-mining-deco.png"
        alt=""
        aria-hidden="true"
        className="absolute right-0 top-0 w-[40%] sm:w-[50%] md:w-[62%] pointer-events-none select-none"
        style={{ opacity: 0.65 }}
      />
      <PanelHeader icon={ZapIcon} title="ELA Merge-Mining" />
      <div className="flex items-baseline gap-1 md:gap-2 mt-0.5 md:mt-1">
        <p className="text-[16px] md:text-[26px] lg:text-[28px] font-bold text-primary" style={TABULAR}>
          {mergePct}
        </p>
        <span className="text-[8px] md:text-[12px] text-muted tracking-[0.3px] md:tracking-[0.48px]">of BTC hashrate</span>
      </div>

      <div className="surface-inset p-1.5 md:p-3.5 mt-2 md:mt-4 space-y-1.5 md:space-y-3">
        <StatRow label="ELA Hashrate" value={elaHash} />
        <StatRow label="BTC Hashrate" value={btcHash} />
      </div>
    </div>
  );
}

/* ── Network Panel ── */
function NetworkPanel({ totalTransactions, totalBlocks, totalAddresses, avgBlockTime }: {
  totalTransactions: number;
  totalBlocks: number;
  totalAddresses: number;
  avgBlockTime: number;
}) {
  const blockTimeDisplay = avgBlockTime > 0
    ? `${Math.floor(avgBlockTime / 60)}m ${Math.round(avgBlockTime % 60)}s`
    : '--';

  return (
    <div className="card p-2 md:p-5 relative overflow-hidden">
      <AccentLine delay={4} />
      <PanelHeader icon={GlobeIcon} title="Network (Transactions)" />
      <p className="text-[16px] md:text-[26px] lg:text-[28px] font-bold text-primary mt-0.5 md:mt-1" style={TABULAR}>
        {fmtCompact(totalTransactions)}
      </p>

      <div className="surface-inset p-1.5 md:p-3.5 mt-2 md:mt-4 space-y-1.5 md:space-y-3">
        <StatRow label="Block Height" value={fmtNum(totalBlocks)} />
        <StatRow label="Total Addresses" value={fmtNum(totalAddresses)} />
        <div className="flex items-center justify-between gap-1">
          <div className="flex items-center gap-1">
            <span className="text-[9px] md:text-[12px] text-muted tracking-[0.3px] md:tracking-[0.48px]">Avg Block Time</span>
            <span className="text-[8px] md:text-[10px] text-muted/60">(7d)</span>
          </div>
          <span className="text-[9px] md:text-[12px] text-primary font-semibold whitespace-nowrap" style={TABULAR}>
            {blockTimeDisplay}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ── Circulating Supply Panel ── */
function CirculatingSupplyPanel({ totalStaked, totalLocked, totalIndexedSupply }: {
  totalStaked: string;
  totalLocked: string;
  totalIndexedSupply: string;
}) {
  const circulating = parseFloat(totalIndexedSupply) || 0;
  const staked = parseFloat(totalStaked) || 0;
  const locked = parseFloat(totalLocked) || 0;
  const idle = Math.max(0, staked - locked);
  const stakedPct = circulating > 0 ? ((staked / circulating) * 100).toFixed(2) : '0.00';

  return (
    <div className="card p-2 md:p-5 relative overflow-hidden">
      <AccentLine delay={6} />
      <PanelHeader icon={CoinsIcon} title="Circulating Supply" />
      <p className="text-[16px] md:text-[26px] lg:text-[28px] font-bold text-primary mt-0.5 md:mt-1" style={TABULAR}>
        {fmtSupply(totalIndexedSupply)}
      </p>

      <div className="surface-inset p-1.5 md:p-3.5 mt-2 md:mt-4 space-y-1.5 md:space-y-3">
        <StatRow
          label="Total Staked"
          value={fmtNum(Math.floor(staked))}
          sub={`${stakedPct}%`}
          tip="All ELA deposited into staking. Includes both pledged (earning rewards) and idle (not yet pledged to validators)."
          tipChildren={
            <Link to="/staking" className="block mt-1 text-brand hover:text-brand-200 font-medium">
              View Staking Overview →
            </Link>
          }
        />
        <StatRow
          label="Pledged to Validators"
          value={fmtNum(Math.floor(locked))}
          tip="Staked and voted on validator nodes — earning rewards."
        />
        <StatRow
          label="Idle Stake"
          value={fmtNum(Math.floor(idle))}
          tip="Staked but not pledged to any validator — not earning rewards."
        />
      </div>
    </div>
  );
}

const NetworkStatsGrid = ({
  totalBlocks,
  totalTransactions,
  totalAddresses,
  totalSupply,
  totalIndexedSupply,
  totalStaked,
  totalLocked,
  avgBlockTime,
}: NetworkStatsGridProps) => (
  <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 md:gap-5">
    <SupplyPanel totalBlocks={totalBlocks} totalSupply={totalSupply} />
    <HashratePanel />
    <NetworkPanel totalTransactions={totalTransactions} totalBlocks={totalBlocks} totalAddresses={totalAddresses} avgBlockTime={avgBlockTime} />
    <CirculatingSupplyPanel totalStaked={totalStaked} totalLocked={totalLocked} totalIndexedSupply={totalIndexedSupply} />
  </div>
);

export default NetworkStatsGrid;
