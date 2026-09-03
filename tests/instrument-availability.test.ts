import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeInstrumentAvailability,
  MIN_SESSIONS_FOR_BASIC_ANALYSIS,
  MIN_SESSIONS_FOR_FULL_HISTORY,
} from '../lib/instrument-availability.ts';

// ─── Threshold constants ─────────────────────────────────────────────────────

test('MIN_SESSIONS_FOR_BASIC_ANALYSIS is 20', () => {
  assert.equal(MIN_SESSIONS_FOR_BASIC_ANALYSIS, 20);
});

test('MIN_SESSIONS_FOR_FULL_HISTORY is 100', () => {
  assert.equal(MIN_SESSIONS_FOR_FULL_HISTORY, 100);
});

// ─── missing_snapshot ────────────────────────────────────────────────────────

test('zero snapshots produces missing_snapshot', () => {
  const result = computeInstrumentAvailability(0, 0);
  assert.equal(result.availability, 'missing_snapshot');
  assert.ok(result.reason?.includes('No saved OI snapshot'));
});

test('zero snapshots with many sessions is still missing_snapshot', () => {
  const result = computeInstrumentAvailability(0, 200);
  assert.equal(result.availability, 'missing_snapshot');
  assert.equal(result.historyCoverage, 'full');
});

// ─── insufficient_history ────────────────────────────────────────────────────

test('snapshot exists but too few sessions produces insufficient_history', () => {
  const result = computeInstrumentAvailability(1, 10);
  assert.equal(result.availability, 'insufficient_history');
  assert.equal(result.historyCoverage, 'none');
  assert.ok(result.reason?.includes('at least 20'));
});

test('snapshot exists with exactly 19 sessions is insufficient', () => {
  const result = computeInstrumentAvailability(2, 19);
  assert.equal(result.availability, 'insufficient_history');
});

// ─── ready with partial history ──────────────────────────────────────────────

test('snapshot and 20 sessions produces ready with partial coverage', () => {
  const result = computeInstrumentAvailability(1, 20);
  assert.equal(result.availability, 'ready');
  assert.equal(result.historyCoverage, 'partial');
  assert.equal(result.partialHistory, true);
  assert.ok(result.reason?.includes('Partial history'));
});

test('snapshot and 50 sessions is ready with partial coverage', () => {
  const result = computeInstrumentAvailability(1, 50);
  assert.equal(result.availability, 'ready');
  assert.equal(result.historyCoverage, 'partial');
  assert.equal(result.partialHistory, true);
});

test('snapshot and 99 sessions is still partial', () => {
  const result = computeInstrumentAvailability(3, 99);
  assert.equal(result.availability, 'ready');
  assert.equal(result.historyCoverage, 'partial');
  assert.equal(result.partialHistory, true);
});

// ─── ready with full history ─────────────────────────────────────────────────

test('snapshot and 100 sessions produces ready with full coverage', () => {
  const result = computeInstrumentAvailability(1, 100);
  assert.equal(result.availability, 'ready');
  assert.equal(result.historyCoverage, 'full');
  assert.equal(result.partialHistory, false);
  assert.equal(result.reason, null);
});

test('snapshot and 120 sessions is full coverage', () => {
  const result = computeInstrumentAvailability(5, 120);
  assert.equal(result.availability, 'ready');
  assert.equal(result.historyCoverage, 'full');
  assert.equal(result.partialHistory, false);
  assert.equal(result.reason, null);
});

// ─── Partial history must not claim full validation ──────────────────────────

test('partial history cannot claim six-month validation or confluence', () => {
  const result = computeInstrumentAvailability(1, 60);
  assert.equal(result.availability, 'ready');
  assert.equal(result.partialHistory, true);
  assert.ok(
    result.reason?.includes('model comparison'),
    'Partial history reason must warn about model comparison limitations',
  );
  assert.ok(
    result.reason?.includes('100'),
    'Partial history reason must mention the 100 session threshold',
  );
});

// ─── No cross-instrument substitution ────────────────────────────────────────

test('availability is per-instrument and never uses another symbols data', () => {
  // Two separate instruments with different states
  const tcs = computeInstrumentAvailability(1, 120);
  const sbin = computeInstrumentAvailability(0, 0);
  assert.equal(tcs.availability, 'ready');
  assert.equal(sbin.availability, 'missing_snapshot');
  // Prove they are independent — sbin can't inherit tcs readiness
  assert.notEqual(tcs.availability, sbin.availability);
});
