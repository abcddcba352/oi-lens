import { and, eq, gte, lt } from 'drizzle-orm';
import { getDb } from '@/db';
import { instruments, levelOutcomes, oiSnapshots, oiStrikes } from '@/db/schema';
import type { HistoricalLevelObservation, LevelFeatures, MarketSnapshot } from './market-types';

const DAY = 86_400_000;

export async function persistSnapshot(snapshot: MarketSnapshot) {
  if (snapshot.source === 'demo') return;
  const db = getDb();
  const instrumentId = snapshot.symbol;
  const snapshotId = `${snapshot.symbol}:${snapshot.expiryEpoch ?? snapshot.expiry}:${snapshot.asOf}`;
  await db.insert(instruments).values({ id: instrumentId, symbol: snapshot.symbol, displayName: snapshot.displayName, instrumentType: snapshot.instrumentType, strikeStep: snapshot.strikeStep, updatedAt: snapshot.asOf })
    .onConflictDoUpdate({ target: instruments.id, set: { displayName: snapshot.displayName, instrumentType: snapshot.instrumentType, strikeStep: snapshot.strikeStep, updatedAt: snapshot.asOf } });
  await db.insert(oiSnapshots).values({ id: snapshotId, instrumentId, capturedAt: snapshot.asOf, expiry: snapshot.expiry, expiryEpoch: snapshot.expiryEpoch, spot: snapshot.spot, spotChangePercent: snapshot.spotChangePercent, atr14: snapshot.atr14, ivPercentile: snapshot.ivPercentile, source: snapshot.source }).onConflictDoNothing();
  if (snapshot.chain.length) {
    await db.insert(oiStrikes).values(snapshot.chain.map((row) => ({ id: `${snapshotId}:${row.strike}`, snapshotId, ...row }))).onConflictDoNothing();
  }
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
