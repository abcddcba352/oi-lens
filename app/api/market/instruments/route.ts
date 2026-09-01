import { and, eq, like, or, sql } from 'drizzle-orm';
import { ensureDbSchema, getDb } from '@/db';
import { instruments, oiSnapshots } from '@/db/schema';

export async function GET() {
  try {
    await ensureDbSchema();
    const rows = await getDb()
      .select({
        symbol: instruments.id,
        label: instruments.displayName,
        instrumentType: instruments.instrumentType,
        snapshots: sql<number>`count(${oiSnapshots.id})`,
      })
      .from(instruments)
      .leftJoin(oiSnapshots, eq(oiSnapshots.instrumentId, instruments.id))
      .where(and(
        like(instruments.id, 'NSE:%'),
        or(eq(instruments.instrumentType, 'index'), sql`${oiSnapshots.id} IS NOT NULL`),
      ))
      .groupBy(instruments.id, instruments.displayName, instruments.instrumentType);

    const supported = rows
      .filter((row) => row.instrumentType === 'index' || Number(row.snapshots) > 0)
      .sort((a, b) => {
        if (a.instrumentType !== b.instrumentType) return a.instrumentType === 'index' ? -1 : 1;
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
