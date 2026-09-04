import { analyzeSnapshotWithPriceHistory } from '@/lib/oi-model';
import { getMarketProvider, DemoProvider } from '@/lib/providers';
import { readFyersAuthorization } from '@/lib/fyers-auth';
import {
  evaluatePendingWalls,
  loadFeatureThresholds,
  loadHistoricalObservations,
  loadCachedPriceHistory,
  loadLatestStoredSnapshot,
  loadOiCoverage,
  loadOiHistoryContext,
  loadOrRefreshPriceHistory,
  loadWallTrainingObservations,
  loadWallTrainingObservationsWithPrice,
  loadWallStats,
  loadWallStatsByQuarter,
  persistSnapshot,
  persistWallPredictions,
} from '@/lib/history-store';
import type { QuarterStats } from '@/lib/history-store';
import { runModelComparison } from '@/lib/model-comparison';
import { findConfirmedPivots, groupPivotsIntoZones, priceSRFeatures } from '@/lib/price-levels';
import type { LevelSide, LevelFeatures } from '@/lib/market-types';
import { MIN_SESSIONS_FOR_FULL_HISTORY, MIN_SESSIONS_FOR_BASIC_ANALYSIS } from '@/lib/instrument-availability';

import { ensureDbSchema, getDb } from '@/db';
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

  try {
    await ensureDbSchema();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to initialize the historical database.';
    return Response.json({ error: message }, { status: 500 });
  }

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
      const cached = provider.id === 'demo'
        ? await loadCachedPriceHistory(symbol, dummySnapshot.asOf)
        : await loadOrRefreshPriceHistory(provider, dummySnapshot);
      if (!cached) {
        throw new Error(`No cached daily history for ${symbol}. Connect FYERS and refresh once to populate it.`);
      }
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
    const authorization = await readFyersAuthorization(request);
    const provider = getMarketProvider(authorization);
    let snapshot: MarketSnapshot | null = null;
    if (provider.id === 'fyers') {
      try {
        snapshot = await provider.fetchOptionChain({ symbol, expiryEpoch, strikeCount: 25 });
      } catch (fyersError) {
        console.warn('FYERS live chain fetch failed (market may be closed/after-hours); falling back to stored D1 snapshot:', fyersError);
        snapshot = await loadLatestStoredSnapshot(symbol, expiryEpoch);
        if (!snapshot) {
          throw fyersError;
        }
      }
    } else {
      snapshot = await loadLatestStoredSnapshot(symbol, expiryEpoch);
    }

    if (!snapshot) {
      throw new Error(`No saved OI snapshot found for ${symbol}. Please ensure backfill has completed or connect FYERS.`);
    }

    let cached = provider.id === 'demo' && snapshot.source !== 'demo'
      ? await loadCachedPriceHistory(snapshot.symbol, snapshot.asOf)
      : null;

    if (!cached) {
      try {
        cached = await loadOrRefreshPriceHistory(provider, snapshot);
      } catch {
        cached = await loadCachedPriceHistory(snapshot.symbol, snapshot.asOf);
      }
    }

    if (!cached) {
      cached = await loadCachedPriceHistory(snapshot.symbol, snapshot.asOf);
    }

    // Fallback for demo-supported indices if D1 does not have cached sessions yet
    if (!cached && (snapshot.instrumentType === 'index' || symbol.endsWith('-INDEX'))) {
      const demoProvider = new DemoProvider();
      cached = await loadOrRefreshPriceHistory(demoProvider, snapshot);
    }

    if (!cached) {
      throw new Error(`Only 0 cached daily sessions available for ${symbol}; at least ${MIN_SESSIONS_FOR_BASIC_ANALYSIS} are needed for basic analysis.`);
    }

    const isFullHistory = cached.history.length >= MIN_SESSIONS_FOR_FULL_HISTORY;

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
    let oiCoverage = { snapshots: 0, firstSnapshot: null as string | null, latestSnapshot: null as string | null };

    try {
      const snapshotId = await persistSnapshot(analysis.snapshot);
      if (snapshotId) {
        oiSnapshotStored = true;
        await persistWallPredictions(analysis.snapshot, snapshotId);
        await evaluatePendingWalls(symbol, cached.history);
      }
      // Always load wall stats from D1 — even when market is closed, FYERS
      // is not connected, or no new snapshot was stored this request.
      // This ensures "Observed 10-session wall outcomes" shows backfilled data.
      [wallStats, featureThresholds, quarterStats, oiCoverage] = await Promise.all([
        loadWallStats(symbol),
        loadFeatureThresholds(symbol),
        loadWallStatsByQuarter(symbol),
        loadOiCoverage(symbol),
      ]);
    } catch {
      oiSnapshotWarning = 'Live analysis loaded. OI archival will retry on the next refresh.';
    }

    // ─── Model comparison (OI-only vs price-only vs hybrid) ────────────
    // Requires full six-month history (≥100 sessions) for valid price S/R
    // training/validation. Partial history would produce misleading results.
    let modelComparison = null;
    if (!isFullHistory) {
      // Skip model comparison entirely — partial history cannot train reliably
    } else try {
      const wallCount = (wallStats?.support.evaluated ?? 0) + (wallStats?.resistance.evaluated ?? 0);
      if (wallCount >= 10) {
        const enrichedObservations = await loadWallTrainingObservationsWithPrice(symbol);
        if (enrichedObservations.length >= 10) {
          const comparison = runModelComparison(enrichedObservations);
          modelComparison = comparison;
          analysis.modelComparison = comparison;

          // ─── Hybrid confidence: apply trained model to current levels ───
          // Only when ALL gates pass and confluence exists.
          // Uses training-fitted coefficients and training-only standardisation.
          // NEVER replaces OI Strength; displayed separately as Validated Hybrid Confidence.
          if (comparison.hybridApproved && comparison.hybridCoefficients && comparison.standardization && analysis.currentConfluence) {
            const { weights, bias } = comparison.hybridCoefficients;
            const std = comparison.standardization;
            const snap = analysis.snapshot;

            const computeHybrid = (side: LevelSide, level: { strike: number; score: number; features: LevelFeatures }) => {
              // Build the same 12-feature vector used during training
              const pivots = findConfirmedPivots(cached.history.filter(s => s.date < snap.asOf.slice(0, 10)));
              const zones = groupPivotsIntoZones(pivots, cached.history.filter(s => s.date < snap.asOf.slice(0, 10)), snap.atr14, snap.strikeStep);
              const priceF = priceSRFeatures(zones, level.strike, side, snap.atr14, snap.strikeStep, snap.spot);

              const raw = [
                level.features.clusterOi, level.features.oiChange, level.features.volumeConfirmation,
                level.features.proximity, level.features.persistence, level.features.regimeFit,
                priceF.priceHoldRate, priceF.priceTouches, priceF.priceBounceAtr,
                priceF.priceRecency, priceF.priceDistance, priceF.isConfluent ? 1 : 0,
              ];

              // Apply training-only z-score standardisation
              const standardised = raw.map((val, j) => (val - std.means[j]) / std.stds[j]);

              // Sigmoid(w·x + b)
              let z = bias;
              for (let j = 0; j < weights.length; j++) z += weights[j] * standardised[j];
              const prob = z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
              return Math.round(prob * 100) / 100;
            };

            try {
              if (analysis.currentConfluence.support && analysis.positional.primarySupport) {
                analysis.currentConfluence.support.hybridConfidence = computeHybrid('support', analysis.positional.primarySupport);
              }
              if (analysis.currentConfluence.resistance && analysis.positional.primaryResistance) {
                analysis.currentConfluence.resistance.hybridConfidence = computeHybrid('resistance', analysis.positional.primaryResistance);
              }
            } catch {
              // Hybrid confidence is non-critical
            }
          }
        }
      }
    } catch {
      // Model comparison is non-critical; live analysis still works
    }

    return Response.json(
      {
        analysis,
        wallStats,
        quarterStats,
        featureThresholds,
        modelComparison,
        provider: provider.id,
        dataStatus: {
          historySource: cached.source,
          historySessions: cached.history.length,
          latestSession: cached.latestSession,
          oiSnapshotStored,
          oiSnapshotWarning,
          oiSnapshotIntervalMinutes: 15,
          storedOiSnapshots: oiCoverage.snapshots,
          earliestOiSnapshot: oiCoverage.firstSnapshot,
          latestOiSnapshot: oiCoverage.latestSnapshot,
          partialHistory: !isFullHistory,
          historyCoverage: isFullHistory ? 'full' as const : cached.history.length >= MIN_SESSIONS_FOR_BASIC_ANALYSIS ? 'partial' as const : 'none' as const,
        },
      },
      { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to analyze the option chain.';
    return Response.json({ error: message }, { status: 400 });
  }
}
