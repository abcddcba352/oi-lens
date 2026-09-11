/**
 * relocation-screener.ts
 *
 * Implements Method 2: The Resistance Relocation Pattern.
 *
 * Footprint of a Bullish Resistance Relocation:
 *   1. Old Resistance (K_old) Unwinds: Call writers at the prior session's
 *      primary resistance wall are trapped and forced to buy back/cover (ΔCall OI < 0).
 *   2. New Resistance (K_new > K_old) Relocates Higher: Call writers retreat to
 *      a higher strike, writing fresh contracts (ΔCall OI > 0).
 *   3. Strong OI & Volume Confirmation: High Call OI concentration and above-average
 *      Call trading volume on K_new confirm institutional activity, not illiquid noise.
 *   4. Price Momentum: Spot price advances or pushes into the prior resistance zone.
 */

import type { MarketSnapshot } from './market-types';
import { declarePrimaryWalls } from './wall-backtest';

export interface RelocationCandidate {
  symbol: string;
  displayName: string;
  instrumentType: 'index' | 'stock';
  spot: number;
  spotChangePercent: number;
  previousSpot: number;
  asOf: string;
  previousAsOf: string;

  // Resistance Shift
  oldResistanceStrike: number;
  newResistanceStrike: number;
  shiftPoints: number;
  shiftPercent: number;

  // Old Resistance Unwinding (Short Covering)
  oldStrikeOiBefore: number;
  oldStrikeOiAfter: number;
  oldStrikeOiChange: number;
  oldStrikeUnwindingPercent: number;

  // New Resistance Fresh Writing & Cluster Score
  newStrikeOi: number;
  newStrikeOiChange: number;
  newStrikeOiChangePercent: number;
  newStrikeClusterScore: number;

  // Volume Confirmation
  callVolume: number;
  volumeConfirmation: number; // 0 to 1
  volumeRatio: number; // relative to chain median call volume

  // Scoring & Signals
  relocationScore: number; // 0 to 100
  signalStrength: 'Strong Bullish' | 'Bullish' | 'Moderate';
  explanation: string;
}

export interface ScreenerOptions {
  minShiftPercent?: number;
  minVolumeConfirmation?: number;
  requireUnwinding?: boolean;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function median(values: number[]): number {
  if (!values.length) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Detect whether a pair of snapshots (previous -> current) exhibits
 * the Method 2 Resistance Relocation Pattern.
 */
export function detectRelocation(
  prevSnapshot: MarketSnapshot,
  currSnapshot: MarketSnapshot,
  options: ScreenerOptions = {},
): RelocationCandidate | null {
  const {
    minShiftPercent = 0.5,
    minVolumeConfirmation = 0.15,
    requireUnwinding = true,
  } = options;

  if (!prevSnapshot.chain?.length || !currSnapshot.chain?.length) {
    return null;
  }

  // 1. Identify primary resistance walls at T-1 and T
  const prevWalls = declarePrimaryWalls(prevSnapshot, prevSnapshot.asOf);
  const currWalls = declarePrimaryWalls(currSnapshot, currSnapshot.asOf);

  if (!prevWalls.resistance || !currWalls.resistance) {
    return null;
  }

  const oldResistanceStrike = prevWalls.resistance.strike;
  const newResistanceStrike = currWalls.resistance.strike;

  // 2. Condition: Resistance Strike MUST have moved strictly UP
  if (newResistanceStrike <= oldResistanceStrike) {
    return null;
  }

  const shiftPoints = newResistanceStrike - oldResistanceStrike;
  const shiftPercent = (shiftPoints / oldResistanceStrike) * 100;

  if (shiftPercent < minShiftPercent) {
    return null;
  }

  // 3. Inspect Old Resistance Strike (K_old) in both snapshots
  const oldStrikeInPrev = prevSnapshot.chain.find((r) => r.strike === oldResistanceStrike);
  const oldStrikeInCurr = currSnapshot.chain.find((r) => r.strike === oldResistanceStrike);

  const oldStrikeOiBefore = oldStrikeInPrev?.callOi ?? prevWalls.resistance.oi;
  const oldStrikeOiAfter = oldStrikeInCurr?.callOi ?? Math.max(0, oldStrikeOiBefore + (oldStrikeInCurr?.callOiChange ?? 0));
  const oldStrikeOiChange = oldStrikeInCurr?.callOiChange ?? (oldStrikeOiAfter - oldStrikeOiBefore);

  const oldStrikeDelta = oldStrikeOiAfter - oldStrikeOiBefore;
  const unwindingPercent = oldStrikeOiBefore > 0 ? (oldStrikeDelta / oldStrikeOiBefore) * 100 : 0;

  // Method 2 requirement: Call Unwinding at K_old (ΔCall OI < 0)
  if (requireUnwinding && oldStrikeOiChange >= 0 && oldStrikeDelta >= 0) {
    return null; // No short covering detected at the old resistance
  }

  // 4. Inspect New Resistance Strike (K_new) in current snapshot
  const newStrikeInPrev = prevSnapshot.chain.find((r) => r.strike === newResistanceStrike);
  const newStrikeInCurr = currSnapshot.chain.find((r) => r.strike === newResistanceStrike);

  if (!newStrikeInCurr || newStrikeInCurr.callOi <= 0) {
    return null;
  }

  const newStrikeOi = newStrikeInCurr.callOi;
  const newStrikeOiChange = newStrikeInCurr.callOiChange;
  const newStrikeOiBefore = newStrikeInPrev?.callOi ?? Math.max(1, newStrikeOi - newStrikeOiChange);
  const newStrikeOiChangePercent = newStrikeOiBefore > 0 ? ((newStrikeOi - newStrikeOiBefore) / newStrikeOiBefore) * 100 : 0;

  // Must have positive build-up or healthy OI at new level
  if (newStrikeOiChange < 0 && newStrikeOiChangePercent < 0) {
    return null; // Also unwinding at the new level, not a fresh wall
  }

  // 5. Volume Confirmation at K_new
  const callVolumes = currSnapshot.chain.map((r) => r.callVolume);
  const logVolumes = currSnapshot.chain.map((r) => Math.log1p(r.callVolume));
  const maxLogVol = Math.max(...logVolumes, 1);
  const newStrikeLogVol = Math.log1p(newStrikeInCurr.callVolume);
  const volumeConfirmation = clamp01(newStrikeLogVol / maxLogVol);

  if (volumeConfirmation < minVolumeConfirmation) {
    return null; // Strike has insufficient liquidity
  }

  const medianCallVol = median(callVolumes.filter((v) => v > 0));
  const volumeRatio = medianCallVol > 0 ? Number((newStrikeInCurr.callVolume / medianCallVol).toFixed(1)) : 1;

  // 6. Calculate Composite Relocation Score (0 to 100)
  // Component A: Shift Magnitude (normalized by ATR or strike step) -> 0 to 25 pts
  const atrNorm = Math.max(currSnapshot.atr14, currSnapshot.strikeStep * 2);
  const shiftScore = clamp01(shiftPoints / (atrNorm * 1.5)) * 25;

  // Component B: Unwinding Intensity at K_old -> 0 to 25 pts
  const unwindingScore = clamp01(Math.abs(unwindingPercent) / 25) * 25;

  // Component C: Fresh Writing & Clustering at K_new -> 0 to 25 pts
  const buildUpScore = clamp01(Math.max(0, newStrikeOiChangePercent) / 30) * 15 + currWalls.resistance.clusterScore * 10;

  // Component D: Volume Confirmation -> 0 to 25 pts
  const volumeScore = volumeConfirmation * 20 + clamp01((volumeRatio - 1) / 3) * 5;

  const rawScore = Math.round(shiftScore + unwindingScore + buildUpScore + volumeScore);
  const relocationScore = Math.min(99, Math.max(25, rawScore));

  let signalStrength: RelocationCandidate['signalStrength'] = 'Moderate';
  if (relocationScore >= 75) {
    signalStrength = 'Strong Bullish';
  } else if (relocationScore >= 55) {
    signalStrength = 'Bullish';
  }

  const formatPoints = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 1 });
  const explanation = `Resistance moved up from ₹${formatPoints(oldResistanceStrike)} to ₹${formatPoints(newResistanceStrike)} (+${shiftPercent.toFixed(1)}%). Call sellers covered at ₹${formatPoints(oldResistanceStrike)} (${unwindingPercent.toFixed(0)}% OI) and rebuilt at ₹${formatPoints(newResistanceStrike)} (+${newStrikeOiChangePercent.toFixed(0)}% OI) with ${volumeRatio}× median volume.`;

  return {
    symbol: currSnapshot.symbol,
    displayName: currSnapshot.displayName,
    instrumentType: currSnapshot.instrumentType,
    spot: currSnapshot.spot,
    spotChangePercent: currSnapshot.spotChangePercent,
    previousSpot: prevSnapshot.spot,
    asOf: currSnapshot.asOf,
    previousAsOf: prevSnapshot.asOf,

    oldResistanceStrike,
    newResistanceStrike,
    shiftPoints,
    shiftPercent,

    oldStrikeOiBefore,
    oldStrikeOiAfter,
    oldStrikeOiChange,
    oldStrikeUnwindingPercent: unwindingPercent,

    newStrikeOi,
    newStrikeOiChange,
    newStrikeOiChangePercent,
    newStrikeClusterScore: currWalls.resistance.clusterScore,

    callVolume: newStrikeInCurr.callVolume,
    volumeConfirmation,
    volumeRatio,

    relocationScore,
    signalStrength,
    explanation,
  };
}

/**
 * Detect relocation pattern from a single snapshot by reconstructing
 * previous day's baseline from callOiChange, putOiChange, and spotChangePercent.
 * This allows scanning instruments even if only 1 snapshot has been saved!
 */
export function detectRelocationFromSingleSnapshot(
  snapshot: MarketSnapshot,
  options: ScreenerOptions = {},
): RelocationCandidate | null {
  if (!snapshot.chain?.length) return null;

  const changePct = snapshot.spotChangePercent || 0;
  const prevSpot = snapshot.spot / (1 + changePct / 100);

  const prevChain = snapshot.chain.map((row) => ({
    ...row,
    callOi: Math.max(0, row.callOi - row.callOiChange),
    putOi: Math.max(0, row.putOi - row.putOiChange),
    callOiChange: 0,
    putOiChange: 0,
    callVolume: Math.round(row.callVolume * 0.7),
    putVolume: Math.round(row.putVolume * 0.7),
  }));

  const prevSnapshot: MarketSnapshot = {
    ...snapshot,
    spot: prevSpot,
    asOf: new Date(Date.parse(snapshot.asOf || new Date().toISOString()) - 86400000).toISOString(),
    chain: prevChain,
  };

  return detectRelocation(prevSnapshot, snapshot, options);
}

/**
 * Scan multiple snapshot pairs and sort candidates by relocation strength.
 */
export function scanSnapshotPairs(
  pairs: Array<{ prev: MarketSnapshot; curr: MarketSnapshot }>,
  options: ScreenerOptions = {},
): RelocationCandidate[] {
  const candidates: RelocationCandidate[] = [];

  for (const pair of pairs) {
    const candidate = detectRelocation(pair.prev, pair.curr, options);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates.sort((a, b) => b.relocationScore - a.relocationScore);
}

/**
 * Realistic demo relocation candidates for immediate interactive display in demo mode.
 */
export function getDemoRelocationCandidates(): RelocationCandidate[] {
  return [
    {
      symbol: 'NSE:TCS-EQ',
      displayName: 'TCS',
      instrumentType: 'stock',
      spot: 3824.5,
      spotChangePercent: 2.15,
      previousSpot: 3744.0,
      asOf: '2026-08-30T15:30:00.000Z',
      previousAsOf: '2026-08-29T15:30:00.000Z',
      oldResistanceStrike: 3800,
      newResistanceStrike: 3900,
      shiftPoints: 100,
      shiftPercent: 2.63,
      oldStrikeOiBefore: 1_250_000,
      oldStrikeOiAfter: 920_000,
      oldStrikeOiChange: -330_000,
      oldStrikeUnwindingPercent: -26.4,
      newStrikeOi: 1_840_000,
      newStrikeOiChange: 480_000,
      newStrikeOiChangePercent: 35.3,
      newStrikeClusterScore: 0.88,
      callVolume: 142_500,
      volumeConfirmation: 0.92,
      volumeRatio: 3.8,
      relocationScore: 94,
      signalStrength: 'Strong Bullish',
      explanation: 'Resistance moved up from ₹3,800 to ₹3,900 (+2.6%). Call sellers covered at ₹3,800 (-26% OI) and rebuilt at ₹3,900 (+35% OI) with 3.8× median volume.',
    },
    {
      symbol: 'NSE:RELIANCE-EQ',
      displayName: 'RELIANCE',
      instrumentType: 'stock',
      spot: 1462.4,
      spotChangePercent: 1.64,
      previousSpot: 1438.8,
      asOf: '2026-08-30T15:30:00.000Z',
      previousAsOf: '2026-08-29T15:30:00.000Z',
      oldResistanceStrike: 1460,
      newResistanceStrike: 1500,
      shiftPoints: 40,
      shiftPercent: 2.74,
      oldStrikeOiBefore: 3_840_000,
      oldStrikeOiAfter: 3_120_000,
      oldStrikeOiChange: -720_000,
      oldStrikeUnwindingPercent: -18.75,
      newStrikeOi: 4_620_000,
      newStrikeOiChange: 980_000,
      newStrikeOiChangePercent: 26.9,
      newStrikeClusterScore: 0.82,
      callVolume: 328_000,
      volumeConfirmation: 0.86,
      volumeRatio: 3.1,
      relocationScore: 89,
      signalStrength: 'Strong Bullish',
      explanation: 'Resistance moved up from ₹1,460 to ₹1,500 (+2.7%). Call sellers covered at ₹1,460 (-19% OI) and rebuilt at ₹1,500 (+27% OI) with 3.1× median volume.',
    },
    {
      symbol: 'NSE:INFY-EQ',
      displayName: 'INFY',
      instrumentType: 'stock',
      spot: 1845.0,
      spotChangePercent: 1.35,
      previousSpot: 1820.5,
      asOf: '2026-08-30T15:30:00.000Z',
      previousAsOf: '2026-08-29T15:30:00.000Z',
      oldResistanceStrike: 1840,
      newResistanceStrike: 1880,
      shiftPoints: 40,
      shiftPercent: 2.17,
      oldStrikeOiBefore: 2_100_000,
      oldStrikeOiAfter: 1_790_000,
      oldStrikeOiChange: -310_000,
      oldStrikeUnwindingPercent: -14.8,
      newStrikeOi: 2_450_000,
      newStrikeOiChange: 420_000,
      newStrikeOiChangePercent: 20.7,
      newStrikeClusterScore: 0.74,
      callVolume: 198_000,
      volumeConfirmation: 0.78,
      volumeRatio: 2.4,
      relocationScore: 78,
      signalStrength: 'Strong Bullish',
      explanation: 'Resistance moved up from ₹1,840 to ₹1,880 (+2.2%). Call sellers covered at ₹1,840 (-15% OI) and rebuilt at ₹1,880 (+21% OI) with 2.4× median volume.',
    },
    {
      symbol: 'NSE:TATAMOTORS-EQ',
      displayName: 'TATAMOTORS',
      instrumentType: 'stock',
      spot: 988.2,
      spotChangePercent: 1.12,
      previousSpot: 977.3,
      asOf: '2026-08-30T15:30:00.000Z',
      previousAsOf: '2026-08-29T15:30:00.000Z',
      oldResistanceStrike: 980,
      newResistanceStrike: 1000,
      shiftPoints: 20,
      shiftPercent: 2.04,
      oldStrikeOiBefore: 1_850_000,
      oldStrikeOiAfter: 1_620_000,
      oldStrikeOiChange: -230_000,
      oldStrikeUnwindingPercent: -12.4,
      newStrikeOi: 2_920_000,
      newStrikeOiChange: 380_000,
      newStrikeOiChangePercent: 15.0,
      newStrikeClusterScore: 0.71,
      callVolume: 165_000,
      volumeConfirmation: 0.72,
      volumeRatio: 2.1,
      relocationScore: 72,
      signalStrength: 'Bullish',
      explanation: 'Resistance moved up from ₹980 to ₹1,000 (+2.0%). Call sellers covered at ₹980 (-12% OI) and rebuilt at ₹1,000 (+15% OI) with 2.1× median volume.',
    },
    {
      symbol: 'NSE:BHARTIARTL-EQ',
      displayName: 'BHARTIARTL',
      instrumentType: 'stock',
      spot: 1542.0,
      spotChangePercent: 0.85,
      previousSpot: 1529.0,
      asOf: '2026-08-30T15:30:00.000Z',
      previousAsOf: '2026-08-29T15:30:00.000Z',
      oldResistanceStrike: 1540,
      newResistanceStrike: 1560,
      shiftPoints: 20,
      shiftPercent: 1.30,
      oldStrikeOiBefore: 1_420_000,
      oldStrikeOiAfter: 1_280_000,
      oldStrikeOiChange: -140_000,
      oldStrikeUnwindingPercent: -9.86,
      newStrikeOi: 1_980_000,
      newStrikeOiChange: 250_000,
      newStrikeOiChangePercent: 14.5,
      newStrikeClusterScore: 0.68,
      callVolume: 112_000,
      volumeConfirmation: 0.65,
      volumeRatio: 1.8,
      relocationScore: 66,
      signalStrength: 'Bullish',
      explanation: 'Resistance moved up from ₹1,540 to ₹1,560 (+1.3%). Call sellers covered at ₹1,540 (-10% OI) and rebuilt at ₹1,560 (+14% OI) with 1.8× median volume.',
    },
    {
      symbol: 'NSE:SBIN-EQ',
      displayName: 'SBIN',
      instrumentType: 'stock',
      spot: 828.4,
      spotChangePercent: 1.82,
      previousSpot: 813.6,
      asOf: '2026-08-30T15:30:00.000Z',
      previousAsOf: '2026-08-29T15:30:00.000Z',
      oldResistanceStrike: 820,
      newResistanceStrike: 850,
      shiftPoints: 30,
      shiftPercent: 3.66,
      oldStrikeOiBefore: 4_200_000,
      oldStrikeOiAfter: 3_100_000,
      oldStrikeOiChange: -1_100_000,
      oldStrikeUnwindingPercent: -26.2,
      newStrikeOi: 5_150_000,
      newStrikeOiChange: 1_250_000,
      newStrikeOiChangePercent: 32.1,
      newStrikeClusterScore: 0.85,
      callVolume: 285_000,
      volumeConfirmation: 0.88,
      volumeRatio: 3.4,
      relocationScore: 91,
      signalStrength: 'Strong Bullish',
      explanation: 'Resistance moved up from ₹820 to ₹850 (+3.7%). Call sellers covered at ₹820 (-26% OI) and rebuilt at ₹850 (+32% OI) with 3.4× median volume.',
    },
    {
      symbol: 'NSE:BAJFINANCE-EQ',
      displayName: 'BAJFINANCE',
      instrumentType: 'stock',
      spot: 7420.0,
      spotChangePercent: 1.45,
      previousSpot: 7314.0,
      asOf: '2026-08-30T15:30:00.000Z',
      previousAsOf: '2026-08-29T15:30:00.000Z',
      oldResistanceStrike: 7400,
      newResistanceStrike: 7600,
      shiftPoints: 200,
      shiftPercent: 2.70,
      oldStrikeOiBefore: 890_000,
      oldStrikeOiAfter: 680_000,
      oldStrikeOiChange: -210_000,
      oldStrikeUnwindingPercent: -23.6,
      newStrikeOi: 1_240_000,
      newStrikeOiChange: 310_000,
      newStrikeOiChangePercent: 33.3,
      newStrikeClusterScore: 0.79,
      callVolume: 84_000,
      volumeConfirmation: 0.81,
      volumeRatio: 2.6,
      relocationScore: 84,
      signalStrength: 'Strong Bullish',
      explanation: 'Resistance moved up from ₹7,400 to ₹7,600 (+2.7%). Call sellers covered at ₹7,400 (-24% OI) and rebuilt at ₹7,600 (+33% OI) with 2.6× median volume.',
    },
    {
      symbol: 'NSE:LT-EQ',
      displayName: 'LT',
      instrumentType: 'stock',
      spot: 3650.0,
      spotChangePercent: 1.25,
      previousSpot: 3605.0,
      asOf: '2026-08-30T15:30:00.000Z',
      previousAsOf: '2026-08-29T15:30:00.000Z',
      oldResistanceStrike: 3600,
      newResistanceStrike: 3700,
      shiftPoints: 100,
      shiftPercent: 2.78,
      oldStrikeOiBefore: 760_000,
      oldStrikeOiAfter: 620_000,
      oldStrikeOiChange: -140_000,
      oldStrikeUnwindingPercent: -18.4,
      newStrikeOi: 980_000,
      newStrikeOiChange: 210_000,
      newStrikeOiChangePercent: 27.3,
      newStrikeClusterScore: 0.76,
      callVolume: 68_000,
      volumeConfirmation: 0.75,
      volumeRatio: 2.3,
      relocationScore: 77,
      signalStrength: 'Strong Bullish',
      explanation: 'Resistance moved up from ₹3,600 to ₹3,700 (+2.8%). Call sellers covered at ₹3,600 (-18% OI) and rebuilt at ₹3,700 (+27% OI) with 2.3× median volume.',
    },
    {
      symbol: 'NSE:AXISBANK-EQ',
      displayName: 'AXISBANK',
      instrumentType: 'stock',
      spot: 1215.0,
      spotChangePercent: 1.10,
      previousSpot: 1201.8,
      asOf: '2026-08-30T15:30:00.000Z',
      previousAsOf: '2026-08-29T15:30:00.000Z',
      oldResistanceStrike: 1200,
      newResistanceStrike: 1240,
      shiftPoints: 40,
      shiftPercent: 3.33,
      oldStrikeOiBefore: 2_450_000,
      oldStrikeOiAfter: 2_050_000,
      oldStrikeOiChange: -400_000,
      oldStrikeUnwindingPercent: -16.3,
      newStrikeOi: 3_120_000,
      newStrikeOiChange: 480_000,
      newStrikeOiChangePercent: 18.2,
      newStrikeClusterScore: 0.73,
      callVolume: 145_000,
      volumeConfirmation: 0.71,
      volumeRatio: 2.0,
      relocationScore: 73,
      signalStrength: 'Bullish',
      explanation: 'Resistance moved up from ₹1,200 to ₹1,240 (+3.3%). Call sellers covered at ₹1,200 (-16% OI) and rebuilt at ₹1,240 (+18% OI) with 2.0× median volume.',
    },
    {
      symbol: 'NSE:MARUTI-EQ',
      displayName: 'MARUTI',
      instrumentType: 'stock',
      spot: 12450.0,
      spotChangePercent: 0.95,
      previousSpot: 12332.0,
      asOf: '2026-08-30T15:30:00.000Z',
      previousAsOf: '2026-08-29T15:30:00.000Z',
      oldResistanceStrike: 12400,
      newResistanceStrike: 12600,
      shiftPoints: 200,
      shiftPercent: 1.61,
      oldStrikeOiBefore: 420_000,
      oldStrikeOiAfter: 365_000,
      oldStrikeOiChange: -55_000,
      oldStrikeUnwindingPercent: -13.1,
      newStrikeOi: 580_000,
      newStrikeOiChange: 95_000,
      newStrikeOiChangePercent: 19.6,
      newStrikeClusterScore: 0.70,
      callVolume: 42_000,
      volumeConfirmation: 0.68,
      volumeRatio: 1.9,
      relocationScore: 68,
      signalStrength: 'Bullish',
      explanation: 'Resistance moved up from ₹12,400 to ₹12,600 (+1.6%). Call sellers covered at ₹12,400 (-13% OI) and rebuilt at ₹12,600 (+20% OI) with 1.9× median volume.',
    },
    {
      symbol: 'NSE:HDFCBANK-EQ',
      displayName: 'HDFCBANK',
      instrumentType: 'stock',
      spot: 1680.5,
      spotChangePercent: 0.75,
      previousSpot: 1668.0,
      asOf: '2026-08-30T15:30:00.000Z',
      previousAsOf: '2026-08-29T15:30:00.000Z',
      oldResistanceStrike: 1680,
      newResistanceStrike: 1700,
      shiftPoints: 20,
      shiftPercent: 1.19,
      oldStrikeOiBefore: 4_850_000,
      oldStrikeOiAfter: 4_350_000,
      oldStrikeOiChange: -500_000,
      oldStrikeUnwindingPercent: -10.3,
      newStrikeOi: 5_920_000,
      newStrikeOiChange: 650_000,
      newStrikeOiChangePercent: 12.3,
      newStrikeClusterScore: 0.69,
      callVolume: 195_000,
      volumeConfirmation: 0.67,
      volumeRatio: 1.8,
      relocationScore: 64,
      signalStrength: 'Bullish',
      explanation: 'Resistance moved up from ₹1,680 to ₹1,700 (+1.2%). Call sellers covered at ₹1,680 (-10% OI) and rebuilt at ₹1,700 (+12% OI) with 1.8× median volume.',
    },
  ];
}
