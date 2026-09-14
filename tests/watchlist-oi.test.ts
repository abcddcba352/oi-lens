import assert from 'node:assert/strict';
import test from 'node:test';
import type { MarketSnapshot } from '../lib/market-types.ts';
import type { WatchCandidate } from '../lib/position-watchlist.ts';
import { declarePrimaryWalls } from '../lib/wall-backtest.ts';
import {
  buildWatchOiEvidence,
  applyWatchOiPriorityGuard,
  deriveWatchWallOutcomes,
  unavailableWatchOiEvidence,
  watchOiRank,
  type WatchWallOutcomeRow,
} from '../lib/watchlist-oi.ts';

const candidate: WatchCandidate = {
  symbol: 'NSE:TEST-EQ',
  name: 'TEST',
  horizon: 'short',
  group: 'developing',
  asOf: '2026-09-11',
  source: 'nse-bhavcopy',
  close: 100,
  sessions: 120,
  score: 70,
  stage: 'Approaching resistance',
  resistance: 105,
  entryTrigger: 106,
  invalidation: 94,
  nextResistance: 115,
  rewardRisk: 1,
  targetReviewRequired: false,
  riskDistance: 12,
  riskDistanceAtr: 1.2,
  distancePercent: 5,
  distanceAtr: 0.5,
  atr: 10,
  relativeStrength: 2,
  reasons: [],
  scoreBreakdown: [],
  probability: null,
};

const snapshot: MarketSnapshot = {
  symbol: candidate.symbol,
  displayName: candidate.name,
  instrumentType: 'stock',
  spot: 100,
  spotChangePercent: 0,
  expiry: '2026-09-24',
  strikeStep: 5,
  atr14: 10,
  ivPercentile: 50,
  asOf: '2026-09-11T12:00:00.000Z',
  source: 'nse-bhavcopy',
  chain: [
    { strike: 90, callOi: 10, callOiChange: 0, callVolume: 10, putOi: 200, putOiChange: 5, putVolume: 50 },
    { strike: 95, callOi: 20, callOiChange: 0, callVolume: 10, putOi: 2_000, putOiChange: 300, putVolume: 500 },
    { strike: 105, callOi: 2_000, callOiChange: -300, callVolume: 500, putOi: 20, putOiChange: 0, putVolume: 10 },
    { strike: 110, callOi: 100, callOiChange: -5, callVolume: 20, putOi: 10, putOiChange: 0, putVolume: 10 },
  ],
};

function breakoutFixture(closes: number[], overrides: Partial<MarketSnapshot> = {}) {
  const setup: WatchCandidate = { ...candidate, close: closes.at(-1)!, atr: 10, group: 'priority' };
  const chain: MarketSnapshot = { ...snapshot, spot: setup.close, chain: [
    ...snapshot.chain,
    { strike: 100, callOi: 1500, callOiChange: 100, callVolume: 500, putOi: 100, putOiChange: 0, putVolume: 10 },
  ], ...overrides };
  const prices = closes.map((close, index) => ({
    date: `2026-09-${String(12 - closes.length + index).padStart(2, '0')}`,
    open: close, high: close + 1, low: close - 1, close, source: 'nse-bhavcopy',
  }));
  setup.oiEvidence = buildWatchOiEvidence(setup, chain, [], setup.asOf, prices);
  applyWatchOiPriorityGuard(setup);
  return setup;
}

test('small crossing retains the call zone and demotes priority despite a higher overhead wall', () => {
  const setup = breakoutFixture([99, 101]);
  assert.equal(setup.oiEvidence?.breakoutCheck?.strike, 100);
  assert.equal(setup.oiEvidence?.resistance?.strike, 105);
  assert.equal(setup.oiEvidence?.breakoutCheck?.status, 'Needs confirmation');
  assert.equal(setup.group, 'developing');
});

test('one clear close does not confirm but two closes beyond tolerance do', () => {
  assert.equal(breakoutFixture([99, 104]).group, 'developing');
  // Isolate the crossed zone: an additional nearby overhead wall should still block priority.
  const isolated = { chain: [{ ...snapshot.chain[2], strike: 100 }] };
  assert.equal(breakoutFixture([99, 104], isolated).group, 'developing');
  assert.equal(breakoutFixture([103, 104], isolated).oiEvidence?.breakoutCheck?.status, 'Held above zone');
});

test('close back below the zone after clearing it flags failed breakout', () => {
  const setup = breakoutFixture([104, 97]);
  assert.equal(setup.oiEvidence?.breakoutCheck?.status, 'Failed breakout');
  assert.equal(setup.group, 'developing');
});

test('stale OI cannot confirm or veto a current breakout', () => {
  assert.equal(breakoutFixture([99, 101], { asOf: '2026-08-01T12:00:00Z' }).oiEvidence?.breakoutCheck, undefined);
});

test('insignificant call OI is not treated as an unresolved wall', () => {
  const setup = breakoutFixture([99, 101], { chain: snapshot.chain });
  assert.equal(setup.oiEvidence?.breakoutCheck, undefined);
});

const outcome = (
  side: 'support' | 'resistance',
  day: number,
  values: Partial<WatchWallOutcomeRow> = {},
): WatchWallOutcomeRow => ({
  side,
  declaredDate: `2026-08-${String(day).padStart(2, '0')}`,
  capturedAt: `2026-08-${String(day).padStart(2, '0')}T12:00:00.000Z`,
  reached: true,
  daysToReach: 2,
  held: side === 'support',
  broke: side === 'resistance',
  bouncePoints: 5,
  bounceAtr: 0.5,
  ...values,
});

test('watchlist reuses the Level Map primary wall selector', () => {
  const declared = declarePrimaryWalls(snapshot, 'comparison');
  const evidence = buildWatchOiEvidence(candidate, snapshot, [], '2026-09-11');
  assert.equal(evidence.support?.strike, declared.support?.strike);
  assert.equal(evidence.resistance?.strike, declared.resistance?.strike);
});

test('put build, call reduction and price/OI confluence confirm without claiming probability', () => {
  const evidence = buildWatchOiEvidence(candidate, snapshot, [], '2026-09-11');
  assert.equal(evidence.priceResistanceConfluence, true);
  assert.ok(evidence.confirmations.some(text => text.includes('Put OI increased')));
  assert.ok(evidence.confirmations.some(text => text.includes('Call OI decreased')));
  assert.equal(evidence.classification, 'OI confirmed');
});

test('opposing OI changes are classified as conflict', () => {
  const conflicting: MarketSnapshot = {
    ...snapshot,
    chain: snapshot.chain.map(row => ({
      ...row,
      putOiChange: row.strike < 100 ? -Math.abs(row.putOiChange || 10) : row.putOiChange,
      callOiChange: row.strike > 100 ? Math.abs(row.callOiChange || 10) : row.callOiChange,
    })),
  };
  const evidence = buildWatchOiEvidence({ ...candidate, resistance: 120 }, conflicting, [], '2026-09-11');
  assert.equal(evidence.classification, 'OI conflict');
  assert.equal(evidence.conflicts.length, 2);
});

test('historical stats count one latest wall per side and declaration day', () => {
  const rows = Array.from({ length: 5 }, (_, index) => outcome('support', index + 1));
  rows.push(outcome('support', 1, {
    capturedAt: '2026-08-01T15:00:00.000Z',
    held: false,
    broke: true,
  }));
  const evidence = buildWatchOiEvidence(candidate, snapshot, rows, '2026-09-11');
  assert.equal(evidence.historical?.support.evaluated, 5);
  assert.equal(evidence.historical?.support.reached, 5);
  assert.equal(evidence.historical?.support.held, 4);
  assert.equal(evidence.historical?.support.broke, 1);
});

test('cutoff and unevaluated rows cannot leak into historical rates', () => {
  const rows = [
    outcome('support', 1),
    outcome('support', 2, { declaredDate: '2026-09-11' }),
    outcome('support', 3, { reached: null, held: null, broke: null }),
  ];
  const evidence = buildWatchOiEvidence(candidate, snapshot, rows, '2026-09-11');
  assert.equal(evidence.historical?.support.evaluated, 1);
});

test('stale and unavailable OI never count as confirmation', () => {
  const stale = buildWatchOiEvidence(candidate, { ...snapshot, asOf: '2026-08-01T12:00:00.000Z' }, [], '2026-09-11');
  assert.equal(stale.classification, 'OI stale');
  assert.deepEqual(stale.confirmations, []);
  assert.equal(unavailableWatchOiEvidence().classification, 'Price only');
  assert.ok(watchOiRank('OI confirmed') > watchOiRank('OI developing'));
  assert.ok(watchOiRank('Price only') > watchOiRank('OI conflict'));
});

test('archive snapshots derive completed outcomes once per day without future leakage', () => {
  const archived = { ...snapshot, asOf: '2026-08-01T12:00:00.000Z' };
  const laterSameDay = { ...archived, asOf: '2026-08-01T15:00:00.000Z' };
  const cutoffSnapshot = { ...archived, asOf: '2026-09-11T09:00:00.000Z' };
  const prices = Array.from({ length: 10 }, (_, index) => ({
    date: `2026-08-${String(index + 2).padStart(2, '0')}`,
    high: 106,
    low: 94,
    close: 100,
  }));
  const rows = deriveWatchWallOutcomes(
    [archived, laterSameDay, cutoffSnapshot],
    prices,
    '2026-09-11',
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.capturedAt === laterSameDay.asOf));
  assert.ok(rows.every(row => row.reached === true));
});
