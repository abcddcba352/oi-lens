import type { LevelSide, MarketSnapshot, PriceSession } from './market-types.ts';
import type { WatchCandidate } from './position-watchlist.ts';
import { cleanCandles, type WatchCandle } from './position-watchlist.ts';
import {
  aggregateWallStats,
  declarePrimaryWalls,
  evaluateFromHistory,
  HORIZON_SESSIONS,
  tradingSessionsUntilExpiry,
  type EvaluatedPredictionRow,
} from './wall-backtest.ts';

export type WatchOiClassification =
  | 'OI confirmed'
  | 'OI developing'
  | 'OI conflict'
  | 'OI stale'
  | 'Price only';

export interface WatchOiWall {
  side: LevelSide;
  strike: number;
  oi: number;
  oiChange: number;
  clusterScore: number;
  distancePercent: number;
  distanceAtr: number;
}

export interface WatchWallHistory {
  evaluated: number;
  reached: number;
  held: number;
  broke: number;
  reachRate: number;
  holdRate: number | null;
  breakRate: number | null;
  avgDaysToReach: number | null;
  avgBounceAtr: number | null;
}

export interface WatchWallOutcomeRow extends EvaluatedPredictionRow {
  side: LevelSide;
  declaredDate: string;
  capturedAt: string;
}

export interface WatchOiEvidence {
  breakoutCheck?: { strike: number; confirmationClose: number; status: 'Needs confirmation' | 'Held above zone' | 'Failed breakout'; detail: string };
  classification: WatchOiClassification;
  asOf: string | null;
  expiry: string | null;
  source: string | null;
  ageDays: number | null;
  support: WatchOiWall | null;
  resistance: WatchOiWall | null;
  priceResistanceConfluence: boolean;
  confirmations: string[];
  conflicts: string[];
  historical: {
    support: WatchWallHistory;
    resistance: WatchWallHistory;
  } | null;
  note: string;
}

const DAY = 86_400_000;
const round = (value: number) => Math.round(value * 100) / 100;

function historyForSide(rows: WatchWallOutcomeRow[], side: LevelSide): WatchWallHistory {
  // Imported and live feeds can create more than one prediction in a day. Keep
  // only the latest declaration for each side/day so a busy intraday session
  // cannot receive more weight than an EOD session.
  const daily = new Map<string, WatchWallOutcomeRow>();
  for (const row of rows) {
    if (row.side !== side || row.reached === null) continue;
    const current = daily.get(row.declaredDate);
    if (!current || row.capturedAt > current.capturedAt) daily.set(row.declaredDate, row);
  }
  const values = [...daily.values()];
  const stats = aggregateWallStats(values);
  const reached = values.filter(row => row.reached === true);
  return {
    evaluated: stats.evaluated,
    reached: reached.length,
    held: reached.filter(row => row.held === true).length,
    broke: reached.filter(row => row.broke === true).length,
    reachRate: round(stats.reachRate),
    holdRate: stats.holdRate === null ? null : round(stats.holdRate),
    breakRate: stats.breakRate === null ? null : round(stats.breakRate),
    avgDaysToReach: stats.avgDaysToReach === null ? null : round(stats.avgDaysToReach),
    avgBounceAtr: stats.avgBounceAtr === null ? null : round(stats.avgBounceAtr),
  };
}

function wall(
  side: LevelSide,
  declaration: ReturnType<typeof declarePrimaryWalls>[LevelSide],
  snapshot: MarketSnapshot,
): WatchOiWall | null {
  if (!declaration) return null;
  return {
    side,
    strike: declaration.strike,
    oi: declaration.oi,
    oiChange: declaration.oiChange,
    clusterScore: round(declaration.clusterScore * 100),
    distancePercent: round((Math.abs(declaration.strike - snapshot.spot) / snapshot.spot) * 100),
    distanceAtr: snapshot.atr14 > 0
      ? round(Math.abs(declaration.strike - snapshot.spot) / snapshot.atr14)
      : 0,
  };
}

export function unavailableWatchOiEvidence(note = 'No saved option-chain snapshot is available for this setup.'): WatchOiEvidence {
  return {
    classification: 'Price only',
    asOf: null,
    expiry: null,
    source: null,
    ageDays: null,
    support: null,
    resistance: null,
    priceResistanceConfluence: false,
    confirmations: [],
    conflicts: [],
    historical: null,
    note,
  };
}

/** Derive completed outcomes from saved daily snapshots without writing more D1 rows. */
export function deriveWatchWallOutcomes(
  snapshots: MarketSnapshot[],
  prices: PriceSession[],
  cutoffDate: string,
): WatchWallOutcomeRow[] {
  const latestByDay = new Map<string, MarketSnapshot>();
  for (const snapshot of snapshots) {
    const date = snapshot.asOf.slice(0, 10);
    if (date >= cutoffDate || !snapshot.chain.length) continue;
    const current = latestByDay.get(date);
    if (!current || snapshot.asOf > current.asOf) latestByDay.set(date, snapshot);
  }

  const rows: WatchWallOutcomeRow[] = [];
  for (const snapshot of [...latestByDay.values()].sort((a, b) => a.asOf.localeCompare(b.asOf))) {
    const declaredDate = snapshot.asOf.slice(0, 10);
    const walls = declarePrimaryWalls(snapshot, `derived:${snapshot.symbol}:${snapshot.asOf}`);
    const horizon = tradingSessionsUntilExpiry(snapshot.asOf, snapshot.expiryEpoch, HORIZON_SESSIONS);
    if (horizon <= 0) continue;
    for (const side of ['support', 'resistance'] as const) {
      const declaration = walls[side];
      if (!declaration) continue;
      const result = evaluateFromHistory(prices, declaredDate, declaration.strike, side, declaration.atr14, horizon);
      if (!result) continue;
      rows.push({
        side,
        declaredDate,
        capturedAt: snapshot.asOf,
        reached: result.reached,
        daysToReach: result.daysToReach,
        held: result.held,
        broke: result.broke,
        bouncePoints: result.bouncePoints,
        bounceAtr: result.bounceAtr,
      });
    }
  }
  return rows;
}

/**
 * Add an honest OI confirmation layer to an already-qualified price setup.
 * OI changes describe exchange-reported contract changes; they do not identify
 * whether participants are buyers or writers.
 */
export function buildWatchOiEvidence(
  candidate: WatchCandidate,
  snapshot: MarketSnapshot,
  outcomes: WatchWallOutcomeRow[],
  cutoffDate: string,
  prices: WatchCandle[] = [],
): WatchOiEvidence {
  const declarations = declarePrimaryWalls(snapshot, `watchlist:${snapshot.symbol}:${snapshot.asOf}`);
  const support = wall('support', declarations.support, snapshot);
  const resistance = wall('resistance', declarations.resistance, snapshot);
  const ageDays = Math.max(0, Math.floor((Date.parse(cutoffDate) - Date.parse(snapshot.asOf.slice(0, 10))) / DAY));
  const stale = ageDays > 7;
  // Keep substantial call strikes around spot visible even after a small crossing.
  // This uses current OI, not a claim that the strike was a historical OI wall.
  const tolerance = candidate.atr * 0.25;
  const recent = cleanCandles(prices, cutoffDate).slice(-10);
  const maxCallOi = Math.max(0, ...snapshot.chain.map(row => row.callOi));
  const nearby = snapshot.chain.filter(row => row.callOi > 0 &&
    row.callOi >= maxCallOi * 0.25 &&
    row.strike >= candidate.close - candidate.atr &&
    (row.strike <= candidate.close + tolerance ||
      (row.strike <= candidate.close + candidate.atr &&
        recent.slice(0, -1).some(price => price.close > row.strike + tolerance))))
    .sort((a, b) => Math.abs(a.strike - candidate.close) - Math.abs(b.strike - candidate.close))[0];
  let breakoutCheck: WatchOiEvidence['breakoutCheck'];
  if (!stale && snapshot.asOf.slice(0, 10) === candidate.asOf && nearby && candidate.atr > 0) {
    const threshold = nearby.strike + tolerance;
    const last = recent.at(-1);
    const previous = recent.at(-2);
    const aligned = last?.date === candidate.asOf && Math.abs(last.close - candidate.close) < 0.01;
    const consecutive = aligned && last.close > threshold && previous !== undefined && previous.close > threshold;
    const retested = aligned && last.close > threshold && last.low >= nearby.strike - tolerance &&
      last.low <= threshold && recent.slice(0, -1).some(row => row.close > threshold);
    const failed = aligned && last.close < nearby.strike - tolerance &&
      recent.slice(0, -1).some(row => row.close > threshold);
    const status = failed ? 'Failed breakout' : consecutive || retested ? 'Held above zone' : 'Needs confirmation';
    breakoutCheck = {
      strike: nearby.strike,
      confirmationClose: round(threshold),
      status,
      detail: status === 'Held above zone'
        ? `Price held above ${nearby.strike} by more than 0.25 ATR on two closes or a later retest. This does not guarantee a breakout.`
        : status === 'Failed breakout'
          ? `Price closed back below ${nearby.strike} minus 0.25 ATR after an earlier close above the zone.`
          : `Call OI remains at ${nearby.strike}. Needs two closes above ${round(threshold)}, or a later retest that holds and closes above it.`,
    };
  }
  const eligibleOutcomes = outcomes.filter(row => row.declaredDate < cutoffDate);
  const supportHistory = historyForSide(eligibleOutcomes, 'support');
  const resistanceHistory = historyForSide(eligibleOutcomes, 'resistance');
  const historical = supportHistory.evaluated + resistanceHistory.evaluated > 0
    ? { support: supportHistory, resistance: resistanceHistory }
    : null;

  const confluenceTolerance = Math.max(candidate.atr * 0.35, snapshot.strikeStep * 0.5);
  const priceResistanceConfluence = resistance !== null &&
    Math.abs(resistance.strike - candidate.resistance) <= confluenceTolerance;
  const confirmations: string[] = [];
  const conflicts: string[] = [];

  if (!stale) {
    if (support && support.oiChange > 0) confirmations.push('Put OI increased at the primary support wall');
    if (resistance && resistance.oiChange < 0) confirmations.push('Call OI decreased at the primary resistance wall');
    if (priceResistanceConfluence) confirmations.push('OI resistance aligns with prior price resistance');
    if (support && support.oiChange < 0) conflicts.push('Put OI decreased at the primary support wall');
    if (resistance && resistance.oiChange > 0) conflicts.push('Call OI increased at the primary resistance wall');

    if (supportHistory.evaluated >= 5 && supportHistory.reached >= 3 &&
        (supportHistory.holdRate ?? 0) > (supportHistory.breakRate ?? 0)) {
      confirmations.push(`Past support walls held more often than they broke (${supportHistory.held}/${supportHistory.reached} reached)`);
    }
    if (resistanceHistory.evaluated >= 5 && resistanceHistory.reached >= 3 &&
        (resistanceHistory.breakRate ?? 0) > (resistanceHistory.holdRate ?? 0)) {
      confirmations.push(`Past resistance walls broke more often than they held (${resistanceHistory.broke}/${resistanceHistory.reached} reached)`);
    }
  }

  let classification: WatchOiClassification = 'Price only';
  if (stale) classification = 'OI stale';
  else if (conflicts.length > confirmations.length) classification = 'OI conflict';
  else if (confirmations.length >= 2 && conflicts.length === 0) classification = 'OI confirmed';
  else if (confirmations.length > 0) classification = 'OI developing';
  else if (conflicts.length > 0) classification = 'OI conflict';

  return {
    breakoutCheck,
    classification,
    asOf: snapshot.asOf,
    expiry: snapshot.expiry,
    source: snapshot.source,
    ageDays,
    support,
    resistance,
    priceResistanceConfluence,
    confirmations,
    conflicts,
    historical,
    note: stale
      ? 'The saved OI snapshot is more than seven calendar days older than the price cutoff, so it is displayed but not used as confirmation.'
      : historical
        ? 'Historical rates use completed 10-session wall outcomes from independent weekly archive samples.'
        : 'Current walls are available, but no completed historical wall outcomes are stored yet.',
  };
}

/** OI review can demote a price-qualified setup, but never promote one. */
export function applyWatchOiPriorityGuard(candidate: WatchCandidate): void {
  const check = candidate.oiEvidence?.breakoutCheck;
  if (check && check.status !== 'Held above zone') {
    candidate.group = 'developing';
    candidate.stage = check.status === 'Failed breakout' ? 'Failed OI breakout' : 'OI breakout needs confirmation';
  }
}

export function watchOiRank(classification: WatchOiClassification) {
  return classification === 'OI confirmed' ? 4
    : classification === 'OI developing' ? 3
      : classification === 'Price only' ? 2
        : classification === 'OI stale' ? 1
          : 0;
}
