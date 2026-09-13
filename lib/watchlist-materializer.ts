import { instruments, marketSessions } from '@/db/schema';
import { and, gte, lte, asc, ne, sql } from 'drizzle-orm';
import {
  buildEvidence,
  type Participation,
  type FutureRow,
  type Membership,
  type SectorPrice,
} from './watchlist-evidence';
import {
  cleanCandles,
  evaluateWatchlist,
  type WatchCandle,
  type WatchCandidate,
  type WatchHorizon,
  DEFAULT_WATCHLIST_THRESHOLDS,
} from './position-watchlist';

export interface DataIncompleteCandidate {
  symbol: string;
  name: string;
  reason: string;
  sessions: number;
  requiredSessions: number;
  asOf: string;
  missingDetails: string[];
}

export interface ExcludedCandidate {
  symbol: string;
  name: string;
  reason: string;
  close?: number;
  asOf: string;
}

export interface WatchlistPayload {
  prioritySetups: WatchCandidate[];
  developingSetups: WatchCandidate[];
  dataIncomplete: DataIncompleteCandidate[];
  excluded: ExcludedCandidate[];
  candidates: WatchCandidate[];
  scannedCount: number;
  asOf: string;
  horizon: WatchHorizon;
  generatedAt: string;
  source: string;
  missingInputs: string[];
  validation: string;
  exclusions: Record<string, number>;
  staleFallback?: boolean;
}

interface D1Like {
  prepare: (query: string) => {
    bind: (...args: any[]) => {
      first: <T>() => Promise<T | null>;
      all: <T>() => Promise<{ results: T[] }>;
      run: () => Promise<any>;
    };
  };
}

const groupBySymbol = <T extends { symbol: string }>(items: T[]) => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.symbol) ?? [];
    group.push(item);
    groups.set(item.symbol, group);
  }
  return groups;
};

export async function computeWatchlistPayload(
  db: any,
  d1: D1Like,
  horizon: WatchHorizon,
  asOf: string,
): Promise<WatchlistPayload> {
  const start = new Date(Date.parse(asOf) - 420 * 86400000).toISOString().slice(0, 10);
  const activeCutoff = new Date(Date.parse(asOf) - 14 * 86400000).toISOString().slice(0, 10);

  // Distinguish current active F&O universe from legacy symbols:
  // Active symbols must have recent OI snapshots within 14 calendar days of asOf.
  const [metadata, activeIdsResult, rows, cashResult, futuresResult, memberResult, sectorResult] =
    await Promise.all([
      db.select().from(instruments).where(
        sql`exists (select 1 from oi_snapshots where instrument_id = ${instruments.id})`,
      ),
      d1
        .prepare(
          "SELECT DISTINCT instrument_id FROM oi_snapshots WHERE substr(captured_at,1,10) >= ?",
        )
        .bind(activeCutoff)
        .all<{ instrument_id: string }>(),
      db
        .select({
          symbol: marketSessions.instrumentId,
          date: marketSessions.sessionDate,
          open: marketSessions.open,
          high: marketSessions.high,
          low: marketSessions.low,
          close: marketSessions.close,
          source: marketSessions.source,
        })
        .from(marketSessions)
        .where(
          and(
            gte(marketSessions.sessionDate, start),
            lte(marketSessions.sessionDate, asOf),
            ne(marketSessions.source, 'demo'),
            sql`(${marketSessions.instrumentId} = 'NSE:NIFTY50-INDEX' or exists (select 1 from oi_snapshots where instrument_id = ${marketSessions.instrumentId}))`,
          ),
        )
        .orderBy(asc(marketSessions.sessionDate))
        .limit(100001),
      d1
        .prepare(
          'SELECT * FROM cash_participation c WHERE date BETWEEN ? AND ? AND EXISTS (SELECT 1 FROM oi_snapshots s WHERE s.instrument_id=c.symbol) LIMIT 100001',
        )
        .bind(start, asOf)
        .all<Participation>(),
      d1
        .prepare("SELECT * FROM futures_daily WHERE date BETWEEN date(?, '-10 days') AND ? LIMIT 20001")
        .bind(asOf, asOf)
        .all<FutureRow>(),
      d1
        .prepare(
          'SELECT m.* FROM sector_membership m WHERE m.observed_date = (SELECT MAX(i.observed_date) FROM sector_imports i WHERE i.benchmark=m.benchmark AND i.observed_date<=?)',
        )
        .bind(asOf)
        .all<Membership>(),
      d1
        .prepare('SELECT * FROM sector_prices WHERE date BETWEEN ? AND ? LIMIT 10001')
        .bind(start, asOf)
        .all<SectorPrice>(),
    ]);

  if (
    rows.length > 100000 ||
    cashResult.results.length > 100000 ||
    futuresResult.results.length > 20000 ||
    sectorResult.results.length > 10000
  ) {
    throw new Error('History exceeds the scan limit.');
  }

  const activeUniverse = new Set(activeIdsResult.results.map(r => r.instrument_id));

  const bySymbol = new Map<string, WatchCandle[]>();
  for (const row of rows) {
    const group = bySymbol.get(row.symbol) ?? [];
    group.push(row);
    bySymbol.set(row.symbol, group);
  }
  const benchmark = bySymbol.get('NSE:NIFTY50-INDEX') ?? [];

  const cashBySymbol = groupBySymbol(cashResult.results);
  const futuresBySymbol = groupBySymbol(futuresResult.results);
  const membersBySymbol = groupBySymbol(memberResult.results);

  const prioritySetups: WatchCandidate[] = [];
  const developingSetups: WatchCandidate[] = [];
  const dataIncomplete: DataIncompleteCandidate[] = [];
  const excluded: ExcludedCandidate[] = [];
  const exclusions: Record<string, number> = {};

  const recordExclusion = (symbol: string, name: string, reason: string, close?: number) => {
    exclusions[reason] = (exclusions[reason] ?? 0) + 1;
    excluded.push({ symbol, name, reason, close, asOf });
  };

  const stocks = metadata.filter((m: any) => m.instrumentType === 'stock' && m.id.startsWith('NSE:'));

  for (const stock of stocks) {
    // Validate current F&O universe separately from legacy symbols
    if (activeUniverse.size > 0 && !activeUniverse.has(stock.id)) {
      recordExclusion(stock.id, stock.displayName, 'Legacy or inactive F&O symbol');
      continue;
    }

    const candleHistory = bySymbol.get(stock.id) ?? [];
    const cleaned = cleanCandles(candleHistory, asOf);
    const minSessions =
      horizon === 'short'
        ? DEFAULT_WATCHLIST_THRESHOLDS.shortMinSessions
        : DEFAULT_WATCHLIST_THRESHOLDS.positionalMinSessions;

    if (cleaned.length < minSessions) {
      exclusions[`Needs ${minSessions} valid sessions`] =
        (exclusions[`Needs ${minSessions} valid sessions`] ?? 0) + 1;
      dataIncomplete.push({
        symbol: stock.id,
        name: stock.displayName,
        reason: `Needs ${minSessions} valid sessions (has ${cleaned.length})`,
        sessions: cleaned.length,
        requiredSessions: minSessions,
        asOf,
        missingDetails: [`Insufficient price history: ${cleaned.length}/${minSessions} sessions`],
      });
      continue;
    }

    const latest = cleaned.at(-1)!;
    const firstOffset = horizon === 'short' ? 21 : 64;
    const first = cleaned.length >= firstOffset ? cleaned[cleaned.length - firstOffset] : cleaned[0];

    const evidence = buildEvidence(
      stock.id,
      latest.date,
      first.date,
      first.close,
      latest.close,
      cashBySymbol.get(stock.id) ?? [],
      futuresBySymbol.get(stock.id) ?? [],
      membersBySymbol.get(stock.id) ?? [],
      sectorResult.results,
      benchmark,
    );

    const result = evaluateWatchlist(
      stock.id,
      stock.displayName,
      candleHistory,
      benchmark,
      horizon,
      asOf,
      DEFAULT_WATCHLIST_THRESHOLDS,
      evidence,
    );

    if (result.candidate) {
      if (result.candidate.group === 'priority') {
        prioritySetups.push(result.candidate);
      } else {
        developingSetups.push(result.candidate);
      }
    } else if (result.group === 'data_incomplete') {
      exclusions[result.reason ?? 'Data incomplete'] =
        (exclusions[result.reason ?? 'Data incomplete'] ?? 0) + 1;
      dataIncomplete.push({
        symbol: stock.id,
        name: stock.displayName,
        reason: result.reason ?? 'Data incomplete',
        sessions: cleaned.length,
        requiredSessions: minSessions,
        asOf,
        missingDetails: result.incompleteDetails ?? [result.reason ?? 'Data incomplete'],
      });
    } else if (result.reason) {
      recordExclusion(stock.id, stock.displayName, result.reason, latest.close);
    }
  }

  // Sort: Priority by technical score desc, then symbol asc
  prioritySetups.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  // Sort: Developing by technical score desc, then symbol asc
  developingSetups.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));

  const candidates = [...prioritySetups, ...developingSetups];

  return {
    prioritySetups,
    developingSetups,
    dataIncomplete,
    excluded,
    candidates,
    scannedCount: stocks.length,
    asOf,
    horizon,
    generatedAt: new Date().toISOString(),
    source: 'stored-eod',
    missingInputs: [
      'Fundamentals and valuation are Unassessed. Cash delivery, stock futures and sector coverage are shown per stock.',
    ],
    validation:
      horizon === 'positional'
        ? 'Positional technical research rules. Scores are not win probabilities. Stored history covers up to 183 calendar days and does not validate a 6-month holding strategy.'
        : 'Short-term technical research rules. Breakouts require hold/retest confirmation and positive volume/OI participation.',
    exclusions,
  };
}

export async function materializeOrFetchWatchlist(
  db: any,
  d1: D1Like,
  horizon: WatchHorizon,
  asOf: string,
  forceRefresh = false,
): Promise<WatchlistPayload> {
  // 1. Attempt fast read from watchlist_snapshots table (< 20ms)
  const existing = await d1
    .prepare(
      'SELECT payload_json, as_of, generated_at FROM watchlist_snapshots WHERE horizon = ? ORDER BY as_of DESC LIMIT 1',
    )
    .bind(horizon)
    .first<{ payload_json: string; as_of: string; generated_at: string }>();

  if (!forceRefresh && existing && existing.as_of === asOf) {
    try {
      return JSON.parse(existing.payload_json) as WatchlistPayload;
    } catch {
      // If corrupted, recompute below
    }
  }

  // 2. Compute snapshot
  try {
    const payload = await computeWatchlistPayload(db, d1, horizon, asOf);
    const id = `${horizon}:${asOf}`;
    await d1
      .prepare(`
        INSERT INTO watchlist_snapshots (
          id, horizon, as_of, generated_at, methodology_version,
          scanned_count, priority_count, developing_count, incomplete_count, excluded_count,
          payload_json
        ) VALUES (?, ?, ?, ?, 'v2', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          generated_at = excluded.generated_at,
          scanned_count = excluded.scanned_count,
          priority_count = excluded.priority_count,
          developing_count = excluded.developing_count,
          incomplete_count = excluded.incomplete_count,
          excluded_count = excluded.excluded_count,
          payload_json = excluded.payload_json;
      `)
      .bind(
        id,
        horizon,
        asOf,
        payload.generatedAt,
        payload.scannedCount,
        payload.prioritySetups.length,
        payload.developingSetups.length,
        payload.dataIncomplete.length,
        payload.excluded.length,
        JSON.stringify(payload),
      )
      .run();

    return payload;
  } catch (err) {
    // 3. Stale snapshot fallback on generation failure
    if (existing) {
      try {
        const stale = JSON.parse(existing.payload_json) as WatchlistPayload;
        stale.staleFallback = true;
        console.warn(`Watchlist generation failed; serving stale snapshot from ${existing.as_of}`);
        return stale;
      } catch {
        // Fall through to throw
      }
    }
    throw err;
  }
}
