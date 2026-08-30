import assert from 'node:assert/strict';
import test from 'node:test';
import { getDemoObservations, getDemoPersistence, getDemoPriceHistory, getDemoSnapshot } from '../lib/demo-data.ts';
import { analyzeSnapshot, analyzeSnapshotWithPriceHistory, atrFromPriceHistory, calibrateModel, filterSixMonthObservations, labelLevelOutcome } from '../lib/oi-model.ts';

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
  assert.ok(analysis.levels.every((level) => level.probability >= 0 && level.probability <= 1));
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
