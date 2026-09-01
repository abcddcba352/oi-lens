import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateWallStats,
  declarePrimaryWalls,
  evaluateFromHistory,
  evaluateWallOutcome,
  HORIZON_SESSIONS,
  tradingSessionsUntilExpiry,
} from '../lib/wall-backtest.ts';
import { getDemoSnapshot } from '../lib/demo-data.ts';

// ─── evaluateWallOutcome ──────────────────────────────────────────────────────

test('support: not reached if price never dips to strike', () => {
  const outcome = evaluateWallOutcome(24_000, 'support', 200, [
    { date: '2026-01-02', high: 24_800, low: 24_350, close: 24_500 },
    { date: '2026-01-03', high: 24_900, low: 24_300, close: 24_600 },
  ]);
  assert.equal(outcome.reached, false);
  assert.equal(outcome.daysToReach, null);
  assert.equal(outcome.held, false);
  assert.equal(outcome.broke, false);
});

test('support: reached on day 1 and held', () => {
  const atr = 200;
  const strike = 24_000;
  // Low touches strike on day 1, then price bounces well above.
  const outcome = evaluateWallOutcome(strike, 'support', atr, [
    { date: '2026-01-02', high: 24_500, low: 23_980, close: 24_300 }, // touches
    { date: '2026-01-03', high: 24_700, low: 24_200, close: 24_600 }, // bounces
    { date: '2026-01-04', high: 24_800, low: 24_400, close: 24_750 },
  ]);
  assert.equal(outcome.reached, true);
  assert.equal(outcome.daysToReach, 1);
  assert.equal(outcome.held, true);
  assert.equal(outcome.broke, false);
  assert.ok(outcome.bouncePoints !== null && outcome.bouncePoints > 0);
  assert.ok(outcome.bounceAtr !== null && outcome.bounceAtr > 0);
});

test('support: reached and broke through', () => {
  const atr = 200;
  const strike = 24_000;
  const breachClose = strike - atr * 0.3; // clearly below breach tolerance
  const outcome = evaluateWallOutcome(strike, 'support', atr, [
    { date: '2026-01-02', high: 24_200, low: 23_970, close: 24_100 }, // touches
    { date: '2026-01-03', high: 24_000, low: breachClose - 20, close: breachClose }, // breaks
  ]);
  assert.equal(outcome.reached, true);
  assert.equal(outcome.held, false);
  assert.equal(outcome.broke, true);
});

test('support: a breach on the touch session is not later reclassified as held', () => {
  const outcome = evaluateWallOutcome(24_000, 'support', 200, [
    { date: '2026-01-02', high: 24_100, low: 23_800, close: 23_900 },
    { date: '2026-01-03', high: 24_200, low: 24_000, close: 24_100 },
  ]);
  assert.equal(outcome.reached, true);
  assert.equal(outcome.broke, true);
  assert.equal(outcome.held, false);
});

test('resistance: reached on day 2 and held', () => {
  const atr = 200;
  const strike = 25_000;
  const outcome = evaluateWallOutcome(strike, 'resistance', atr, [
    { date: '2026-01-02', high: 24_800, low: 24_500, close: 24_700 }, // does not touch
    { date: '2026-01-03', high: 25_020, low: 24_600, close: 24_800 }, // touches
    { date: '2026-01-04', high: 24_900, low: 24_400, close: 24_500 }, // drops away
  ]);
  assert.equal(outcome.reached, true);
  assert.equal(outcome.daysToReach, 2);
  assert.equal(outcome.held, true);
  assert.equal(outcome.broke, false);
});

test('resistance: breaks above', () => {
  const atr = 200;
  const strike = 25_000;
  const breachClose = strike + atr * 0.4;
  const outcome = evaluateWallOutcome(strike, 'resistance', atr, [
    { date: '2026-01-02', high: 25_020, low: 24_700, close: 24_900 }, // touches
    { date: '2026-01-03', high: breachClose + 50, low: 24_900, close: breachClose }, // breaks
  ]);
  assert.equal(outcome.reached, true);
  assert.equal(outcome.held, false);
  assert.equal(outcome.broke, true);
});

// ─── evaluateFromHistory ──────────────────────────────────────────────────────

test('evaluateFromHistory returns null when no sessions after declaredDate', () => {
  const sessions = [
    { date: '2026-01-01', high: 24_500, low: 24_100, close: 24_300 },
  ];
  const result = evaluateFromHistory(sessions, '2026-01-01', 24_000, 'support', 200);
  assert.equal(result, null);
});

test('evaluateFromHistory correctly slices future sessions', () => {
  const sessions = [
    { date: '2026-01-01', high: 24_500, low: 24_100, close: 24_300 },
    { date: '2026-01-02', high: 24_200, low: 23_970, close: 24_100 }, // touches 24_000 support
    { date: '2026-01-03', high: 24_600, low: 24_200, close: 24_500 },
  ];
  const result = evaluateFromHistory(sessions, '2026-01-01', 24_000, 'support', 200, 2);
  assert.ok(result !== null);
  assert.equal(result.reached, true);
  assert.equal(result.daysToReach, 1);
});

test('evaluateFromHistory respects horizon limit', () => {
  // Strike is at 24_000 but only day 3 would touch it (after 2-session horizon)
  const sessions = [
    { date: '2026-01-01', high: 24_500, low: 24_200, close: 24_350 }, // declaration day
    { date: '2026-01-02', high: 24_400, low: 24_150, close: 24_300 }, // future day 1 — no touch
    { date: '2026-01-03', high: 24_200, low: 24_050, close: 24_100 }, // future day 2 — no touch (within horizon=2)
    { date: '2026-01-04', high: 24_100, low: 23_970, close: 24_050 }, // would touch, but outside horizon
  ];
  const result = evaluateFromHistory(sessions, '2026-01-01', 24_000, 'support', 200, 2);
  assert.ok(result !== null);
  assert.equal(result.reached, false);
});

test('evaluateFromHistory waits for the complete declared horizon', () => {
  const result = evaluateFromHistory([
    { date: '2026-01-01', high: 24_500, low: 24_200, close: 24_300 },
    { date: '2026-01-02', high: 24_600, low: 24_300, close: 24_500 },
    { date: '2026-01-03', high: 24_700, low: 24_400, close: 24_600 },
  ], '2026-01-01', 24_000, 'support', 200, 10);
  assert.equal(result, null);
});

test('stock walls use the matching stock sessions for expiry-limited outcomes', () => {
  const sessions = [
    { date: '2026-08-24', high: 2_300, low: 2_270, close: 2_284.09 },
    { date: '2026-08-25', high: 2_313.5, low: 2_262, close: 2_296.2 },
  ];
  const support = evaluateFromHistory(sessions, '2026-08-24', 2_280, 'support', 50, 1);
  const resistance = evaluateFromHistory(sessions, '2026-08-24', 2_320, 'resistance', 50, 1);
  assert.deepEqual(support, {
    reached: true,
    daysToReach: 1,
    held: true,
    broke: false,
    bouncePoints: null,
    bounceAtr: null,
  });
  assert.deepEqual(resistance, {
    reached: true,
    daysToReach: 1,
    held: true,
    broke: false,
    bouncePoints: null,
    bounceAtr: null,
  });
});

test('expiry horizon counts actual weekdays instead of scaling calendar days', () => {
  const expiryEpoch = Math.floor(Date.parse('2026-08-31T10:00:00+05:30') / 1_000);
  assert.equal(tradingSessionsUntilExpiry('2026-08-28T10:00:00+05:30', expiryEpoch), 1);
});

// ─── aggregateWallStats ───────────────────────────────────────────────────────

test('aggregateWallStats: empty rows returns zero stats', () => {
  const stats = aggregateWallStats([]);
  assert.equal(stats.evaluated, 0);
  assert.equal(stats.reachRate, 0);
  assert.equal(stats.avgDaysToReach, null);
  assert.equal(stats.holdRate, null);
});

test('aggregateWallStats: unevaluated rows (reached=null) are excluded', () => {
  const stats = aggregateWallStats([
    { reached: null, daysToReach: null, held: null, broke: null, bouncePoints: null, bounceAtr: null },
    { reached: null, daysToReach: null, held: null, broke: null, bouncePoints: null, bounceAtr: null },
  ]);
  assert.equal(stats.evaluated, 0);
});

test('aggregateWallStats: correct percentages with mixed outcomes', () => {
  const rows = [
    // reached + held (×3)
    { reached: true, daysToReach: 2, held: true, broke: false, bouncePoints: 150, bounceAtr: 0.75 },
    { reached: true, daysToReach: 3, held: true, broke: false, bouncePoints: 200, bounceAtr: 1.0 },
    { reached: true, daysToReach: 1, held: true, broke: false, bouncePoints: 100, bounceAtr: 0.5 },
    // reached + broke (×1)
    { reached: true, daysToReach: 4, held: false, broke: true, bouncePoints: null, bounceAtr: null },
    // not reached (×1)
    { reached: false, daysToReach: null, held: false, broke: false, bouncePoints: null, bounceAtr: null },
  ];
  const stats = aggregateWallStats(rows);
  assert.equal(stats.evaluated, 5);
  assert.equal(stats.reachRate, 80); // 4/5
  assert.ok(Math.abs((stats.avgDaysToReach ?? 0) - 2.5) < 0.01); // (2+3+1+4)/4
  assert.equal(stats.holdRate, 75); // 3/4 reached → held
  assert.equal(stats.breakRate, 25); // 1/4 reached → broke
  assert.ok(Math.abs((stats.avgBounceAtr ?? 0) - 0.75) < 0.01); // avg of [0.75,1.0,0.5]
  assert.ok(Math.abs((stats.avgBouncePoints ?? 0) - 150) < 0.01);
});

// ─── declarePrimaryWalls ──────────────────────────────────────────────────────

test('declarePrimaryWalls picks support below spot and resistance above spot', () => {
  const snapshot = getDemoSnapshot();
  const walls = declarePrimaryWalls(snapshot, 'test-snapshot-id');
  assert.ok(walls.support, 'should have support');
  assert.ok(walls.resistance, 'should have resistance');
  assert.ok(walls.support!.strike < snapshot.spot, 'support must be below spot');
  assert.ok(walls.resistance!.strike > snapshot.spot, 'resistance must be above spot');
  assert.equal(walls.support!.snapshotId, 'test-snapshot-id');
  assert.equal(walls.resistance!.snapshotId, 'test-snapshot-id');
  assert.ok(walls.support!.clusterScore >= 0 && walls.support!.clusterScore <= 1);
  assert.ok(walls.resistance!.clusterScore >= 0 && walls.resistance!.clusterScore <= 1);
});

test('declarePrimaryWalls returns null sides when chain has no relevant strikes', () => {
  const snapshot = getDemoSnapshot();
  // Chain with only strikes above spot — no support possible
  const onlyAbove = snapshot.chain.filter((r) => r.strike > snapshot.spot);
  const walls = declarePrimaryWalls({ ...snapshot, chain: onlyAbove }, 'snap-id');
  assert.equal(walls.support, null);
  assert.ok(walls.resistance !== null);
});

test('HORIZON_SESSIONS is exported as 10', () => {
  assert.equal(HORIZON_SESSIONS, 10);
});
