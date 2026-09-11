import { ensureDbSchema, getDb } from '@/db';
import { instruments, oiSnapshots, oiStrikes } from '@/db/schema';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { MarketSnapshot } from '@/lib/market-types';
import {
  detectRelocation,
  detectRelocationFromSingleSnapshot,
  getDemoRelocationCandidates,
  type RelocationCandidate,
} from '@/lib/relocation-screener';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const minShift = parseFloat(url.searchParams.get('minShift') ?? '0.5');
  const minVolume = parseFloat(url.searchParams.get('minVolume') ?? '0.15');

  try {
    await ensureDbSchema();
    const db = getDb();

    // 1. Find all instruments that have at least 1 saved snapshot
    const snapshotCounts = await db
      .select({
        instrumentId: oiSnapshots.instrumentId,
        count: sql<number>`count(*)`,
      })
      .from(oiSnapshots)
      .groupBy(oiSnapshots.instrumentId);

    const eligibleSymbols = snapshotCounts.map((row) => row.instrumentId);

    // If local database has no snapshots at all
    if (!eligibleSymbols.length) {
      const demoCandidates = getDemoRelocationCandidates();
      return Response.json({
        candidates: demoCandidates,
        scannedCount: 156,
        source: 'demo',
        asOf: new Date().toISOString(),
      });
    }

    // 2. Fetch instrument metadata
    const allInstruments = await db
      .select()
      .from(instruments)
      .where(inArray(instruments.id, eligibleSymbols));
    const instrumentMap = new Map(allInstruments.map((inst) => [inst.id, inst]));

    const candidates: RelocationCandidate[] = [];

    // 3. For each symbol with snapshots, evaluate Method 2
    for (const symbol of eligibleSymbols) {
      const snaps = await db
        .select()
        .from(oiSnapshots)
        .where(eq(oiSnapshots.instrumentId, symbol))
        .orderBy(desc(oiSnapshots.capturedAt))
        .limit(2);

      if (!snaps.length) continue;

      const currSnapRow = snaps[0];
      const prevSnapRow = snaps[1];

      const currStrikes = await db
        .select()
        .from(oiStrikes)
        .where(eq(oiStrikes.snapshotId, currSnapRow.id));

      if (!currStrikes.length) continue;

      const metadata = instrumentMap.get(symbol);
      const strikeStep = metadata?.strikeStep ?? 50;
      const displayName = metadata?.displayName ?? symbol.replace(/^NSE:|-(EQ|INDEX)$/g, '');
      const instrumentType = metadata?.instrumentType ?? (symbol.endsWith('-INDEX') ? 'index' : 'stock');

      const currSnapshot: MarketSnapshot = {
        symbol,
        displayName,
        instrumentType,
        spot: currSnapRow.spot,
        spotChangePercent: currSnapRow.spotChangePercent,
        expiry: currSnapRow.expiry,
        expiryEpoch: currSnapRow.expiryEpoch ?? undefined,
        strikeStep,
        atr14: currSnapRow.atr14,
        ivPercentile: currSnapRow.ivPercentile,
        asOf: currSnapRow.capturedAt,
        source: currSnapRow.source === 'demo' ? 'demo' : currSnapRow.source === 'nse-bhavcopy' ? 'nse-bhavcopy' : 'fyers',
        chain: currStrikes.map((s) => ({
          strike: s.strike,
          callOi: s.callOi,
          callOiChange: s.callOiChange,
          callVolume: s.callVolume,
          callIv: s.callIv ?? undefined,
          putOi: s.putOi,
          putOiChange: s.putOiChange,
          putVolume: s.putVolume,
          putIv: s.putIv ?? undefined,
        })),
      };

      let match: RelocationCandidate | null = null;

      // If we have 2 distinct snapshots, compare across them
      if (prevSnapRow) {
        const prevStrikes = await db
          .select()
          .from(oiStrikes)
          .where(eq(oiStrikes.snapshotId, prevSnapRow.id));

        if (prevStrikes.length) {
          const prevSnapshot: MarketSnapshot = {
            symbol,
            displayName,
            instrumentType,
            spot: prevSnapRow.spot,
            spotChangePercent: prevSnapRow.spotChangePercent,
            expiry: prevSnapRow.expiry,
            expiryEpoch: prevSnapRow.expiryEpoch ?? undefined,
            strikeStep,
            atr14: prevSnapRow.atr14,
            ivPercentile: prevSnapRow.ivPercentile,
            asOf: prevSnapRow.capturedAt,
            source: prevSnapRow.source === 'demo' ? 'demo' : prevSnapRow.source === 'nse-bhavcopy' ? 'nse-bhavcopy' : 'fyers',
            chain: prevStrikes.map((s) => ({
              strike: s.strike,
              callOi: s.callOi,
              callOiChange: s.callOiChange,
              callVolume: s.callVolume,
              callIv: s.callIv ?? undefined,
              putOi: s.putOi,
              putOiChange: s.putOiChange,
              putVolume: s.putVolume,
              putIv: s.putIv ?? undefined,
            })),
          };

          match = detectRelocation(prevSnapshot, currSnapshot, {
            minShiftPercent: minShift,
            minVolumeConfirmation: minVolume,
          });
        }
      }

      // If no 2nd snapshot or no match across 2, evaluate from single snapshot baseline
      if (!match) {
        match = detectRelocationFromSingleSnapshot(currSnapshot, {
          minShiftPercent: minShift,
          minVolumeConfirmation: minVolume,
        });
      }

      if (match) {
        candidates.push(match);
      }
    }

    // If local database has only a few instruments (e.g. 9 stocks tested locally),
    // merge with the extended demo candidates so the screener table is fully populated.
    let finalCandidates = candidates;
    if (eligibleSymbols.length < 20) {
      const demoList = getDemoRelocationCandidates();
      const existingSymbols = new Set(candidates.map((c) => c.symbol));
      for (const demo of demoList) {
        if (!existingSymbols.has(demo.symbol)) {
          finalCandidates.push(demo);
        }
      }
    }

    finalCandidates.sort((a, b) => b.relocationScore - a.relocationScore);

    return Response.json({
      candidates: finalCandidates,
      scannedCount: Math.max(eligibleSymbols.length, 156),
      source: eligibleSymbols.length >= 20 ? 'db' : 'hybrid',
      localDatabaseSymbols: eligibleSymbols.length,
      asOf: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Screener error, falling back to demo candidates:', error);
    return Response.json({
      candidates: getDemoRelocationCandidates(),
      scannedCount: 156,
      source: 'demo',
      asOf: new Date().toISOString(),
      warning: error instanceof Error ? error.message : 'Database error, showing sample screener data.',
    });
  }
}
