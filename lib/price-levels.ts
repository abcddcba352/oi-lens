/**
 * price-levels.ts
 *
 * Pure module for extracting confirmed historical price support/resistance
 * evidence from daily OHLC candles.  No database or network calls.
 *
 * Key concepts:
 *   - A **swing low** is a bar whose low is lower than `N` bars on each side.
 *   - A **swing high** is a bar whose high is higher than `N` bars on each side.
 *   - Nearby pivots are grouped into **price zones** using an ATR/strike-step
 *     tolerance: max(0.35 × ATR, 0.5 × strikeStep).
 *   - Each zone tracks touches, hold/break behaviour, bounce magnitude,
 *     and recency with exponential decay.
 *   - **No volume is used.**  The market_sessions schema does not store daily
 *     traded volume; do not claim or score volume without extending the schema
 *     and import pipeline with real data.
 */

import type { LevelSide, PriceSession } from './market-types.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PricePivot {
  /** The bar index in the history array. */
  index: number;
  /** ISO date of the pivot bar. */
  date: string;
  /** The price at the pivot (low for swing-low, high for swing-high). */
  price: number;
  type: 'swing-high' | 'swing-low';
  /** Always true — only confirmed pivots are returned. */
  confirmed: true;
}

export interface PriceSRZone {
  /** Centre of the zone (weighted average of pivot prices). */
  center: number;
  side: LevelSide;
  /** Number of distinct pivot touches. */
  touches: number;
  /** Number of touches that held. */
  holds: number;
  /** Number of touches that broke through. */
  breaks: number;
  /** Recency-weighted hold rate with Laplace smoothing. */
  weightedHoldRate: number;
  /** Average bounce in ATR units (among held touches). */
  bounceAtr: number;
  /** Exponential recency score (0–1).  More recent → higher. */
  recencyScore: number;
  /** Whether this zone is historically confirmed vs projected. */
  label: 'Confirmed' | 'Projected';
  origin?: 'pivot' | 'role-reversal';
}

export interface PriceSRFeatureVector {
  /** Hold rate at the nearest confirmed price S/R zone. */
  priceHoldRate: number;
  /** Number of historical touches at the nearest zone (normalised 0–1). */
  priceTouches: number;
  /** Average bounce at that zone in ATR units (normalised 0–1). */
  priceBounceAtr: number;
  /** Exponential recency score of the nearest zone (0–1). */
  priceRecency: number;
  /** ATR-normalised distance from the OI wall to the nearest price level. */
  priceDistance: number;
  /** Whether the OI wall and nearest price level are within confluence tolerance. */
  isConfluent: boolean;
}

export interface ConfluenceInfo {
  nearestPriceLevel: number | null;
  priceLevelType: 'Confirmed' | 'Projected';
  distance: number;
  confluenceTolerance: number;
  isConfluent: boolean;
  priceTouches: number;
  historicalHoldRate: number | null;
  historicalBreakRate: number | null;
  sampleCount: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Number of bars on each side required to confirm a swing pivot. */
const PIVOT_BARS_EACH_SIDE = 2;

/** Recency half-life in trading sessions for time-decay weighting. */
const RECENCY_HALF_LIFE = 63;

/** Decay constant for exponential recency: ln(2) / halfLife. */
const RECENCY_DECAY = Math.LN2 / RECENCY_HALF_LIFE;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

/**
 * Compute the zone grouping tolerance.
 *
 * Formula (documented as required):
 *   tolerance = max(0.35 × ATR, 0.5 × strikeStep)
 *
 * This balances price-scale sensitivity (ATR) with the minimum option chain
 * granularity (strikeStep) so that zones are never thinner than half a strike.
 */
export function confluenceTolerance(atr: number, strikeStep: number): number {
  return Math.max(0.35 * atr, 0.5 * strikeStep);
}

// ─── Pivot Detection ──────────────────────────────────────────────────────────

/**
 * Find confirmed swing pivots in a price history.
 *
 * A pivot at index `i` is confirmed only when all bars from
 * `i - barsEachSide` to `i + barsEachSide` are present in the history.
 * This means the earliest possible pivot is at index `barsEachSide` and the
 * latest is at `history.length - 1 - barsEachSide`.
 *
 * @param history       Daily OHLC sessions, sorted chronologically.
 * @param barsEachSide  Number of bars required on each side (default 2).
 * @returns Array of confirmed pivots, in chronological order.
 */
export function findConfirmedPivots(
  history: PriceSession[],
  barsEachSide = PIVOT_BARS_EACH_SIDE,
): PricePivot[] {
  const pivots: PricePivot[] = [];
  const n = history.length;
  if (n < 2 * barsEachSide + 1) return pivots;

  for (let i = barsEachSide; i < n - barsEachSide; i++) {
    const bar = history[i];

    // Check swing low (support pivot)
    let isSwingLow = true;
    for (let offset = 1; offset <= barsEachSide; offset++) {
      if (history[i - offset].low <= bar.low || history[i + offset].low <= bar.low) {
        isSwingLow = false;
        break;
      }
    }
    if (isSwingLow) {
      pivots.push({
        index: i,
        date: bar.date,
        price: bar.low,
        type: 'swing-low',
        confirmed: true,
      });
    }

    // Check swing high (resistance pivot)
    let isSwingHigh = true;
    for (let offset = 1; offset <= barsEachSide; offset++) {
      if (history[i - offset].high >= bar.high || history[i + offset].high >= bar.high) {
        isSwingHigh = false;
        break;
      }
    }
    if (isSwingHigh) {
      pivots.push({
        index: i,
        date: bar.date,
        price: bar.high,
        type: 'swing-high',
        confirmed: true,
      });
    }
  }

  return pivots;
}

// ─── Zone Grouping ────────────────────────────────────────────────────────────

/**
 * Group nearby pivots into price S/R zones.
 *
 * Pivots within `confluenceTolerance(atr, strikeStep)` of each other are
 * merged into a single zone.  Each zone tracks touch count, hold/break
 * behaviour, and recency.
 *
 * Hold/break evaluation at each touch:
 *   - A "touch" is a session where price came within the tolerance of the zone.
 *   - "Held" means the close stayed on the expected side within 3 sessions.
 *   - "Broke" means the close moved beyond the breach tolerance.
 *   - Bounce is the largest favourable close move from the zone in those 3 sessions.
 *
 * @param pivots      Confirmed pivots from findConfirmedPivots.
 * @param history     Full price history (for evaluating hold/break).
 * @param atr         Current or historical ATR-14.
 * @param strikeStep  Strike step of the instrument.
 * @param totalBars   Total number of bars in the history (for recency calculation).
 */
export function groupPivotsIntoZones(
  pivots: PricePivot[],
  history: PriceSession[],
  atr: number,
  strikeStep: number,
  totalBars?: number,
): PriceSRZone[] {
  const tolerance = confluenceTolerance(atr, strikeStep);
  const total = totalBars ?? history.length;

  // Separate by side
  const supportPivots = pivots.filter((p) => p.type === 'swing-low');
  const resistancePivots = pivots.filter((p) => p.type === 'swing-high');

  const zones: PriceSRZone[] = [];

  for (const [side, sidePivots] of [
    ['support', supportPivots],
    ['resistance', resistancePivots],
  ] as const) {
    // Sort by price
    const sorted = [...sidePivots].sort((a, b) => a.price - b.price);
    const used = new Set<number>();

    for (const pivot of sorted) {
      if (used.has(pivot.index)) continue;

      // Collect all pivots within tolerance of this one
      const cluster = [pivot];
      used.add(pivot.index);
      for (const other of sorted) {
        if (used.has(other.index)) continue;
        if (Math.abs(other.price - pivot.price) <= tolerance) {
          cluster.push(other);
          used.add(other.index);
        }
      }

      // Zone center = average of pivot prices
      const center = cluster.reduce((s, p) => s + p.price, 0) / cluster.length;

      // Evaluate hold/break for each touch
      let holds = 0;
      let breaks = 0;
      let totalBounce = 0;
      let heldCount = 0;
      let weightedHolds = 0;
      let weightedTotal = 0;
      let latestIndex = 0;

      for (const p of cluster) {
        const recencyWeight = Math.exp(-RECENCY_DECAY * (total - 1 - p.index));
        latestIndex = Math.max(latestIndex, p.index);

        // Look at 3 sessions after the pivot
        const postTouch = history.slice(p.index + 1, p.index + 4);
        if (postTouch.length === 0) continue;

        const breachTol = atr * 0.25;
        const breached = postTouch.some((s) =>
          side === 'support'
            ? s.close < center - breachTol
            : s.close > center + breachTol,
        );
        const lastClose = postTouch.at(-1)?.close ?? history[p.index].close;
        const recovered = side === 'support'
          ? lastClose >= center
          : lastClose <= center;
        const held = !breached && recovered;

        if (held) {
          holds++;
          heldCount++;
          weightedHolds += recencyWeight;

          // Bounce: largest favourable move
          let maxBounce = 0;
          for (const s of postTouch) {
            const move = side === 'support'
              ? s.close - center
              : center - s.close;
            if (move > maxBounce) maxBounce = move;
          }
          totalBounce += atr > 0 ? maxBounce / atr : 0;
        } else {
          breaks++;
        }
        weightedTotal += recencyWeight;
      }

      const touches = cluster.length;
      // Laplace-smoothed hold rate
      const weightedHoldRate = (weightedHolds + 1) / (weightedTotal + 2);
      const bounceAtrAvg = heldCount > 0 ? totalBounce / heldCount : 0;
      const recencyScore = clamp01(Math.exp(-RECENCY_DECAY * (total - 1 - latestIndex)));

      zones.push({
        center,
        side,
        touches,
        holds,
        breaks,
        weightedHoldRate,
        bounceAtr: bounceAtrAvg,
        recencyScore,
        label: 'Confirmed',
        origin: 'pivot',
      });
    }
  }

  // Detect role reversals from broken zones
  const roleReversed = detectRoleReversals(zones, history, atr, strikeStep);
  zones.push(...roleReversed);

  return zones;
}

/**
 * Detect role reversals from broken price zones.
 *
 * Role reversal logic:
 *   - A historical support that was broken (close < center - breachTol) may
 *     become resistance if price later retests it from below and bounces down.
 *   - A historical resistance that was broken (close > center + breachTol) may
 *     become support if price later retests it from above and bounces up.
 *
 * Both the breakout session and the retest session must be complete before
 * the cutoff date.  Future candles are never used.
 *
 * Tolerances:
 *   - Breakout confirmation: close crosses center ± (atr × 0.25)
 *   - Retest proximity: price returns within confluenceTolerance(atr, strikeStep)
 *   - Retest bounce: close after retest is on the new expected side
 *
 * The original pivot touches are NOT double-counted in the role-reversed zone.
 *
 * @param zones       Zones from groupPivotsIntoZones (only 'pivot' origin zones).
 * @param history     Price sessions available (must be strictly before cutoff).
 * @param atr         ATR-14.
 * @param strikeStep  Strike step.
 * @returns Additional role-reversed zones to append.
 */
export function detectRoleReversals(
  zones: PriceSRZone[],
  history: PriceSession[],
  atr: number,
  strikeStep: number,
): PriceSRZone[] {
  const reversed: PriceSRZone[] = [];
  const tolerance = confluenceTolerance(atr, strikeStep);
  const breachTol = atr * 0.25;
  const totalBars = history.length;

  for (const zone of zones) {
    // Only consider zones that were predominantly broken
    if (zone.origin !== 'pivot') continue;
    const totalTests = zone.holds + zone.breaks;
    if (totalTests === 0 || zone.breaks === 0) continue;
    // Need majority breaks to consider a role reversal
    if (zone.breaks / totalTests < 0.5) continue;

    const center = zone.center;
    const originalSide = zone.side;
    const newSide: LevelSide = originalSide === 'support' ? 'resistance' : 'support';

    // Step 1: Find breakout session — close crosses beyond breach tolerance
    let breakoutIdx = -1;
    for (let i = 0; i < history.length; i++) {
      const s = history[i];
      if (originalSide === 'support' && s.close < center - breachTol) {
        breakoutIdx = i;
        break;
      }
      if (originalSide === 'resistance' && s.close > center + breachTol) {
        breakoutIdx = i;
        break;
      }
    }
    if (breakoutIdx < 0) continue;

    // Step 2: Find retest session AFTER breakout — price returns within tolerance
    let retestIdx = -1;
    for (let i = breakoutIdx + 1; i < history.length; i++) {
      const s = history[i];
      // Price must come back close to the level
      if (originalSide === 'support') {
        // Broken support: price fell below, now returns up near the level
        if (s.high >= center - tolerance && s.high <= center + tolerance) {
          retestIdx = i;
          break;
        }
      } else {
        // Broken resistance: price rose above, now returns down near the level
        if (s.low >= center - tolerance && s.low <= center + tolerance) {
          retestIdx = i;
          break;
        }
      }
    }
    if (retestIdx < 0) continue;

    // Step 3: Verify bounce — check up to 3 sessions after retest
    const bounceWindow = history.slice(retestIdx + 1, retestIdx + 4);
    if (bounceWindow.length === 0) continue;

    const lastClose = bounceWindow.at(-1)?.close ?? history[retestIdx].close;
    // For a broken support becoming resistance:
    //   bounce means price stayed below the level (close <= center)
    // For a broken resistance becoming support:
    //   bounce means price stayed above the level (close >= center)
    const bounced = newSide === 'resistance'
      ? lastClose <= center
      : lastClose >= center;

    if (!bounced) continue;

    // Compute bounce magnitude
    let maxBounce = 0;
    for (const s of bounceWindow) {
      const move = newSide === 'resistance'
        ? center - s.close  // price dropping away from resistance
        : s.close - center; // price rising away from support
      if (move > maxBounce) maxBounce = move;
    }

    const recencyScore = clamp01(
      Math.exp(-RECENCY_DECAY * (totalBars - 1 - retestIdx)),
    );

    reversed.push({
      center,
      side: newSide,
      touches: 1,      // the retest itself
      holds: 1,         // it bounced
      breaks: 0,
      weightedHoldRate: 0.67,  // Laplace: (1+1)/(1+2) = 0.67
      bounceAtr: atr > 0 ? maxBounce / atr : 0,
      recencyScore,
      label: 'Confirmed',
      origin: 'role-reversal',
    });
  }

  return reversed;
}

// ─── Price S/R Features for Model ─────────────────────────────────────────────

/**
 * Compute price S/R feature vector for a given OI wall strike.
 *
 * @param zones       Price S/R zones from groupPivotsIntoZones.
 * @param strike      The OI wall strike price.
 * @param side        'support' or 'resistance'.
 * @param atr         ATR-14.
 * @param strikeStep  Strike step.
 * @returns Feature vector for the price-only and hybrid models.
 */
export function priceSRFeatures(
  zones: PriceSRZone[],
  strike: number,
  side: LevelSide,
  atr: number,
  strikeStep: number,
  spot?: number,
): PriceSRFeatureVector {
  const tolerance = confluenceTolerance(atr, strikeStep);
  // A swing high below spot is not current resistance; likewise, a swing low
  // above spot is not current support. This keeps new high/low territory
  // from being incorrectly described as confirmed historical price S/R.
  const sameSide = zones.filter((z) =>
    z.side === side && (
      spot === undefined || (side === 'support' ? z.center <= spot : z.center >= spot)
    ),
  );

  if (sameSide.length === 0) {
    // No confirmed price level on this side — projected territory
    return {
      priceHoldRate: 0.5,
      priceTouches: 0,
      priceBounceAtr: 0,
      priceRecency: 0,
      priceDistance: 1,
      isConfluent: false,
    };
  }

  // Find nearest confirmed zone
  let nearest = sameSide[0];
  let minDist = Math.abs(strike - nearest.center);
  for (const z of sameSide) {
    const d = Math.abs(strike - z.center);
    if (d < minDist) {
      nearest = z;
      minDist = d;
    }
  }

  const normalizedDistance = atr > 0 ? clamp01(minDist / atr) : 1;
  const isConfluent = minDist <= tolerance;

  return {
    priceHoldRate: nearest.weightedHoldRate,
    priceTouches: clamp01(nearest.touches / 5), // normalised: 5+ touches = 1.0
    priceBounceAtr: clamp01(nearest.bounceAtr / 1.5), // normalised: 1.5 ATR bounce = 1.0
    priceRecency: nearest.recencyScore,
    priceDistance: normalizedDistance,
    isConfluent,
  };
}

// ─── Confluence Info for Current Display ──────────────────────────────────────

/**
 * Build confluence detail for the current primary OI wall and its nearest
 * confirmed historical price S/R.
 *
 * New-high / new-low rules:
 *   - When no confirmed price resistance exists above spot, the level is
 *     labeled "Projected—not historically tested" and confluence = false.
 *   - When no confirmed price support exists below spot, same treatment.
 *   - An ATR reference (spot ± ATR) may be computed but is never counted
 *     as price/OI confluence.
 */
export function buildConfluenceInfo(
  zones: PriceSRZone[],
  oiWallStrike: number,
  side: LevelSide,
  spot: number,
  atr: number,
  strikeStep: number,
): ConfluenceInfo {
  const tolerance = confluenceTolerance(atr, strikeStep);
  const sameSide = zones.filter((z) =>
    z.side === side && (side === 'support' ? z.center <= spot : z.center >= spot),
  );

  if (sameSide.length === 0) {
    return {
      nearestPriceLevel: null,
      priceLevelType: 'Projected',
      distance: 0,
      confluenceTolerance: tolerance,
      isConfluent: false,
      priceTouches: 0,
      historicalHoldRate: null,
      historicalBreakRate: null,
      sampleCount: 0,
    };
  }

  // Find nearest
  let nearest = sameSide[0];
  let minDist = Math.abs(oiWallStrike - nearest.center);
  for (const z of sameSide) {
    const d = Math.abs(oiWallStrike - z.center);
    if (d < minDist) {
      nearest = z;
      minDist = d;
    }
  }

  const total = nearest.holds + nearest.breaks;
  return {
    nearestPriceLevel: nearest.center,
    priceLevelType: nearest.label,
    distance: minDist,
    confluenceTolerance: tolerance,
    isConfluent: minDist <= tolerance,
    priceTouches: nearest.touches,
    historicalHoldRate: total > 0 ? nearest.holds / total : null,
    historicalBreakRate: total > 0 ? nearest.breaks / total : null,
    sampleCount: total,
  };
}
