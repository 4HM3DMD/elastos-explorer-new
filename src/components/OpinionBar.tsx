// OpinionBar — stacked horizontal bar showing the proportion of
// approve / reject / abstain opinions across a body of CR proposal
// reviews. Used on CandidateDetail to summarise a member's
// governance posture at a glance.
//
// Visual: a thin coloured bar (green/red/amber) with a 3-pill
// legend below showing absolute counts + percentages. If the total
// is zero, renders a quiet empty-state pill instead of a 0/0/0 bar.
//
// Distinct from CRProposals.tsx VoteBar (12-slot grid for one
// proposal's council vote): that visualises a count out of 12; this
// visualises a proportion of an arbitrary total.

import { ThumbsUp, ThumbsDown, Scale } from 'lucide-react';

interface OpinionBarProps {
  approve: number;
  reject: number;
  abstain: number;
  /** Optional override for the bar height in px (default 6). */
  height?: number;
  className?: string;
}

const OpinionBar = ({ approve, reject, abstain, height = 6, className }: OpinionBarProps) => {
  const total = approve + reject + abstain;
  if (total === 0) {
    return (
      <div className={className}>
        <span className="text-[11px] text-muted">No reviews recorded yet.</span>
      </div>
    );
  }

  const pct = (n: number) => (n / total) * 100;
  const aPct = pct(approve);
  const rPct = pct(reject);
  const sPct = pct(abstain);

  return (
    <div className={className}>
      <div
        className="w-full rounded-full overflow-hidden flex bg-[var(--color-surface-tertiary)]"
        style={{ height }}
        role="img"
        aria-label={`${approve} approved, ${reject} rejected, ${abstain} abstained out of ${total} reviews`}
      >
        {approve > 0 && (
          <div
            className="bg-emerald-500"
            style={{ width: `${aPct}%` }}
            title={`Approve · ${approve} (${aPct.toFixed(1)}%)`}
          />
        )}
        {reject > 0 && (
          <div
            className="bg-red-500"
            style={{ width: `${rPct}%` }}
            title={`Reject · ${reject} (${rPct.toFixed(1)}%)`}
          />
        )}
        {abstain > 0 && (
          <div
            className="bg-amber-400"
            style={{ width: `${sPct}%` }}
            title={`Abstain · ${abstain} (${sPct.toFixed(1)}%)`}
          />
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <LegendPill
          icon={ThumbsUp}
          colour="text-emerald-400"
          label="Approve"
          count={approve}
          pct={aPct}
        />
        <LegendPill
          icon={ThumbsDown}
          colour="text-red-400"
          label="Reject"
          count={reject}
          pct={rPct}
        />
        <LegendPill
          icon={Scale}
          colour="text-amber-400"
          label="Abstain"
          count={abstain}
          pct={sPct}
        />
        <span className="text-muted ml-auto">
          {total.toLocaleString()} total
        </span>
      </div>
    </div>
  );
};

function LegendPill({
  icon: Icon,
  colour,
  label,
  count,
  pct,
}: {
  icon: typeof ThumbsUp;
  colour: string;
  label: string;
  count: number;
  pct: number;
}) {
  return (
    <span className="inline-flex items-center gap-1 text-secondary">
      <Icon size={11} className={colour} />
      <span className="font-medium text-primary">{count}</span>
      <span>{label}</span>
      <span className="text-muted">({pct.toFixed(1)}%)</span>
    </span>
  );
}

export default OpinionBar;
