import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateResearchStrategies } from '../lib/research-strategy.ts';
import { evaluateResearchWatchlist } from '../lib/research-watchlist.ts';
import { selectResearchStrategy } from '../lib/strategy-selection.ts';
import { buildEvidence } from '../lib/watchlist-evidence.ts';
import { readFileSync } from 'node:fs';

const history = () =>
  Array.from({ length: 70 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
    open: 100 + i,
    high: 102 + i,
    low: 99 + i,
    close: 101 + i,
    source: 'nse-bhavcopy',
  }));
const rows = history();
const benchmark = rows.map((r) => ({
  ...r,
  open: 99,
  high: 101,
  low: 99,
  close: 100,
}));
const asOf = rows.at(-1)!.date;
const evaluate = (
  input = rows,
  bench = benchmark,
  volume: number | null = 30000,
) => evaluateResearchStrategies(input, bench, asOf, volume);

test('rising liquid stock outperforming benchmark qualifies trend', () => {
  assert.equal(evaluate().matches.trend, true);
  assert.equal(evaluate().matches.pullback_oi, false);
});
test('future price and benchmark rows cannot alter a signal', () => {
  const future = { ...rows.at(-1)!, date: '2027-01-01', close: 500, high: 510 };
  assert.deepEqual(
    evaluate([...rows, future], [...benchmark, future]),
    evaluate(),
  );
});
test('missing, NaN and illiquid volume never qualify', () => {
  for (const volume of [null, NaN, 24999])
    assert.equal(evaluate(rows, benchmark, volume).eligible, false);
});
test('needs exact current and benchmark dates', () => {
  assert.equal(evaluate(rows.slice(0, -1)).eligible, false);
  assert.equal(evaluate(rows, benchmark.slice(0, -1)).eligible, false);
});
test('duplicates and bad candles cannot inflate the 60-session minimum', () => {
  assert.equal(evaluate([...rows.slice(-59), rows.at(-1)!]).eligible, false);
  assert.equal(
    evaluate(rows.slice(-60).map((r, i) => (i ? r : { ...r, low: r.high + 1 })))
      .eligible,
    false,
  );
});
test('large discontinuities fail safely', () => {
  assert.match(
    evaluate(
      rows.map((r, i) => (i === 40 ? { ...r, close: 210, high: 211 } : r)),
    ).reason,
    /corporate actions/,
  );
});
test('risk assumptions are 2 ATR stop and 4 ATR projected target', () => {
  const s = evaluate();
  assert.equal(s.stop, rows.at(-1)!.close - 2 * s.atr);
  assert.equal(s.target, rows.at(-1)!.close + 4 * s.atr);
});
test('OI room requires a qualifying recovery and positive same-date walls', () => {
  const pullback = rows.map((r, i) =>
    i === 69
      ? { ...r, open: 161, close: 162.5, high: 164, low: 160 }
      : i >= 60
        ? { ...r, open: 160, close: 161, high: 162, low: 159 }
        : r,
  );
  const signal = evaluateResearchStrategies(pullback, benchmark, asOf, 30000, {
    support: 162,
    resistance: 175,
    date: asOf,
  });
  assert.equal(signal.matches.pullback, true);
  assert.equal(signal.matches.pullback_oi, true);
  for (const oi of [
    { support: 162, resistance: 175, date: '2026-01-01' },
    { support: 0, resistance: Infinity, date: asOf },
    { support: 162, resistance: 164, date: asOf },
  ]) {
    assert.equal(
      evaluateResearchStrategies(pullback, benchmark, asOf, 30000, oi).matches
        .pullback_oi,
      false,
    );
  }
});
test('stronger benchmark rejects weak relative strength', () => {
  const fast = rows.map((r, i) => ({ ...r, close: 100 + 3 * i }));
  assert.equal(evaluate(rows, fast).eligible, false);
});
test('breakout needs actual close beyond prior resistance tolerance', () => {
  assert.equal(evaluate().matches.breakout, false);
  const breakout = rows.map((r, i) =>
    i === rows.length - 1 ? { ...r, close: 174, high: 175 } : r,
  );
  assert.equal(evaluate(breakout).matches.breakout, true);
});
test('live research wrapper uses shared rules and cannot promote to priority', () => {
  const cash = rows.map((r) => ({
    symbol: 'TEST',
    date: r.date,
    volume: 30000,
    delivery: null,
  }));
  const evidence = buildEvidence(
    'TEST',
    asOf,
    rows.at(-21)!.date,
    rows.at(-21)!.close,
    rows.at(-1)!.close,
    cash,
    [],
    [],
    [],
    benchmark,
  );
  const c = evaluateResearchWatchlist(
    'TEST',
    'Test',
    rows,
    benchmark,
    asOf,
    evidence,
  ).candidate!;
  assert.equal(c.group, 'developing');
  assert.equal(c.probability, null);
  assert.equal(c.nextResistance, null);
  assert.equal(c.strategy?.projectedTarget, evaluate().target);
  assert.equal(c.invalidation, evaluate().stop);
  assert.equal(c.strategy?.status, 'Research only');
});
test('missing live evidence is data incomplete, not bearish or zero-filled', () => {
  const result = evaluateResearchWatchlist(
    'TEST',
    'Test',
    rows,
    benchmark,
    asOf,
  );
  assert.equal(result.candidate, null);
  assert.equal(result.group, 'data_incomplete');
});
const period = (meanNetR: number, count = 40) => ({
  count,
  stocks: count,
  meanNetR,
  clusterCi95: [0.01, 0.8],
});
test('later results may reject but never select a different winner', () => {
  assert.deepEqual(
    selectResearchStrategy([
      { id: 'trend', selection: period(0.2), later: period(-0.3) },
      { id: 'pullback', selection: period(0.1), later: period(2) },
    ]),
    { selectedId: 'trend', passesStudyGate: false },
  );
});
test('three OI trades cannot win or pass despite high returns', () => {
  assert.equal(
    selectResearchStrategy([
      { id: 'trend', selection: period(0.1), later: period(-0.1) },
      { id: 'pullback_oi', selection: period(10, 3), later: period(10, 3) },
    ]).selectedId,
    'trend',
  );
});
test('fallback without enough earlier trades can never pass', () => {
  assert.equal(
    selectResearchStrategy([
      { id: 'trend', selection: period(1, 2), later: period(1) },
    ]).passesStudyGate,
    false,
  );
});
test('checked-in results reproduce selection and failed gate', () => {
  const report = JSON.parse(
    readFileSync(
      new URL('../lib/strategy-study.json', import.meta.url),
      'utf8',
    ),
  );
  assert.deepEqual(selectResearchStrategy(report.summaries), {
    selectedId: report.selectedId,
    passesStudyGate: report.passesStudyGate,
  });
  assert.equal(report.selectedId, 'trend');
  assert.equal(report.passesStudyGate, false);
});
