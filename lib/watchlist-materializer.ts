import { instruments, marketSessions } from '@/db/schema';
import type { getDb } from '@/db';
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
import type { ChainStrike, MarketSnapshot } from './market-types';
import {
  buildWatchOiEvidence,
  applyWatchOiPriorityGuard,
  deriveWatchWallOutcomes,
  unavailableWatchOiEvidence,
  watchOiRank,
  type WatchWallOutcomeRow,
} from './watchlist-oi';
import type { MarketDayStatus } from './nse-market-calendar';
import { evaluateResearchWatchlist } from './research-watchlist';

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
  marketStatus?: MarketDayStatus;
}

interface D1Like {
  prepare: (query: string) => {
    bind: (...args: unknown[]) => {
      first: <T>() => Promise<T | null>;
      all: <T>() => Promise<{ results: T[] }>;
      run: () => Promise<unknown>;
    };
  };
}

const WATCHLIST_METHODOLOGY_VERSION = 'v7-research-comparison';

const groupBySymbol = <T extends { symbol: string }>(items: T[]) => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.symbol) ?? [];
    group.push(item);
    groups.set(item.symbol, group);
  }
  return groups;
};

interface SnapshotRow {
  id: string;
  instrument_id: string;
  captured_at: string;
  expiry: string;
  expiry_epoch: number | null;
  spot: number;
  spot_change_percent: number;
  atr14: number;
  iv_percentile: number;
  source: string;
  display_name: string;
  instrument_type: 'index' | 'stock';
  strike_step: number;
}

interface StrikeRow extends ChainStrike {
  snapshot_id: string;
}

interface OutcomeRow {
  instrument_id: string;
  side: 'support' | 'resistance';
  declared_date: string;
  captured_at: string;
  reached: number | null;
  days_to_reach: number | null;
  held: number | null;
  broke: number | null;
  bounce_points: number | null;
  bounce_atr: number | null;
}

interface HistoricalStrikeRow extends SnapshotRow, ChainStrike {}

const chunks = <T,>(values: T[], size = 60) => {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size));
  return output;
};

async function addOiEvidence(
  d1: D1Like,
  candidates: WatchCandidate[],
  asOf: string,
  pricesBySymbol: Map<string, WatchCandle[]>,
) {
  if (!candidates.length) return;
  const symbols = [...new Set(candidates.map(candidate => candidate.symbol))];
  const snapshots: SnapshotRow[] = [];

  for (const batch of chunks(symbols)) {
    const placeholders = batch.map(() => '?').join(',');
    const result = await d1.prepare(`
      SELECT s.id, s.instrument_id, s.captured_at, s.expiry, s.expiry_epoch,
             s.spot, s.spot_change_percent, s.atr14, s.iv_percentile, s.source,
             i.display_name, i.instrument_type, i.strike_step
      FROM oi_snapshots s
      JOIN instruments i ON i.id=s.instrument_id
      WHERE s.instrument_id IN (${placeholders})
        AND substr(s.captured_at,1,10)<=?
        AND NOT EXISTS (
          SELECT 1 FROM oi_snapshots newer
          WHERE newer.instrument_id=s.instrument_id
            AND substr(newer.captured_at,1,10)<=?
            AND newer.captured_at>s.captured_at
        )
    `).bind(...batch, asOf, asOf).all<SnapshotRow>();
    snapshots.push(...result.results);
  }

  const strikes: StrikeRow[] = [];
  for (const batch of chunks(snapshots.map(snapshot => snapshot.id))) {
    const placeholders = batch.map(() => '?').join(',');
    const result = await d1.prepare(`
      SELECT snapshot_id, strike,
             call_oi AS callOi, call_oi_change AS callOiChange, call_volume AS callVolume, call_iv AS callIv,
             put_oi AS putOi, put_oi_change AS putOiChange, put_volume AS putVolume, put_iv AS putIv
      FROM oi_strikes WHERE snapshot_id IN (${placeholders}) ORDER BY snapshot_id, strike
    `).bind(...batch).all<StrikeRow>();
    strikes.push(...result.results);
  }

  const historyStart = new Date(Date.parse(asOf) - 183 * 86_400_000).toISOString().slice(0, 10);
  const outcomeRows: OutcomeRow[] = [];
  for (const batch of chunks(symbols)) {
    const placeholders = batch.map(() => '?').join(',');
    const result = await d1.prepare(`
      SELECT wp.instrument_id, wp.side, wp.declared_date, s.captured_at,
             wp.reached, wp.days_to_reach, wp.held, wp.broke, wp.bounce_points, wp.bounce_atr
      FROM wall_predictions wp
      JOIN oi_snapshots s ON s.id=wp.snapshot_id
      WHERE wp.instrument_id IN (${placeholders})
        AND wp.declared_date>=? AND wp.declared_date<?
        AND wp.evaluated_at IS NOT NULL AND wp.evaluation_version=2
      ORDER BY wp.instrument_id, wp.declared_date, s.captured_at
    `).bind(...batch, historyStart, asOf).all<OutcomeRow>();
    outcomeRows.push(...result.results);
  }

  const strikesBySnapshot = new Map<string, ChainStrike[]>();
  for (const row of strikes) {
    const chain = strikesBySnapshot.get(row.snapshot_id) ?? [];
    chain.push({
      strike: row.strike,
      callOi: row.callOi,
      callOiChange: row.callOiChange,
      callVolume: row.callVolume,
      callIv: row.callIv ?? undefined,
      putOi: row.putOi,
      putOiChange: row.putOiChange,
      putVolume: row.putVolume,
      putIv: row.putIv ?? undefined,
    });
    strikesBySnapshot.set(row.snapshot_id, chain);
  }

  const snapshotBySymbol = new Map<string, MarketSnapshot>();
  for (const row of snapshots) {
    const chain = strikesBySnapshot.get(row.id) ?? [];
    if (!chain.length) continue;
    snapshotBySymbol.set(row.instrument_id, {
      symbol: row.instrument_id,
      displayName: row.display_name,
      instrumentType: row.instrument_type,
      spot: row.spot,
      spotChangePercent: row.spot_change_percent,
      expiry: row.expiry,
      expiryEpoch: row.expiry_epoch ?? undefined,
      strikeStep: row.strike_step,
      atr14: row.atr14,
      ivPercentile: row.iv_percentile,
      asOf: row.captured_at,
      source: row.source as MarketSnapshot['source'],
      chain,
    });
  }

  const outcomesBySymbol = new Map<string, WatchWallOutcomeRow[]>();
  for (const row of outcomeRows) {
    const values = outcomesBySymbol.get(row.instrument_id) ?? [];
    values.push({
      side: row.side,
      declaredDate: row.declared_date,
      capturedAt: row.captured_at,
      reached: row.reached === null ? null : row.reached === 1,
      daysToReach: row.days_to_reach,
      held: row.held === null ? null : row.held === 1,
      broke: row.broke === null ? null : row.broke === 1,
      bouncePoints: row.bounce_points,
      bounceAtr: row.bounce_atr,
    });
    outcomesBySymbol.set(row.instrument_id, values);
  }

  // Most archive snapshots pre-date wall_predictions. Derive completed outcomes
  // from one saved OI declaration per week so overlapping 10-session windows
  // are not treated as independent tests. This runs only during once-per-EOD
  // watchlist materialization; stored outcomes remain a fallback.
  for (const batch of chunks(symbols, 4)) {
    const placeholders = batch.map(() => '?').join(',');
    const result = await d1.prepare(`
      WITH weekly AS (
        SELECT instrument_id, strftime('%Y-%W', captured_at) AS week_key, MAX(captured_at) AS captured_at
        FROM oi_snapshots
        WHERE instrument_id IN (${placeholders})
          AND substr(captured_at,1,10)>=? AND substr(captured_at,1,10)<?
        GROUP BY instrument_id, week_key
      )
      SELECT s.id, s.instrument_id, s.captured_at, s.expiry, s.expiry_epoch,
             s.spot, s.spot_change_percent, s.atr14, s.iv_percentile, s.source,
             i.display_name, i.instrument_type, i.strike_step,
             os.strike,
             os.call_oi AS callOi, os.call_oi_change AS callOiChange,
             os.call_volume AS callVolume, os.call_iv AS callIv,
             os.put_oi AS putOi, os.put_oi_change AS putOiChange,
             os.put_volume AS putVolume, os.put_iv AS putIv
      FROM weekly w
      JOIN oi_snapshots s ON s.instrument_id=w.instrument_id AND s.captured_at=w.captured_at
      JOIN instruments i ON i.id=s.instrument_id
      JOIN oi_strikes os ON os.snapshot_id=s.id
      ORDER BY s.instrument_id, s.captured_at, os.strike
    `).bind(...batch, historyStart, asOf).all<HistoricalStrikeRow>();

    const historicalSnapshots = new Map<string, MarketSnapshot>();
    for (const row of result.results) {
      let historical = historicalSnapshots.get(row.id);
      if (!historical) {
        historical = {
          symbol: row.instrument_id,
          displayName: row.display_name,
          instrumentType: row.instrument_type,
          spot: row.spot,
          spotChangePercent: row.spot_change_percent,
          expiry: row.expiry,
          expiryEpoch: row.expiry_epoch ?? undefined,
          strikeStep: row.strike_step,
          atr14: row.atr14,
          ivPercentile: row.iv_percentile,
          asOf: row.captured_at,
          source: row.source as MarketSnapshot['source'],
          chain: [],
        };
        historicalSnapshots.set(row.id, historical);
      }
      historical.chain.push({
        strike: row.strike,
        callOi: row.callOi,
        callOiChange: row.callOiChange,
        callVolume: row.callVolume,
        callIv: row.callIv ?? undefined,
        putOi: row.putOi,
        putOiChange: row.putOiChange,
        putVolume: row.putVolume,
        putIv: row.putIv ?? undefined,
      });
    }

    for (const symbol of batch) {
      const snapshotsForSymbol = [...historicalSnapshots.values()].filter(snapshot => snapshot.symbol === symbol);
      const derived = deriveWatchWallOutcomes(
        snapshotsForSymbol,
        pricesBySymbol.get(symbol) ?? [],
        asOf,
      );
      if (derived.length) outcomesBySymbol.set(symbol, derived);
    }
  }

  for (const candidate of candidates) {
    const snapshot = snapshotBySymbol.get(candidate.symbol);
    candidate.oiEvidence = snapshot
      ? buildWatchOiEvidence(candidate, snapshot, outcomesBySymbol.get(candidate.symbol) ?? [], asOf, pricesBySymbol.get(candidate.symbol) ?? [])
      : unavailableWatchOiEvidence();
  }
}

export async function computeWatchlistPayload(
  db: ReturnType<typeof getDb>,
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

  const stocks = metadata.filter(m => m.instrumentType === 'stock' && m.id.startsWith('NSE:'));

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

    const result = horizon === 'short' ? evaluateResearchWatchlist(
      stock.id, stock.displayName, candleHistory, benchmark, asOf, evidence,
    ) : evaluateWatchlist(
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

  const allSetups = [...prioritySetups, ...developingSetups];
  try {
    await addOiEvidence(d1, allSetups, asOf, bySymbol);
  } catch (error) {
    console.warn('OI watchlist enrichment unavailable', error);
    for (const candidate of allSetups) {
      candidate.oiEvidence = unavailableWatchOiEvidence('OI evidence could not be read; the price setup remains available.');
    }
  }

  for (const candidate of allSetups) {
    // The compared strategy did not use this extra filter; OI stays visible as context.
    if (!candidate.strategy) applyWatchOiPriorityGuard(candidate);
  }
  prioritySetups.splice(0, prioritySetups.length, ...allSetups.filter(candidate => candidate.group === 'priority'));
  developingSetups.splice(0, developingSetups.length, ...allSetups.filter(candidate => candidate.group === 'developing'));

  const compare = (a: WatchCandidate, b: WatchCandidate) => horizon === 'short'
    ? (b.relativeStrength ?? -Infinity) - (a.relativeStrength ?? -Infinity) || a.symbol.localeCompare(b.symbol)
    :
    watchOiRank(b.oiEvidence?.classification ?? 'Price only') -
      watchOiRank(a.oiEvidence?.classification ?? 'Price only') ||
    (b.oiEvidence?.confirmations.length ?? 0) - (a.oiEvidence?.confirmations.length ?? 0) ||
    b.score - a.score ||
    a.symbol.localeCompare(b.symbol);
  prioritySetups.sort(compare);
  developingSetups.sort(compare);

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
      'Fundamentals and valuation are Unassessed. OI, cash delivery, stock futures and sector coverage are shown per stock.',
    ],
    validation:
      horizon === 'positional'
        ? 'Positional technical research rules. Scores are not win probabilities. Stored history covers up to 183 calendar days and does not validate a 6-month holding strategy.'
        : 'Research only: no dependable winner in the 219-stock comparison through 2026-09-11. Trend won the earlier period but failed the later test. No short-term priority recommendations. OI is context, not a tested extra filter. Ranking by relative strength is descriptive, not a tested portfolio.',
    exclusions,
  };
}

export async function materializeOrFetchWatchlist(
  db: ReturnType<typeof getDb>,
  d1: D1Like,
  horizon: WatchHorizon,
  asOf: string,
  forceRefresh = false,
): Promise<WatchlistPayload> {
  // 1. Attempt fast read from watchlist_snapshots table (< 20ms)
  const existing = await d1
    .prepare(
      'SELECT payload_json, as_of, generated_at, methodology_version FROM watchlist_snapshots WHERE horizon = ? ORDER BY as_of DESC LIMIT 1',
    )
    .bind(horizon)
    .first<{ payload_json: string; as_of: string; generated_at: string; methodology_version: string }>();

  if (!forceRefresh && existing && existing.as_of === asOf && existing.methodology_version === WATCHLIST_METHODOLOGY_VERSION) {
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          generated_at = excluded.generated_at,
          methodology_version = excluded.methodology_version,
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
        WATCHLIST_METHODOLOGY_VERSION,
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
    if (existing && existing.methodology_version === WATCHLIST_METHODOLOGY_VERSION) {
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
