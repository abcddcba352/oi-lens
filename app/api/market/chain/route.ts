import { analyzeSnapshotWithPriceHistory } from '@/lib/oi-model';
import { getMarketProvider } from '@/lib/providers';
import { readFyersAuthorization } from '@/lib/fyers-auth';
import {
  evaluatePendingWalls,
  loadFeatureThresholds,
  loadHistoricalObservations,
  loadOiHistoryContext,
  loadOrRefreshPriceHistory,
  loadWallTrainingObservations,
  loadWallStats,
  loadWallStatsByQuarter,
  persistSnapshot,
  persistWallPredictions,
} from '@/lib/history-store';
import type { QuarterStats } from '@/lib/history-store';
import { getDb } from '@/db';
import { instruments, oiSnapshots, oiStrikes } from '@/db/schema';
import { asc, eq } from 'drizzle-orm';
import type { HistoricalLevelObservation, MarketSnapshot, OiHistoryContext } from '@/lib/market-types';

const SYMBOL = /^(NSE|BSE):[A-Z0-9&._-]+-(EQ|INDEX)$/;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get('symbol') ?? 'NSE:NIFTY50-INDEX').toUpperCase();
  if (!SYMBOL.test(symbol)) return Response.json({ error: 'Use a valid exchange symbol such as NSE:NIFTY50-INDEX.' }, { status: 400 });
  const expiryRaw = url.searchParams.get('expiry');
  const expiryEpoch = expiryRaw ? Number(expiryRaw) : undefined;
  if (expiryRaw && (!Number.isInteger(expiryEpoch) || (expiryEpoch ?? 0) <= 0)) return Response.json({ error: 'Expiry must be a positive Unix timestamp.' }, { status: 400 });

  const backfill = url.searchParams.get('backfill') === 'true';
  if (backfill) {
    try {
      const db = getDb();
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50));

      // Count total snapshots for this symbol so caller can track progress.
      const allSnaps = await db
        .select({ id: oiSnapshots.id })
        .from(oiSnapshots)
        .where(eq(oiSnapshots.instrumentId, symbol));
      const total = allSnaps.length;

      const instrument = await db.select().from(instruments).where(eq(instruments.id, symbol)).limit(1);
      const metadata = instrument[0];

      const snaps = await db
        .select()
        .from(oiSnapshots)
        .where(eq(oiSnapshots.instrumentId, symbol))
        .orderBy(asc(oiSnapshots.capturedAt))
        .limit(limit)
        .offset(offset);

      let declaredCount = 0;
      for (const snap of snaps) {
        const strikes = await db.select().from(oiStrikes).where(eq(oiStrikes.snapshotId, snap.id));
        const marketSnapshot: MarketSnapshot = {
          symbol: snap.instrumentId,
          displayName: metadata?.displayName ?? symbol.replace(/^NSE:|-(EQ|INDEX)$/g, ''),
          instrumentType: metadata?.instrumentType ?? (symbol.endsWith('-INDEX') ? 'index' : 'stock'),
          spot: snap.spot,
          spotChangePercent: snap.spotChangePercent,
          expiry: snap.expiry,
          expiryEpoch: snap.expiryEpoch ?? undefined,
          strikeStep: metadata?.strikeStep ?? 50,
          atr14: snap.atr14,
          ivPercentile: snap.ivPercentile,
          asOf: snap.capturedAt,
          source: snap.source === 'demo'
            ? 'demo'
            : snap.source === 'nse-bhavcopy'
              ? 'nse-bhavcopy'
              : 'fyers',
          chain: strikes.map((s) => ({
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
        await persistWallPredictions(marketSnapshot, snap.id);
        declaredCount++;
      }

      // Use a correctly typed dummy snapshot for loadOrRefreshPriceHistory.
      const provider = getMarketProvider(await readFyersAuthorization(request));
      const instrumentType = metadata?.instrumentType ?? (symbol.endsWith('-INDEX') ? 'index' : 'stock');
      const dummySnapshot: MarketSnapshot = {
        symbol,
        displayName: metadata?.displayName ?? symbol.replace(/^NSE:|-(EQ|INDEX)$/g, ''),
        instrumentType,
        spot: 0,
        spotChangePercent: 0,
        expiry: 'Backfill',
        strikeStep: metadata?.strikeStep ?? 50,
        atr14: 1,
        ivPercentile: 0.5,
        asOf: new Date().toISOString(),
        source: provider.id,
        chain: [],
      };
      const cached = await loadOrRefreshPriceHistory(provider, dummySnapshot);
      await evaluatePendingWalls(symbol, cached.history);

      const processed = offset + declaredCount;
      const remaining = Math.max(0, total - processed);
      return Response.json({
        success: true,
        message: `Declared ${declaredCount} walls (offset ${offset}–${processed - 1} of ${total}). Evaluated pending outcomes.`,
        processed,
        remaining,
        total,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Backfill failed';
      return Response.json({ error: msg }, { status: 500 });
    }
  }


  try {
    const provider = getMarketProvider(await readFyersAuthorization(request));
    const snapshot = await provider.fetchOptionChain({ symbol, expiryEpoch, strikeCount: 25 });
    const cached = await loadOrRefreshPriceHistory(provider, snapshot);

    if (snapshot.spotChangePercent === 0 && cached.history.length >= 2) {
      const todayIso = snapshot.asOf.slice(0, 10);
      const prevSession = cached.history.filter((s) => s.date < todayIso).at(-1) ?? cached.history.at(-2);
      if (prevSession && prevSession.close > 0) {
        snapshot.spotChangePercent = ((snapshot.spot - prevSession.close) / prevSession.close) * 100;
      }
    }

    let oiHistory: OiHistoryContext = { intraday: [], positional: [] };
    let historicalOiObservations: HistoricalLevelObservation[] = [];
    let featureThresholds = null;
    try {
      oiHistory = await loadOiHistoryContext(snapshot);
      // Mature any previously declared walls first, then load the complete
      // six-month D1 outcome set used to calibrate today's positional ranking.
      await evaluatePendingWalls(symbol, cached.history);
      const [legacyOutcomes, wallOutcomes] = await Promise.all([
        loadHistoricalObservations(symbol, snapshot.asOf),
        loadWallTrainingObservations(symbol),
      ]);
      // Antigravity's original six-month records live in level_outcomes;
      // newer daily wall evaluations live in wall_predictions. Merge both
      // without letting an overlapping observation count twice.
      historicalOiObservations = [
        ...new Map(
          [...legacyOutcomes, ...wallOutcomes].map((item) => [
            `${item.sessionDate}:${item.side}:${item.strike}`,
            item,
          ]),
        ).values(),
      ];
    } catch {
      // Live analysis remains available when historical OI storage is not yet
      // initialized or a database read is temporarily unavailable.
    }

    const analysis = analyzeSnapshotWithPriceHistory(
      snapshot,
      cached.history,
      oiHistory,
      historicalOiObservations,
    );

    let oiSnapshotStored = false;
    let oiSnapshotWarning: string | null = null;
    let wallStats = null;
    let quarterStats: QuarterStats[] = [];

    try {
      const snapshotId = await persistSnapshot(analysis.snapshot);
      if (snapshotId) {
        oiSnapshotStored = true;
        await persistWallPredictions(analysis.snapshot, snapshotId);
        await evaluatePendingWalls(symbol, cached.history);
        [wallStats, featureThresholds, quarterStats] = await Promise.all([
          loadWallStats(symbol),
          loadFeatureThresholds(symbol),
          loadWallStatsByQuarter(symbol),
        ]);
      }
    } catch {
      oiSnapshotWarning = 'Live analysis loaded. OI archival will retry on the next refresh.';
    }

    return Response.json(
      {
        analysis,
        wallStats,
        quarterStats,
        featureThresholds,
        provider: provider.id,
        dataStatus: {
          historySource: cached.source,
          historySessions: cached.history.length,
          latestSession: cached.latestSession,
          oiSnapshotStored,
          oiSnapshotWarning,
          oiSnapshotIntervalMinutes: 15,
        },
      },
      { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to analyze the option chain.';
    return Response.json({ error: message }, { status: 502 });
  }
}
