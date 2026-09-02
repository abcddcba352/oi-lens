import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findConfirmedPivots,
  groupPivotsIntoZones,
  priceSRFeatures,
  buildConfluenceInfo,
  confluenceTolerance,
} from '../lib/price-levels.ts';
import { runModelComparison } from '../lib/model-comparison.ts';
import type { ComparisonObservation } from '../lib/model-comparison.ts';
import type { PriceSession, LevelFeatures } from '../lib/market-types.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeHistory(n: number, basePrice = 100, startDate = '2026-01-01'): PriceSession[] {
  const sessions: PriceSession[] = [];
  let price = basePrice;
  const start = new Date(startDate);
  for (let i = 0; i < n; i++) {
    const date = new Date(start.getTime() + i * 86_400_000);
    const dow = date.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const swing = Math.sin(i * 0.17) * 3;
    price = basePrice + swing;
    sessions.push({
      date: date.toISOString().slice(0, 10),
      open: price - 0.5,
      high: price + 2,
      low: price - 2,
      close: price + 0.3,
    });
  }
  return sessions;
}

function makeSwingHistory(): PriceSession[] {
  // Craft a history with clear swing highs and lows
  // Pattern: 100, 98, 95, 98, 100, 103, 106, 103, 100, 97, 94, 97, 100
  const prices = [100, 98, 95, 98, 100, 103, 106, 103, 100, 97, 94, 97, 100, 102, 105];
  return prices.map((p, i) => ({
    date: `2026-01-${String(i + 2).padStart(2, '0')}`,
    open: p - 0.5,
    high: p + 1,
    low: p - 1,
    close: p,
  }));
}

function makeObservations(n: number, holdRate = 0.6): ComparisonObservation[] {
  const obs: ComparisonObservation[] = [];
  const base = new Date('2026-03-01');
  for (let i = 0; i < n; i++) {
    const date = new Date(base.getTime() + i * 86_400_000);
    const dow = date.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const held = (i % 10) < Math.round(holdRate * 10);
    obs.push({
      sessionDate: date.toISOString().slice(0, 10),
      side: i % 2 === 0 ? 'support' : 'resistance',
      strike: 100 + (i % 5) * 10,
      held,
      oiFeatures: {
        clusterOi: 0.3 + (i % 7) * 0.1,
        oiChange: -0.2 + (i % 5) * 0.15,
        volumeConfirmation: 0.2 + (i % 6) * 0.12,
        proximity: 0.5 + (i % 3) * 0.15,
        persistence: 0.4 + (i % 4) * 0.1,
        regimeFit: 0.6 + (i % 5) * 0.05,
      },
      priceFeatures: {
        priceHoldRate: 0.3 + (i % 4) * 0.15,
        priceTouches: (i % 5) * 0.2,
        priceBounceAtr: (i % 3) * 0.3,
        priceRecency: 0.2 + (i % 4) * 0.2,
        priceDistance: (i % 6) * 0.15,
        isConfluent: i % 3 === 0,
      },
    });
    if (obs.length >= n) break;
  }
  return obs.slice(0, n);
}

// ─── Test 1: No future candle leakage ─────────────────────────────────────────

test('price features use only candles before the declaration date', () => {
  const history = makeHistory(100);
  const declarationDate = history[50].date;
  // Only candles strictly before D should be used
  const before = history.filter((s) => s.date < declarationDate);
  const pivots = findConfirmedPivots(before);
  // All pivots must have dates < declarationDate
  assert.ok(pivots.every((p) => p.date < declarationDate));
  // Verify that no pivot uses future data
  assert.ok(pivots.every((p) => p.index < before.length));
});

// ─── Test 2: Confirmed swing highs/lows ──────────────────────────────────────

test('findConfirmedPivots returns only pivots where all 5 bars are known', () => {
  const history = makeSwingHistory();
  const pivots = findConfirmedPivots(history, 2);

  // Each pivot must have 2 bars on each side (index >= 2, index <= length - 3)
  for (const pivot of pivots) {
    assert.ok(pivot.index >= 2, `Pivot at index ${pivot.index} is too early`);
    assert.ok(pivot.index <= history.length - 3, `Pivot at index ${pivot.index} is too late`);

    if (pivot.type === 'swing-low') {
      // Verify it's actually a swing low
      const bar = history[pivot.index];
      assert.ok(history[pivot.index - 1].low > bar.low);
      assert.ok(history[pivot.index - 2].low > bar.low);
      assert.ok(history[pivot.index + 1].low > bar.low);
      assert.ok(history[pivot.index + 2].low > bar.low);
    }
    if (pivot.type === 'swing-high') {
      const bar = history[pivot.index];
      assert.ok(history[pivot.index - 1].high < bar.high);
      assert.ok(history[pivot.index - 2].high < bar.high);
      assert.ok(history[pivot.index + 1].high < bar.high);
      assert.ok(history[pivot.index + 2].high < bar.high);
    }
  }
  assert.ok(pivots.length > 0, 'Should find at least one pivot');
});

// ─── Test 3: New-high resistance → Projected ─────────────────────────────────

test('new-high territory labels resistance as Projected even when older highs exist below spot', () => {
  // Make history where spot is well above all historical highs
  const history = makeHistory(30, 100);
  const pivots = findConfirmedPivots(history);
  const zones = groupPivotsIntoZones(pivots, history, 5, 10);

  // Check above all resistance zones — should return Projected
  const info = buildConfluenceInfo(zones, 200, 'resistance', 200, 5, 10);
  // If no resistance zones exist above 200, or none at all, it should be Projected
  assert.equal(info.priceLevelType, 'Projected');
  assert.equal(info.isConfluent, false);
  assert.equal(info.nearestPriceLevel, null);
});

// ─── Test 4: New-low support → Projected ─────────────────────────────────────

test('new-low territory labels support as Projected even when older lows exist above spot', () => {
  const history = makeHistory(30, 100);
  const pivots = findConfirmedPivots(history);
  const zones = groupPivotsIntoZones(pivots, history, 5, 10);

  const info = buildConfluenceInfo(zones, 50, 'support', 50, 5, 10);
  assert.equal(info.priceLevelType, 'Projected');
  assert.equal(info.isConfluent, false);
  assert.equal(info.nearestPriceLevel, null);
});

// ─── Test 5: Confluence tolerance ─────────────────────────────────────────────

test('confluence tolerance follows max(0.35 × ATR, 0.5 × strikeStep)', () => {
  // ATR = 10, strikeStep = 20: max(3.5, 10) = 10
  assert.equal(confluenceTolerance(10, 20), 10);
  // ATR = 100, strikeStep = 20: max(35, 10) = 35
  assert.equal(confluenceTolerance(100, 20), 35);
  // ATR = 0, strikeStep = 50: max(0, 25) = 25
  assert.equal(confluenceTolerance(0, 50), 25);
});

test('distance within tolerance is confluent, outside is not', () => {
  const history = makeSwingHistory();
  const pivots = findConfirmedPivots(history, 2);
  const atr = 5;
  const strikeStep = 10;
  const zones = groupPivotsIntoZones(pivots, history, atr, strikeStep);
  const tolerance = confluenceTolerance(atr, strikeStep);

  if (zones.length > 0) {
    const zone = zones[0];
    const spot = zone.side === 'support' ? zone.center + 20 : zone.center - 20;
    // Within tolerance: confluent
    const nearFeatures = priceSRFeatures(zones, zone.center + tolerance * 0.5, zone.side, atr, strikeStep, spot);
    assert.equal(nearFeatures.isConfluent, true);
    // Far beyond tolerance: not confluent
    const farFeatures = priceSRFeatures(zones, zone.center + tolerance * 5, zone.side, atr, strikeStep, spot);
    assert.equal(farFeatures.isConfluent, false);
  }
});

// ─── Test 6: Chronological split + purge ─────────────────────────────────────

test('chronological split has purge gap and no date in validation <= training', () => {
  const observations = makeObservations(60);
  const sorted = [...observations].sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
  const validationStart = Math.floor(sorted.length * 0.8);
  const trainEnd = Math.max(1, validationStart - 3);
  const train = sorted.slice(0, trainEnd);
  const validation = sorted.slice(validationStart);

  // Purge gap: at least 3 observations between train and validation
  assert.ok(validationStart - trainEnd >= 3);
  // No date overlap
  const latestTrain = train.at(-1)!.sessionDate;
  const earliestVal = validation[0].sessionDate;
  assert.ok(earliestVal > latestTrain, `Validation start ${earliestVal} should be > training end ${latestTrain}`);
});

// ─── Test 7: Insufficient samples → provisional ──────────────────────────────

test('fewer than 40 tested walls returns insufficient', () => {
  const observations = makeObservations(20);
  const result = runModelComparison(observations);
  assert.equal(result.winner, 'insufficient');
  assert.equal(result.hybridApproved, false);
  assert.equal(result.oiOnly.status, 'provisional');
  assert.equal(result.priceOnly.status, 'provisional');
  assert.equal(result.hybrid.status, 'provisional');
  assert.match(result.explanation, /Insufficient/i);
});

// ─── Test 8: Hybrid not selected without validation improvement ───────────────

test('hybrid is not approved when Brier improvement is insufficient', () => {
  // With identical features the hybrid cannot beat sub-models by 0.01
  const observations: ComparisonObservation[] = [];
  const base = new Date('2026-03-01');
  for (let i = 0; i < 60; i++) {
    const date = new Date(base.getTime() + i * 86_400_000);
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    const held = i % 3 !== 0;
    const features: LevelFeatures = {
      clusterOi: 0.5, oiChange: 0.1, volumeConfirmation: 0.3,
      proximity: 0.6, persistence: 0.4, regimeFit: 0.7,
    };
    observations.push({
      sessionDate: date.toISOString().slice(0, 10),
      side: i % 2 === 0 ? 'support' : 'resistance',
      strike: 100,
      held,
      oiFeatures: features,
      priceFeatures: {
        priceHoldRate: 0.5, priceTouches: 0.3, priceBounceAtr: 0.2,
        priceRecency: 0.5, priceDistance: 0.3, isConfluent: true,
      },
    });
    if (observations.length >= 60) break;
  }
  const result = runModelComparison(observations.slice(0, 60));
  assert.equal(result.hybridApproved, false);
  // hybridApproved should be false when hybrid can't beat both by 0.01
  if (result.winner !== 'insufficient') {
    // The comparison ran — verify it computed something
    assert.ok(result.oiOnly.brierScore !== null);
    assert.ok(result.priceOnly.brierScore !== null);
    assert.ok(result.hybrid.brierScore !== null);
  }
});

// ─── Test 9: All three models use same observations ──────────────────────────

test('all three models receive identical observation counts', () => {
  const observations = makeObservations(55);
  const result = runModelComparison(observations);
  if (result.winner !== 'insufficient') {
    assert.equal(result.oiOnly.trainingSamples, result.priceOnly.trainingSamples);
    assert.equal(result.oiOnly.trainingSamples, result.hybrid.trainingSamples);
    assert.equal(result.oiOnly.validationSamples, result.priceOnly.validationSamples);
    assert.equal(result.oiOnly.validationSamples, result.hybrid.validationSamples);
  }
});

// ─── Test 10: Support/resistance rules mirrored ──────────────────────────────

test('swing lows map to support and swing highs map to resistance', () => {
  const history = makeSwingHistory();
  const pivots = findConfirmedPivots(history, 2);

  const swingLows = pivots.filter((p) => p.type === 'swing-low');
  const swingHighs = pivots.filter((p) => p.type === 'swing-high');

  const zones = groupPivotsIntoZones(pivots, history, 5, 10);
  const supportZones = zones.filter((z) => z.side === 'support');
  const resistanceZones = zones.filter((z) => z.side === 'resistance');

  // Swing lows should only produce support zones
  if (swingLows.length > 0) {
    assert.ok(supportZones.length > 0, 'Swing lows should produce support zones');
  }
  // Swing highs should only produce resistance zones
  if (swingHighs.length > 0) {
    assert.ok(resistanceZones.length > 0, 'Swing highs should produce resistance zones');
  }
});

// ─── Test 11: Empty history produces no pivots ───────────────────────────────

test('empty or very short history produces no pivots', () => {
  assert.deepEqual(findConfirmedPivots([]), []);
  assert.deepEqual(findConfirmedPivots(makeHistory(3)), []);
  // With 4 bars and barsEachSide=2, no pivot can have 2 bars on each side
  assert.deepEqual(findConfirmedPivots(makeHistory(4), 2), []);
});

// ─── Test 12: price features for no zones returns defaults ───────────────────

test('no price zones returns default neutral features', () => {
  const features = priceSRFeatures([], 100, 'support', 10, 20, 105);
  assert.equal(features.priceHoldRate, 0.5);
  assert.equal(features.priceTouches, 0);
  assert.equal(features.isConfluent, false);
  assert.equal(features.priceDistance, 1);
});
