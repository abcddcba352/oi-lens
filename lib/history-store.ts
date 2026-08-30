import { env } from 'cloudflare:workers';
import { and, asc, eq, gte, lte, lt } from 'drizzle-orm';
import { getDb } from '@/db';
import { instruments, levelOutcomes, marketSessions, oiSnapshots, oiStrikes } from '@/db/schema';
import type { HistoricalLevelObservation, LevelFeatures, MarketSnapshot, PriceSession } from './market-types';
import type { MarketDataProvider } from './providers/types';

const DAY = 86_400_000;

const REFRESH_OVERLAP_DAYS = 5;
const SNAPSHOT_BUCKET_MINUTES = 15;
// D1 has a conservative bound-parameter ceiling. A strike row can bind up to
// eleven values, so small chunks keep every insert safely below that limit.
const STRIKE_INSERT_CHUNK = 8;

function dateOffset(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

async function ensureInstrument(snapshot: MarketSnapshot) {
  const db = getDb();
  const instrumentId = snapshot.symbol;
  await db.insert(instruments).values({ id: instrumentId, symbol: snapshot.symbol, displayName: snapshot.displayName, instrumentType: snapshot.instrumentType, strikeStep: snapshot.strikeStep, updatedAt: snapshot.asOf })
    .onConflictDoUpdate({ target: instruments.id, set: { displayName: snapshot.displayName, instrumentType: snapshot.instrumentType, strikeStep: snapshot.strikeStep, updatedAt: snapshot.asOf } });
}

export async function persistSnapshot(snapshot: MarketSnapshot) {
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
  return true;
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
