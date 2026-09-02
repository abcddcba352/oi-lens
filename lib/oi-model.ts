import {
  featureNames,
  type HistoricalLevelObservation,
  type OiHistoryContext,
  type CurrentConfluenceReport,
  type LevelFeatures,
  type LevelSide,
  type MarketAnalysis,
  type MarketSnapshot,
  type ModelDiagnostics,
  type PriceSession,
  type TimeframeAnalysis,
} from './market-types.ts';
import { tradingSessionsUntilExpiry } from './wall-backtest.ts';
import { findConfirmedPivots, groupPivotsIntoZones, buildConfluenceInfo } from './price-levels.ts';


const DAY = 86_400_000;
const SIX_MONTH_DAYS = 183;
const MIN_CALIBRATION_SAMPLES = 40;
const PURGE_OBSERVATIONS = 3;
const CLUSTER_WEIGHTS = [0.25, 0.6, 1, 0.6, 0.25] as const;
const FALLBACK_COEFFICIENTS = [1.2, 0.8, 0.45, 0.35, 0.7, 0.3] as const;
const POSITIONAL_HORIZON_SESSIONS = 10;
const OI_HISTORY_LOOKBACK_DAYS = 21;

interface TrainedModel {
  intercept: number;
  coefficients: number[];
  diagnostics: ModelDiagnostics;
}

interface Candidate {
  side: LevelSide;
  strike: number;
  oi: number;
  oiChange: number;
  features: LevelFeatures;
}

interface OiContinuity {
  /** Number of saved snapshots that contained this exact strike. */
  samples: number;
  /** Normalised OI change from the earliest saved snapshot to the live one. */
  change: number | null;
  /** Whether OI has remained present and relatively stable through the window. */
  persistence: number | null;
}

interface ZoneHistoryStats {
  tests: number;
  holds: number;
  weightedHoldRate: number;
  confidence: number;
}

interface OutcomePrior {
  samples: number;
  holdRate: number;
  confidence: number;
}

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function sigmoid(value: number) {
  if (value >= 0) {
    const exp = Math.exp(-value);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function logit(probability: number) {
  const p = clamp(probability, 0.05, 0.95);
  return Math.log(p / (1 - p));
}

function featureVector(features: LevelFeatures) {
  return featureNames.map((name) => features[name]);
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function isValidDate(value: string) {
  return Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

export function filterSixMonthObservations(
  observations: HistoricalLevelObservation[],
  instrument: string,
  asOf: string,
) {
  const asOfTime = Date.parse(asOf);
  const start = asOfTime - SIX_MONTH_DAYS * DAY;
  return observations
    .filter((observation) => {
      const time = Date.parse(`${observation.sessionDate}T00:00:00Z`);
      return (
        observation.instrument === instrument &&
        observation.tested &&
        isValidDate(observation.sessionDate) &&
        time >= start &&
        time < asOfTime
      );
    })
    .sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
}

function fitLogistic(observations: HistoricalLevelObservation[]) {
  const positives = observations.filter((item) => item.held).length;
  let intercept = logit(positives / Math.max(1, observations.length));
  const coefficients = Array.from({ length: featureNames.length }, () => 0);
  const positiveWeight = observations.length / Math.max(1, 2 * positives);
  const negativeWeight = observations.length / Math.max(1, 2 * (observations.length - positives));
  const learningRate = 0.12;
  const l2 = 0.08;

  for (let iteration = 0; iteration < 700; iteration += 1) {
    let interceptGradient = 0;
    const gradients = Array.from({ length: featureNames.length }, () => 0);
    for (const observation of observations) {
      const x = featureVector(observation.features);
      const prediction = sigmoid(
        intercept + coefficients.reduce((sum, coefficient, index) => sum + coefficient * x[index], 0),
      );
      const weight = observation.held ? positiveWeight : negativeWeight;
      const error = (prediction - Number(observation.held)) * weight;
      interceptGradient += error;
      gradients.forEach((_, index) => {
        gradients[index] += error * x[index];
      });
    }
    intercept -= (learningRate * interceptGradient) / observations.length;
    coefficients.forEach((coefficient, index) => {
      coefficients[index] -=
        learningRate * (gradients[index] / observations.length + l2 * coefficient);
    });
  }
  return { intercept, coefficients };
}

function predict(model: Pick<TrainedModel, 'intercept' | 'coefficients'>, features: LevelFeatures) {
  const x = featureVector(features);
  return sigmoid(model.intercept + model.coefficients.reduce((sum, coefficient, index) => sum + coefficient * x[index], 0));
}

function validationMetrics(model: Pick<TrainedModel, 'intercept' | 'coefficients'>, observations: HistoricalLevelObservation[]) {
  if (observations.length === 0) return { balancedAccuracy: null, brierScore: null };
  let truePositive = 0;
  let trueNegative = 0;
  let positive = 0;
  let negative = 0;
  let brier = 0;
  for (const observation of observations) {
    const probability = predict(model, observation.features);
    const predicted = probability >= 0.5;
    if (observation.held) {
      positive += 1;
      if (predicted) truePositive += 1;
    } else {
      negative += 1;
      if (!predicted) trueNegative += 1;
    }
    brier += (probability - Number(observation.held)) ** 2;
  }
  const sensitivity = positive ? truePositive / positive : 0.5;
  const specificity = negative ? trueNegative / negative : 0.5;
  return {
    balancedAccuracy: (sensitivity + specificity) / 2,
    brierScore: brier / observations.length,
  };
}

export function calibrateModel(
  observations: HistoricalLevelObservation[],
  instrument: string,
  asOf: string,
): TrainedModel {
  const filtered = filterSixMonthObservations(observations, instrument, asOf);
  const lookbackStart = isoDate(new Date(Date.parse(asOf) - SIX_MONTH_DAYS * DAY));
  const lookbackEnd = filtered.at(-1)?.sessionDate ?? isoDate(new Date(Date.parse(asOf) - DAY));
  const holdRate = filtered.filter((item) => item.held).length / Math.max(1, filtered.length);

  if (filtered.length < MIN_CALIBRATION_SAMPLES) {
    return {
      intercept: logit(filtered.length ? holdRate : 0.5) - 1.8,
      coefficients: [...FALLBACK_COEFFICIENTS],
      diagnostics: {
        mode: 'provisional',
        lookbackStart,
        lookbackEnd,
        samples: filtered.length,
        validationSamples: 0,
        holdRate,
        balancedAccuracy: null,
        brierScore: null,
        note: `Needs at least ${MIN_CALIBRATION_SAMPLES} tested levels; score is provisional, not a historical hold rate.`,
      },
    };
  }

  const validationStart = Math.floor(filtered.length * 0.8);
  const training = filtered.slice(0, Math.max(1, validationStart - PURGE_OBSERVATIONS));
  const validation = filtered.slice(validationStart);
  const validationModel = fitLogistic(training);
  const metrics = validationMetrics(validationModel, validation);
  const finalModel = fitLogistic(filtered);
  return {
    ...finalModel,
    diagnostics: {
      mode: 'calibrated',
      lookbackStart,
      lookbackEnd,
      samples: filtered.length,
      validationSamples: validation.length,
      holdRate,
      balancedAccuracy: metrics.balancedAccuracy,
      brierScore: metrics.brierScore,
      note: 'Time-ordered validation with a three-observation purge; only information available before each outcome is used.',
    },
  };
}

function normalized(values: number[]) {
  const max = Math.max(...values, 1);
  return values.map((value) => clamp(value / max));
}

function candidates(snapshot: MarketSnapshot, persistence: Record<string, number>): Candidate[] {
  const chain = [...snapshot.chain].sort((a, b) => a.strike - b.strike);
  const putClusters = chain.map((_, index) =>
    CLUSTER_WEIGHTS.reduce((sum, weight, offset) => sum + (chain[index + offset - 2]?.putOi ?? 0) * weight, 0),
  );
  const callClusters = chain.map((_, index) =>
    CLUSTER_WEIGHTS.reduce((sum, weight, offset) => sum + (chain[index + offset - 2]?.callOi ?? 0) * weight, 0),
  );
  const putClusterStrength = normalized(putClusters);
  const callClusterStrength = normalized(callClusters);
  const putVolumes = normalized(chain.map((item) => Math.log1p(item.putVolume)));
  const callVolumes = normalized(chain.map((item) => Math.log1p(item.callVolume)));
  const distanceScale = Math.max(snapshot.atr14, snapshot.strikeStep * 2);
  const maxDistance = snapshot.instrumentType === 'stock'
    ? Math.max(snapshot.atr14 * 3, snapshot.strikeStep * 8)
    : Math.max(snapshot.atr14 * 3.5, snapshot.strikeStep * 10);
  const regimeFit = clamp(1 - Math.abs(snapshot.ivPercentile - 0.5) * 0.7);
  const result: Candidate[] = [];

  chain.forEach((strike, index) => {
    const distance = Math.abs(snapshot.spot - strike.strike);
    if (distance > maxDistance) return;
    const proximity = Math.exp(-distance / distanceScale);

    if (strike.strike <= snapshot.spot && strike.putOi > 0) {
      result.push({
        side: 'support',
        strike: strike.strike,
        oi: strike.putOi,
        oiChange: strike.putOiChange,
        features: {
          clusterOi: putClusterStrength[index],
          oiChange: Math.tanh(strike.putOiChange / Math.max(1, strike.putOi * 0.2)),
          volumeConfirmation: putVolumes[index],
          proximity,
          persistence: clamp(persistence[`support:${strike.strike}`] ?? 0.5),
          regimeFit,
        },
      });
    }
    if (strike.strike >= snapshot.spot && strike.callOi > 0) {
      result.push({
        side: 'resistance',
        strike: strike.strike,
        oi: strike.callOi,
        oiChange: strike.callOiChange,
        features: {
          clusterOi: callClusterStrength[index],
          oiChange: Math.tanh(strike.callOiChange / Math.max(1, strike.callOi * 0.2)),
          volumeConfirmation: callVolumes[index],
          proximity,
          persistence: clamp(persistence[`resistance:${strike.strike}`] ?? 0.5),
          regimeFit,
        },
      });
    }
  });
  if (snapshot.instrumentType !== 'stock') return result;

  // Single-stock option chains are often thinner than index chains. Ignore
  // weak, isolated rows when at least three liquid candidates exist on that
  // side, but retain a safe fallback for genuinely thin contracts.
  return (['support', 'resistance'] as const).flatMap((side) => {
    const sideCandidates = result.filter((candidate) => candidate.side === side);
    const liquid = sideCandidates.filter(
      (candidate) => candidate.features.volumeConfirmation >= 0.08 && candidate.features.clusterOi >= 0.12,
    );
    return liquid.length >= 3 ? liquid : sideCandidates;
  });
}



function maxPain(snapshot: MarketSnapshot) {
  if (!snapshot.chain.length) return null;
  let bestStrike = snapshot.chain[0].strike;
  let bestPayout = Number.POSITIVE_INFINITY;
  for (const settlement of snapshot.chain.map((row) => row.strike)) {
    const payout = snapshot.chain.reduce(
      (sum, row) =>
        sum + Math.max(0, settlement - row.strike) * row.callOi + Math.max(0, row.strike - settlement) * row.putOi,
      0,
    );
    if (payout < bestPayout) {
      bestPayout = payout;
      bestStrike = settlement;
    }
  }
  return bestStrike;
}

interface ScoredCandidate extends Candidate {
  rank: number;
  probability: number | null;
  score: number;
  distancePoints: number;
  distancePercent: number;
  zoneLow: number;
  zoneHigh: number;
  invalidation: number;
  historicalTests: number;
  historicalHoldRate: number | null;
  oiHistorySnapshots: number;
}

function oiContinuity(candidate: Candidate, history: OiHistoryContext['intraday']): OiContinuity {
  if (!history.length) return { samples: 0, change: null, persistence: null };
  const values = history.flatMap((snapshot) => {
    const row = snapshot.chain.find((item) => item.strike === candidate.strike);
    if (!row) return [];
    const oi = candidate.side === 'support' ? row.putOi : row.callOi;
    return Number.isFinite(oi) && oi >= 0 ? [oi] : [];
  });
  if (!values.length) return { samples: 0, change: null, persistence: null };

  if (values.length < 2) return { samples: values.length, change: null, persistence: null };
  const previousMedian = median(values);
  const coverage = values.length / history.length;
  const currentVsMedian = previousMedian > 0 ? clamp(candidate.oi / previousMedian, 0, 1) : 0.5;
  const persistence = clamp(0.2 + coverage * 0.4 + currentVsMedian * 0.4);

  // The denominator is deliberately robust to one noisy interval.  This is a
  // measure of observed OI movement, not an inference about trader direction.
  const baseline = Math.max(1, median(values));
  const change = Math.tanh((candidate.oi - values[0]) / (baseline * 0.2));
  return { samples: values.length, change, persistence };
}

function sideMaxOi(levels: ScoredCandidate[], side: LevelSide) {
  return Math.max(...levels.filter((level) => level.side === side).map((level) => level.oi), 1);
}

function rankLevels(
  levels: ScoredCandidate[],
  horizon: 'intraday' | 'positional',
  instrumentType: MarketSnapshot['instrumentType'] = 'index',
) {
  return (['support', 'resistance'] as const).flatMap((side) => {
    const maxOi = sideMaxOi(levels, side);
    return levels
      .filter((level) => level.side === side)
      .sort((a, b) => {
        const scoreA = a.score / 100;
        const scoreB = b.score / 100;
        const oiA = a.oi / maxOi;
        const oiB = b.oi / maxOi;
        const valueA = instrumentType === 'stock'
          ? horizon === 'intraday'
            ? scoreA * 0.6 + oiA * 0.15 + a.features.volumeConfirmation * 0.15 + a.features.proximity * 0.1
            : scoreA * 0.62 + oiA * 0.12 + a.features.clusterOi * 0.1 + a.features.volumeConfirmation * 0.08 + a.features.persistence * 0.08
          : horizon === 'intraday'
            ? scoreA * 0.55 + oiA * 0.25 + a.features.proximity * 0.2
            : scoreA * 0.55 + oiA * 0.2 + a.features.clusterOi * 0.15 + a.features.persistence * 0.1;
        const valueB = instrumentType === 'stock'
          ? horizon === 'intraday'
            ? scoreB * 0.6 + oiB * 0.15 + b.features.volumeConfirmation * 0.15 + b.features.proximity * 0.1
            : scoreB * 0.62 + oiB * 0.12 + b.features.clusterOi * 0.1 + b.features.volumeConfirmation * 0.08 + b.features.persistence * 0.08
          : horizon === 'intraday'
            ? scoreB * 0.55 + oiB * 0.25 + b.features.proximity * 0.2
            : scoreB * 0.55 + oiB * 0.2 + b.features.clusterOi * 0.15 + b.features.persistence * 0.1;
        return valueB - valueA || a.distancePoints - b.distancePoints;
      })
      .slice(0, 3)
      .map((level, index) => ({ ...level, rank: index + 1 }));
  });
}

function outcomePrior(
  observations: HistoricalLevelObservation[],
  instrument: string,
  asOf: string,
  side: LevelSide,
): OutcomePrior {
  const matching = filterSixMonthObservations(observations, instrument, asOf)
    .filter((observation) => observation.side === side);
  const held = matching.filter((observation) => observation.held).length;
  // Beta(3,3) shrinkage prevents a handful of old stock outcomes from
  // producing an extreme support/resistance score.
  return {
    samples: matching.length,
    holdRate: (held + 3) / (matching.length + 6),
    confidence: 1 - Math.exp(-matching.length / 12),
  };
}

function rangePositionFor(levels: ScoredCandidate[], spot: number) {
  const support = levels.find((level) => level.side === 'support' && level.rank === 1) ?? null;
  const resistance = levels.find((level) => level.side === 'resistance' && level.rank === 1) ?? null;
  const range = support && resistance ? resistance.strike - support.strike : 0;
  return range > 0 && support ? clamp((spot - support.strike) / range) : null;
}

function positionalHorizon(snapshot: MarketSnapshot) {
  // The positional card still represents the current session when the
  // contract expires today, while stored forward outcomes are skipped.
  return Math.max(1, tradingSessionsUntilExpiry(snapshot.asOf, snapshot.expiryEpoch, POSITIONAL_HORIZON_SESSIONS));
}

function makeTimeframe(
  horizon: 'intraday' | 'positional',
  levels: ScoredCandidate[],
  snapshot: MarketSnapshot,
  options: {
    horizonLabel: string;
    zoneWidth: number;
    invalidationDistance: number;
    oiHistorySnapshots: number;
    historicalTests: number;
    historicalHoldRate: number | null;
    note: string;
  },
): TimeframeAnalysis {
  const primarySupport = levels.find((level) => level.side === 'support' && level.rank === 1) ?? null;
  const primaryResistance = levels.find((level) => level.side === 'resistance' && level.rank === 1) ?? null;
  return {
    horizon,
    label: horizon === 'intraday' ? 'Intraday OI map' : 'Positional price-zone map',
    horizonLabel: options.horizonLabel,
    levels,
    primarySupport,
    primaryResistance,
    rangePosition: rangePositionFor(levels, snapshot.spot),
    zoneWidth: options.zoneWidth,
    invalidationDistance: options.invalidationDistance,
    oiHistorySnapshots: options.oiHistorySnapshots,
    historicalTests: options.historicalTests,
    historicalHoldRate: options.historicalHoldRate,
    note: options.note,
  };
}

export function analyzeSnapshot(
  snapshot: MarketSnapshot,
  observations: HistoricalLevelObservation[] = [],
  persistence: Record<string, number> = {},
): MarketAnalysis {
  const model = calibrateModel(observations, snapshot.symbol, snapshot.asOf);
  const zoneWidth = Math.max(snapshot.atr14 * 0.18, snapshot.strikeStep * 0.35);
  const invalidationDistance = Math.max(snapshot.atr14 * 0.25, snapshot.strikeStep * 0.2);
  const scored: ScoredCandidate[] = candidates(snapshot, persistence).map((candidate) => {
    const probability = predict(model, candidate.features);
    return {
      ...candidate,
      rank: 0,
      probability,
      score: Math.round(probability * 100),
      distancePoints: Math.abs(snapshot.spot - candidate.strike),
      distancePercent: (Math.abs(snapshot.spot - candidate.strike) / snapshot.spot) * 100,
      zoneLow: candidate.strike - zoneWidth,
      zoneHigh: candidate.strike + zoneWidth,
      invalidation: candidate.side === 'support'
        ? candidate.strike - invalidationDistance
        : candidate.strike + invalidationDistance,
      historicalTests: 0,
      historicalHoldRate: null,
      oiHistorySnapshots: 0,
    };
  });
  const levels = rankLevels(scored, 'positional', snapshot.instrumentType);
  const intradayLevels = rankLevels(scored, 'intraday', snapshot.instrumentType);
  const positional = makeTimeframe('positional', levels, snapshot, {
    horizonLabel: `Up to ${positionalHorizon(snapshot)} trading sessions`,
    zoneWidth,
    invalidationDistance,
    oiHistorySnapshots: 0,
    historicalTests: 0,
    historicalHoldRate: null,
    note: 'Legacy calibrated view. New live requests use the separate intraday and positional evidence paths.',
  });
  const intraday = makeTimeframe('intraday', intradayLevels, snapshot, {
    horizonLabel: 'Current session',
    zoneWidth: Math.max(snapshot.atr14 * 0.1, snapshot.strikeStep * 0.25),
    invalidationDistance,
    oiHistorySnapshots: 0,
    historicalTests: 0,
    historicalHoldRate: null,
    note: 'Legacy calibrated view. New live requests require saved intraday snapshots before using OI-flow evidence.',
  });
  const totalPutOi = snapshot.chain.reduce((sum, row) => sum + row.putOi, 0);
  const totalCallOi = snapshot.chain.reduce((sum, row) => sum + row.callOi, 0);

  return {
    snapshot,
    intraday,
    positional,
    levels,
    primarySupport: positional.primarySupport,
    primaryResistance: positional.primaryResistance,
    putCallRatio: totalCallOi ? totalPutOi / totalCallOi : 0,
    maxPain: maxPain(snapshot),
    rangePosition: positional.rangePosition,
    diagnostics: model.diagnostics,
  };
}

export function atrFromPriceHistory(history: PriceSession[], period = 14) {
  if (history.length < 2) return 0;
  const trueRanges = history.slice(1).map((session, index) => {
    const previousClose = history[index].close;
    return Math.max(
      session.high - session.low,
      Math.abs(session.high - previousClose),
      Math.abs(session.low - previousClose),
    );
  });
  const selected = trueRanges.slice(-period);
  return selected.reduce((sum, value) => sum + value, 0) / Math.max(1, selected.length);
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function historicalZoneStats(
  history: PriceSession[],
  strike: number,
  side: LevelSide,
  atr: number,
  strikeStep: number,
): ZoneHistoryStats {
  let tests = 0;
  let holds = 0;
  let weightedTests = 0;
  let weightedHolds = 0;

  for (let index = 1; index < history.length - 3; index += 1) {
    const session = history[index];
    const previous = history[index - 1];
    // Use only volatility observable on or before the test.  Applying today's
    // ATR to all six months makes old, quiet sessions look artificially loose.
    const historicalAtr = atrFromPriceHistory(history.slice(0, index + 1)) || atr;
    const touchTolerance = Math.max(historicalAtr * 0.18, strikeStep * 0.35);
    const breachTolerance = Math.max(historicalAtr * 0.25, strikeStep * 0.2);
    const approachedFromExpectedSide = side === 'support'
      ? previous.close >= strike - touchTolerance
      : previous.close <= strike + touchTolerance;
    const touched = session.low <= strike + touchTolerance && session.high >= strike - touchTolerance;
    if (!approachedFromExpectedSide || !touched) continue;
    const outcome = history.slice(index, index + 4);
    const breached = outcome.some((item) => side === 'support'
      ? item.close < strike - breachTolerance
      : item.close > strike + breachTolerance);
    const finalClose = outcome.at(-1)?.close ?? session.close;
    const recovered = side === 'support' ? finalClose >= strike : finalClose <= strike;
    const held = !breached && recovered;
    const recencyWeight = Math.exp(-(history.length - 1 - index) / 63);
    tests += 1;
    holds += Number(held);
    weightedTests += recencyWeight;
    weightedHolds += held ? recencyWeight : 0;
    index += 2;
  }

  const weightedHoldRate = (weightedHolds + 1) / (weightedTests + 2);
  const confidence = 1 - Math.exp(-tests / 4);
  return { tests, holds, weightedHoldRate, confidence };
}

export function analyzeSnapshotWithPriceHistory(
  snapshot: MarketSnapshot,
  priceHistory: PriceSession[],
  oiHistory: OiHistoryContext = { intraday: [], positional: [] },
  historicalOiObservations: HistoricalLevelObservation[] = [],
): MarketAnalysis {
  const asOfDate = snapshot.asOf.slice(0, 10);
  const history = priceHistory
    .filter((session) => isValidDate(session.date) && session.date < asOfDate)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-140);
  const calculatedAtr = atrFromPriceHistory(history);
  const lastSession = history.at(-1);
  const calculatedChange = lastSession && lastSession.close > 0
    ? ((snapshot.spot - lastSession.close) / lastSession.close) * 100
    : snapshot.spotChangePercent;
  const liveSnapshot = {
    ...snapshot,
    atr14: calculatedAtr > 0 ? calculatedAtr : snapshot.atr14,
    spotChangePercent: snapshot.spotChangePercent !== 0 ? snapshot.spotChangePercent : calculatedChange,
  };
  const recentRanges = history.slice(-63).map((session) => session.high - session.low);
  const typicalRange = median(recentRanges);
  const regimeFit = typicalRange > 0
    ? clamp(1 - Math.abs(Math.log(liveSnapshot.atr14 / typicalRange)) / 1.5)
    : 0.5;
  const baseCandidates = candidates(liveSnapshot, {});
  const oiOutcomeModel = calibrateModel(historicalOiObservations, liveSnapshot.symbol, liveSnapshot.asOf);
  const useCalibratedOiOutcomes = oiOutcomeModel.diagnostics.mode === 'calibrated';
  const supportPrior = outcomePrior(historicalOiObservations, liveSnapshot.symbol, liveSnapshot.asOf, 'support');
  const resistancePrior = outcomePrior(historicalOiObservations, liveSnapshot.symbol, liveSnapshot.asOf, 'resistance');
  const isStock = liveSnapshot.instrumentType === 'stock';
  const positionalZoneWidth = Math.max(
    liveSnapshot.atr14 * (isStock ? 0.24 : 0.18),
    liveSnapshot.strikeStep * (isStock ? 0.45 : 0.35),
  );
  const intradayZoneWidth = Math.max(
    liveSnapshot.atr14 * (isStock ? 0.14 : 0.1),
    liveSnapshot.strikeStep * (isStock ? 0.3 : 0.25),
  );
  const positionalInvalidation = Math.max(
    liveSnapshot.atr14 * (isStock ? 0.32 : 0.25),
    liveSnapshot.strikeStep * (isStock ? 0.3 : 0.2),
  );
  const intradayInvalidation = Math.max(
    liveSnapshot.atr14 * (isStock ? 0.2 : 0.16),
    liveSnapshot.strikeStep * (isStock ? 0.2 : 0.15),
  );

  const positionalScored: ScoredCandidate[] = baseCandidates.map((candidate) => {
    const historyStats = historicalZoneStats(
      history,
      candidate.strike,
      candidate.side,
      liveSnapshot.atr14,
      liveSnapshot.strikeStep,
    );
    const historicalDefense = 0.5 * (1 - historyStats.confidence)
      + historyStats.weightedHoldRate * historyStats.confidence;
    const continuity = oiContinuity(candidate, oiHistory.positional);
    const features: LevelFeatures = {
      ...candidate.features,
      // Price-zone memory and same-expiry OI persistence are independent
      // inputs.  The price history remains dominant until the archive has
      // enough chain snapshots to contribute meaningful evidence.
      persistence: clamp(historicalDefense * 0.72 + (continuity.persistence ?? 0.5) * 0.28),
      regimeFit,
    };
    const oiChangeStrength = (features.oiChange + 1) / 2;
    const evidence = isStock
      ? features.clusterOi * 0.24
        + oiChangeStrength * 0.14
        + features.volumeConfirmation * 0.16
        + features.proximity * 0.08
        + historicalDefense * 0.22
        + (continuity.persistence ?? 0.5) * 0.1
        + features.regimeFit * 0.06
      : features.clusterOi * 0.26
        + oiChangeStrength * 0.14
        + features.volumeConfirmation * 0.1
        + features.proximity * 0.1
        + historicalDefense * 0.28
        + (continuity.persistence ?? 0.5) * 0.08
        + features.regimeFit * 0.04;
    const outcomeProbability = useCalibratedOiOutcomes ? predict(oiOutcomeModel, features) : null;
    const prior = candidate.side === 'support' ? supportPrior : resistancePrior;
    // Once D1 contains enough time-ordered, evaluated OI walls, let their
    // observed outcomes materially influence the positional ranking. Until
    // then the deterministic live-OI + price-zone score remains in charge.
    const outcomeWeight = outcomeProbability !== null
      ? (isStock ? 0.5 : 0.4)
      : (isStock ? prior.confidence * 0.22 : 0);
    const historicalOiEvidence = outcomeProbability ?? prior.holdRate;
    const calibratedEvidence = evidence * (1 - outcomeWeight) + historicalOiEvidence * outcomeWeight;
    return {
      ...candidate,
      features,
      rank: 0,
      probability: outcomeProbability,
      score: Math.round(clamp(calibratedEvidence) * 100),
      distancePoints: Math.abs(liveSnapshot.spot - candidate.strike),
      distancePercent: (Math.abs(liveSnapshot.spot - candidate.strike) / liveSnapshot.spot) * 100,
      zoneLow: candidate.strike - positionalZoneWidth,
      zoneHigh: candidate.strike + positionalZoneWidth,
      invalidation: candidate.side === 'support'
        ? candidate.strike - positionalInvalidation
        : candidate.strike + positionalInvalidation,
      historicalTests: historyStats.tests,
      historicalHoldRate: historyStats.tests ? historyStats.weightedHoldRate : null,
      oiHistorySnapshots: continuity.samples,
    };
  });

  const intradayScored: ScoredCandidate[] = baseCandidates.map((candidate) => {
    const continuity = oiContinuity(candidate, oiHistory.intraday);
    // FYERS supplies an OI change relative to the previous *trading session*.
    // It must not be presented as an intraday change.  Intraday flow is only
    // used once this application has at least two saved live snapshots.
    const observedFlow = continuity.change ?? 0;
    const features: LevelFeatures = {
      ...candidate.features,
      oiChange: observedFlow,
      persistence: continuity.persistence ?? 0.5,
      regimeFit,
    };
    const evidence =
      features.clusterOi * 0.35
      + features.volumeConfirmation * 0.23
      + features.proximity * 0.18
      + ((observedFlow + 1) / 2) * 0.15
      + features.persistence * 0.09;
    return {
      ...candidate,
      features,
      rank: 0,
      probability: null,
      score: Math.round(clamp(evidence) * 100),
      distancePoints: Math.abs(liveSnapshot.spot - candidate.strike),
      distancePercent: (Math.abs(liveSnapshot.spot - candidate.strike) / liveSnapshot.spot) * 100,
      zoneLow: candidate.strike - intradayZoneWidth,
      zoneHigh: candidate.strike + intradayZoneWidth,
      invalidation: candidate.side === 'support'
        ? candidate.strike - intradayInvalidation
        : candidate.strike + intradayInvalidation,
      historicalTests: 0,
      historicalHoldRate: null,
      oiHistorySnapshots: continuity.samples,
    };
  });

  const positionalLevels = rankLevels(positionalScored, 'positional', liveSnapshot.instrumentType);
  const intradayLevels = rankLevels(intradayScored, 'intraday', liveSnapshot.instrumentType);
  const primaryPositionalLevels = positionalLevels.filter((level) => level.rank === 1);
  const primaryHistoricalTests = primaryPositionalLevels.reduce((sum, level) => sum + level.historicalTests, 0);
  const primaryHistoricalHoldRate = primaryHistoricalTests
    ? primaryPositionalLevels.reduce(
      (sum, level) => sum + (level.historicalHoldRate ?? 0) * level.historicalTests,
      0,
    ) / primaryHistoricalTests
    : null;
  const positionalSessions = positionalHorizon(liveSnapshot);
  const positional = makeTimeframe('positional', positionalLevels, liveSnapshot, {
    horizonLabel: `Up to ${positionalSessions} trading session${positionalSessions === 1 ? '' : 's'} or expiry`,
    zoneWidth: positionalZoneWidth,
    invalidationDistance: positionalInvalidation,
    oiHistorySnapshots: oiHistory.positional.length,
    historicalTests: primaryHistoricalTests,
    historicalHoldRate: primaryHistoricalHoldRate,
    note: useCalibratedOiOutcomes
      ? `${isStock ? 'Stock-specific model' : 'Index model'}: ${oiOutcomeModel.diagnostics.samples} same-instrument Cloudflare D1 OI-wall outcomes from the previous six months calibrate the ranking. Current OI, volume, price-zone tests and up to ${OI_HISTORY_LOOKBACK_DAYS} days of same-expiry continuity provide the live context.`
      : isStock
        ? `Stock-specific provisional model: ${supportPrior.samples + resistancePrior.samples} same-stock D1 OI outcomes contribute a conservative historical hold prior. Current OI cluster, option liquidity, ATR zones and price history remain dominant until ${MIN_CALIBRATION_SAMPLES} tested outcomes are available.`
        : `Current OI supplies candidate zones. Six-month daily price-zone tests supply the historical defence evidence; same-expiry OI continuity uses up to ${OI_HISTORY_LOOKBACK_DAYS} saved calendar days. ${oiOutcomeModel.diagnostics.samples} evaluated D1 OI outcomes are available; ${MIN_CALIBRATION_SAMPLES} are required before outcome calibration is activated.`,
  });
  const intraday = makeTimeframe('intraday', intradayLevels, liveSnapshot, {
    horizonLabel: 'Current trading session',
    zoneWidth: intradayZoneWidth,
    invalidationDistance: intradayInvalidation,
    oiHistorySnapshots: oiHistory.intraday.length,
    historicalTests: 0,
    historicalHoldRate: null,
    note: oiHistory.intraday.length >= 2
      ? `Live OI cluster, liquidity, distance and ${oiHistory.intraday.length} saved same-expiry snapshots from this session. This is a positioning-strength map, not a backtested intraday probability.`
      : 'Live OI cluster, liquidity and distance only. Daily candles cannot validate intraday reactions; refresh during the session to accumulate same-expiry OI-flow evidence.',
  });
  const totalPutOi = liveSnapshot.chain.reduce((sum, row) => sum + row.putOi, 0);
  const totalCallOi = liveSnapshot.chain.reduce((sum, row) => sum + row.callOi, 0);

  // ─── Current confluence: OI wall vs confirmed price S/R ──────────────
  let currentConfluence: CurrentConfluenceReport | undefined;
  if (history.length >= 10 && (positional.primarySupport || positional.primaryResistance)) {
    const pivots = findConfirmedPivots(history);
    const zones = groupPivotsIntoZones(pivots, history, liveSnapshot.atr14, liveSnapshot.strikeStep);
    const supportDetail = positional.primarySupport
      ? {
          oiWall: positional.primarySupport.strike,
          oiStrength: positional.primarySupport.score,
          ...buildConfluenceInfo(zones, positional.primarySupport.strike, 'support', liveSnapshot.atr14, liveSnapshot.strikeStep),
        }
      : null;
    const resistanceDetail = positional.primaryResistance
      ? {
          oiWall: positional.primaryResistance.strike,
          oiStrength: positional.primaryResistance.score,
          ...buildConfluenceInfo(zones, positional.primaryResistance.strike, 'resistance', liveSnapshot.atr14, liveSnapshot.strikeStep),
        }
      : null;
    currentConfluence = { support: supportDetail, resistance: resistanceDetail };
  }

  return {
    snapshot: liveSnapshot,
    intraday,
    positional,
    // Preserve the previous surface as the more evidence-rich positional map.
    levels: positional.levels,
    primarySupport: positional.primarySupport,
    primaryResistance: positional.primaryResistance,
    putCallRatio: totalCallOi ? totalPutOi / totalCallOi : 0,
    maxPain: maxPain(liveSnapshot),
    rangePosition: positional.rangePosition,
    diagnostics: useCalibratedOiOutcomes ? { ...oiOutcomeModel.diagnostics, note: positional.note } : {
      mode: 'historical',
      lookbackStart: history[0]?.date ?? isoDate(new Date(Date.parse(snapshot.asOf) - SIX_MONTH_DAYS * DAY)),
      lookbackEnd: history.at(-1)?.date ?? isoDate(new Date(Date.parse(snapshot.asOf) - DAY)),
      samples: primaryHistoricalTests,
      validationSamples: history.length,
      holdRate: primaryHistoricalHoldRate ?? 0,
      balancedAccuracy: null,
      brierScore: null,
      note: positional.note,
    },
    currentConfluence,
  };
}

export function labelLevelOutcome(
  level: number,
  side: LevelSide,
  atr: number,
  futureSessions: PriceSession[],
) {
  const touchTolerance = atr * 0.15;
  const breachTolerance = atr * 0.25;
  const tested = futureSessions.some((session) =>
    side === 'support' ? session.low <= level + touchTolerance : session.high >= level - touchTolerance,
  );
  if (!tested) return { tested: false, held: false };
  const breached = futureSessions.some((session) =>
    side === 'support' ? session.close < level - breachTolerance : session.close > level + breachTolerance,
  );
  const lastClose = futureSessions.at(-1)?.close ?? level;
  const recovered = side === 'support' ? lastClose >= level : lastClose <= level;
  return { tested: true, held: !breached && recovered };
}
