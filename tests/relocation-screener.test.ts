import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectRelocation,
  detectRelocationFromSingleSnapshot,
  getDemoRelocationCandidates,
  scanSnapshotPairs,
} from '../lib/relocation-screener.ts';
import type { MarketSnapshot } from '../lib/market-types.ts';

function createMockSnapshot(
  symbol: string,
  spot: number,
  resistanceStrike: number,
  oldStrikeOi: number,
  oldStrikeChange: number,
  newStrikeOi: number,
  newStrikeChange: number,
  callVolume = 50_000,
): MarketSnapshot {
  const strikes = [
    {
      strike: 3700,
      callOi: 200_000,
      callOiChange: 10_000,
      callVolume: 10_000,
      putOi: 1_500_000,
      putOiChange: 50_000,
      putVolume: 40_000,
    },
    {
      strike: 3800,
      callOi: oldStrikeOi,
      callOiChange: oldStrikeChange,
      callVolume: 25_000,
      putOi: 800_000,
      putOiChange: 30_000,
      putVolume: 20_000,
    },
    {
      strike: 3900,
      callOi: newStrikeOi,
      callOiChange: newStrikeChange,
      callVolume,
      putOi: 300_000,
      putOiChange: 10_000,
      putVolume: 15_000,
    },
    {
      strike: 4000,
      callOi: 400_000,
      callOiChange: 5_000,
      callVolume: 12_000,
      putOi: 100_000,
      putOiChange: -5_000,
      putVolume: 8_000,
    },
  ];

  return {
    symbol,
    displayName: symbol.replace(/^NSE:|-(EQ|INDEX)$/g, ''),
    instrumentType: 'stock',
    spot,
    spotChangePercent: 1.5,
    expiry: '24 Sep 2026',
    strikeStep: 100,
    atr14: 60,
    ivPercentile: 0.5,
    asOf: '2026-09-11T15:30:00.000Z',
    source: 'demo',
    chain: strikes,
  };
}

test('detectRelocation: identifies valid Method 2 relocation pattern', () => {
  // At T-1: Resistance was at 3800 with 1,200,000 Call OI
  const prev = createMockSnapshot('NSE:TCS-EQ', 3750, 3800, 1_200_000, 50_000, 400_000, 10_000, 20_000);
  prev.asOf = '2026-09-10T15:30:00.000Z';

  // At T: Resistance moved to 3900 with 1,800,000 Call OI (+600k fresh writing)
  // while 3800 unwound (-400,000 Call OI) with high volume (150,000)
  const curr = createMockSnapshot('NSE:TCS-EQ', 3820, 3900, 800_000, -400_000, 1_800_000, 600_000, 150_000);
  curr.asOf = '2026-09-11T15:30:00.000Z';

  const candidate = detectRelocation(prev, curr);

  assert.ok(candidate !== null, 'Expected candidate to be detected');
  assert.equal(candidate.symbol, 'NSE:TCS-EQ');
  assert.equal(candidate.oldResistanceStrike, 3800);
  assert.equal(candidate.newResistanceStrike, 3900);
  assert.equal(candidate.shiftPoints, 100);
  assert.ok(candidate.shiftPercent > 0);
  assert.ok(candidate.oldStrikeUnwindingPercent < 0, 'Old strike must show unwinding');
  assert.ok(candidate.newStrikeOiChangePercent > 0, 'New strike must show fresh build-up');
  assert.ok(candidate.relocationScore >= 50, 'Score should be high');
});

test('detectRelocation: rejects when resistance did not move up', () => {
  // Both T-1 and T have resistance at 3800
  const prev = createMockSnapshot('NSE:TCS-EQ', 3750, 3800, 1_200_000, 50_000, 400_000, 10_000, 20_000);
  const curr = createMockSnapshot('NSE:TCS-EQ', 3760, 3800, 1_300_000, 100_000, 420_000, 20_000, 30_000);

  const candidate = detectRelocation(prev, curr);
  assert.equal(candidate, null, 'Should return null when resistance did not move up');
});

test('detectRelocation: rejects when old resistance did not unwind (no short covering)', () => {
  const prev = createMockSnapshot('NSE:TCS-EQ', 3750, 3800, 1_000_000, 50_000, 400_000, 10_000, 20_000);
  // In curr, old strike at 3800 still increased OI (+200_000) instead of unwinding
  const curr = createMockSnapshot('NSE:TCS-EQ', 3820, 3900, 1_200_000, 200_000, 2_000_000, 800_000, 100_000);

  const candidate = detectRelocation(prev, curr, { requireUnwinding: true });
  assert.equal(candidate, null, 'Should return null when old resistance did not unwind');
});

test('scanSnapshotPairs: sorts candidates by relocationScore descending', () => {
  const prev1 = createMockSnapshot('NSE:TCS-EQ', 3750, 3800, 1_200_000, 50_000, 400_000, 10_000, 20_000);
  const curr1 = createMockSnapshot('NSE:TCS-EQ', 3820, 3900, 800_000, -400_000, 1_800_000, 600_000, 150_000);

  const prev2 = createMockSnapshot('NSE:INFY-EQ', 1800, 1800, 900_000, 30_000, 300_000, 10_000, 15_000);
  const curr2 = createMockSnapshot('NSE:INFY-EQ', 1810, 1850, 850_000, -50_000, 1_000_000, 100_000, 35_000);

  const results = scanSnapshotPairs([
    { prev: prev1, curr: curr1 },
    { prev: prev2, curr: curr2 },
  ]);

  assert.ok(results.length >= 1);
  for (let i = 0; i < results.length - 1; i++) {
    assert.ok(results[i].relocationScore >= results[i + 1].relocationScore);
  }
});

test('getDemoRelocationCandidates: returns well-formed candidates', () => {
  const candidates = getDemoRelocationCandidates();
  assert.ok(candidates.length >= 3);
  for (const c of candidates) {
    assert.ok(c.newResistanceStrike > c.oldResistanceStrike);
    assert.ok(c.oldStrikeUnwindingPercent < 0);
    assert.ok(c.newStrikeOiChangePercent > 0);
    assert.ok(c.volumeRatio >= 1);
    assert.ok(c.relocationScore > 0);
  }
});

test('detectRelocationFromSingleSnapshot: reconstructs baseline and detects relocation', () => {
  // A single snapshot with 3800 unwound (-400k) and 3900 added (+600k)
  const curr = createMockSnapshot('NSE:TCS-EQ', 3820, 3900, 800_000, -400_000, 1_800_000, 600_000, 150_000);
  const candidate = detectRelocationFromSingleSnapshot(curr);

  assert.ok(candidate !== null, 'Single snapshot reconstruction should detect candidate');
  assert.equal(candidate.symbol, 'NSE:TCS-EQ');
  assert.equal(candidate.newResistanceStrike, 3900);
  assert.ok(candidate.shiftPoints > 0);
  assert.ok(candidate.oldStrikeUnwindingPercent < 0);
});

