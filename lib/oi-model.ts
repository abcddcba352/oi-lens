import {
  featureNames,
  type HistoricalLevelObservation,
  type LevelFeatures,
  type LevelSide,
  type MarketAnalysis,
  type MarketSnapshot,
  type ModelDiagnostics,
  type PriceSession,
} from './market-types.ts';

const DAY = 86_400_000;
const SIX_MONTH_DAYS = 183;
const MIN_CALIBRATION_SAMPLES = 40;
const PURGE_OBSERVATIONS = 3;
const CLUSTER_WEIGHTS = [0.25, 0.6, 1, 0.6, 0.25] as const;
const FALLBACK_COEFFICIENTS = [1.2, 0.8, 0.45, 0.35, 0.7, 0.3] as const;

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
  const regimeFit = clamp(1 - Math.abs(snapshot.ivPercentile - 0.5) * 0.7);
  const result: Candidate[] = [];

  chain.forEach((strike, index) => {
    const distance = Math.abs(snapshot.spot - strike.strike);
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
  return result;
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

export function analyzeSnapshot(
  snapshot: MarketSnapshot,
  observations: HistoricalLevelObservation[] = [],
  persistence: Record<string, number> = {},
): MarketAnalysis {
  const model = calibrateModel(observations, snapshot.symbol, snapshot.asOf);
  const scored = candidates(snapshot, persistence).map((candidate) => {
    const probability = predict(model, candidate.features);
    return {
      ...candidate,
      rank: 0,
      probability,
      score: Math.round(probability * 100),
      distancePoints: Math.abs(snapshot.spot - candidate.strike),
      distancePercent: (Math.abs(snapshot.spot - candidate.strike) / snapshot.spot) * 100,
    };
  });
  const levels = (['support', 'resistance'] as const).flatMap((side) =>
    scored
      .filter((level) => level.side === side)
      .sort((a, b) => b.probability - a.probability || a.distancePoints - b.distancePoints)
      .slice(0, 3)
      .map((level, index) => ({ ...level, rank: index + 1 })),
  );
  const primarySupport = levels.find((level) => level.side === 'support' && level.rank === 1) ?? null;
  const primaryResistance = levels.find((level) => level.side === 'resistance' && level.rank === 1) ?? null;
  const totalPutOi = snapshot.chain.reduce((sum, row) => sum + row.putOi, 0);
  const totalCallOi = snapshot.chain.reduce((sum, row) => sum + row.callOi, 0);
  const range = primarySupport && primaryResistance ? primaryResistance.strike - primarySupport.strike : 0;

  return {
    snapshot,
    levels,
    primarySupport,
    primaryResistance,
    putCallRatio: totalCallOi ? totalPutOi / totalCallOi : 0,
    maxPain: maxPain(snapshot),
    rangePosition: range > 0 && primarySupport ? clamp((snapshot.spot - primarySupport.strike) / range) : null,
    diagnostics: model.diagnostics,
  };
}

interface ZoneHistoryStats {
  tests: number;
  holds: number;
  weightedHoldRate: number;
  confidence: number;
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
  const touchTolerance = Math.max(atr * 0.18, strikeStep * 0.35);
  const breachTolerance = atr * 0.25;
  let tests = 0;
  let holds = 0;
  let weightedTests = 0;
  let weightedHolds = 0;

  for (let index = 1; index < history.length - 1; index += 1) {
    const session = history[index];
    const previous = history[index - 1];
    const approachedFromExpectedSide = side === 'support'
      ? previous.close >= strike - touchTolerance
      : previous.close <= strike + touchTolerance;
    const touched = session.low <= strike + touchTolerance && session.high >= strike - touchTolerance;
    if (!approachedFromExpectedSide || !touched) continue;
    const outcome = history.slice(index, Math.min(history.length, index + 4));
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
): MarketAnalysis {
  const asOfDate = snapshot.asOf.slice(0, 10);
  const history = priceHistory
    .filter((session) => isValidDate(session.date) && session.date < asOfDate)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-140);
  const calculatedAtr = atrFromPriceHistory(history);
  const liveSnapshot = { ...snapshot, atr14: calculatedAtr > 0 ? calculatedAtr : snapshot.atr14 };
  const recentRanges = history.slice(-63).map((session) => session.high - session.low);
  const typicalRange = median(recentRanges);
  const regimeFit = typicalRange > 0
    ? clamp(1 - Math.abs(Math.log(liveSnapshot.atr14 / typicalRange)) / 1.5)
    : 0.5;
  const baseCandidates = candidates(liveSnapshot, {});
  let totalTests = 0;
  let totalHolds = 0;

  const scored = baseCandidates.map((candidate) => {
    const historyStats = historicalZoneStats(
      history,
      candidate.strike,
      candidate.side,
      liveSnapshot.atr14,
      liveSnapshot.strikeStep,
    );
    totalTests += historyStats.tests;
    totalHolds += historyStats.holds;
    const historicalDefense = 0.5 * (1 - historyStats.confidence)
      + historyStats.weightedHoldRate * historyStats.confidence;
    const features: LevelFeatures = {
      ...candidate.features,
      persistence: historicalDefense,
      regimeFit,
    };
    const oiChangeStrength = (features.oiChange + 1) / 2;
    const evidence =
      features.clusterOi * 0.30
      + oiChangeStrength * 0.16
      + features.volumeConfirmation * 0.12
      + features.proximity * 0.12
      + features.persistence * 0.24
      + features.regimeFit * 0.06;
    const probability = clamp(0.12 + evidence * 0.78, 0.05, 0.95);
    return {
      ...candidate,
      features,
      rank: 0,
      probability,
      score: Math.round(probability * 100),
      distancePoints: Math.abs(liveSnapshot.spot - candidate.strike),
      distancePercent: (Math.abs(liveSnapshot.spot - candidate.strike) / liveSnapshot.spot) * 100,
    };
  });

  const levels = (['support', 'resistance'] as const).flatMap((side) =>
    scored
      .filter((level) => level.side === side)
      .sort((a, b) => b.probability - a.probability || a.distancePoints - b.distancePoints)
      .slice(0, 3)
      .map((level, index) => ({ ...level, rank: index + 1 })),
  );
  const primarySupport = levels.find((level) => level.side === 'support' && level.rank === 1) ?? null;
  const primaryResistance = levels.find((level) => level.side === 'resistance' && level.rank === 1) ?? null;
  const totalPutOi = liveSnapshot.chain.reduce((sum, row) => sum + row.putOi, 0);
  const totalCallOi = liveSnapshot.chain.reduce((sum, row) => sum + row.callOi, 0);
  const range = primarySupport && primaryResistance ? primaryResistance.strike - primarySupport.strike : 0;

  return {
    snapshot: liveSnapshot,
    levels,
    primarySupport,
    primaryResistance,
    putCallRatio: totalCallOi ? totalPutOi / totalCallOi : 0,
    maxPain: maxPain(liveSnapshot),
    rangePosition: range > 0 && primarySupport ? clamp((liveSnapshot.spot - primarySupport.strike) / range) : null,
    diagnostics: {
      mode: 'historical',
      lookbackStart: history[0]?.date ?? isoDate(new Date(Date.parse(snapshot.asOf) - SIX_MONTH_DAYS * DAY)),
      lookbackEnd: history.at(-1)?.date ?? isoDate(new Date(Date.parse(snapshot.asOf) - DAY)),
      samples: totalTests,
      validationSamples: history.length,
      holdRate: totalHolds / Math.max(1, totalTests),
      balancedAccuracy: null,
      brierScore: null,
      note: 'No snapshots are stored. Current OI is confirmed by six months of FYERS daily price-zone tests, weighted toward recent sessions.',
    },
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
