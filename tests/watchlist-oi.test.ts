import assert from 'node:assert/strict';
import test from 'node:test';
import type { MarketSnapshot } from '../lib/market-types.ts';
import type { WatchCandidate } from '../lib/position-watchlist.ts';
import { declarePrimaryWalls } from '../lib/wall-backtest.ts';
import {
  buildWatchOiEvidence,
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
