/**
 * wall-backtest.ts
 *
 * Pure engine for OI-wall backtesting. No database or network calls.
 * All functions take only data that is already in memory.
 *
 * The key idea:
 *   1. On any given day we have a live option chain + spot price.
 *   2. We identify the strongest put-wall (support) and call-wall (resistance).
 *   3. We look forward up to HORIZON_SESSIONS trading sessions.
 *   4. We measure: did price reach the level? How many days? Did it hold or break?
 *      How big was the post-touch move?
 *
 * Using 6 months of daily price candles already in marketSessions, we can
 * evaluate outcomes for any past oiSnapshot automatically.
 */

import type { ChainStrike, LevelSide, MarketSnapshot, PriceSession } from './market-types.ts';

// Default forward-look window for outcome evaluation (two calendar weeks ≈ 10 trading sessions).
export const HORIZON_SESSIONS = 10;
const DAY = 86_400_000;

function indiaDateParts(value: string | number) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value);
  return { year: part('year'), month: part('month'), day: part('day') };
}

/** Count weekday sessions strictly after `asOf` and on or before expiry. */
export function tradingSessionsUntilExpiry(asOf: string, expiryEpoch?: number, cap = HORIZON_SESSIONS) {
  if (!expiryEpoch) return cap;
  const startParts = indiaDateParts(asOf);
  const expiryParts = indiaDateParts(expiryEpoch * 1_000);
  const start = Date.UTC(startParts.year, startParts.month - 1, startParts.day);
  const expiry = Date.UTC(expiryParts.year, expiryParts.month - 1, expiryParts.day);
  let sessions = 0;
  for (let cursor = start + DAY; cursor <= expiry && sessions < cap; cursor += DAY) {
    const weekday = new Date(cursor).getUTCDay();
    if (weekday !== 0 && weekday !== 6) sessions += 1;
  }
  return sessions;
}

// Cluster weights centred on the target strike (same as oi-model.ts).
const CLUSTER_WEIGHTS = [0.25, 0.6, 1, 0.6, 0.25] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WallDeclaration {
  strike: number;
  oi: number;
  oiChange: number;
  /** Normalised 0-1 clustered OI score at declaration time. */
  clusterScore: number;
  atr14: number;
  spot: number;
  snapshotId: string;
  declaredDate: string;
}

export interface WallOutcome {
  /** Did price reach within `HORIZON_SESSIONS` sessions? */
  reached: boolean;
  /** Number of sessions until first touch (null if never reached). */
  daysToReach: number | null;
  /** Did it hold (bounce back) after being touched? */
  held: boolean;
  /**
   * Did it break cleanly through (close beyond breach tolerance)?
   * A wall can neither hold nor break if it only briefly touches and drifts.
   */
  broke: boolean;
  /**
   * Largest favourable move (in the expected direction) in the 3 sessions
   * after the first touch, in price points. null if not reached.
   */
  bouncePoints: number | null;
  /**
   * bouncePoints / atr14AtDeclaration. null if not reached or atr=0.
   */
  bounceAtr: number | null;
}

export interface WallStats {
  /** Total evaluated predictions in the lookback window. */
  evaluated: number;
  /** Percentage that reached the level (0–100). */
  reachRate: number;
  /** Average trading sessions to first touch (among those reached). */
  avgDaysToReach: number | null;
  /** Percentage that held, among those reached (0–100). */
  holdRate: number | null;
  /** Percentage that broke through, among those reached (0–100). */
  breakRate: number | null;
  /** Average bounce in ATR units (among those reached and held). */
  avgBounceAtr: number | null;
  /** Average bounce in price points (among those reached and held). */
  avgBouncePoints: number | null;
}

/**
 * Row shape returned by history-store for aggregation.
 * Mirrors the evaluated columns of the wallPredictions DB table.
 */
export interface EvaluatedPredictionRow {
  reached: boolean | null;
  daysToReach: number | null;
  held: boolean | null;
  broke: boolean | null;
  bouncePoints: number | null;
  bounceAtr: number | null;
}

/**
 * Shape describing what declarePrimaryWalls returns per side.
 * Null if no candidate exists on that side.
 */
export interface PrimaryWalls {
  support: WallDeclaration | null;
  resistance: WallDeclaration | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function normalizeArray(values: number[]) {
  const max = Math.max(...values, 1);
  return values.map((v) => clamp01(v / max));
}

/**
 * Compute the clustered OI score for each strike in the sorted chain.
 * Returns an array of normalised scores (0–1), same order as `chain`.
 */
function computeClusterScores(chain: ChainStrike[], side: 'put' | 'call'): number[] {
  const raw = chain.map((_, index) =>
    CLUSTER_WEIGHTS.reduce(
      (sum, weight, offset) =>
        sum +
        (side === 'put'
          ? (chain[index + offset - 2]?.putOi ?? 0)
          : (chain[index + offset - 2]?.callOi ?? 0)) *
          weight,
      0,
    ),
  );
  return normalizeArray(raw);
}

// ─── Primary wall declaration ─────────────────────────────────────────────────

/**
 * Given a market snapshot (option chain + spot), identify the single strongest
 * support (put-wall below spot) and resistance (call-wall above spot).
 *
 * Scoring: clustered OI × OI-change sign factor × proximity decay.
 * This is intentionally simpler than the full model — we want a single
 * deterministic wall per day that we can track forward.
 */
export function declarePrimaryWalls(snapshot: MarketSnapshot, snapshotId: string): PrimaryWalls {
  const chain = [...snapshot.chain].sort((a, b) => a.strike - b.strike);
  const putClusters = computeClusterScores(chain, 'put');
  const callClusters = computeClusterScores(chain, 'call');
  const distanceScale = Math.max(snapshot.atr14, snapshot.strikeStep * 2);
  const maxDistance = snapshot.instrumentType === 'stock'
    ? Math.max(snapshot.atr14 * 3, snapshot.strikeStep * 8)
    : Math.max(snapshot.atr14 * 3.5, snapshot.strikeStep * 10);
  const putVolumes = normalizeArray(chain.map((row) => Math.log1p(row.putVolume)));
  const callVolumes = normalizeArray(chain.map((row) => Math.log1p(row.callVolume)));
  const date = snapshot.asOf.slice(0, 10);

  interface ScoredStrike {
    strike: number;
    oi: number;
    oiChange: number;
    clusterScore: number;
    volumeScore: number;
    compositeScore: number;
  }

  const supports: ScoredStrike[] = [];
  const resistances: ScoredStrike[] = [];

  chain.forEach((row, index) => {
    const distance = Math.abs(snapshot.spot - row.strike);
    if (distance > maxDistance) return;
    const proximity = Math.exp(-distance / distanceScale);
    const putOiChangeFactor = (Math.tanh(row.putOiChange / Math.max(1, row.putOi * 0.2)) + 1) / 2;
    const callOiChangeFactor = (Math.tanh(row.callOiChange / Math.max(1, row.callOi * 0.2)) + 1) / 2;

    if (row.strike < snapshot.spot && row.putOi > 0) {
      const cluster = putClusters[index];
      supports.push({
        strike: row.strike,
        oi: row.putOi,
        oiChange: row.putOiChange,
        clusterScore: cluster,
        volumeScore: putVolumes[index],
        compositeScore: snapshot.instrumentType === 'stock'
          ? cluster * 0.45 + putOiChangeFactor * 0.2 + proximity * 0.15 + putVolumes[index] * 0.2
          : cluster * 0.55 + putOiChangeFactor * 0.25 + proximity * 0.20,
      });
    }

    if (row.strike > snapshot.spot && row.callOi > 0) {
      const cluster = callClusters[index];
      resistances.push({
        strike: row.strike,
        oi: row.callOi,
        oiChange: row.callOiChange,
        clusterScore: cluster,
        volumeScore: callVolumes[index],
        compositeScore: snapshot.instrumentType === 'stock'
          ? cluster * 0.45 + callOiChangeFactor * 0.2 + proximity * 0.15 + callVolumes[index] * 0.2
          : cluster * 0.55 + callOiChangeFactor * 0.25 + proximity * 0.20,
      });
    }
  });

  const best = (list: ScoredStrike[]): WallDeclaration | null => {
    if (!list.length) return null;
    const liquid = snapshot.instrumentType === 'stock'
      ? list.filter((candidate) => candidate.volumeScore >= 0.08 && candidate.clusterScore >= 0.12)
      : list;
    const pool = liquid.length >= 3 ? liquid : list;
    const top = pool.reduce((prev, cur) => (cur.compositeScore > prev.compositeScore ? cur : prev));
    return {
      strike: top.strike,
      oi: top.oi,
      oiChange: top.oiChange,
      clusterScore: top.clusterScore,
      atr14: snapshot.atr14,
      spot: snapshot.spot,
      snapshotId,
      declaredDate: date,
    };
  };

  return { support: best(supports), resistance: best(resistances) };
}

// ─── Outcome evaluation ───────────────────────────────────────────────────────

/**
 * Walk `futureSessions` (in chronological order) and evaluate whether the
 * price reached `strike`, and what happened next.
 *
 * @param strike          The declared OI wall price level.
 * @param side            'support' or 'resistance'.
 * @param atr14           ATR on the declaration day (used for tolerance calculations).
 * @param futureSessions  Trading sessions AFTER the declaration day, in order.
 */
export function evaluateWallOutcome(
  strike: number,
  side: LevelSide,
  atr14: number,
  futureSessions: PriceSession[],
): WallOutcome {
  // Touch: low/high within 15% of ATR from the strike.
  const touchTolerance = Math.max(atr14 * 0.15, 0.5);
  // Breach: closing price crosses more than 25% of ATR beyond the strike.
  const breachTolerance = atr14 * 0.25;

  let touchDayIndex: number | null = null;

  // Find first session that touches the level.
  for (let i = 0; i < futureSessions.length; i++) {
    const s = futureSessions[i];
    const touched =
      side === 'support' ? s.low <= strike + touchTolerance : s.high >= strike - touchTolerance;
    if (touched) {
      touchDayIndex = i;
      break;
    }
  }

  if (touchDayIndex === null) {
    return { reached: false, daysToReach: null, held: false, broke: false, bouncePoints: null, bounceAtr: null };
  }

  // 1-based: reached on the very next session = daysToReach 1.
  const daysToReach = touchDayIndex + 1;

  // A wall can fail on the touch session itself. Include that close when
  // checking breaches, then use up to three later sessions for recovery.
  const postTouch = futureSessions.slice(touchDayIndex + 1, touchDayIndex + 4);
  const breachWindow = futureSessions.slice(touchDayIndex, touchDayIndex + 4);

  // Broke = any close crossing more than breachTolerance beyond the strike.
  const broke = breachWindow.some((s) =>
    side === 'support'
      ? s.close < strike - breachTolerance
      : s.close > strike + breachTolerance,
  );

  // Held = did not break, and the final close in the window is on the expected side.
  const lastClose = postTouch.at(-1)?.close ?? futureSessions[touchDayIndex].close;
  const recovered = side === 'support' ? lastClose >= strike : lastClose <= strike;
  const held = !broke && recovered;

  // Bounce = largest favourable move in post-touch window (in the correct direction).
  let maxFavourableMove = 0;
  for (const s of postTouch) {
    const move =
      side === 'support'
        ? s.close - strike // positive = price bounced up away from support
        : strike - s.close; // positive = price dropped away from resistance
    if (move > maxFavourableMove) maxFavourableMove = move;
  }

  const bouncePoints = maxFavourableMove > 0 ? maxFavourableMove : null;
  const bounceAtr = bouncePoints !== null && atr14 > 0 ? bouncePoints / atr14 : null;

  return { reached: true, daysToReach, held, broke, bouncePoints, bounceAtr };
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

/**
 * Aggregate an array of evaluated wall prediction rows into human-readable stats.
 * Only rows where `reached` is non-null (i.e. already evaluated) are counted.
 */
export function aggregateWallStats(rows: EvaluatedPredictionRow[]): WallStats {
  const evaluated = rows.filter((r) => r.reached !== null);

  if (evaluated.length === 0) {
    return {
      evaluated: 0,
      reachRate: 0,
      avgDaysToReach: null,
      holdRate: null,
      breakRate: null,
      avgBounceAtr: null,
      avgBouncePoints: null,
    };
  }

  const reached = evaluated.filter((r) => r.reached === true);
  const reachRate = (reached.length / evaluated.length) * 100;

  const daysValues = reached.map((r) => r.daysToReach).filter((d): d is number => d !== null);
  const avgDaysToReach =
    daysValues.length > 0 ? daysValues.reduce((a, b) => a + b, 0) / daysValues.length : null;

  const held = reached.filter((r) => r.held === true);
  const broke = reached.filter((r) => r.broke === true);
  const holdRate = reached.length > 0 ? (held.length / reached.length) * 100 : null;
  const breakRate = reached.length > 0 ? (broke.length / reached.length) * 100 : null;

  const bounceAtrValues = held.map((r) => r.bounceAtr).filter((v): v is number => v !== null);
  const bouncePointValues = held.map((r) => r.bouncePoints).filter((v): v is number => v !== null);

  const avgBounceAtr =
    bounceAtrValues.length > 0
      ? bounceAtrValues.reduce((a, b) => a + b, 0) / bounceAtrValues.length
      : null;
  const avgBouncePoints =
    bouncePointValues.length > 0
      ? bouncePointValues.reduce((a, b) => a + b, 0) / bouncePointValues.length
      : null;

  return {
    evaluated: evaluated.length,
    reachRate,
    avgDaysToReach,
    holdRate,
    breakRate,
    avgBounceAtr,
    avgBouncePoints,
  };
}

// ─── History-based evaluation helper ─────────────────────────────────────────

/**
 * Given the full sorted price-history array, evaluate the outcome of a declared
 * wall using sessions that came AFTER `declaredDate`.
 *
 * Used during backfill: for every saved oiSnapshot in the DB, we look up the
 * subsequent daily candles from `marketSessions` and compute the outcome.
 *
 * @param allSessions  All daily sessions in chronological order (any date range).
 * @param declaredDate YYYY-MM-DD of the prediction day.
 * @param strike       Declared wall strike price.
 * @param side         'support' or 'resistance'.
 * @param atr14        ATR on the declaration day.
 * @param horizon      Maximum sessions to look forward (default HORIZON_SESSIONS).
 * @returns WallOutcome, or null if no future sessions are available yet.
 */
export function evaluateFromHistory(
  allSessions: PriceSession[],
  declaredDate: string,
  strike: number,
  side: LevelSide,
  atr14: number,
  horizon = HORIZON_SESSIONS,
): WallOutcome | null {
  const afterIndex = allSessions.findIndex((s) => s.date > declaredDate);
  if (afterIndex === -1) return null; // no future sessions available yet
  const futureSessions = allSessions.slice(afterIndex, afterIndex + horizon);
  // Do not permanently label a wall as "not reached" until its complete
  // declared horizon has elapsed.
  if (futureSessions.length < horizon) return null;
  return evaluateWallOutcome(strike, side, atr14, futureSessions);
}

// ─── Feature Threshold Diagnostics ──────────────────────────────────────────

export interface FeatureThresholds {
  positiveOiChangeHoldRate: number | null;
  negativeOiChangeHoldRate: number | null;
  highClusterHoldRate: number | null;
  lowClusterHoldRate: number | null;
  sampleCount: number;
}

export interface WallPredictionRowForThresholds {
  oiChangeAtDeclaration: number;
  clusterScore: number;
  reached: boolean | null;
  held: boolean | null;
}

export function analyzeFeatureThresholds(rows: WallPredictionRowForThresholds[]): FeatureThresholds {
  const reached = rows.filter((r) => r.reached === true && r.held !== null);
  if (!reached.length) {
    return {
      positiveOiChangeHoldRate: null,
      negativeOiChangeHoldRate: null,
      highClusterHoldRate: null,
      lowClusterHoldRate: null,
      sampleCount: 0,
    };
  }

  const positiveOi = reached.filter((r) => r.oiChangeAtDeclaration > 0);
  const negativeOi = reached.filter((r) => r.oiChangeAtDeclaration <= 0);
  const highCluster = reached.filter((r) => r.clusterScore >= 0.65);
  const lowCluster = reached.filter((r) => r.clusterScore < 0.65);

  const calcRate = (list: typeof reached) =>
    list.length ? (list.filter((r) => r.held).length / list.length) * 100 : null;

  return {
    positiveOiChangeHoldRate: calcRate(positiveOi),
    negativeOiChangeHoldRate: calcRate(negativeOi),
    highClusterHoldRate: calcRate(highCluster),
    lowClusterHoldRate: calcRate(lowCluster),
    sampleCount: reached.length,
  };
}
