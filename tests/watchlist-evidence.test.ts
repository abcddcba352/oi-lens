import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidence, type Participation, type FutureRow } from '../lib/watchlist-evidence.ts';

const symbol = 'NSE:TCS-EQ';
const cash: Participation[] = Array.from({ length: 21 }, (_, i) => ({
  symbol,
  date: `2026-08-${String(i + 1).padStart(2, '0')}`,
  volume: i === 20 ? 200 : 100,
  delivery: i === 20 ? 80 : 40,
}));
const future: FutureRow = {
  symbol,
  date: '2026-08-21',
  expiry: '2026-09-29',
  close: 102,
  previous_close: 100,
  oi: 1100,
  oi_change: 100,
  volume: 50,
  lot_size: 100,
};

test('delivery baseline excludes current and future quantities', () => {
  const result = buildEvidence(
    symbol,
    '2026-08-21',
    '2026-08-01',
    100,
    110,
    [...cash, { ...cash[0], date: '2026-08-22', volume: 99999 }],
    [],
    [],
    [],
    [],
  );
  assert.equal(result.volumeRatio, 2);
  assert.equal(result.deliveryRatio, 2);
  assert.equal(result.deliveryPercent, 40);
});

test('unavailable delivery is not treated as zero', () => {
  const result = buildEvidence(
    symbol,
    '2026-08-21',
    '2026-08-01',
    100,
    110,
    cash.map(r => ({ ...r, delivery: null })),
    [],
    [],
    [],
    [],
  );
  assert.equal(result.deliveryRatio, null);
  assert.equal(result.volumeRatio, 2);
  // Delivery item marked unavailable in coverage, not zero
  const delItem = result.coverage.items.find(i => i.field === 'deliveryRatio');
  assert.equal(delItem?.status, 'unavailable');
});

test('futures classification uses matching contract prior close and OI', () => {
  const result = buildEvidence(symbol, '2026-08-21', '2026-08-01', 100, 110, [], [future], [], [], []);
  assert.equal(result.futuresPattern, 'Long buildup');
  assert.equal(result.futuresOiChangePercent, 10);
});

test('near-expiry rolloff is excluded and stale futures cannot confirm', () => {
  const result = buildEvidence(
    symbol,
    '2026-08-21',
    '2026-08-01',
    100,
    110,
    [],
    [{ ...future, expiry: '2026-08-22' }, { ...future, date: '2026-08-20' }],
    [],
    [],
    [],
  );
  assert.equal(result.futuresPattern, null);
});

test('today sector membership cannot leak into past predictions', () => {
  const result = buildEvidence(
    symbol,
    '2026-08-21',
    '2026-08-01',
    100,
    110,
    [],
    [],
    [{ symbol, benchmark: 'NIFTY IT', observed_date: '2026-08-22' }],
    [],
    [],
  );
  assert.equal(result.sector, null);
});

test('sector comparisons use matching endpoints', () => {
  const result = buildEvidence(
    symbol,
    '2026-08-21',
    '2026-08-01',
    100,
    120,
    [],
    [],
    [{ symbol, benchmark: 'NIFTY IT', observed_date: '2026-08-01' }],
    [
      { benchmark: 'NIFTY IT', date: '2026-08-01', close: 100 },
      { benchmark: 'NIFTY IT', date: '2026-08-21', close: 110 },
    ],
    [
      { date: '2026-08-01', close: 100 },
      { date: '2026-08-21', close: 105 },
    ],
  );
  assert.equal(result.stockVsSector, 10);
  assert.equal(result.sectorVsNifty, 5);
});

test('supporting evidence and opposing headwinds are separated', () => {
  // Low volume (0.5x) and short buildup in futures
  const lowCash = cash.map((r, i) => (i === 20 ? { ...r, volume: 50, delivery: 15 } : r));
  const shortBuildupFuture: FutureRow = {
    symbol,
    date: '2026-08-21',
    expiry: '2026-09-29',
    close: 95,
    previous_close: 100,
    oi: 1200,
    oi_change: 200,
    volume: 50,
    lot_size: 100,
  };

  const result = buildEvidence(
    symbol,
    '2026-08-21',
    '2026-08-01',
    100,
    95,
    lowCash,
    [shortBuildupFuture],
    [],
    [],
    [],
  );

  assert.ok(result.opposingEvidence.some(e => e.includes('Below-normal cash volume')));
  assert.ok(result.opposingEvidence.some(e => e.includes('Futures short buildup')));
  assert.equal(result.supportingEvidence.length, 0);
});

test('evidence coverage accurately tallies available vs total inputs', () => {
  // Only cash volume is available, others missing
  const cashOnly = cash.map(r => ({ ...r, delivery: null }));
  const result = buildEvidence(symbol, '2026-08-21', '2026-08-01', 100, 110, cashOnly, [], [], [], []);

  assert.equal(result.coverage.totalCount, 4);
  assert.equal(result.coverage.availableCount, 1);
  assert.equal(result.coverage.coveragePercent, 25);
  assert.equal(result.coverage.items[0].status, 'available'); // Volume
  assert.equal(result.coverage.items[1].status, 'unavailable'); // Delivery
  assert.equal(result.coverage.items[2].status, 'unavailable'); // Futures
  assert.equal(result.coverage.items[3].status, 'unavailable'); // Sector
});

