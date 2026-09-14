import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FORWARD_RULES,
  FORWARD_VERSION,
  emptyForwardOutcome,
  captureWindow,
  forwardSessionDates,
  advanceForwardSignal,
  blocksNewSignal,
  createForwardSignal,
  type ForwardSignal,
} from '../lib/forward-test.ts';
import { evaluateResearchStrategies } from '../lib/research-strategy.ts';

const signal: ForwardSignal = {
  id: 'test',
  symbol: 'NSE:TEST-EQ',
  name: 'TEST',
  signalDate: '2026-09-11',
  recordedAt: '2026-09-14T22:00:00.000Z',
  version: FORWARD_VERSION,
  rulesHash: 'hash',
  inputHash: 'inputs',
  close: 100,
  stop: 90,
  target: 120,
  atr: 5,
  relativeStrength: 2,
  medianVolume: 30000,
  sessionDates: forwardSessionDates('2026-09-11')!,
  rules: FORWARD_RULES,
  benchmarkSource: 'nse-bhavcopy',
};
const candle = (i = 0, overrides = {}) => ({
  date: signal.sessionDates[i],
  open: 100,
  high: 105,
  low: 95,
  close: 101,
  ...overrides,
});
const advance = (rows = [candle()], cutoff = rows.at(-1)!.date) =>
  advanceForwardSignal(signal, emptyForwardOutcome(), rows, cutoff);

test('Friday entry skips weekend and Monday holiday; records before Tuesday open', () => {
  assert.equal(signal.sessionDates[0], '2026-09-15');
  assert.equal(
    captureWindow('2026-09-11', '2026-09-15T03:44:59.999Z').allowed,
    true,
  );
  assert.equal(
    captureWindow('2026-09-11', '2026-09-15T03:45:00.000Z').allowed,
    false,
  );
});
test('no historical capture after next open or before EOD publication', () => {
  assert.equal(
    captureWindow('2026-09-11', '2026-09-16T00:00:00Z').allowed,
    false,
  );
  assert.equal(
    captureWindow('2026-09-11', '2026-09-11T12:00:00Z').allowed,
    false,
  );
  assert.equal(
    captureWindow('2026-09-14', '2026-09-14T14:00:00Z').allowed,
    false,
  );
});
test('unknown holiday calendar never silently assumes weekdays', () => {
  assert.equal(forwardSessionDates('2027-01-04'), null);
  assert.equal(forwardSessionDates('2026-12-30'), null);
});
test('next open establishes entry, not signal close', () => {
  const result = advance([candle(0, { open: 102 })]);
  assert.equal(result.entry, 102);
  assert.equal(result.status, 'open');
  assert.equal(result.netR, null);
});
test('out-of-range opening gaps are skipped, without profit or loss', () => {
  for (const open of [90, 120]) {
    const result = advance([
      candle(0, { open, high: Math.max(open, 105), low: Math.min(open, 95) }),
    ]);
    assert.equal(result.status, 'skipped');
    assert.equal(result.entry, null);
    assert.equal(result.netR, null);
  }
});
test('target exit deducts 0.2 percent of entry value in R units', () => {
  const result = advance([candle(0, { high: 120 })]);
  assert.equal(result.exit, 120);
  assert.equal(result.grossR, 2);
  assert.equal(result.cost, 0.2);
  assert.equal(result.netR, 1.98);
});
test('stop exit includes costs and is not exactly minus one net R', () => {
  const result = advance([candle(0, { low: 90 })]);
  assert.equal(result.exit, 90);
  assert.equal(result.netR, -1.02);
});
test('both levels hit uses conservative stop with explicit ambiguity', () => {
  const result = advance([candle(0, { low: 89, high: 121 })]);
  assert.equal(result.exit, 90);
  assert.equal(result.ambiguous, true);
  assert.equal(result.netR, -1.02);
});
test('subsequent overnight gaps use actual open, not frozen level', () => {
  assert.equal(
    advance([candle(), candle(1, { open: 87, low: 85, high: 99, close: 95 })])
      .exit,
    87,
  );
  assert.equal(
    advance([
      candle(),
      candle(1, { open: 122, low: 118, high: 123, close: 121 }),
    ]).exit,
    122,
  );
});
test('time exit occurs at session 20, not twenty calendar days', () => {
  const rows = signal.sessionDates.map((_, i) => candle(i));
  assert.equal(advance(rows.slice(0, 19)).status, 'open');
  const result = advance(rows);
  assert.equal(result.status, 'closed');
  assert.equal(result.sessions, 20);
  assert.equal(result.exitDate, signal.sessionDates[19]);
  assert.equal(result.reason, '20-session time exit');
});
test('missing entry candle cannot be replaced by a later open', () => {
  const result = advance([candle(1)]);
  assert.equal(result.entry, null);
  assert.equal(result.sessions, 0);
  assert.match(result.needsData!, /2026-09-15/);
});
test('missing mid-trade candle pauses before processing later target', () => {
  const result = advance([candle(), candle(2, { high: 121 })]);
  assert.equal(result.status, 'open');
  assert.equal(result.exit, null);
  assert.equal(result.sessions, 1);
});
test('missing candle recovery processes chronological data once', () => {
  const initial = advance([candle(), candle(2)]);
  const result = advanceForwardSignal(
    signal,
    initial,
    [candle(), candle(1), candle(2)],
    signal.sessionDates[2],
  );
  assert.equal(result.sessions, 3);
  assert.equal(result.needsData, null);
  assert.deepEqual(
    advanceForwardSignal(
      signal,
      result,
      [candle(), candle(1), candle(2)],
      signal.sessionDates[2],
    ),
    result,
  );
});
test('future candles cannot affect an earlier ledger cutoff', () => {
  assert.deepEqual(
    advance([candle(), candle(1, { high: 125 })], signal.sessionDates[0]),
    advance(),
  );
});
test('prior observed bar revisions quarantine rather than rewrite', () => {
  const first = advance();
  const revised = advanceForwardSignal(
    signal,
    first,
    [candle(0, { close: 102 })],
    signal.sessionDates[0],
  );
  assert.equal(revised.status, 'review');
  assert.equal(revised.bars[0].close, 101);
  assert.equal(revised.netR, null);
});
test('possible corporate actions are visible review cases, not fake gains', () => {
  const result = advance([
    candle(0, { open: 50, low: 49, high: 52, close: 51 }),
  ]);
  assert.equal(result.status, 'review');
  assert.equal(result.netR, null);
});
test('closed outcomes are frozen on later refreshes and corrections', () => {
  const result = advance([candle(0, { high: 121 })]);
  assert.deepEqual(
    advanceForwardSignal(
      signal,
      result,
      [candle(0, { low: 80, close: 85 })],
      '2026-10-01',
    ),
    result,
  );
});
test('late recorded signal cannot acquire a retroactive entry', () => {
  const late = { ...signal, recordedAt: '2026-09-15T04:00:00Z' };
  assert.equal(
    advanceForwardSignal(
      late,
      emptyForwardOutcome(),
      [candle()],
      signal.sessionDates[0],
    ).status,
    'review',
  );
});
test('accepted entries retain full cooldown after early exits', () => {
  const closed = advance([candle(0, { high: 121 })]);
  assert.equal(blocksNewSignal(signal, closed, signal.sessionDates[19]), true);
  assert.equal(blocksNewSignal(signal, closed, '2026-11-02'), false);
  assert.equal(
    blocksNewSignal(signal, emptyForwardOutcome(), '2026-11-02'),
    true,
  );
});
test('skipped entries allow a later signal but not duplicate same-day capture', () => {
  const skipped = advance([candle(0, { open: 90, low: 90 })]);
  assert.equal(blocksNewSignal(signal, skipped, signal.signalDate), true);
  assert.equal(blocksNewSignal(signal, skipped, signal.sessionDates[0]), false);
});
test('capture reuses shared trend rules and stores unrounded stop/target', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 6, 14 + i)).toISOString().slice(0, 10),
    open: 100 + i,
    high: 102 + i,
    low: 99 + i,
    close: 101 + i,
  }));
  const bench = rows.map((r) => ({ ...r, close: 100 }));
  const date = rows.at(-1)!.date;
  const s = evaluateResearchStrategies(rows, bench, date, 30000);
  const created = createForwardSignal(
    {
      symbol: 'TEST',
      name: 'TEST',
      signalDate: date,
      recordedAt: date + 'T14:00:00Z',
      close: 160,
      medianVolume: 30000,
      rulesHash: 'hash',
      inputHash: 'input',
      benchmarkSource: 'nse-bhavcopy',
    },
    s,
  );
  assert.ok(created);
  assert.equal(created.stop, s.stop);
  assert.equal(created.target, s.target);
  assert.equal(created.version, FORWARD_VERSION);
  assert.equal(created.rules.roundTripCost, 0.002);
});
