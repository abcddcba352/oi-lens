import {
  cleanCandles,
  type WatchCandle,
  type WatchResult,
} from './position-watchlist.ts';
import type { WatchEvidence } from './watchlist-evidence.ts';
import {
  evaluateResearchStrategies,
  RESEARCH_STRATEGIES,
} from './research-strategy.ts';

/** Frozen selection: trend won the early comparison but failed the later gate.
 * Do not promote it, add untested OI filters, or claim a fitted probability. */
export function evaluateResearchWatchlist(
  symbol: string,
  name: string,
  input: WatchCandle[],
  benchmark: WatchCandle[],
  asOf: string,
  evidence?: WatchEvidence,
): WatchResult {
  const rows = cleanCandles(input, asOf);
  const signal = evaluateResearchStrategies(
    rows,
    cleanCandles(benchmark, asOf),
    asOf,
    evidence?.medianVolume ?? null,
  );
  if (!signal.eligible) {
    const missing =
      rows.length < 60 ||
      rows.at(-1)?.date !== asOf ||
      evidence?.medianVolume == null ||
      signal.relativeStrength === null;
    return {
      candidate: null,
      reason: signal.reason,
      group: missing ? 'data_incomplete' : 'excluded',
    };
  }
  const latest = rows.at(-1)!;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    reason: null,
    candidate: {
      symbol,
      name,
      horizon: 'short',
      group: 'developing',
      asOf,
      source: latest.source,
      close: latest.close,
      sessions: rows.length,
      score: 0,
      stage: 'Trend watch',
      resistance: round(signal.resistance),
      entryTrigger: latest.close,
      invalidation: round(signal.stop),
      nextResistance: null,
      rewardRisk: null,
      targetReviewRequired: true,
      riskDistance: round(2 * signal.atr),
      riskDistanceAtr: 2,
      distancePercent: round(
        (100 * (signal.resistance - latest.close)) / latest.close,
      ),
      distanceAtr: round((signal.resistance - latest.close) / signal.atr),
      atr: round(signal.atr),
      relativeStrength: signal.relativeStrength,
      probability: null,
      scoreBreakdown: [],
      reasons: [
        'Close above rising MA20; MA20 above MA50; outperforming NIFTY over 20 sessions.',
        'Prior 20-session median cash volume at least 25,000 shares.',
        'Selected from earlier results; later test failed. Observation only, not a buy signal.',
        'OI, delivery, futures and sector evidence are context, not additional tested entry filters.',
      ],
      evidence,
      evidenceCoverage: evidence?.coverage,
      researchLabel: 'Research only',
      fundamentalsStatus: 'Unassessed',
      strategy: {
        id: 'trend',
        status: 'Research only',
        projectedTarget: round(signal.target),
        matchedRules: (
          Object.keys(
            RESEARCH_STRATEGIES,
          ) as (keyof typeof RESEARCH_STRATEGIES)[]
        )
          .filter((id) => signal.matches[id])
          .map((id) => RESEARCH_STRATEGIES[id]),
      },
    },
  };
}
