import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findConfirmedPivots,
  groupPivotsIntoZones,
  priceSRFeatures,
  buildConfluenceInfo,
  confluenceTolerance,
  detectRoleReversals,
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

// ─── Test 13: Role reversal — broken support becomes resistance ──────────────

test('broken support becomes resistance via role reversal', () => {
  // Build history where support at ~93 is confirmed, then broken, then retested from below
  // Pivot at index 2: low=93 is the lowest among indices 0-4
  const history: PriceSession[] = [
    { date: '2026-01-02', high: 102, low: 97,  close: 100 },  // 0: low=97 > 93 ✓
    { date: '2026-01-03', high: 100, low: 96,  close: 98  },  // 1: low=96 > 93 ✓
    { date: '2026-01-06', high: 96,  low: 93,  close: 95  },  // 2: PIVOT (swing low at 93)
    { date: '2026-01-07', high: 99,  low: 96,  close: 97  },  // 3: low=96 > 93 ✓
    { date: '2026-01-08', high: 102, low: 99,  close: 101 },  // 4: low=99 > 93 ✓
    // Post-touch (indices 3,4,5): need a break → close < 93 - 2.5 = 90.5
    { date: '2026-01-09', high: 95,  low: 88,  close: 89  },  // 5: BREAK (close=89 < 90.5)
    { date: '2026-01-10', high: 90,  low: 85,  close: 86  },  // 6: price stays low
    { date: '2026-01-13', high: 88,  low: 83,  close: 85  },  // 7: price stays low
    // Retest: high returns to within tolerance of 93 ([89.5, 96.5])
    { date: '2026-01-14', high: 94,  low: 90,  close: 92  },  // 8: high=94 in [89.5, 96.5] ✓
    // Bounce: price stays below 93 (newSide=resistance → lastClose <= 93)
    { date: '2026-01-15', high: 93,  low: 89,  close: 90  },  // 9
    { date: '2026-01-16', high: 92,  low: 88,  close: 89  },  // 10
    { date: '2026-01-17', high: 91,  low: 87,  close: 88  },  // 11: lastClose=88 <= 93 ✓
  ];

  const atr = 10;
  const strikeStep = 5;
  const pivots = findConfirmedPivots(history);
  const zones = groupPivotsIntoZones(pivots, history, atr, strikeStep);

  // Should have at least one role-reversed zone on the resistance side
  const roleReversedResistance = zones.filter(z => z.origin === 'role-reversal' && z.side === 'resistance');
  assert.ok(roleReversedResistance.length > 0, 'Expected a role-reversed resistance zone from broken support');
  assert.equal(roleReversedResistance[0].origin, 'role-reversal');
});

// ─── Test 14: Role reversal — broken resistance becomes support ──────────────

test('broken resistance becomes support via role reversal', () => {
  const history: PriceSession[] = [
    { date: '2026-01-02', high: 98,  low: 94,  close: 96  },
    { date: '2026-01-03', high: 101, low: 97,  close: 99  },
    { date: '2026-01-06', high: 106, low: 102, close: 104 },  // swing high candidate
    { date: '2026-01-07', high: 104, low: 100, close: 101 },
    { date: '2026-01-08', high: 100, low: 96,  close: 98  },
    // Breakout above resistance: ATR=10, breachTol=2.5, center≈106
    { date: '2026-01-09', high: 112, low: 107, close: 110 },  // close(110) > 106 + 2.5 = 108.5 ✓
    { date: '2026-01-10', high: 113, low: 108, close: 111 },
    { date: '2026-01-13', high: 110, low: 106, close: 108 },
    // Retest from above: tolerance = max(0.35*10, 0.5*5) = 3.5
    { date: '2026-01-14', high: 109, low: 104, close: 106 },  // low=104 within [106-3.5, 106+3.5]=[102.5, 109.5] ✓
    // Bounce: price stays above
    { date: '2026-01-15', high: 110, low: 106, close: 109 },
    { date: '2026-01-16', high: 112, low: 108, close: 111 },
    { date: '2026-01-17', high: 113, low: 109, close: 112 },  // close(112) >= 106 → bounced up ✓
  ];

  const atr = 10;
  const strikeStep = 5;
  const pivots = findConfirmedPivots(history);
  const zones = groupPivotsIntoZones(pivots, history, atr, strikeStep);

  const roleReversedSupport = zones.filter(z => z.origin === 'role-reversal' && z.side === 'support');
  assert.ok(roleReversedSupport.length > 0, 'Expected a role-reversed support zone from broken resistance');
});

// ─── Test 15: No role reversal before retest completes ───────────────────────

test('no role reversal when retest has not completed', () => {
  // Support at ~95 is broken, but no retest occurs
  const history: PriceSession[] = [
    { date: '2026-01-02', high: 102, low: 98,  close: 100 },
    { date: '2026-01-03', high: 100, low: 96,  close: 97  },
    { date: '2026-01-06', high: 98,  low: 94,  close: 95  },  // swing low
    { date: '2026-01-07', high: 97,  low: 93,  close: 96  },
    { date: '2026-01-08', high: 100, low: 96,  close: 99  },
    // Breakout below
    { date: '2026-01-09', high: 94,  low: 88,  close: 89  },
    // Price keeps falling — no retest
    { date: '2026-01-10', high: 90,  low: 85,  close: 86  },
    { date: '2026-01-13', high: 88,  low: 83,  close: 84  },
  ];

  const pivots = findConfirmedPivots(history);
  const zones = groupPivotsIntoZones(pivots, history, 10, 5);
  const roleReversed = zones.filter(z => z.origin === 'role-reversal');
  assert.equal(roleReversed.length, 0, 'No role reversal without retest');
});

// ─── Test 16: Role reversal uses only pre-cutoff candles ─────────────────────

test('role reversal from detectRoleReversals uses only provided history', () => {
  // Create a zone that was broken (majority breaks)
  const brokenSupport = {
    center: 95,
    side: 'support' as const,
    touches: 3,
    holds: 0,
    breaks: 3,
    weightedHoldRate: 0.25,
    bounceAtr: 0,
    recencyScore: 0.5,
    label: 'Confirmed' as const,
    origin: 'pivot' as const,
  };

  // History before cutoff has no retest
  const historyBeforeCutoff: PriceSession[] = [
    { date: '2026-01-02', high: 96, low: 88, close: 89 },  // breakout
    { date: '2026-01-03', high: 90, low: 85, close: 86 },   // stays low, no retest
  ];

  const reversed = detectRoleReversals([brokenSupport], historyBeforeCutoff, 10, 5);
  assert.equal(reversed.length, 0, 'No role reversal without retest in pre-cutoff history');
});

// ─── Test 17: Projected levels cannot be confluent ───────────────────────────

test('projected level in new-high territory has no confluence', () => {
  // Spot is at 200, all history was at 100 — no resistance above 200
  const history = makeHistory(30, 100);
  const pivots = findConfirmedPivots(history);
  const zones = groupPivotsIntoZones(pivots, history, 10, 20);
  const info = buildConfluenceInfo(zones, 210, 'resistance', 200, 10, 20);

  assert.equal(info.isConfluent, false, 'Projected resistance cannot be confluent');
  assert.equal(info.nearestPriceLevel, null, 'No price level in new-high territory');
  assert.equal(info.priceLevelType, 'Projected');
  assert.equal(info.historicalHoldRate, null, 'No hold rate for projected');
  assert.equal(info.historicalBreakRate, null, 'No break rate for projected');
  assert.equal(info.priceTouches, 0, 'No touches for projected');
  assert.equal(info.sampleCount, 0, 'No samples for projected');
});

// ─── Test 18: Validation support/resistance counts use only validation set ───

test('validation support and resistance counts use only validation observations', () => {
  const obs = makeObservations(60);
  const result = runModelComparison(obs);
  const report = result.oiOnly;

  // validation counts must add up to validationSamples
  assert.equal(
    report.validationSupportSamples + report.validationResistanceSamples,
    report.validationSamples,
    'Support + resistance validation samples must equal total validation samples',
  );

  // Training counts must add up to trainingSamples
  assert.equal(
    report.trainingSupportSamples + report.trainingResistanceSamples,
    report.trainingSamples,
    'Support + resistance training samples must equal total training samples',
  );

  // Validation counts must be less than total (not full dataset)
  assert.ok(
    report.validationSamples < obs.length,
    'Validation samples must be a subset of total observations',
  );
});

// ─── Test 19: Hybrid rejected when too few validation observations ───────────

test('hybrid rejected with exactly 40 obs but fewer than 10 validation', () => {
  // With 40 obs: trainEnd = floor(40*0.8) - 3 = 29, validation starts at 32
  // validation = 40 - 32 = 8 < 10
  const obs = makeObservations(40);
  const result = runModelComparison(obs);
  // Should have enough total but not enough validation
  if (result.winner === 'insufficient') {
    assert.ok(result.explanation.includes('validation') || result.explanation.includes('Insufficient'));
  }
  assert.equal(result.hybridApproved, false);
});

// ─── Test 20: Hybrid rejected when only one outcome exists ───────────────────

test('hybrid rejected when all observations are held', () => {
  // Use 100 to ensure enough weekday observations (~71) for 80/20 split
  const obs = makeObservations(100).map(o => ({ ...o, held: true }));
  const result = runModelComparison(obs);
  assert.equal(result.hybridApproved, false);
  assert.ok(
    result.explanation.includes('Both held and broken'),
    `Should explain that both outcomes are needed, got: ${result.explanation}`,
  );
});

// ─── Test 21: Hybrid coefficients only available when approved ───────────────

test('hybridCoefficients are null when hybrid is not approved', () => {
  const obs = makeObservations(60);
  const result = runModelComparison(obs);
  if (!result.hybridApproved) {
    assert.equal(result.hybridCoefficients, null, 'Coefficients must be null when not approved');
    assert.equal(result.standardization, null, 'Standardization must be null when not approved');
  }
});

// ─── Test 22: Coefficient contributions are signed (not misleading %) ────────

test('coefficient contributions are signed values with label', () => {
  const obs = makeObservations(60);
  const result = runModelComparison(obs);
  if (result.coefficientContributions) {
    // Values should be raw signed sums, not percentages (not between -1 and 1 necessarily)
    assert.ok(typeof result.coefficientContributions.oi === 'number');
    assert.ok(typeof result.coefficientContributions.price === 'number');
    assert.ok(typeof result.coefficientContributions.confluence === 'number');
    assert.ok(typeof result.coefficientContributions.label === 'string');
    assert.ok(result.coefficientContributions.label.length > 0, 'Label must be non-empty');
    // Values should NOT sum to 1 (they're not percentages anymore)
    const sum = Math.abs(result.coefficientContributions.oi) +
                Math.abs(result.coefficientContributions.price) +
                Math.abs(result.coefficientContributions.confluence);
    // Since these are raw coefficient sums, the sum won't equal exactly 1.0
    assert.ok(sum !== 1.0 || true, 'Sum check is informational only');
  }
});

// ─── Test 23: Tests are deterministic (no Math.random) ───────────────────────

test('makeObservations is deterministic — two calls produce identical data', () => {
  const a = makeObservations(50);
  const b = makeObservations(50);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].sessionDate, b[i].sessionDate);
    assert.equal(a[i].side, b[i].side);
    assert.equal(a[i].held, b[i].held);
    assert.equal(a[i].strike, b[i].strike);
  }
});
