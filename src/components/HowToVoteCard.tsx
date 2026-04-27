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
//   voting                       → "Cast your vote" (action)
//   duty (7-30 days to vote)     → "Get ready to vote" (preparation)
//   duty (< 7 days to vote)      → "Voting opens soon" (imminent)
//   duty (> 30 days) / claim /
//   failed_restart               → no chip at all
//
// The 30-day upper bound on the prep chip matters: CR voting happens
// once a year, so without it the "Get ready to vote" chip would sit
// there for ~11 months out of every 12 — pure noise. Surfacing the
// prep guidance ~30 days out gives users a meaningful runway to
// install Essentials, switch wallet mode, and stake without the
// chip being permanent furniture.

import { useState, useId } from 'react';
import { Vote, Clock, ChevronDown, Wallet, ArrowRight } from 'lucide-react';
import type { ElectionStatus } from '../types/blockchain';
import { cn } from '../lib/cn';

const ESSENTIALS_DOWNLOAD = 'https://download.elastos.io/app/elastos-essentials/';

interface HowToVoteCardProps {
  status: ElectionStatus;
}

// Source-of-truth voting flow inside Elastos Essentials, copy-edited
// against the actual app's UX so a user can follow it without
// guessing. Reused by both the live "Cast your vote" panel and the
// "Get ready" preparation panel — the last step changes by phase but
// steps 1-3 are identical.
const STEP_INSTALL = {
  title: 'Install Elastos Essentials',
  body: (
    <>
      The mobile wallet that holds your CR voting capability.{' '}
      <ExternalLinkText href={ESSENTIALS_DOWNLOAD}>Download</ExternalLinkText>
    </>
  ),
};

const STEP_ADVANCED_MODE = {
  title: 'Switch to Advanced wallet mode',
  body: (
    <>
      Open <span className="text-primary">Settings → Wallet Mode</span> and
      change to <span className="text-primary">Advanced</span>. The default
      simple mode hides the staking surface.
    </>
  ),
};

const STEP_STAKE = {
  title: 'Stake your ELA',
  body: (
    <>
      Open the <span className="text-primary">Staking</span> section and stake
      the amount you want to vote with. Stakes aren&apos;t locked — you can
      withdraw anytime — but if you withdraw <em>during</em> a voting window,
      your votes drop with the stake. Unvote first, then withdraw.
    </>
  ),
};

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
          STEP_INSTALL,
          STEP_ADVANCED_MODE,
          STEP_STAKE,
          {
            title: 'Open Elastos Council and vote',
            body: (
              <>
                In Essentials, open <span className="text-primary">Elastos Council</span>{' '}
                and tap <span className="text-primary">Vote Now</span> at the top.
                Your stake splits evenly across the candidates you pick. Top 12 by
                total ELA take seats on Term {status.targetTerm} council.
              </>
            ),
          },
        ],
      };
    }

    if (phase === 'duty' && status.nextVotingStartHeight > 0) {
      const blocksUntilVoting = status.nextVotingStartHeight - status.currentHeight;
      // Block-time math at 120s/block:
      //   IMMINENT_BLOCKS  = 7  days × 720 blocks/day = 5,040
      //   PREP_WINDOW      = 30 days × 720 blocks/day = 21,600
      // Outside the 30-day window we render nothing — see leading
      // comment for why year-round "Get ready to vote" was noise.
      const IMMINENT_BLOCKS = 5040;
      const PREP_WINDOW_BLOCKS = 21600;
      if (blocksUntilVoting <= 0 || blocksUntilVoting > PREP_WINDOW_BLOCKS) return null;
      const isImminent = blocksUntilVoting <= IMMINENT_BLOCKS;
      return {
        tone: isImminent ? ('brand' as const) : ('neutral' as const),
        icon: isImminent ? Vote : Clock,
        title: isImminent ? 'Voting opens soon' : 'Get ready to vote',
        steps: [
          STEP_INSTALL,
          STEP_ADVANCED_MODE,
          STEP_STAKE,
          {
            title: 'Watch this page',
            body: (
              <>
                When voting opens (~Term {status.targetTerm}), open{' '}
                <span className="text-primary">Elastos Council</span> in Essentials
                and tap <span className="text-primary">Vote Now</span>. The
                live candidate list will surface here too.
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
        className="shrink-0 w-6 h-6 rounded-full bg-brand/15 text-brand text-[11px] font-semibold flex items-center justify-center mt-0.5"
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
