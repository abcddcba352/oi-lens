import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWatchlist, cleanCandles, type WatchCandle } from '../lib/position-watchlist.ts';
function history(count = 150): WatchCandle[] {
  return Array.from({ length: count }, (_, i) => ({
    date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
    open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, source: 'nse-bhavcopy',
  }));
}
const evaluate = (rows: WatchCandle[], mode: 'short' | 'positional' = 'short', asOf = rows.at(-1)!.date) =>
  evaluateWatchlist('NSE:TEST-EQ', 'TEST', rows, [], mode, asOf);
test('future candles cannot change a historical watchlist', () => {
  const rows = history();
  assert.deepEqual(evaluate(rows, 'short', rows[100].date), evaluate(rows.slice(0, 101)));
});
test('demo, malformed and duplicate candles cannot inflate history', () => {
  const rows = history(3);
  assert.equal(cleanCandles([...rows, rows[0], { ...rows[1], source: 'demo' }, { ...rows[2], close: NaN }], rows[2].date).length, 3);
});
test('positional needs substantially more history than a short-term screen', () => {
  assert.ok(evaluate(history(70)).candidate);
  assert.equal(evaluate(history(70), 'positional').candidate, null);
});
test('stale data is excluded', () => {
  assert.equal(evaluate(history(), 'short', '2026-01-01').reason, 'Price history is stale');
});
test('large corporate action discontinuities require review', () => {
  const rows = history();
  rows[145] = { ...rows[145], open: 100, high: 101, low: 99, close: 100 };
  assert.match(evaluate(rows).reason!, /corporate actions/);
});
test('falling prices do not qualify as a rising trend', () => {
  const rows = history().map((r, i) => ({ ...r, open: 400 - i, high: 402 - i, low: 399 - i, close: 401 - i }));
  assert.equal(evaluate(rows).reason, 'Rising trend not confirmed');
});
test('new highs never fabricate overhead targets or probabilities', () => {
  const candidate = evaluate(history(), 'positional').candidate!;
  assert.ok(candidate);
  assert.equal(candidate.nextResistance, null);
  assert.equal(candidate.rewardRisk, null);
  assert.equal(candidate.probability, null);
  assert.equal(candidate.relativeStrength, null);
  assert.ok(candidate.invalidation < candidate.entryTrigger);
});
test('matching benchmark dates produce zero relative strength for identical paths', () => {
  const rows = history();
  const result = evaluateWatchlist('NSE:TEST-EQ', 'TEST', rows, rows, 'short', rows.at(-1)!.date);
  assert.equal(result.candidate?.relativeStrength, 0);
});
test('today high does not rewrite the prior resistance', () => {
  const rows = history();
  const first = evaluate(rows).candidate!;
  rows[149] = { ...rows[149], high: 300 };
  assert.equal(evaluate(rows).candidate?.resistance, first.resistance);
});
