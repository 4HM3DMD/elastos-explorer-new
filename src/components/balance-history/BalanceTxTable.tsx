// Expandable data table shown below the chart in daily mode. Lists
// each daily balance point with its delta bar. Stateless: the
// show/hide state and the computed `dailyChanges` array are both
// owned by the parent controller.

import { useState } from 'react';
import { ArrowUp, ArrowDown } from 'lucide-react';
import { cn } from '../../lib/cn';
import { type ChartPoint, fmtBal, fmtBalFull } from './helpers';

interface BalanceTxTableProps {
  entryCount: number;
  dailyChanges: (ChartPoint & { barWidth: number })[];
}

export function BalanceTxTable({ entryCount, dailyChanges }: BalanceTxTableProps) {
  const [showTable, setShowTable] = useState(false);

  return (
    <div className="card overflow-hidden">
      <button
        onClick={() => setShowTable(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-hover transition-colors"
      >
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">
          Daily Balance Log ({entryCount} entries)
        </span>
        <span className="text-xs text-muted">{showTable ? 'Hide' : 'Show'}</span>
      </button>
      {showTable && (
        <div className="border-t border-[var(--color-border)] overflow-x-auto max-h-80">
          <table className="table-clean w-full">
            <thead className="sticky top-0" style={{ background: 'var(--color-surface-secondary)' }}>
              <tr>
                <th className="text-left">Date</th>
                <th className="text-right">Balance (ELA)</th>
                <th className="text-right">Change</th>
                <th className="text-right w-24"></th>
              </tr>
            </thead>
            <tbody>
              {dailyChanges.map((point) => (
                <tr key={point.rawDate}>
                  <td className="py-2 px-4 text-sm text-secondary whitespace-nowrap">{point.fullDate}</td>
                  <td className="py-2 px-4 text-sm text-primary font-mono text-right whitespace-nowrap">
                    {fmtBalFull(point.rawBalance)}
                  </td>
                  <td className={cn(
                    'py-2 px-4 text-sm font-mono text-right whitespace-nowrap',
                    point.delta > 0 ? 'text-emerald-400' : point.delta < 0 ? 'text-red-400' : 'text-muted',
                  )}>
                    {/* Direction signalled by an icon AS WELL AS by
                        colour, so colour-blind users (and anyone in
                        a high-contrast / inverted-colour viewing
                        mode) can still tell positive from negative.
                        The `+`/`−` prefix already helped, but the
                        arrow makes it scannable at a glance. */}
                    {point.delta === 0 ? (
                      '—'
                    ) : (
                      <span className="inline-flex items-center justify-end gap-1">
                        {point.delta > 0 ? (
                          <ArrowUp size={12} aria-hidden="true" />
                        ) : (
                          <ArrowDown size={12} aria-hidden="true" />
                        )}
                        <span>
                          {point.delta > 0 ? '+' : ''}{fmtBal(point.delta)}
                        </span>
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-4">
                    {point.delta !== 0 && (
                      <div className="flex items-center justify-end gap-1">
                        <div
                          className={cn(
                            'h-1.5 rounded-full',
                            point.delta > 0 ? 'bg-emerald-500/60' : 'bg-red-500/60',
                          )}
                          style={{ width: `${Math.max(point.barWidth * 60, 2)}px` }}
                        />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
