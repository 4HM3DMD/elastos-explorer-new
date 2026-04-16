/**
 * ELA halving schedule constants and utilities.
 * Ported from https://github.com/4HM3DMD/HalvingElastos (server/blockchain.ts)
 */

export const HALVING_INTERVAL = 1_051_200;
export const MAX_SUPPLY = 28_219_999;
export const AVG_BLOCK_TIME_SECONDS = 120;

const INITIAL_REWARD_SELA = 304_400_000;
const SELA_PER_ELA = 100_000_000;

export interface HalvingInfo {
  halvingNumber: number;
  currentReward: number;
  nextHalvingBlock: number;
  blocksRemaining: number;
  progressPercent: number;
  barPercent: number;
  estimatedDate: Date;
  eraLabel: string;
}

export function getHalvingInfo(currentBlock: number): HalvingInfo {
  const halvingNumber = Math.floor(currentBlock / HALVING_INTERVAL);
  const nextHalvingBlock = (halvingNumber + 1) * HALVING_INTERVAL;
  const blocksRemaining = nextHalvingBlock - currentBlock;
  const progressInCycle = currentBlock % HALVING_INTERVAL;
  const rawProgress = (progressInCycle / HALVING_INTERVAL) * 100;

  const barPercent = rawProgress > 90
    ? 90 + (rawProgress - 90) * 0.5
    : rawProgress;

  const divisor = 2 ** halvingNumber;
  const rewardSela = divisor > 0 ? Math.floor(INITIAL_REWARD_SELA / divisor) : 0;
  const currentReward = rewardSela / SELA_PER_ELA;

  const secondsRemaining = blocksRemaining * AVG_BLOCK_TIME_SECONDS;
  const estimatedDate = new Date(Date.now() + secondsRemaining * 1000);

  return {
    halvingNumber,
    currentReward,
    nextHalvingBlock,
    blocksRemaining,
    progressPercent: rawProgress,
    barPercent,
    estimatedDate,
    eraLabel: `Era ${halvingNumber + 1}`,
  };
}
