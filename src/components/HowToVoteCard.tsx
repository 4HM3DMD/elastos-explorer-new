// HowToVoteCard — surfaces "how do I actually vote" guidance for the
// Elastos DAO, gated by election phase.
//
// COLLAPSED by default — renders as a single-line chip on the
// governance landing so it doesn't dominate the page above the
// council table. Click expands the steps with a smooth height
// animation; click again to collapse. No external "Full voting
// guide" link until we actually have one to point at.
//
// Phase routing (controls the chip's visibility AND label):
//   voting          → "Cast your vote" (action)
//   duty (>= 7 days
//   to next vote)   → "Get ready to vote" (preparation)
//   duty (< 7 days) → "Voting opens soon" (imminent)
//   claim / failed  → no chip at all (vote isn't actionable)

import { useState, useId } from 'react';
import { Vote, Clock, ChevronDown, Wallet, ArrowRight } from 'lucide-react';
import type { ElectionStatus } from '../types/blockchain';
import { cn } from '../lib/cn';

const ESSENTIALS_DOWNLOAD = 'https://download.elastos.io/app/elastos-essentials/';
const STAKING_PORTAL = 'https://staking.elastos.net/';

interface HowToVoteCardProps {
  status: ElectionStatus;
}

const HowToVoteCard = ({ status }: HowToVoteCardProps) => {
  const phase = status.phase === 'claiming' ? 'claim' : status.phase;
  const [open, setOpen] = useState(false);
  const panelId = useId();

  // Resolve content per phase. Returning null hides the chip
  // entirely for phases where voting isn't actionable.
  const variant = (() => {
    if (phase === 'voting') {
      return {
        tone: 'brand' as const,
        icon: Vote,
        title: 'Cast your vote',
        steps: [
          {
            title: 'Open Elastos Essentials',
            body: (
              <>
                The mobile wallet that signs CR voting transactions.{' '}
                <ExternalLinkText href={ESSENTIALS_DOWNLOAD}>Download</ExternalLinkText>
              </>
            ),
          },
          {
            title: 'Stake your ELA',
            body: (
              <>
                Voting weight = staked ELA × lock duration. Visit the{' '}
                <ExternalLinkText href={STAKING_PORTAL}>Staking Portal</ExternalLinkText>{' '}
                if you haven&apos;t already.
              </>
            ),
          },
          {
            title: 'Pick up to 12 candidates',
            body: (
              <>
                Your stake splits evenly across the candidates you select. Top 12 by
                total ELA take seats on Term {status.targetTerm} council.
              </>
            ),
          },
        ],
      };
    }

    if (phase === 'duty' && status.nextVotingStartHeight > 0) {
      const blocksUntilVoting = status.nextVotingStartHeight - status.currentHeight;
      // ~1 week worth of blocks (BLOCK_TIME_SECONDS=120 * 7 days = 5040)
      const isImminent = blocksUntilVoting > 0 && blocksUntilVoting <= 5040;
      return {
        tone: isImminent ? ('brand' as const) : ('neutral' as const),
        icon: isImminent ? Vote : Clock,
        title: isImminent ? 'Voting opens soon' : 'Get ready to vote',
        steps: [
          {
            title: 'Stake ELA in advance',
            body: (
              <>
                Voting weight is computed from already-staked ELA at the moment voting
                opens — there&apos;s no last-minute path.{' '}
                <ExternalLinkText href={STAKING_PORTAL}>Staking Portal</ExternalLinkText>
              </>
            ),
          },
          {
            title: 'Install Elastos Essentials',
            body: (
              <>
                The wallet that holds your CR voting capability.{' '}
                <ExternalLinkText href={ESSENTIALS_DOWNLOAD}>Download</ExternalLinkText>
              </>
            ),
          },
          {
            title: 'Watch this page',
            body: (
              <>
                When voting opens (~Term {status.targetTerm}), the candidate list and
                voting flow appear here.
              </>
            ),
          },
        ],
      };
    }
    return null;
  })();

  if (!variant) return null;
  const { tone, icon: Icon, title, steps } = variant;
  const accent = tone === 'brand' ? 'bg-brand' : 'bg-brand/40';

  return (
    <section className="card relative overflow-hidden">
      <div className={cn('absolute left-0 top-[15%] bottom-[15%] w-[3px] rounded-r-full', accent)} />

      {/* Trigger row — single line, clickable. Whole row is the
          button so the click target is generous on mobile. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="w-full flex items-center justify-between gap-2 px-3 sm:px-4 py-2.5 text-left hover:bg-[var(--color-surface-hover)] transition-colors"
      >
        <span className="inline-flex items-center gap-2 text-sm font-medium text-primary pl-1">
          <Icon size={14} className="text-brand shrink-0" />
          {title}
          <span className="text-[11px] text-muted font-normal">· how it works</span>
        </span>
        <ChevronDown
          size={14}
          className={cn(
            'text-muted shrink-0 transition-transform duration-200',
            open && 'rotate-180',
          )}
        />
      </button>

      {/* Smooth expand using the grid-rows 0fr ↔ 1fr trick. Animates
          arbitrary-height content without measuring or pinning a
          max-height guess. The inner overflow-hidden clips during the
          animation; the inner element provides the actual content. */}
      <div
        id={panelId}
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
        aria-hidden={!open}
      >
        <div className="overflow-hidden">
          <ol className="space-y-2.5 px-3 sm:px-4 pb-4 pt-1 pl-5 sm:pl-6">
            {steps.map((s, i) => (
              <Step key={s.title} number={i + 1} title={s.title}>
                {s.body}
              </Step>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
};

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3 items-start">
      <span
        className="shrink-0 w-5 h-5 rounded-full bg-brand/15 text-brand text-[10px] font-semibold flex items-center justify-center mt-0.5"
        style={{ fontVariantNumeric: 'tabular-nums' }}
        aria-hidden="true"
      >
        {number}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium text-primary inline-flex items-center gap-1">
          {title}
        </p>
        <p className="text-[11px] text-secondary mt-0.5">{children}</p>
      </div>
    </li>
  );
}

function ExternalLinkText({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-brand hover:underline inline-flex items-center gap-0.5"
    >
      {children}
      <ArrowRight size={9} />
    </a>
  );
}

// Re-export the wallet icon so any future caller wanting a Wallet
// glyph can pull it from this module instead of importing lucide
// twice.
export { Wallet as VotingWalletIcon };

export default HowToVoteCard;
