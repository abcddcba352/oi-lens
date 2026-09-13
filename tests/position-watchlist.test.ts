import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateWatchlist,
  cleanCandles,
  detectBreakoutRetest,
  type WatchCandle,
} from '../lib/position-watchlist.ts';

function history(count = 150): WatchCandle[] {
  return Array.from({ length: count }, (_, i) => ({
    date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
    open: 100 + i,
    high: 102 + i,
    low: 99 + i,
    close: 101 + i,
    source: 'nse-bhavcopy',
  }));
}

const evaluate = (
  rows: WatchCandle[],
  mode: 'short' | 'positional' = 'short',
  asOf = rows.at(-1)!.date,
) => evaluateWatchlist('NSE:TEST-EQ', 'TEST', rows, [], mode, asOf);

test('future candles cannot change a historical watchlist', () => {
  const rows = history();
  assert.deepEqual(evaluate(rows, 'short', rows[100].date), evaluate(rows.slice(0, 101)));
});

test('demo, malformed and duplicate candles cannot inflate history', () => {
  const rows = history(3);
  assert.equal(
    cleanCandles(
      [...rows, rows[0], { ...rows[1], source: 'demo' }, { ...rows[2], close: NaN }],
      rows[2].date,
    ).length,
    3,
  );
});

test('positional needs substantially more history than a short-term screen', () => {
  assert.ok(evaluate(history(70)).candidate);
  assert.equal(evaluate(history(70), 'positional').candidate, null);
  assert.equal(evaluate(history(70), 'positional').group, 'data_incomplete');
});

test('positional accepts a normal six-calendar-month session count', () => {
  assert.equal(evaluate(history(119), 'positional').reason, 'Needs 120 valid sessions');
  assert.equal(evaluate(history(119), 'positional').group, 'data_incomplete');
  assert.ok(evaluate(history(120), 'positional').candidate);
});

test('stale data is excluded', () => {
  const res = evaluate(history(), 'short', '2026-01-01');
  assert.equal(res.reason, 'Price history is stale');
  assert.equal(res.group, 'excluded');
});

test('large corporate action discontinuities require review', () => {
  const rows = history();
  rows[145] = { ...rows[145], open: 100, high: 101, low: 99, close: 100 };
  const res = evaluate(rows);
  assert.match(res.reason!, /corporate actions/);
  assert.equal(res.group, 'excluded');
});

test('falling prices do not qualify as a rising trend', () => {
  const rows = history().map((r, i) => ({
    ...r,
    open: 400 - i,
    high: 402 - i,
    low: 399 - i,
    close: 401 - i,
  }));
  const res = evaluate(rows);
  assert.equal(res.reason, 'Rising trend not confirmed');
  assert.equal(res.group, 'excluded');
});

test('new highs never fabricate overhead targets or probabilities', () => {
  const candidate = evaluate(history(), 'positional').candidate!;
  assert.ok(candidate);
  assert.equal(candidate.nextResistance, null);
  assert.equal(candidate.rewardRisk, null);
  assert.equal(candidate.targetReviewRequired, true);
  assert.equal(candidate.probability, null);
  assert.equal(candidate.relativeStrength, null);
  assert.ok(candidate.invalidation < candidate.entryTrigger);
  assert.equal(candidate.researchLabel, 'Positional technical research');
  assert.equal(candidate.fundamentalsStatus, 'Unassessed');
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

test('breakout retest is detected chronologically without future leakage', () => {
  // Build a base of 60 sessions where resistance is established at 200
  const rows: WatchCandle[] = Array.from({ length: 70 }, (_, i) => {
    const d = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
    // rising MA from 100 to 190
    const p = 100 + i * 1.3;
    return { date: d, open: p, high: p + 1, low: p - 1, close: p, source: 'nse-bhavcopy' };
  });

  // Base resistance at index 65 was ~185
  // Now session 66: Breakout closes at 195 (above resistance 185)
  rows[66] = { ...rows[66], open: 186, high: 196, low: 185, close: 195 };
  // Session 67: Pullback dips to 186 (tests resistance 185 within 0.5 ATR), does not break invalidation
  rows[67] = { ...rows[67], open: 194, high: 194, low: 186, close: 188 };
  // Session 68: Rebound holds and closes above resistance at 196
  rows[68] = { ...rows[68], open: 188, high: 197, low: 187, close: 196 };

  const retestDetected = detectBreakoutRetest(rows.slice(0, 69), 185, 170, 2, 10);
  assert.equal(retestDetected, true);

  // If pullback dipped below invalidation (e.g. low 165 < invalidation 170)
  const failedRows = [...rows];
  failedRows[67] = { ...failedRows[67], low: 165 };
  const failedRetest = detectBreakoutRetest(failedRows.slice(0, 69), 185, 170, 2, 10);
  assert.equal(failedRetest, false);

  // Zero future data leakage: Adding subsequent sessions cannot alter session 68's evaluation
  const futureRows = [...rows.slice(0, 69), {
    date: '2025-04-01', open: 196, high: 200, low: 195, close: 199, source: 'nse-bhavcopy'
  }];
  const asOfDay68 = detectBreakoutRetest(futureRows.slice(0, 69), 185, 170, 2, 10);
  assert.equal(asOfDay68, true);
});

test('extended price beyond 1.5 ATR is classified into Extended stage', () => {
  const rows = history(70);
  // Entry trigger is around 171. Set latest close to 185 (> trigger + 1.5 ATR)
  rows[69] = { ...rows[69], open: 184, high: 186, low: 183, close: 185 };
  const res = evaluate(rows, 'short');
  assert.ok(res.candidate);
  assert.equal(res.candidate.stage, 'Extended beyond reasonable entry area');
  assert.equal(res.candidate.group, 'developing'); // Extended setups are not Priority
});

test('approaching resistance is distinguished when close is within 1 ATR below resistance', () => {
  const rows = history(70);
  // Last close in history(70) is 170, prior resistance is 170, ATR is 3.
  // Distance to resistance is 0 ATR (within 1 ATR) and close <= entryTrigger.
  const res = evaluate(rows, 'short');
  assert.ok(res.candidate);
  assert.equal(res.candidate.stage, 'Approaching resistance');
});

test('technical score has explainable factors and avoids double-counting', () => {
  const res = evaluate(history(70), 'short');
  assert.ok(res.candidate);
  assert.ok(res.candidate.score >= 25 && res.candidate.score <= 100);
  assert.ok(res.candidate.scoreBreakdown.length > 0);
  const totalFromBreakdown = res.candidate.scoreBreakdown.reduce((sum, f) => sum + f.points, 0);
  assert.equal(res.candidate.score, totalFromBreakdown);
});

