/**
 * Elastos DAO (CR) governance constants & helpers.
 *
 * Values MUST mirror the backend aggregator
 * (`ela-explorer/internal/aggregator/aggregator.go` lines 31-35).
 * Any drift produces incorrect term numbers across the UI.
 */

export const CR_FIRST_TERM_START_HEIGHT = 658930;
export const CR_TERM_LENGTH_BLOCKS = 262800;
export const CR_VOTING_PERIOD_BLOCKS = 21600;
export const CR_CLAIMING_PERIOD_BLOCKS = 10080;

/** Average seconds per block on Elastos main chain (merged-mined, 2-min target). */
export const BLOCK_TIME_SECONDS = 120;

/**
 * Backend (`aggregator.go:electionVotingPeriod`) defines the election window as:
 *   narrowEnd   = termStart - 1 - CLAIMING     (termStart - 10081)
 *   narrowStart = narrowEnd - VOTING           (termStart - 31681)
 * So narrowStart is (CLAIMING + VOTING + 1) blocks before termStart.
 */
const ELECTION_WINDOW_OFFSET = CR_CLAIMING_PERIOD_BLOCKS + CR_VOTING_PERIOD_BLOCKS + 1;

/**
 * Council term number for an event that occurs DURING on-duty period
 * (council reviews, impeachment votes, proposal authoring, etc).
 *
 * Returns 0 for blocks before the first term (pre-DAO activation).
 */
export function getTermFromHeight(height: number): number {
  if (!Number.isFinite(height) || height < CR_FIRST_TERM_START_HEIGHT) return 0;
  return Math.floor((height - CR_FIRST_TERM_START_HEIGHT) / CR_TERM_LENGTH_BLOCKS) + 1;
}

/**
 * Target term being ELECTED by an election vote cast at the given block height.
 *
 * Election votes are cast in the window BEFORE a term starts, so the plain
 * `getTermFromHeight` formula would yield the outgoing term. This shifts the
 * height forward by the claim+voting window so in-window votes resolve to the
 * term they're electing.
 *
 * Returns 0 for blocks before the first election window (pre-DAO activation).
 */
export function getElectionTargetTerm(height: number): number {
  if (!Number.isFinite(height)) return 0;
  const firstWindowStart = CR_FIRST_TERM_START_HEIGHT - ELECTION_WINDOW_OFFSET;
  if (height < firstWindowStart) return 0;
  return Math.floor((height - firstWindowStart) / CR_TERM_LENGTH_BLOCKS) + 1;
}

/**
 * Format a lock duration (in blocks) as a human-readable "~N days" string.
 * Short locks under a day render as hours; under an hour as minutes.
 */
export function formatBlocksAsDuration(blocks: number): string {
  if (!Number.isFinite(blocks) || blocks <= 0) return '—';
  const seconds = blocks * BLOCK_TIME_SECONDS;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.round(seconds / 3600);
  if (hours < 48) return `~${hours} hr`;
  const days = Math.round(seconds / 86400);
  if (days < 60) return `~${days} days`;
  const months = (days / 30).toFixed(1);
  return `~${months} mo`;
}
