import { env } from 'cloudflare:workers';
import { and, asc, desc, eq, gte, inArray, isNull, lte, lt, or, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { instruments, levelOutcomes, marketSessions, oiSnapshots, oiStrikes, wallPredictions } from '@/db/schema';
import type { HistoricalLevelObservation, LevelFeatures, LevelSide, MarketSnapshot, OiHistoryContext, OiHistorySnapshot, PriceSession } from './market-types';
import type { MarketDataProvider } from './providers/types';
import { HORIZON_SESSIONS, declarePrimaryWalls, evaluateFromHistory, aggregateWallStats, analyzeFeatureThresholds, tradingSessionsUntilExpiry } from './wall-backtest';
import type { WallStats, FeatureThresholds } from './wall-backtest';

const DAY = 86_400_000;

const REFRESH_OVERLAP_DAYS = 5;
const SNAPSHOT_BUCKET_MINUTES = 15;
// D1 has a conservative bound-parameter ceiling. A strike row can bind up to
// eleven values, so small chunks keep every insert safely below that limit.
const STRIKE_INSERT_CHUNK = 8;
// Minimum calendar days after declaration before we attempt to evaluate an outcome.
// 10 trading sessions ≈ 14 calendar days.
const OI_CONTEXT_DAYS = 21;
const OI_CONTEXT_MAX_SNAPSHOTS = 240;
// Version 2 recalculates legacy outcomes from each instrument's own sessions.
// Some imported stock rows were evaluated against a different price scale.
export const WALL_EVALUATION_VERSION = 2;
const WALL_EVALUATION_BATCH_LIMIT = 300;

export interface OiCoverage {
  snapshots: number;
  firstSnapshot: string | null;
  latestSnapshot: string | null;
}

function dateOffset(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

function latestDailyPredictions<T extends { declaredDate: string; side: LevelSide; capturedAt: string }>(rows: T[]) {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.declaredDate}:${row.side}`;
    const current = latest.get(key);
    if (!current || row.capturedAt > current.capturedAt) latest.set(key, row);
  }
  return [...latest.values()];
}

function predictionHorizon(snapshot: MarketSnapshot) {
  return tradingSessionsUntilExpiry(snapshot.asOf, snapshot.expiryEpoch, HORIZON_SESSIONS);
}

async function ensureInstrument(snapshot: MarketSnapshot) {
  const db = getDb();
  const instrumentId = snapshot.symbol;
  await db.insert(instruments).values({ id: instrumentId, symbol: snapshot.symbol, displayName: snapshot.displayName, instrumentType: snapshot.instrumentType, strikeStep: snapshot.strikeStep, updatedAt: snapshot.asOf })
    .onConflictDoUpdate({ target: instruments.id, set: { displayName: snapshot.displayName, instrumentType: snapshot.instrumentType, strikeStep: snapshot.strikeStep, updatedAt: snapshot.asOf } });
}

/**
 * Persist a live OI snapshot and its strikes.
 * Returns the snapshotId string if stored, false if skipped (demo source).
 */
export async function persistSnapshot(snapshot: MarketSnapshot): Promise<string | false> {
  if (snapshot.source === 'demo') return false;
  await ensureInstrument(snapshot);
  const db = getDb();
  const instrumentId = snapshot.symbol;
  const captured = new Date(snapshot.asOf);
  captured.setUTCMinutes(Math.floor(captured.getUTCMinutes() / SNAPSHOT_BUCKET_MINUTES) * SNAPSHOT_BUCKET_MINUTES, 0, 0);
  const bucket = captured.toISOString();
  const snapshotId = `${snapshot.symbol}:${snapshot.expiryEpoch ?? snapshot.expiry}:${bucket}`;
  await db.insert(oiSnapshots).values({ id: snapshotId, instrumentId, capturedAt: snapshot.asOf, expiry: snapshot.expiry, expiryEpoch: snapshot.expiryEpoch, spot: snapshot.spot, spotChangePercent: snapshot.spotChangePercent, atr14: snapshot.atr14, ivPercentile: snapshot.ivPercentile, source: snapshot.source }).onConflictDoNothing();
  const values = snapshot.chain.map((row) => ({ id: `${snapshotId}:${row.strike}`, snapshotId, ...row }));
  for (let index = 0; index < values.length; index += STRIKE_INSERT_CHUNK) {
    await db.insert(oiStrikes).values(values.slice(index, index + STRIKE_INSERT_CHUNK)).onConflictDoNothing();
  }
  return snapshotId;
}

/**
 * Loads only snapshots captured before the current request and only for the
 * selected expiry.  This prevents a weekly-expiry rollover from being mistaken
 * for persistent OI and gives the intraday model genuine saved OI deltas.
 */
export async function loadOiHistoryContext(snapshot: MarketSnapshot): Promise<OiHistoryContext> {
  const empty: OiHistoryContext = { intraday: [], positional: [] };
  if (snapshot.source === 'demo') return empty;

  const db = getDb();
  const asOf = snapshot.asOf;
  const start = `${dateOffset(asOf.slice(0, 10), -OI_CONTEXT_DAYS)}T00:00:00.000Z`;
  const sessionStart = `${asOf.slice(0, 10)}T00:00:00.000Z`;
  const expiryCondition = snapshot.expiryEpoch !== undefined
    ? eq(oiSnapshots.expiryEpoch, snapshot.expiryEpoch)
    : eq(oiSnapshots.expiry, snapshot.expiry);
  const snapshotRows = await db
    .select({ id: oiSnapshots.id, capturedAt: oiSnapshots.capturedAt, spot: oiSnapshots.spot })
    .from(oiSnapshots)
    .where(and(
      eq(oiSnapshots.instrumentId, snapshot.symbol),
      expiryCondition,
      gte(oiSnapshots.capturedAt, start),
      lt(oiSnapshots.capturedAt, asOf),
    ))
    .orderBy(desc(oiSnapshots.capturedAt))
    .limit(OI_CONTEXT_MAX_SNAPSHOTS);
  if (!snapshotRows.length) return empty;

  // Query the strike rows in one batch rather than issuing one request per
  // snapshot.  The capped snapshot count keeps this well inside D1 limits.
  const ids = snapshotRows.map((row) => row.id);
  const strikeRows = await db.select().from(oiStrikes).where(inArray(oiStrikes.snapshotId, ids));
  const bySnapshot = new Map<string, OiHistorySnapshot>(
    snapshotRows.map((row) => [row.id, { capturedAt: row.capturedAt, spot: row.spot, chain: [] }]),
  );
  for (const row of strikeRows) {
    bySnapshot.get(row.snapshotId)?.chain.push({
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

  const positional = snapshotRows
    .reverse()
    .flatMap((row) => {
      const item = bySnapshot.get(row.id);
      return item?.chain.length ? [item] : [];
    });
  return {
    intraday: positional.filter((item) => item.capturedAt >= sessionStart),
    positional,
  };
}

/** Return saved OI coverage for one instrument, used to decide whether a
 * historical wall backfill is possible and to explain empty UI states. */
export async function loadOiCoverage(symbol: string): Promise<OiCoverage> {
  const rows = await getDb()
    .select({
      snapshots: sql<number>`count(*)`,
      firstSnapshot: sql<string | null>`min(${oiSnapshots.capturedAt})`,
      latestSnapshot: sql<string | null>`max(${oiSnapshots.capturedAt})`,
    })
    .from(oiSnapshots)
    .where(eq(oiSnapshots.instrumentId, symbol));
  const row = rows[0];
  return {
    snapshots: Number(row?.snapshots ?? 0),
    firstSnapshot: row?.firstSnapshot ?? null,
    latestSnapshot: row?.latestSnapshot ?? null,
  };
}

/** Load the latest archived OI chain for a symbol when a live broker session is
 * unavailable. This keeps stock identity and price scale intact instead of
 * substituting a demo index snapshot. */
export async function loadLatestStoredSnapshot(
  symbol: string,
  expiryEpoch?: number,
): Promise<MarketSnapshot | null> {
  const db = getDb();
  const snapshotRows = expiryEpoch !== undefined
    ? await db.select().from(oiSnapshots)
        .where(and(eq(oiSnapshots.instrumentId, symbol), eq(oiSnapshots.expiryEpoch, expiryEpoch)))
        .orderBy(desc(oiSnapshots.capturedAt)).limit(1)
    : await db.select().from(oiSnapshots)
        .where(eq(oiSnapshots.instrumentId, symbol))
        .orderBy(desc(oiSnapshots.capturedAt)).limit(1);
  const snapshot = snapshotRows[0];
  if (!snapshot) return null;

  const [metadata, strikes] = await Promise.all([
    db.select().from(instruments).where(eq(instruments.id, symbol)).limit(1),
    db.select().from(oiStrikes).where(eq(oiStrikes.snapshotId, snapshot.id)),
  ]);
  if (!strikes.length) return null;
  const instrument = metadata[0];
  return {
    symbol,
    displayName: instrument?.displayName ?? symbol.replace(/^NSE:|-(EQ|INDEX)$/g, ''),
    instrumentType: instrument?.instrumentType ?? (symbol.endsWith('-INDEX') ? 'index' : 'stock'),
    spot: snapshot.spot,
    spotChangePercent: snapshot.spotChangePercent,
    expiry: snapshot.expiry,
    expiryEpoch: snapshot.expiryEpoch ?? undefined,
    strikeStep: instrument?.strikeStep ?? 50,
    atr14: snapshot.atr14,
    ivPercentile: snapshot.ivPercentile,
    asOf: snapshot.capturedAt,
    source: snapshot.source === 'fyers' ? 'fyers' : 'nse-bhavcopy',
    chain: strikes.map((row) => ({
      strike: row.strike,
      callOi: row.callOi,
      callOiChange: row.callOiChange,
      callVolume: row.callVolume,
      callIv: row.callIv ?? undefined,
      putOi: row.putOi,
      putOiChange: row.putOiChange,
      putVolume: row.putVolume,
      putIv: row.putIv ?? undefined,
    })),
  };
}

async function upsertSessions(symbol: string, sessions: PriceSession[]) {
  if (!sessions.length) return;
  const statements = sessions.map((session) => env.DB.prepare(`
    INSERT INTO market_sessions (id, instrument_id, session_date, open, high, low, close, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'fyers')
    ON CONFLICT(instrument_id, session_date) DO UPDATE SET
      open = excluded.open, high = excluded.high, low = excluded.low,
      close = excluded.close, source = excluded.source
  `).bind(`${symbol}:${session.date}`, symbol, session.date, session.open ?? session.close, session.high, session.low, session.close));
  for (let index = 0; index < statements.length; index += 50) {
    await env.DB.batch(statements.slice(index, index + 50));
  }
}

export interface HistoryCacheResult {
  history: PriceSession[];
  source: 'backfilled' | 'incremental' | 'cache';
  latestSession: string | null;
}

/** Load only same-instrument sessions already stored in D1. Historical wall
 * repair must never substitute demo/index-shaped prices for a stock. */
export async function loadCachedPriceHistory(
  symbol: string,
  asOf: string,
): Promise<HistoryCacheResult | null> {
  const end = asOf.slice(0, 10);
  const start = dateOffset(end, -183);
  const rows = await getDb().select().from(marketSessions)
    .where(and(
      eq(marketSessions.instrumentId, symbol),
      gte(marketSessions.sessionDate, start),
      lte(marketSessions.sessionDate, end),
    ))
    .orderBy(asc(marketSessions.sessionDate));
  if (rows.length < 20) return null;
  const history = rows.map((row) => ({
    date: row.sessionDate,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
  }));
  return { history, source: 'cache', latestSession: history.at(-1)?.date ?? null };
}

export async function loadOrRefreshPriceHistory(
  provider: MarketDataProvider,
  snapshot: MarketSnapshot,
): Promise<HistoryCacheResult> {
  if (snapshot.source === 'demo') {
    const end = snapshot.asOf.slice(0, 10);
    const history = await provider.fetchPriceHistory(snapshot.symbol, dateOffset(end, -183), end);
    return { history, source: 'cache', latestSession: history.at(-1)?.date ?? null };
  }

  await ensureInstrument(snapshot);
  const end = snapshot.asOf.slice(0, 10);
  const start = dateOffset(end, -183);
  const db = getDb();
  const existing = await db.select().from(marketSessions)
    .where(and(eq(marketSessions.instrumentId, snapshot.symbol), gte(marketSessions.sessionDate, start), lte(marketSessions.sessionDate, end)))
    .orderBy(asc(marketSessions.sessionDate));
  const latest = existing.at(-1)?.sessionDate;
  const fetchFrom = existing.length < 20 ? start : dateOffset(latest!, -REFRESH_OVERLAP_DAYS);
  const fetched = await provider.fetchPriceHistory(snapshot.symbol, fetchFrom, end);
  await upsertSessions(snapshot.symbol, fetched);
  const rows = await db.select().from(marketSessions)
    .where(and(eq(marketSessions.instrumentId, snapshot.symbol), gte(marketSessions.sessionDate, start), lte(marketSessions.sessionDate, end)))
    .orderBy(asc(marketSessions.sessionDate));
  const history = rows.map((row) => ({ date: row.sessionDate, open: row.open, high: row.high, low: row.low, close: row.close }));
  if (history.length < 20) throw new Error('FYERS returned too few daily sessions for six-month analysis.');
  return {
    history,
    source: existing.length < 20 ? 'backfilled' : fetched.length ? 'incremental' : 'cache',
    latestSession: history.at(-1)?.date ?? null,
  };
}

export async function loadHistoricalObservations(symbol: string, asOf: string) {
  const end = new Date(asOf).toISOString().slice(0, 10);
  const start = new Date(Date.parse(asOf) - 183 * DAY).toISOString().slice(0, 10);
  const rows = await getDb().select().from(levelOutcomes).where(and(eq(levelOutcomes.instrumentId, symbol), eq(levelOutcomes.tested, true), gte(levelOutcomes.sessionDate, start), lt(levelOutcomes.sessionDate, end)));
  return rows.flatMap<HistoricalLevelObservation>((row) => {
    try {
      return [{ instrument: symbol, sessionDate: row.sessionDate, side: row.side, strike: row.strike, tested: row.tested, held: row.held, features: JSON.parse(row.featuresJson) as LevelFeatures }];
    } catch { return []; }
  });
}

// ─── Wall prediction persistence ──────────────────────────────────────────────

/**
 * Declare and persist the strongest support and resistance wall for a snapshot.
 * Idempotent — unique index on (snapshot_id, side) prevents duplicate rows.
 *
 * @param snapshot    The live market snapshot (chain + spot).
 * @param snapshotId  The ID returned by persistSnapshot.
 */
export async function persistWallPredictions(snapshot: MarketSnapshot, snapshotId: string) {
  if (snapshot.source === 'demo') return;
  const walls = declarePrimaryWalls(snapshot, snapshotId);
  const horizonSessions = predictionHorizon(snapshot);
  if (horizonSessions < 1) return;
  const db = getDb();
  const insertions = [];

  for (const side of ['support', 'resistance'] as const) {
    const wall = walls[side];
    if (!wall) continue;
    const id = `${snapshot.symbol}:${snapshot.expiryEpoch ?? snapshot.expiry}:${wall.declaredDate}:${side}`;
    const values = {
      id,
      instrumentId: snapshot.symbol,
      snapshotId,
      declaredDate: wall.declaredDate,
      side,
      strike: wall.strike,
      spotAtDeclaration: wall.spot,
      oiAtDeclaration: wall.oi,
      oiChangeAtDeclaration: wall.oiChange,
      clusterScore: wall.clusterScore,
      atr14AtDeclaration: wall.atr14,
      horizonSessions,
    };
    insertions.push(
      db.insert(wallPredictions).values(values).onConflictDoUpdate({
        target: wallPredictions.id,
        set: {
          snapshotId: values.snapshotId,
          strike: values.strike,
          spotAtDeclaration: values.spotAtDeclaration,
          oiAtDeclaration: values.oiAtDeclaration,
          oiChangeAtDeclaration: values.oiChangeAtDeclaration,
          clusterScore: values.clusterScore,
          atr14AtDeclaration: values.atr14AtDeclaration,
          horizonSessions: values.horizonSessions,
        },
      }),
    );
  }

  await Promise.all(insertions);
}

// ─── Backfill evaluation ──────────────────────────────────────────────────────

/**
 * For every unevaluated or stale-version wall prediction that is old enough to
 * have sufficient future candles in priceHistory, compute and write the outcome.
 *
 * Processes a bounded number of rows and batches writes in D1-safe chunks.
 * Safe to call on every request — idempotent for already-evaluated rows.
 *
 * @param symbol        Instrument symbol.
 * @param priceHistory  All daily sessions already loaded into memory (6 months).
 */
export async function evaluatePendingWalls(symbol: string, priceHistory: PriceSession[]) {
  const db = getDb();
  const today = priceHistory.at(-1)?.date;
  if (!today) return;

  const pending = await db
    .select()
    .from(wallPredictions)
    .where(
      and(
        eq(wallPredictions.instrumentId, symbol),
        or(
          isNull(wallPredictions.evaluatedAt),
          lt(wallPredictions.evaluationVersion, WALL_EVALUATION_VERSION),
        ),
        lt(wallPredictions.declaredDate, today),
      ),
    )
    .orderBy(asc(wallPredictions.declaredDate))
    .limit(WALL_EVALUATION_BATCH_LIMIT);

  if (!pending.length) return;

  const now = new Date().toISOString();

  const updates = [];
  for (const row of pending) {
    const outcome = evaluateFromHistory(
      priceHistory,
      row.declaredDate,
      row.strike,
      row.side,
      row.atr14AtDeclaration,
      row.horizonSessions,
    );
    if (!outcome) continue; // not enough future sessions yet; skip

    updates.push(env.DB.prepare(`
      UPDATE wall_predictions SET
        evaluated_at = ?, evaluation_version = ?, reached = ?, days_to_reach = ?,
        held = ?, bounce_points = ?, bounce_atr = ?, broke = ?
      WHERE id = ?
    `).bind(
      now,
      WALL_EVALUATION_VERSION,
      outcome.reached ? 1 : 0,
      outcome.daysToReach,
      outcome.held ? 1 : 0,
      outcome.bouncePoints,
      outcome.bounceAtr,
      outcome.broke ? 1 : 0,
      row.id,
    ));
  }

  for (let index = 0; index < updates.length; index += 50) {
    await env.DB.batch(updates.slice(index, index + 50));
  }
}

// ─── Load aggregated stats for UI ─────────────────────────────────────────────

export interface WallStatsResult {
  support: WallStats;
  resistance: WallStats;
}

/**
 * Load evaluated wall predictions for an instrument from the last `lookbackDays`
 * calendar days and return aggregated statistics per side for display in the UI.
 *
 * @param symbol        Instrument symbol.
 * @param lookbackDays  How far back to aggregate (default 183 = 6 months).
 */
export async function loadWallStats(symbol: string, lookbackDays = 183): Promise<WallStatsResult> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const startDate = dateOffset(today, -lookbackDays);

  const rows = await db
    .select({
      declaredDate: wallPredictions.declaredDate,
      side: wallPredictions.side,
      capturedAt: oiSnapshots.capturedAt,
      reached: wallPredictions.reached,
      daysToReach: wallPredictions.daysToReach,
      held: wallPredictions.held,
      broke: wallPredictions.broke,
      bouncePoints: wallPredictions.bouncePoints,
      bounceAtr: wallPredictions.bounceAtr,
    })
    .from(wallPredictions)
    .innerJoin(oiSnapshots, eq(wallPredictions.snapshotId, oiSnapshots.id))
    .where(
      and(
        eq(wallPredictions.instrumentId, symbol),
        gte(wallPredictions.declaredDate, startDate),
        sql`${wallPredictions.evaluatedAt} IS NOT NULL`,
        eq(wallPredictions.evaluationVersion, WALL_EVALUATION_VERSION),
      ),
    );

  const dailyRows = latestDailyPredictions(rows);
  const supportRows = dailyRows.filter((r) => r.side === 'support');
  const resistanceRows = dailyRows.filter((r) => r.side === 'resistance');

  return {
    support: aggregateWallStats(supportRows),
    resistance: aggregateWallStats(resistanceRows),
  };
}

/**
 * Load evaluated wall predictions as training observations for model calibration.
 */
export async function loadWallTrainingObservations(
  symbol: string,
  lookbackDays = 183,
): Promise<HistoricalLevelObservation[]> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const startDate = dateOffset(today, -lookbackDays);

  const rows = await db
    .select({
      declaredDate: wallPredictions.declaredDate,
      side: wallPredictions.side,
      capturedAt: oiSnapshots.capturedAt,
      reached: wallPredictions.reached,
      held: wallPredictions.held,
      oiChangeAtDeclaration: wallPredictions.oiChangeAtDeclaration,
      oiAtDeclaration: wallPredictions.oiAtDeclaration,
      spotAtDeclaration: wallPredictions.spotAtDeclaration,
      strike: wallPredictions.strike,
      atr14AtDeclaration: wallPredictions.atr14AtDeclaration,
      clusterScore: wallPredictions.clusterScore,
      callVolume: oiStrikes.callVolume,
      putVolume: oiStrikes.putVolume,
    })
    .from(wallPredictions)
    .innerJoin(oiSnapshots, eq(wallPredictions.snapshotId, oiSnapshots.id))
    .innerJoin(
      oiStrikes,
      and(
        eq(oiStrikes.snapshotId, wallPredictions.snapshotId),
        eq(oiStrikes.strike, wallPredictions.strike),
      ),
    )
    .where(
      and(
        eq(wallPredictions.instrumentId, symbol),
        gte(wallPredictions.declaredDate, startDate),
        sql`${wallPredictions.evaluatedAt} IS NOT NULL`,
        eq(wallPredictions.evaluationVersion, WALL_EVALUATION_VERSION),
      ),
    );

  return latestDailyPredictions(rows).flatMap<HistoricalLevelObservation>((row) => {
    if (row.reached !== true || row.held === null) return [];

    const oiChangeNormalized = Math.tanh(row.oiChangeAtDeclaration / Math.max(1, row.oiAtDeclaration * 0.2));
    const proximity = Math.exp(-Math.abs(row.spotAtDeclaration - row.strike) / Math.max(row.atr14AtDeclaration, 100));
    const optionVolume = row.side === 'support' ? row.putVolume : row.callVolume;
    const volumeConfirmation = Math.min(
      1,
      Math.max(0, Math.log1p(optionVolume) / Math.max(1, Math.log1p(row.oiAtDeclaration * 2))),
    );

    const features: LevelFeatures = {
      clusterOi: Math.min(1, Math.max(0, row.clusterScore)),
      oiChange: Math.min(1, Math.max(-1, oiChangeNormalized)),
      volumeConfirmation,
      proximity: Math.min(1, Math.max(0, proximity)),
      persistence: 0.5,
      regimeFit: 0.6,
    };

    return [
      {
        instrument: symbol,
        sessionDate: row.declaredDate,
        side: row.side as LevelSide,
        strike: row.strike,
        tested: true,
        held: Boolean(row.held),
        features,
      },
    ];
  });
}

/**
 * Load empirical feature thresholds breakdown (hold rates by fresh OI vs unwinding, cluster thickness).
 */
export async function loadFeatureThresholds(
  symbol: string,
  lookbackDays = 183,
): Promise<FeatureThresholds> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const startDate = dateOffset(today, -lookbackDays);

  const rows = await db
    .select({
      declaredDate: wallPredictions.declaredDate,
      side: wallPredictions.side,
      capturedAt: oiSnapshots.capturedAt,
      oiChangeAtDeclaration: wallPredictions.oiChangeAtDeclaration,
      clusterScore: wallPredictions.clusterScore,
      reached: wallPredictions.reached,
      held: wallPredictions.held,
    })
    .from(wallPredictions)
    .innerJoin(oiSnapshots, eq(wallPredictions.snapshotId, oiSnapshots.id))
    .where(
      and(
        eq(wallPredictions.instrumentId, symbol),
        gte(wallPredictions.declaredDate, startDate),
        sql`${wallPredictions.evaluatedAt} IS NOT NULL`,
        eq(wallPredictions.evaluationVersion, WALL_EVALUATION_VERSION),
      ),
    );

  return analyzeFeatureThresholds(latestDailyPredictions(rows));
}
// ─── Quarterly walk-forward validation ────────────────────────────────────────

export interface QuarterStats {
  /** e.g. "Q2 2026" */
  label: string;
  support: WallStats;
  resistance: WallStats;
}

/**
 * Groups evaluated wall predictions into calendar quarters and returns
 * aggregated stats per quarter, ordered oldest first.
 * Used for walk-forward validation — each quarter is an independent out-of-sample window.
 */
export async function loadWallStatsByQuarter(symbol: string): Promise<QuarterStats[]> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const startDate = dateOffset(today, -183);

  const rows = await db
    .select({
      declaredDate: wallPredictions.declaredDate,
      side: wallPredictions.side,
      capturedAt: oiSnapshots.capturedAt,
      reached: wallPredictions.reached,
      daysToReach: wallPredictions.daysToReach,
      held: wallPredictions.held,
      broke: wallPredictions.broke,
      bouncePoints: wallPredictions.bouncePoints,
      bounceAtr: wallPredictions.bounceAtr,
    })
    .from(wallPredictions)
    .innerJoin(oiSnapshots, eq(wallPredictions.snapshotId, oiSnapshots.id))
    .where(
      and(
        eq(wallPredictions.instrumentId, symbol),
        gte(wallPredictions.declaredDate, startDate),
        sql`${wallPredictions.evaluatedAt} IS NOT NULL`,
        eq(wallPredictions.evaluationVersion, WALL_EVALUATION_VERSION),
      ),
    )
    .orderBy(asc(wallPredictions.declaredDate));

  const daily = latestDailyPredictions(rows);

  // Group by calendar quarter: "2026-Q1", "2026-Q2", etc.
  const byQuarter = new Map<string, { support: typeof daily; resistance: typeof daily }>();
  for (const row of daily) {
    const d = new Date(row.declaredDate);
    const q = Math.ceil((d.getUTCMonth() + 1) / 3);
    const key = `${d.getUTCFullYear()}-Q${q}`;
    if (!byQuarter.has(key)) byQuarter.set(key, { support: [], resistance: [] });
    const bucket = byQuarter.get(key)!;
    if (row.side === 'support') bucket.support.push(row);
    else bucket.resistance.push(row);
  }

  return [...byQuarter.entries()].map(([key, bucket]) => {
    const [year, q] = key.split('-');
    const quarterNames = ['', 'Jan–Mar', 'Apr–Jun', 'Jul–Sep', 'Oct–Dec'];
    const qNum = parseInt(q.replace('Q', ''), 10);
    return {
      label: `${quarterNames[qNum]} ${year}`,
      support: aggregateWallStats(bucket.support),
      resistance: aggregateWallStats(bucket.resistance),
    };
  });
}

// ─── Enriched training observations for model comparison ──────────────────────

import type { ComparisonObservation } from './model-comparison';
import { findConfirmedPivots, groupPivotsIntoZones, priceSRFeatures } from './price-levels';
import { atrFromPriceHistory } from './oi-model';

/**
 * Load evaluated wall predictions enriched with price S/R features for the
 * three-model comparison.
 *
 * **Leakage boundary:** For each wall declared on date D, price features are
 * computed using ONLY candles with `date < D`.  Future candles are never used
 * for price evidence — they are only used to determine the wall outcome
 * (held/broke), which was already evaluated by `evaluatePendingWalls`.
 *
 * @param symbol        Instrument symbol.
 * @param lookbackDays  How far back (default 183 = 6 months).
 * @returns Array of ComparisonObservation ready for runModelComparison.
 */
export async function loadWallTrainingObservationsWithPrice(
  symbol: string,
  lookbackDays = 183,
): Promise<ComparisonObservation[]> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const startDate = dateOffset(today, -lookbackDays);

  // Load all price sessions for the instrument (6 months)
  const priceRows = await db.select().from(marketSessions)
    .where(and(
      eq(marketSessions.instrumentId, symbol),
      gte(marketSessions.sessionDate, dateOffset(today, -lookbackDays - 30)),
      lte(marketSessions.sessionDate, today),
    ))
    .orderBy(asc(marketSessions.sessionDate));

  const allHistory: PriceSession[] = priceRows.map((row) => ({
    date: row.sessionDate,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
  }));

  if (allHistory.length < 20) return [];

  // Load instrument metadata for strikeStep
  const instrumentRow = await db.select().from(instruments)
    .where(eq(instruments.id, symbol)).limit(1);
  const strikeStep = instrumentRow[0]?.strikeStep ?? 50;

  // Load wall prediction rows (same as loadWallTrainingObservations)
  const rows = await db
    .select({
      declaredDate: wallPredictions.declaredDate,
      side: wallPredictions.side,
      capturedAt: oiSnapshots.capturedAt,
      reached: wallPredictions.reached,
      held: wallPredictions.held,
      oiChangeAtDeclaration: wallPredictions.oiChangeAtDeclaration,
      oiAtDeclaration: wallPredictions.oiAtDeclaration,
      spotAtDeclaration: wallPredictions.spotAtDeclaration,
      strike: wallPredictions.strike,
      atr14AtDeclaration: wallPredictions.atr14AtDeclaration,
      clusterScore: wallPredictions.clusterScore,
      callVolume: oiStrikes.callVolume,
      putVolume: oiStrikes.putVolume,
    })
    .from(wallPredictions)
    .innerJoin(oiSnapshots, eq(wallPredictions.snapshotId, oiSnapshots.id))
    .innerJoin(
      oiStrikes,
      and(
        eq(oiStrikes.snapshotId, wallPredictions.snapshotId),
        eq(oiStrikes.strike, wallPredictions.strike),
      ),
    )
    .where(
      and(
        eq(wallPredictions.instrumentId, symbol),
        gte(wallPredictions.declaredDate, startDate),
        sql`${wallPredictions.evaluatedAt} IS NOT NULL`,
        eq(wallPredictions.evaluationVersion, WALL_EVALUATION_VERSION),
      ),
    );

  return latestDailyPredictions(rows).flatMap<ComparisonObservation>((row) => {
    if (row.reached !== true || row.held === null) return [];

    // OI features (same as loadWallTrainingObservations)
    const oiChangeNormalized = Math.tanh(row.oiChangeAtDeclaration / Math.max(1, row.oiAtDeclaration * 0.2));
    const proximity = Math.exp(-Math.abs(row.spotAtDeclaration - row.strike) / Math.max(row.atr14AtDeclaration, 100));
    const optionVolume = row.side === 'support' ? row.putVolume : row.callVolume;
    const volumeConfirmation = Math.min(
      1,
      Math.max(0, Math.log1p(optionVolume) / Math.max(1, Math.log1p(row.oiAtDeclaration * 2))),
    );

    const oiFeatures: LevelFeatures = {
      clusterOi: Math.min(1, Math.max(0, row.clusterScore)),
      oiChange: Math.min(1, Math.max(-1, oiChangeNormalized)),
      volumeConfirmation,
      proximity: Math.min(1, Math.max(0, proximity)),
      persistence: 0.5,
      regimeFit: 0.6,
    };

    // Price features — ONLY candles strictly before the declaration date
    const historyBeforeD = allHistory.filter((s) => s.date < row.declaredDate);
    if (historyBeforeD.length < 10) {
      // Not enough price history before this wall — skip
      return [];
    }

    const atr = atrFromPriceHistory(historyBeforeD) || row.atr14AtDeclaration;
    const pivots = findConfirmedPivots(historyBeforeD);
    const zones = groupPivotsIntoZones(pivots, historyBeforeD, atr, strikeStep);
    const priceFeats = priceSRFeatures(zones, row.strike, row.side as LevelSide, atr, strikeStep);

    return [{
      sessionDate: row.declaredDate,
      side: row.side as LevelSide,
      strike: row.strike,
      held: Boolean(row.held),
      oiFeatures,
      priceFeatures: priceFeats,
    }];
  });
}
