// HowToVoteCard — surfaces "how do I actually vote" guidance for the
// Elastos DAO, gated by election phase.
//
// Pre-this-PR the governance landing told users WHEN voting opens
// (countdown), the live candidates list when voting was open, and a
// transition card during claim. There was no instruction anywhere
// about HOW to vote — which wallet, what's required, what the user
// actually does. This is the most-requested missing piece for the
// May 3 (T7) launch.
//
// Phase routing:
//   voting          → "Cast your vote" (action card)
//   duty (>= 7 days
//   to next vote)   → "Get ready to vote" (preparation card)
//   duty (< 7 days) → "Voting opens soon" (action prep)
//   claim / failed  → no card (vote isn't actionable in those phases)

import { Vote, ExternalLink, Clock, Wallet, ArrowRight } from 'lucide-react';
import type { ElectionStatus } from '../types/blockchain';

const ESSENTIALS_DOWNLOAD = 'https://download.elastos.io/app/elastos-essentials/';
const STAKING_PORTAL = 'https://staking.elastos.net/';
const VOTING_GUIDE = 'https://elastos.info/elastos-dao/voting/';

interface HowToVoteCardProps {
  status: ElectionStatus;
}

const HowToVoteCard = ({ status }: HowToVoteCardProps) => {
  const phase = status.phase === 'claiming' ? 'claim' : status.phase;

  if (phase === 'voting') {
    return (
      <CardShell tone="brand" icon={Vote} title="Cast your vote">
        <Step number={1} title="Open Elastos Essentials">
          The mobile wallet that signs CR voting transactions.{' '}
          <ExternalLinkText href={ESSENTIALS_DOWNLOAD}>Download</ExternalLinkText>
        </Step>
        <Step number={2} title="Stake your ELA">
          Voting weight = staked ELA × lock duration. Visit the{' '}
          <ExternalLinkText href={STAKING_PORTAL}>Staking Portal</ExternalLinkText>{' '}
          if you haven&apos;t already.
        </Step>
        <Step number={3} title="Pick up to 12 candidates">
          Your stake splits evenly across the candidates you select. Top 12 by
          total ELA take seats on Term {status.targetTerm} council.
        </Step>
        <Footer>
          <a
            href={VOTING_GUIDE}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand text-xs hover:underline inline-flex items-center gap-1"
          >
            Full voting guide <ExternalLink size={11} />
          </a>
        </Footer>
      </CardShell>
    );
  }

  // Duty phase — voting is upcoming. Show preparation card if next
  // voting window is known. The countdown lives elsewhere on the page;
  // this card is purely instructions.
  if (phase === 'duty' && status.nextVotingStartHeight > 0) {
    const blocksUntilVoting = status.nextVotingStartHeight - status.currentHeight;
    // ~1 week worth of blocks (BLOCK_TIME_SECONDS=120 * 7 days = 5040)
    const isImminent = blocksUntilVoting > 0 && blocksUntilVoting <= 5040;

    return (
      <CardShell
        tone={isImminent ? 'brand' : 'neutral'}
        icon={isImminent ? Vote : Clock}
        title={isImminent ? 'Voting opens soon' : 'Get ready to vote'}
      >
        <Step number={1} title="Stake ELA in advance">
          Voting weight is computed from already-staked ELA at the moment voting
          opens — there&apos;s no last-minute path.{' '}
          <ExternalLinkText href={STAKING_PORTAL}>Staking Portal</ExternalLinkText>
        </Step>
        <Step number={2} title="Install Elastos Essentials">
          The wallet that holds your CR voting capability.{' '}
          <ExternalLinkText href={ESSENTIALS_DOWNLOAD}>Download</ExternalLinkText>
        </Step>
        <Step number={3} title="Watch this page">
          When voting opens (~Term {status.targetTerm}), the candidate list and
          voting flow appear here.
        </Step>
        <Footer>
          <a
            href={VOTING_GUIDE}
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand text-xs hover:underline inline-flex items-center gap-1"
          >
            Full voting guide <ExternalLink size={11} />
          </a>
        </Footer>
      </CardShell>
    );
  }

  // claim / failed_restart / pre-genesis — no actionable voting
  return null;
};

/* ── shells ────────────────────────────────────────────────────── */

function CardShell({
  tone,
  icon: Icon,
  title,
  children,
}: {
  tone: 'brand' | 'neutral';
  icon: typeof Vote;
  title: string;
  children: React.ReactNode;
}) {
  const accent = tone === 'brand' ? 'bg-brand' : 'bg-brand/40';
  return (
    <section className="card p-4 sm:p-5 relative overflow-hidden">
      <div className={`absolute left-0 top-[15%] bottom-[15%] w-[3px] rounded-r-full ${accent}`} />
      <div className="pl-2 space-y-3">
        <h2 className="text-sm font-semibold text-primary flex items-center gap-2">
          <Icon size={14} className="text-brand" />
          {title}
        </h2>
        <ol className="space-y-2.5">{children}</ol>
      </div>
    </section>
  );
}

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

function Footer({ children }: { children: React.ReactNode }) {
  return (
    <div className="pt-2 border-t border-[var(--color-border)]/40 flex items-center justify-end gap-2">
      {children}
    </div>
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
