// The only ledger writer. Runs after daily ingestion using existing scoped D1 credentials.
// Default is read-only dry-run. No orders, broker calls, or hindsight replay mode.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateResearchStrategies } from '../lib/research-strategy.ts';
import {
  FORWARD_VERSION,
  FORWARD_RULES,
  captureWindow,
  createForwardSignal,
  emptyForwardOutcome,
  advanceForwardSignal,
  blocksNewSignal,
} from '../lib/forward-test.ts';

const write = process.argv.includes('--write');
if (write && process.argv.includes('--dry-run')) throw Error('Choose --write or --dry-run, not both.');
if (process.argv.slice(2).some((a) => !['--write', '--dry-run'].includes(a)))
  throw Error(
    'Only --write or --dry-run supported; historical capture/time overrides are forbidden.',
  );
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const base = [
  cli,
  'd1',
  'execute',
  'site-creator-d1',
  '--config',
  'wrangler.d1.json',
  '--remote',
];
const sqlText = (value) =>
  value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const rulesHash = hash(
  ['lib/research-strategy.ts','lib/forward-test.ts'].map(file =>
    readFileSync(resolve(root,file),'utf8').replaceAll('\r\n','\n')).join('\n') + JSON.stringify(FORWARD_RULES),
);
function query(sql) {
  const raw = execFileSync(
    process.execPath,
    [...base, '--command', sql, '--json'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 40 * 1024 * 1024,
      timeout: 120000,
    },
  );
  const result = JSON.parse(raw);
  if (result.some((r) => !r.success || r.meta?.rows_written !== 0))
    throw Error('Read-only D1 query failed');
  return result.flatMap((r) => r.results);
}
function apply(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'oi-forward-'));
  const file = join(dir, 'update.sql');
  try {
    writeFileSync(file, sql);
    const output = execFileSync(
      process.execPath,
      [...base, '--file', file, '-y', '--json'],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 5 * 1024 * 1024,
        timeout: 120000,
      },
    );
    const jsonStart = output.search(/^\s*\[\s*\{/m);
    if (jsonStart < 0) throw Error('D1 response uncertain; inspect the ledger before retrying.');
    const result = JSON.parse(output.slice(jsonStart));
    if (result.some((r) => !r.success)) throw Error('D1 write failed');
  } finally {
    rmSync(file, { force: true });
    rmdirSync(dir);
  }
}
const now = new Date().toISOString();
const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const state = query(
  `SELECT * FROM forward_test_state WHERE version=${sqlText(FORWARD_VERSION)}`,
)[0];
if (state && state.rules_hash !== rulesHash)
  throw Error(
    'Frozen rules changed: explicitly create a new version before recording more signals.',
  );
const asOf = query(
  `SELECT MAX(session_date) AS date FROM market_sessions WHERE source='nse-bhavcopy' AND session_date<=${sqlText(today)}`,
)[0]?.date;
if (!asOf) throw Error('No completed official EOD data; ledger unchanged.');
const window = captureWindow(asOf, now);
const allExisting = query(
  `SELECT * FROM forward_signals WHERE version=${sqlText(FORWARD_VERSION)} AND (signal_date>=date(${sqlText(asOf)},'-100 days') OR status IN ('pending','open','review'))`,
);
const existing = allExisting.map((r) => ({
  row: r,
  signal: JSON.parse(r.signal_json),
  outcome: JSON.parse(r.outcome_json),
}));
const statements = [
  `INSERT INTO forward_test_state(version,started_at,rules_hash,last_run_at,last_eod,note) VALUES (${sqlText(FORWARD_VERSION)},${sqlText(now)},${sqlText(rulesHash)},${sqlText(now)},NULL,'Starting') ON CONFLICT(version) DO NOTHING;`,
];
// Official stock candles only. Benchmark may use saved FYERS daily history and is labelled.
const stocks = query(
  `SELECT i.id,i.display_name FROM instruments i WHERE i.instrument_type='stock' AND i.id NOT IN ('NSE:NIFTYFPI-EQ','NSE:NIFTYNXT50-EQ') AND EXISTS (SELECT 1 FROM oi_snapshots s WHERE s.instrument_id=i.id AND substr(s.captured_at,1,10)=${sqlText(asOf)} AND s.source='nse-bhavcopy') ORDER BY i.id`,
);
const symbols = [
  ...new Set([
    ...stocks.map((s) => s.id),
    ...existing
      .filter((r) => ['pending', 'open'].includes(r.outcome.status))
      .map((r) => r.signal.symbol),
  ]),
];
const prices = new Map(),
  cash = new Map();
const cutoff = new Date(Date.parse(asOf) - 183 * 86400000)
  .toISOString()
  .slice(0, 10);
for (let i = 0; i < symbols.length; i += 30) {
  const list = symbols
    .slice(i, i + 30)
    .map(sqlText)
    .join(',');
  const rows = query(
    `SELECT instrument_id AS symbol,session_date AS date,open,high,low,close FROM market_sessions WHERE instrument_id IN (${list}) AND source='nse-bhavcopy' AND session_date BETWEEN ${sqlText(cutoff)} AND ${sqlText(asOf)} ORDER BY session_date`,
  );
  for (const r of rows) {
    const a = prices.get(r.symbol) ?? [];
    a.push(r);
    prices.set(r.symbol, a);
  }
  if (window.allowed) {
    const volumes = query(
      `SELECT symbol,date,volume FROM cash_participation WHERE symbol IN (${list}) AND date BETWEEN date(${sqlText(asOf)},'-60 days') AND ${sqlText(asOf)} ORDER BY date`,
    );
    for (const r of volumes) {
      const a = cash.get(r.symbol) ?? [];
      a.push(r);
      cash.set(r.symbol, a);
    }
  }
}
let updated = 0,
  captured = 0,
  blocked = 0,
  ineligible = 0;
for (const record of existing) {
  const next = advanceForwardSignal(
    record.signal,
    record.outcome,
    prices.get(record.signal.symbol) ?? [],
    asOf,
  );
  if (JSON.stringify(next) === JSON.stringify(record.outcome)) continue;
  statements.push(
    `UPDATE forward_signals SET outcome_json=${sqlText(JSON.stringify(next))},status=${sqlText(next.status)},net_r=${next.netR ?? 'NULL'},updated_at=${sqlText(now)} WHERE id=${sqlText(record.row.id)} AND updated_at=${sqlText(record.row.updated_at)};`,
  );
  record.outcome = next;
  updated++;
}
let missingBenchmark = false;
if (window.allowed) {
  const benchmark = query(
    `SELECT session_date AS date,open,high,low,close,source FROM market_sessions WHERE instrument_id='NSE:NIFTY50-INDEX' AND source!='demo' AND session_date BETWEEN ${sqlText(cutoff)} AND ${sqlText(asOf)} ORDER BY session_date`,
  );
  missingBenchmark = !benchmark.some((r) => r.date === asOf);
  for (const stock of stocks) {
    if (
      existing.some(
        (r) =>
          r.signal.symbol === stock.id &&
          blocksNewSignal(r.signal, r.outcome, asOf),
      )
    ) {
      blocked++;
      continue;
    }
    const rows = prices.get(stock.id) ?? [];
    const participation = cash.get(stock.id) ?? [];
    const prior = participation.filter((r) => r.date < asOf).slice(-20);
    const values = prior
      .map((r) => r.volume)
      .filter((n) => Number.isFinite(n) && n >= 0)
      .sort((a, b) => a - b);
    const medianVolume =
      values.length === 20 && participation.some((r) => r.date === asOf)
        ? (values[9] + values[10]) / 2
        : null;
    const signal = evaluateResearchStrategies(
      rows,
      benchmark,
      asOf,
      medianVolume,
    );
    if (!signal.matches.trend) {
      ineligible++;
      continue;
    }
    // Capture timestamp is checked again after remote reads, not just at process start.
    const recordedAt = new Date().toISOString();
    const frozen = createForwardSignal(
      {
        symbol: stock.id,
        name: stock.display_name,
        signalDate: asOf,
        recordedAt,
        close: rows.at(-1).close,
        medianVolume,
        rulesHash,
        inputHash: hash(
          JSON.stringify({
            prices: rows.slice(-60),
            benchmark: benchmark.filter((b) =>
              rows.slice(-21).some((r) => r.date === b.date),
            ),
            prior,
          }),
        ),
        benchmarkSource:
          benchmark.find((r) => r.date === asOf)?.source ?? 'unavailable',
      },
      signal,
    );
    if (!frozen) continue;
    const initial = emptyForwardOutcome();
    // Atomic duplicate/cooldown guard, even if a second runner reads the same old state.
    statements.push(`INSERT INTO forward_signals(id,version,symbol,signal_date,recorded_at,signal_json,outcome_json,status,net_r,updated_at)
      SELECT ${sqlText(frozen.id)},${sqlText(FORWARD_VERSION)},${sqlText(stock.id)},${sqlText(asOf)},${sqlText(recordedAt)},${sqlText(JSON.stringify(frozen))},${sqlText(JSON.stringify(initial))},'pending',NULL,${sqlText(now)}
      WHERE EXISTS (SELECT 1 FROM forward_test_state WHERE version=${sqlText(FORWARD_VERSION)} AND rules_hash=${sqlText(rulesHash)})
      AND strftime('%Y-%m-%dT%H:%M:%fZ','now')<${sqlText(frozen.sessionDates[0] + 'T03:45:00.000Z')}
      AND NOT EXISTS (SELECT 1 FROM forward_signals WHERE version=${sqlText(FORWARD_VERSION)} AND symbol=${sqlText(stock.id)} AND status!='skipped' AND (status IN ('pending','open','review') OR json_extract(signal_json,'$.sessionDates[19]')>=${sqlText(asOf)}))
      ON CONFLICT(id) DO NOTHING;`);
    captured++;
  }
}
const note = JSON.stringify({
  capture: window.reason,
  missingBenchmark,
  scanned: stocks.length,
  captureAttempts: captured,
  updated,
  blocked,
  ineligible,
  needsData: existing.filter((r) => r.outcome.needsData).length,
});
statements.push(
  `UPDATE forward_test_state SET last_run_at=${sqlText(now)},last_eod=${sqlText(asOf)},note=${sqlText(note)} WHERE version=${sqlText(FORWARD_VERSION)} AND rules_hash=${sqlText(rulesHash)} AND last_run_at<=${sqlText(now)};`,
);
if (write) apply(statements.join('\n'));
const persistedThisRun = write ? query(`SELECT COUNT(*) AS count FROM forward_signals WHERE version=${sqlText(FORWARD_VERSION)} AND recorded_at>=${sqlText(now)}`)[0].count : 0;
console.log(
  JSON.stringify(
    { mode: write ? 'written' : 'dry-run', asOf, now, persistedThisRun, ...JSON.parse(note) },
    null,
    2,
  ),
);
