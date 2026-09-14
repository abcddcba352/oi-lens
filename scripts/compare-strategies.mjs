// Local research runner; only the benchmark read uses D1. No remote writes.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  evaluateResearchStrategies,
  RESEARCH_STRATEGIES,
} from '../lib/research-strategy.ts';
import { selectResearchStrategy } from '../lib/strategy-selection.ts';
const dir = process.argv[2];
if (!dir)
  throw Error(
    'Usage: node --experimental-strip-types scripts/compare-strategies.mjs <research-directory>',
  );
const input = JSON.parse(
  readFileSync(resolve(dir, 'strategy-input.json'), 'utf8'),
);
let benchmark;
const benchmarkPath = resolve(dir, 'strategy-benchmark.json');
if (
  existsSync(benchmarkPath) &&
  !process.argv.includes('--refresh-benchmark')
) {
  benchmark = JSON.parse(readFileSync(benchmarkPath, 'utf8'));
} else {
  const raw = execFileSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'd1',
      'execute',
      'site-creator-d1',
      '--remote',
      '--config',
      'wrangler.d1.json',
      '--command',
      "SELECT session_date AS date,open,high,low,close FROM market_sessions WHERE instrument_id='NSE:NIFTY50-INDEX' AND source='nse-bhavcopy' ORDER BY session_date",
      '--json',
    ],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 120000 },
  );
  const response = JSON.parse(raw);
  if (response.some((r) => !r.success || r.meta.rows_written !== 0))
    throw Error('Benchmark read failed');
  benchmark = response.flatMap((r) => r.results);
  writeFileSync(
    resolve(dir, 'strategy-benchmark.json'),
    JSON.stringify(benchmark),
  );
}
const ids = Object.keys(RESEARCH_STRATEGIES),
  trades = [],
  pending = {},
  dates = [
    ...new Set(Object.values(input).flatMap((rows) => rows.map((r) => r.date))),
  ].sort();
const dateIndex = new Map(dates.map((date, i) => [date, i]));
const mean = (a) => a.reduce((s, n) => s + n, 0) / a.length;
for (const [symbol, rows] of Object.entries(input)) {
  const busy = Object.fromEntries(ids.map((id) => [id, -1]));
  for (let i = 59; i < rows.length - 1; i++) {
    const r = rows[i],
      signal = evaluateResearchStrategies(
        rows.slice(0, i + 1),
        benchmark,
        r.date,
        r.medianVolume,
        r.oi ?? undefined,
      );
    if (!signal.eligible || r.activeFo === false) continue;
    const next = rows[i + 1];
    if (
      next.date !== dates[dateIndex.get(r.date) + 1] ||
      next.open <= signal.stop ||
      next.open >= signal.target
    )
      continue;
    for (const id of ids) {
      if (i <= busy[id] || !signal.matches[id]) continue;
      busy[id] = i + 20;
      const future = rows.slice(i + 1, i + 21),
        expected = dates.slice(
          dateIndex.get(r.date) + 1,
          dateIndex.get(r.date) + 21,
        );
      if (
        future.length !== 20 ||
        expected.length !== 20 ||
        future.some((p, j) => p.date !== expected[j])
      ) {
        pending[id] = (pending[id] ?? 0) + 1;
        continue;
      }
      // Actions/cash discontinuities in the future cannot be repaired without an action ledger.
      // Keep these in an explicit excluded count rather than silently interpreting split gaps as P&L.
      const discontinuity = future.some(
        (p, j) =>
          Math.abs(p.close / (j ? future[j - 1].close : r.close) - 1) > 0.25,
      );
      let outcome = 'timeout',
        exit = future.at(-1).close,
        exitDate = future.at(-1).date;
      for (const p of future) {
        if (p.open <= signal.stop) {
          outcome = 'stop';
          exit = p.open;
        } else if (p.open >= signal.target) {
          outcome = 'target';
          exit = p.open;
        } else if (p.low <= signal.stop && p.high >= signal.target) {
          outcome = 'ambiguous';
          exit = signal.stop;
        } else if (p.low <= signal.stop) {
          outcome = 'stop';
          exit = signal.stop;
        } else if (p.high >= signal.target) {
          outcome = 'target';
          exit = signal.target;
        }
        if (outcome !== 'timeout') {
          exitDate = p.date;
          break;
        }
      }
      const risk = next.open - signal.stop,
        grossR = (exit - next.open) / risk,
        netR = grossR - (0.002 * next.open) / risk;
      const period =
        future.at(-1).date < '2026-08-01'
          ? 'selection'
          : r.date >= '2026-08-01'
            ? 'later'
            : 'purged';
      trades.push({
        id,
        symbol,
        date: r.date,
        period,
        entry: next.open,
        stop: signal.stop,
        target: signal.target,
        exit,
        exitDate,
        endDate: future.at(-1).date,
        outcome,
        discontinuity,
        grossR,
        netR,
        riskPct: (100 * risk) / next.open,
      });
    }
  }
}
function stats(rows) {
  const usable = rows.filter((r) => !r.discontinuity),
    v = usable.map((r) => r.netR);
  const byStock = new Map();
  for (const r of usable) {
    const a = byStock.get(r.symbol) ?? [];
    a.push(r.netR);
    byStock.set(r.symbol, a);
  }
  const groups = [...byStock.values()],
    means = [];
  let seed = 7123;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  if (groups.length)
    for (let b = 0; b < 1000; b++) {
      const sample = [];
      for (let n = 0; n < groups.length; n++)
        sample.push(...groups[Math.floor(random() * groups.length)]);
      means.push(mean(sample));
    }
  means.sort((a, b) => a - b);
  return {
    count: usable.length,
    stocks: groups.length,
    actionReviewExcluded: rows.length - usable.length,
    target: usable.filter((r) => r.outcome === 'target').length,
    stop: usable.filter((r) => r.outcome === 'stop').length,
    timeout: usable.filter((r) => r.outcome === 'timeout').length,
    ambiguous: usable.filter((r) => r.outcome === 'ambiguous').length,
    meanNetR: v.length ? mean(v) : null,
    medianNetR: v.length
      ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]
      : null,
    positivePercent: v.length
      ? (100 * v.filter((n) => n > 0).length) / v.length
      : null,
    clusterCi95: means.length ? [means[25], means[974]] : null,
  };
}
const summaries = ids.map((id) => ({
  id,
  name: RESEARCH_STRATEGIES[id],
  selection: stats(
    trades.filter((r) => r.id === id && r.period === 'selection'),
  ),
  later: stats(trades.filter((r) => r.id === id && r.period === 'later')),
  purged: trades.filter((r) => r.id === id && r.period === 'purged').length,
  pending: pending[id] ?? 0,
}));
const selection = selectResearchStrategy(summaries);
const selected = summaries.find((r) => r.id === selection.selectedId);
const passes = selection.passesStudyGate;
const report = {
  asOf: dates.at(-1),
  stockCount: Object.keys(input).length,
  selectionRule:
    'Highest selection-period mean net R among strategies with >=30 trades and >=10 stocks; tie follows simpler strategy order. Fallback trend research if none qualifies.',
  selectionCutoff: '2026-08-01',
  selectedId: selected.id,
  passesStudyGate: passes,
  liveLabel: passes
    ? 'Best in this limited comparison'
    : 'Research only — no dependable winner',
  limitations: [
    'Six-month exploratory sample already examined in earlier research; not a pristine holdout.',
    'Later period is short. Confidence interval resamples stocks, not market dates.',
    'No portfolio capital model; 0.2% total friction is an assumption.',
    'Corporate actions are not normalized; >25% discontinuities require exclusion/review.',
    'OI variant uses full chains and cannot be silently reproduced from truncated live chains.',
  ],
  summaries,
  trades,
};
writeFileSync(
  resolve(dir, 'strategy-comparison.json'),
  JSON.stringify(report, null, 2),
);
const cols = Object.keys(trades[0] ?? {});
writeFileSync(
  resolve(dir, 'strategy-comparison.csv'),
  [
    cols.join(','),
    ...trades.map((r) => cols.map((k) => JSON.stringify(r[k] ?? '')).join(',')),
  ].join('\n'),
);
console.log(JSON.stringify({ ...report, trades: undefined }, null, 2));
