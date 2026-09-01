import assert from 'node:assert/strict';
import test from 'node:test';
import { getDemoObservations, getDemoPersistence, getDemoPriceHistory, getDemoSnapshot } from '../lib/demo-data.ts';
import { analyzeSnapshot, analyzeSnapshotWithPriceHistory, atrFromPriceHistory, calibrateModel, filterSixMonthObservations, labelLevelOutcome } from '../lib/oi-model.ts';
import type { OiHistoryContext } from '../lib/market-types.ts';

test('unknown stock symbols never fall back to the NIFTY demo snapshot', () => {
  assert.throws(
    () => getDemoSnapshot('NSE:TCS-EQ'),
    /No demo snapshot is available for NSE:TCS-EQ/,
  );
});

test('six-month filter excludes present and future observations', () => {
  const snapshot = getDemoSnapshot();
  const observations = getDemoObservations(snapshot.symbol, snapshot.asOf);
  observations.push({ ...observations[0], sessionDate: '2026-08-30' });
  observations.push({ ...observations[0], sessionDate: '2026-09-01' });
  observations.push({ ...observations[0], sessionDate: '2025-12-01' });
  const filtered = filterSixMonthObservations(observations, snapshot.symbol, snapshot.asOf);
  assert.ok(filtered.every((item) => item.sessionDate < '2026-08-30'));
  assert.ok(filtered.every((item) => item.sessionDate >= '2026-02-28'));
});

test('support and resistance outcomes use mirrored ATR-aware rules', () => {
  assert.deepEqual(labelLevelOutcome(100, 'support', 10, [
    { date: '2026-01-02', high: 105, low: 101, close: 103 },
    { date: '2026-01-03', high: 107, low: 99, close: 104 },
  ]), { tested: true, held: true });
  assert.deepEqual(labelLevelOutcome(100, 'resistance', 10, [
    { date: '2026-01-02', high: 99, low: 94, close: 97 },
    { date: '2026-01-03', high: 101, low: 95, close: 96 },
  ]), { tested: true, held: true });
  assert.equal(labelLevelOutcome(100, 'support', 10, [{ date: '2026-01-02', high: 101, low: 98, close: 96 }]).held, false);
});

test('calibration is instrument-specific and never uses as-of data', () => {
  const snapshot = getDemoSnapshot();
  const observations = getDemoObservations(snapshot.symbol, snapshot.asOf);
  const diagnostics = calibrateModel(observations, snapshot.symbol, snapshot.asOf).diagnostics;
  assert.equal(diagnostics.mode, 'calibrated');
  assert.ok(diagnostics.validationSamples > 0);
  assert.ok(diagnostics.lookbackEnd < '2026-08-30');
  assert.equal(calibrateModel(observations, 'NSE:OTHER-EQ', snapshot.asOf).diagnostics.mode, 'provisional');
});

test('analysis returns ranked levels on both sides with valid probabilities', () => {
  const snapshot = getDemoSnapshot();
  const analysis = analyzeSnapshot(snapshot, getDemoObservations(snapshot.symbol, snapshot.asOf), getDemoPersistence(snapshot));
  assert.ok(analysis.primarySupport);
  assert.ok(analysis.primaryResistance);
  assert.ok(analysis.levels.every((level) => level.probability !== null && level.probability >= 0 && level.probability <= 1));
  assert.ok(analysis.primarySupport!.strike <= snapshot.spot);
  assert.ok(analysis.primaryResistance!.strike >= snapshot.spot);
});

test('on-demand six-month history produces ranked levels without stored observations', () => {
  const snapshot = getDemoSnapshot();
  const history = getDemoPriceHistory(snapshot.symbol, snapshot.asOf);
  const analysis = analyzeSnapshotWithPriceHistory(snapshot, history);
  assert.equal(analysis.diagnostics.mode, 'historical');
  assert.ok(analysis.diagnostics.validationSamples >= 120);
  assert.ok(analysis.diagnostics.samples > 0);
  assert.ok(analysis.primarySupport);
  assert.ok(analysis.primaryResistance);
  assert.ok(atrFromPriceHistory(history) > 0);
});

test('intraday and positional maps keep their evidence separate', () => {
  const snapshot = getDemoSnapshot();
  const analysis = analyzeSnapshotWithPriceHistory(snapshot, getDemoPriceHistory(snapshot.symbol, snapshot.asOf));
  assert.equal(analysis.intraday.horizon, 'intraday');
  assert.equal(analysis.positional.horizon, 'positional');
  assert.equal(analysis.intraday.historicalTests, 0);
  assert.ok(analysis.positional.historicalTests > 0);
  assert.ok(analysis.intraday.levels.every((level) => level.probability === null));
  assert.ok(analysis.positional.levels.every((level) => level.probability === null));
  assert.match(analysis.intraday.note, /cannot validate intraday/i);
  assert.match(analysis.positional.note, /daily price-zone tests/i);
});

test('six-month D1 OI outcomes calibrate positional ranking only', () => {
  const snapshot = getDemoSnapshot();
  const analysis = analyzeSnapshotWithPriceHistory(
    snapshot,
    getDemoPriceHistory(snapshot.symbol, snapshot.asOf),
    { intraday: [], positional: [] },
    getDemoObservations(snapshot.symbol, snapshot.asOf),
  );
  assert.equal(analysis.diagnostics.mode, 'calibrated');
  assert.ok(analysis.diagnostics.samples >= 40);
  assert.ok(analysis.positional.levels.every((level) => level.probability !== null));
  assert.ok(analysis.intraday.levels.every((level) => level.probability === null));
  assert.match(analysis.positional.note, /Cloudflare D1 OI-wall outcomes/i);
});

test('F&O stocks use a same-stock outcome model and wider stock volatility zones', () => {
  const snapshot = getDemoSnapshot('NSE:RELIANCE-EQ');
  const observations = getDemoObservations(snapshot.symbol, snapshot.asOf);
  const analysis = analyzeSnapshotWithPriceHistory(
    snapshot,
    getDemoPriceHistory(snapshot.symbol, snapshot.asOf),
    { intraday: [], positional: [] },
    observations,
  );
  assert.equal(analysis.snapshot.instrumentType, 'stock');
  assert.equal(analysis.diagnostics.mode, 'calibrated');
  assert.match(analysis.positional.note, /Stock-specific model/i);
  assert.ok(analysis.positional.zoneWidth >= snapshot.atr14 * 0.24);
  assert.ok(analysis.positional.levels.every((level) => level.probability !== null));
});

test('thin zero-volume stock strikes do not become primary levels when liquid alternatives exist', () => {
  const snapshot = getDemoSnapshot('NSE:RELIANCE-EQ');
  const poisoned = structuredClone(snapshot);
  const isolated = poisoned.chain.find((row) => row.strike < poisoned.spot)!;
  isolated.putOi *= 100;
  isolated.putVolume = 0;
  const analysis = analyzeSnapshotWithPriceHistory(
    poisoned,
    getDemoPriceHistory(poisoned.symbol, poisoned.asOf),
  );
  assert.notEqual(analysis.positional.primarySupport?.strike, isolated.strike);
});

test('saved same-expiry snapshots strengthen an intraday OI build without changing positional history claims', () => {
  const snapshot = getDemoSnapshot();
  const oldChain = snapshot.chain.map((row) => ({
    ...row,
    putOi: Math.max(1, Math.floor(row.putOi * 0.4)),
    callOi: Math.max(1, Math.floor(row.callOi * 0.4)),
  }));
  const middleChain = snapshot.chain.map((row) => ({
    ...row,
    putOi: Math.max(1, Math.floor(row.putOi * 0.65)),
    callOi: Math.max(1, Math.floor(row.callOi * 0.65)),
  }));
  const oiHistory: OiHistoryContext = {
    intraday: [
      { capturedAt: '2026-08-30T04:00:00.000Z', spot: snapshot.spot, chain: oldChain },
      { capturedAt: '2026-08-30T05:00:00.000Z', spot: snapshot.spot, chain: middleChain },
    ],
    positional: [
      { capturedAt: '2026-08-29T05:00:00.000Z', spot: snapshot.spot, chain: oldChain },
      { capturedAt: '2026-08-30T05:00:00.000Z', spot: snapshot.spot, chain: middleChain },
    ],
  };
  const withoutHistory = analyzeSnapshotWithPriceHistory(snapshot, getDemoPriceHistory(snapshot.symbol, snapshot.asOf));
  const withHistory = analyzeSnapshotWithPriceHistory(snapshot, getDemoPriceHistory(snapshot.symbol, snapshot.asOf), oiHistory);
  const strike = withoutHistory.intraday.primarySupport!.strike;
  const baseline = withoutHistory.intraday.levels.find((level) => level.side === 'support' && level.strike === strike)!;
  const observed = withHistory.intraday.levels.find((level) => level.side === 'support' && level.strike === strike)!;
  assert.ok(observed.score > baseline.score);
  assert.ok((observed.oiHistorySnapshots ?? 0) >= 2);
  assert.equal(withHistory.intraday.historicalTests, 0);
  assert.equal(withHistory.positional.historicalTests, withoutHistory.positional.historicalTests);
});

test('one saved snapshot is not treated as intraday OI flow', () => {
  const snapshot = getDemoSnapshot();
  const history = getDemoPriceHistory(snapshot.symbol, snapshot.asOf);
  const singleSnapshot: OiHistoryContext = {
    intraday: [{ capturedAt: '2026-08-30T04:00:00.000Z', spot: snapshot.spot, chain: snapshot.chain }],
    positional: [],
  };
  const baseline = analyzeSnapshotWithPriceHistory(snapshot, history);
  const single = analyzeSnapshotWithPriceHistory(snapshot, history, singleSnapshot);
  const strike = baseline.intraday.primaryResistance!.strike;
  const baselineLevel = baseline.intraday.levels.find((level) => level.side === 'resistance' && level.strike === strike)!;
  const singleLevel = single.intraday.levels.find((level) => level.side === 'resistance' && level.strike === strike)!;
  assert.equal(singleLevel.score, baselineLevel.score);
});

test('positional horizon never extends beyond the selected contract expiry', () => {
  const snapshot = getDemoSnapshot();
  const nearExpiry = { ...snapshot, expiryEpoch: Math.floor(Date.parse(snapshot.asOf) / 1_000) + 86_400 };
  const analysis = analyzeSnapshotWithPriceHistory(nearExpiry, getDemoPriceHistory(snapshot.symbol, snapshot.asOf));
  assert.match(analysis.positional.horizonLabel, /Up to 1 trading session/);
});

test('positional summary reports only the ranked primary zones', () => {
  const snapshot = getDemoSnapshot();
  const analysis = analyzeSnapshotWithPriceHistory(snapshot, getDemoPriceHistory(snapshot.symbol, snapshot.asOf));
  const primaries = [analysis.positional.primarySupport, analysis.positional.primaryResistance].filter((level) => level !== null);
  const expectedTests = primaries.reduce((sum, level) => sum + (level.historicalTests ?? 0), 0);
  assert.equal(analysis.positional.historicalTests, expectedTests);
  if (expectedTests > 0) {
    const expectedRate = primaries.reduce(
      (sum, level) => sum + (level.historicalHoldRate ?? 0) * (level.historicalTests ?? 0),
      0,
    ) / expectedTests;
    assert.ok(Math.abs((analysis.positional.historicalHoldRate ?? 0) - expectedRate) < 1e-12);
  }
});
