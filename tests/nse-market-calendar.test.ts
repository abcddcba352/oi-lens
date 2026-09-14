import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMarketDayStatus } from '../lib/nse-market-calendar.ts';

test('official NSE holiday does not request an EOD collection', () => {
  const status = buildMarketDayStatus(new Date('2026-09-14T06:30:00Z'), '2026-09-11');
  assert.equal(status.state, 'holiday');
  assert.equal(status.holidayName, 'Ganesh Chaturthi');
  assert.equal(status.collectionRequired, false);
  assert.match(status.detail, /No EOD report/);
});

test('weekend does not request an EOD collection', () => {
  const status = buildMarketDayStatus(new Date('2026-09-13T06:30:00Z'), '2026-09-11');
  assert.equal(status.state, 'weekend');
  assert.equal(status.collectionRequired, false);
});

test('current EOD date is reported as already stored', () => {
  const status = buildMarketDayStatus(new Date('2026-09-15T13:30:00Z'), '2026-09-15');
  assert.equal(status.state, 'eod-current');
  assert.equal(status.collectionRequired, false);
});

test('trading-day EOD is not considered missing before publication time', () => {
  const status = buildMarketDayStatus(new Date('2026-09-15T04:30:00Z'), '2026-09-11');
  assert.equal(status.state, 'awaiting-eod');
  assert.equal(status.collectionRequired, false);
});

test('missing trading-day EOD after 18:30 IST requires collection', () => {
  const status = buildMarketDayStatus(new Date('2026-09-15T13:30:00Z'), '2026-09-11');
  assert.equal(status.state, 'eod-missing');
  assert.equal(status.collectionRequired, true);
});
