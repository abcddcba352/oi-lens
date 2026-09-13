/** EOD technical research rules. Scores are NOT fitted probabilities. */
import type { WatchEvidence, EvidenceCoverage } from './watchlist-evidence';

export type WatchHorizon = 'short' | 'positional';
export type WatchlistGroup = 'priority' | 'developing' | 'data_incomplete' | 'excluded';

export type WatchlistStage =
  | 'Approaching resistance'
  | 'Breakout with participation'
  | 'Successful breakout retest'
  | 'Extended beyond reasonable entry area'
  | 'Consolidation base'
  | 'Breakout watch'
  | 'Trend watch';

export interface WatchCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  source: string;
}

export interface WatchlistThresholds {
  shortMinSessions: number;
  positionalMinSessions: number;
  atrPeriod: number;
  shortMaPeriod: number;
  positionalMaPeriod: number;
  shortBaseLength: number;
  positionalBaseLength: number;
  retestLookback: number;
  minLiquidityMedianVolume: number;
  minRiskDistanceAtr: number;
  breakoutExtensionAtr: number;
  volumeRatioPriority: number;
  deliveryRatioPriority: number;
}

export const DEFAULT_WATCHLIST_THRESHOLDS: WatchlistThresholds = {
  shortMinSessions: 60,
  positionalMinSessions: 120,
  atrPeriod: 14,
  shortMaPeriod: 20,
  positionalMaPeriod: 50,
  shortBaseLength: 20,
  positionalBaseLength: 40,
  retestLookback: 10,
  minLiquidityMedianVolume: 25_000,
  minRiskDistanceAtr: 0.5,
  breakoutExtensionAtr: 1.5,
  volumeRatioPriority: 1.3,
  deliveryRatioPriority: 1.2,
};

export interface ScoreFactor {
  factor: string;
  points: number;
}

export interface WatchCandidate {
  symbol: string;
  name: string;
  horizon: WatchHorizon;
  group: 'priority' | 'developing';
  asOf: string;
  source: string;
  close: number;
  sessions: number;
  score: number;
  stage: WatchlistStage;
  resistance: number;
  entryTrigger: number;
  invalidation: number;
  nextResistance: number | null;
  rewardRisk: number | null;
  targetReviewRequired: boolean;
  riskDistance: number;
  riskDistanceAtr: number;
  distancePercent: number;
  distanceAtr: number;
  atr: number;
  relativeStrength: number | null;
  reasons: string[];
  scoreBreakdown: ScoreFactor[];
  probability: null;
  evidence?: WatchEvidence;
  evidenceCoverage?: EvidenceCoverage;
  researchLabel?: string;
  fundamentalsStatus?: 'Unassessed';
}

export interface WatchResult {
  candidate: WatchCandidate | null;
  reason: string | null;
  group?: WatchlistGroup;
  incompleteDetails?: string[];
}

const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
const round = (x: number) => Math.round(x * 100) / 100;

export function cleanCandles(rows: WatchCandle[], asOf: string): WatchCandle[] {
  const unique = new Map<string, WatchCandle>();
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || row.date > asOf || row.source === 'demo') continue;
    if (![row.open, row.high, row.low, row.close].every(x => Number.isFinite(x) && x > 0)) continue;
    if (row.low > Math.min(row.open, row.close) || row.high < Math.max(row.open, row.close)) continue;
    unique.set(row.date, row);
  }
  return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Chronological breakout retest detection without future leakage.
 * 1. A breakout candle (close > resistance) occurred 2 to `lookback` sessions ago.
 * 2. In subsequent sessions before latest, price pulled back to test resistance (low <= resistance + 0.5 ATR)
 *    without violating invalidation (low >= invalidation).
 * 3. Latest session holds above invalidation and closes >= resistance.
 */
export function detectBreakoutRetest(
  candles: WatchCandle[],
  resistance: number,
  invalidation: number,
  atr: number,
  lookback = 10,
): boolean {
  if (candles.length < 5) return false;
  const latest = candles.at(-1)!;
  if (latest.close <= invalidation || latest.close < resistance) return false;

  const window = candles.slice(-Math.min(lookback, candles.length));
  if (window.length < 4) return false;

  // Find breakout candle in earlier part of the window (must have at least 1 pullback candle + latest)
  let breakoutIdx = -1;
  for (let i = 0; i < window.length - 2; i++) {
    if (window[i].close > resistance) {
      breakoutIdx = i;
      break;
    }
  }
  if (breakoutIdx === -1) return false;

  const pullbackCandles = window.slice(breakoutIdx + 1, -1);
  if (pullbackCandles.length === 0) return false;

  let testedResistance = false;
  for (const p of pullbackCandles) {
    if (p.low < invalidation) return false; // Violated invalidation during pullback
    if (p.low <= resistance + 0.5 * atr) {
      testedResistance = true;
    }
  }

  return testedResistance && latest.close >= resistance;
}

export function evaluateWatchlist(
  symbol: string,
  name: string,
  input: WatchCandle[],
  benchmark: WatchCandle[],
  horizon: WatchHorizon,
  asOf: string,
  thresholds: WatchlistThresholds = DEFAULT_WATCHLIST_THRESHOLDS,
  evidence?: WatchEvidence,
): WatchResult {
  const rows = cleanCandles(input, asOf);
  const minimum = horizon === 'short' ? thresholds.shortMinSessions : thresholds.positionalMinSessions;
  const reject = (reason: string, group: WatchlistGroup = 'excluded', incompleteDetails?: string[]): WatchResult => ({
    candidate: null,
    reason,
    group,
    incompleteDetails,
  });

  if (rows.length < minimum) {
    return reject(
      `Needs ${minimum} valid sessions`,
      'data_incomplete',
      [`Insufficient history: ${rows.length} sessions available, ${minimum} required`],
    );
  }

  const latest = rows.at(-1)!;
  if ((Date.parse(asOf) - Date.parse(latest.date)) / 86400000 > 7) {
    return reject('Price history is stale', 'excluded');
  }

  // Large price discontinuities require corporate-action review
  if (rows.slice(-minimum).some((r, i, a) => i > 0 && Math.abs(r.close / a[i - 1].close - 1) > 0.25)) {
    return reject('Large price discontinuity: review corporate actions', 'excluded');
  }

  const prior = rows.slice(0, -1);
  const ranges = prior.slice(-thresholds.atrPeriod).map((r, i) => {
    const previous = prior[prior.length - (thresholds.atrPeriod + 1) + i];
    return Math.max(r.high - r.low, Math.abs(r.high - previous.close), Math.abs(r.low - previous.close));
  });
  const atr = mean(ranges);
  if (!(atr > 0)) return reject('Insufficient price variation', 'excluded');

  const period = horizon === 'short' ? thresholds.shortMaPeriod : thresholds.positionalMaPeriod;
  const average = mean(prior.slice(-period).map(r => r.close));
  const olderAverage = mean(prior.slice(-period - 10, -10).map(r => r.close));
  if (latest.close <= average || average <= olderAverage) {
    return reject('Rising trend not confirmed', 'excluded');
  }

  const baseLength = horizon === 'short' ? thresholds.shortBaseLength : thresholds.positionalBaseLength;
  const base = prior.slice(-baseLength);
  const resistance = Math.max(...base.map(r => r.high));
  const baseLow = Math.min(...base.map(r => r.low));
  const recentLow = Math.min(...prior.slice(-10).map(r => r.low));
  const oldLow = Math.min(...prior.slice(-20, -10).map(r => r.low));

  const compressed =
    mean(prior.slice(-5).map(r => r.high - r.low)) <
    mean(prior.slice(-20, -5).map(r => r.high - r.low)) * 0.8;
  const compactBase = (resistance - baseLow) / atr <= (horizon === 'short' ? 6 : 10);
  const entryTrigger = resistance + 0.25 * atr;
  const invalidation = recentLow - 0.25 * atr;

  const indicativeEntry = Math.max(latest.close, entryTrigger);
  const riskDistance = indicativeEntry - invalidation;
  const riskDistanceAtr = round(riskDistance / atr);

  if (riskDistance <= 0) {
    return reject('Invalid risk distance: invalidation >= entry', 'excluded');
  }

  // Cash liquidity validation if evidence is available
  if (
    evidence?.medianVolume !== undefined &&
    evidence.medianVolume !== null &&
    evidence.medianVolume < thresholds.minLiquidityMedianVolume
  ) {
    return reject('Insufficient cash market liquidity', 'excluded');
  }

  // Older confirmed pivot highs supply overhead resistance, never invented targets
  const overhead = prior.flatMap((r, i) => {
    if (i < 2 || i + 2 >= prior.length || r.high <= Math.max(entryTrigger, latest.close) + 0.25 * atr) return [];
    return [prior[i - 2], prior[i - 1], prior[i + 1], prior[i + 2]].every(p => r.high > p.high) ? [r.high] : [];
  });
  const nextResistance = overhead.length ? Math.min(...overhead) : null;
  const targetReviewRequired = nextResistance === null;
  const rewardRisk = nextResistance !== null && riskDistance > 0 ? (nextResistance - indicativeEntry) / riskDistance : null;

  // Relative strength vs benchmark over matching session dates
  const bench = new Map(cleanCandles(benchmark, latest.date).map(r => [r.date, r.close]));
  const rsOffset = horizon === 'short' ? 21 : 64;
  const start = rows.length >= rsOffset ? rows[rows.length - rsOffset] : null;
  const startBench = start ? bench.get(start.date) : undefined;
  const endBench = bench.get(latest.date);
  const relativeStrength =
    start && startBench && endBench
      ? ((latest.close / start.close - 1) - (endBench / startBench - 1)) * 100
      : null;

  // Participation confirmation
  const hasParticipation = evidence
    ? ((evidence.volumeRatio !== null &&
        evidence.volumeRatio >= thresholds.volumeRatioPriority &&
        evidence.deliveryRatio !== null &&
        evidence.deliveryRatio >= thresholds.deliveryRatioPriority) ||
       evidence.futuresPattern === 'Long buildup')
    : false;

  // Stage classification
  const isRetest = detectBreakoutRetest(rows, resistance, invalidation, atr, thresholds.retestLookback);
  const isExtended = latest.close > entryTrigger + thresholds.breakoutExtensionAtr * atr;
  const isBreakout = latest.close > entryTrigger;
  const isNear = (resistance - latest.close) / atr <= 1 && latest.close <= entryTrigger;
  const strongClose = latest.high > latest.low && (latest.close - latest.low) / (latest.high - latest.low) >= 0.75;

  let stage: WatchlistStage;
  if (isExtended) {
    stage = 'Extended beyond reasonable entry area';
  } else if (isRetest) {
    stage = 'Successful breakout retest';
  } else if (isBreakout) {
    stage = hasParticipation ? 'Breakout with participation' : 'Breakout watch';
  } else if (isNear) {
    stage = 'Approaching resistance';
  } else {
    stage = horizon === 'short' ? 'Trend watch' : 'Consolidation base';
  }

  // Explainable technical score breakdown (0-100)
  const scoreBreakdown: ScoreFactor[] = [
    { factor: 'Price above rising moving average', points: 25 },
  ];
  const reasons = ['Price above a rising moving average'];
  let score = 25;

  if (recentLow > oldLow) {
    score += 15;
    reasons.push('Higher recent lows');
    scoreBreakdown.push({ factor: 'Higher recent lows', points: 15 });
  }
  if (compressed) {
    score += 15;
    reasons.push('Daily ranges contracting');
    scoreBreakdown.push({ factor: 'Daily ranges contracting', points: 15 });
  }
  if (compactBase) {
    score += 10;
    reasons.push('Contained consolidation range');
    scoreBreakdown.push({ factor: 'Contained consolidation range', points: 10 });
  }
  if (relativeStrength !== null && relativeStrength > 0) {
    score += 15;
    reasons.push('Outperforming NIFTY over matching dates');
    scoreBreakdown.push({ factor: 'Outperforming NIFTY over matching dates', points: 15 });
  }
  if ((stage === 'Breakout with participation' || isBreakout) && strongClose) {
    score += 10;
    reasons.push('Strong close beyond prior resistance');
    scoreBreakdown.push({ factor: 'Strong close beyond prior resistance', points: 10 });
  }
  if (rewardRisk !== null && rewardRisk >= 2) {
    score += 10;
    reasons.push('Overhead room exceeds twice indicative risk');
    scoreBreakdown.push({ factor: 'Overhead room exceeds twice indicative risk', points: 10 });
  }
  score = Math.min(score, 100);

  // Group classification: Priority vs Developing
  let group: 'priority' | 'developing' = 'developing';
  const meaningfulRisk = riskDistance >= thresholds.minRiskDistanceAtr * atr;

  if (horizon === 'short') {
    const isPriorityStage = stage === 'Breakout with participation' || stage === 'Successful breakout retest';
    if (isPriorityStage && hasParticipation && meaningfulRisk && !isExtended) {
      group = 'priority';
    }
  } else {
    // Positional priority criteria
    const hasSectorConfirmation = evidence?.stockVsSector !== null && (evidence?.stockVsSector ?? 0) > 0;
    if (
      recentLow > oldLow &&
      compactBase &&
      relativeStrength !== null &&
      relativeStrength > 0 &&
      meaningfulRisk &&
      !isExtended &&
      (hasParticipation || hasSectorConfirmation)
    ) {
      group = 'priority';
    }
  }

  const candidate: WatchCandidate = {
    symbol,
    name,
    horizon,
    group,
    asOf: latest.date,
    source: latest.source,
    close: latest.close,
    sessions: rows.length,
    score,
    stage,
    resistance: round(resistance),
    entryTrigger: round(entryTrigger),
    invalidation: round(invalidation),
    nextResistance: nextResistance === null ? null : round(nextResistance),
    rewardRisk: rewardRisk === null ? null : round(rewardRisk),
    targetReviewRequired,
    riskDistance: round(riskDistance),
    riskDistanceAtr,
    distancePercent: round(((resistance - latest.close) / latest.close) * 100),
    distanceAtr: round((resistance - latest.close) / atr),
    atr: round(atr),
    relativeStrength: relativeStrength === null ? null : round(relativeStrength),
    reasons,
    scoreBreakdown,
    probability: null,
    evidence,
    evidenceCoverage: evidence?.coverage,
    researchLabel: horizon === 'positional' ? 'Positional technical research' : undefined,
    fundamentalsStatus: horizon === 'positional' ? 'Unassessed' : undefined,
  };

  return { candidate, reason: null, group };
}

