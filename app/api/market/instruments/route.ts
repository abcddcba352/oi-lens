import { like, sql } from 'drizzle-orm';
import { ensureDbSchema, getDb } from '@/db';
import { instruments, marketSessions, oiSnapshots } from '@/db/schema';
import { computeInstrumentAvailability } from '@/lib/instrument-availability';

export async function GET() {
  try {
    await ensureDbSchema();
    const db = getDb();

    // Count snapshots per instrument
    const snapshotCounts = await db
      .select({
        symbol: oiSnapshots.instrumentId,
        count: sql<number>`count(*)`,
      })
      .from(oiSnapshots)
      .groupBy(oiSnapshots.instrumentId);
    const snapshotMap = new Map(snapshotCounts.map((r) => [r.symbol, Number(r.count)]));

    // Count cached daily sessions per instrument
    const sessionCounts = await db
      .select({
        symbol: marketSessions.instrumentId,
        count: sql<number>`count(*)`,
      })
      .from(marketSessions)
      .groupBy(marketSessions.instrumentId);
    const sessionMap = new Map(sessionCounts.map((r) => [r.symbol, Number(r.count)]));

    // Fetch all known NSE instruments
    const rows = await db
      .select({
        symbol: instruments.id,
        label: instruments.displayName,
        instrumentType: instruments.instrumentType,
      })
      .from(instruments)
      .where(like(instruments.id, 'NSE:%'));

    const supported = rows
      .map((row) => {
        const snapshots = snapshotMap.get(row.symbol) ?? 0;
        const sessions = sessionMap.get(row.symbol) ?? 0;
        const avail = computeInstrumentAvailability(snapshots, sessions);
        return {
          symbol: row.symbol,
          label: row.label,
          instrumentType: row.instrumentType,
          snapshots,
          sessions,
          ...avail,
        };
      })
      // Show indices (always available via demo) and stocks that have at least a snapshot
      .filter((item) => item.instrumentType === 'index' || item.snapshots > 0)
      .sort((a, b) => {
        if (a.instrumentType !== b.instrumentType) return a.instrumentType === 'index' ? -1 : 1;
        // Sort ready instruments first, then by name
        if (a.availability !== b.availability) {
          if (a.availability === 'ready') return -1;
          if (b.availability === 'ready') return 1;
        }
        return a.label.localeCompare(b.label);
      });

    return Response.json(
      { instruments: supported },
      { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load supported instruments.';
    return Response.json({ error: message }, { status: 500 });
  }
}
