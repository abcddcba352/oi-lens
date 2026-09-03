/**
 * model-comparison.ts
 *
 * Pure module for comparing three regularised logistic models on the same
 * historical OI-wall observations:
 *   1. OI-only      — uses the 6 existing OI features
 *   2. Price-only    — uses 5 price S/R features from price-levels.ts
 *   3. Hybrid        — uses all 11 features + a confluence indicator (12 total)
 *
 * All three models receive IDENTICAL wall declarations with IDENTICAL outcomes.
 * No model gets an easier target.
 *
 * No database or network calls.  Testable with in-memory data only.
 */

import type { LevelFeatures, LevelSide, ModelReport } from './market-types.ts';
import type { PriceSRFeatureVector } from './price-levels.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ComparisonObservation {
  sessionDate: string;
  side: LevelSide;
  strike: number;
  held: boolean;
  oiFeatures: LevelFeatures;
  priceFeatures: PriceSRFeatureVector;
}

export interface ComparisonResult {
  oiOnly: ModelReport;
  priceOnly: ModelReport;
  hybrid: ModelReport;
  winner: 'oi' | 'price' | 'hybrid' | 'insufficient';
  hybridApproved: boolean;
  coefficientContributions: { oi: number; price: number; confluence: number; label: string } | null;
  hybridCoefficients: { weights: number[]; bias: number } | null;
  standardization: { means: number[]; stds: number[] } | null;
  explanation: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_TOTAL_SAMPLES = 40;
const MIN_VALIDATION_SAMPLES = 10;
const BRIER_IMPROVEMENT_THRESHOLD = 0.01;
const BALANCED_ACCURACY_DROP_TOLERANCE = 0.03;
const PURGE_GAP = 3;
const LEARNING_RATE = 0.12;
const L2_REGULARIZATION = 0.08;
const ITERATIONS = 700;

// ─── Logistic regression (mirrors oi-model.ts) ───────────────────────────────

function sigmoid(value: number) {
  if (value >= 0) {
    const exp = Math.exp(-value);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function logit(probability: number) {
  const p = clamp(probability, 0.05, 0.95);
  return Math.log(p / (1 - p));
}

interface FittedModel {
  intercept: number;
  coefficients: number[];
}

function fitLogistic(
  features: number[][],
  labels: boolean[],
): FittedModel {
  const n = features.length;
  if (n === 0) return { intercept: 0, coefficients: [] };
  const dim = features[0].length;

  const positives = labels.filter(Boolean).length;
  let intercept = logit(positives / Math.max(1, n));
  const coefficients = Array.from({ length: dim }, () => 0);
  const positiveWeight = n / Math.max(1, 2 * positives);
  const negativeWeight = n / Math.max(1, 2 * (n - positives));

  for (let iter = 0; iter < ITERATIONS; iter++) {
    let interceptGradient = 0;
    const gradients = Array.from({ length: dim }, () => 0);

    for (let i = 0; i < n; i++) {
      const x = features[i];
      let z = intercept;
      for (let j = 0; j < dim; j++) z += coefficients[j] * x[j];
      const prediction = sigmoid(z);
      const weight = labels[i] ? positiveWeight : negativeWeight;
      const error = (prediction - Number(labels[i])) * weight;
      interceptGradient += error;
      for (let j = 0; j < dim; j++) gradients[j] += error * x[j];
    }

    intercept -= (LEARNING_RATE * interceptGradient) / n;
    for (let j = 0; j < dim; j++) {
      coefficients[j] -= LEARNING_RATE * (gradients[j] / n + L2_REGULARIZATION * coefficients[j]);
    }
  }

  return { intercept, coefficients };
}

function predictModel(model: FittedModel, x: number[]): number {
  let z = model.intercept;
  for (let j = 0; j < model.coefficients.length; j++) z += model.coefficients[j] * x[j];
  return sigmoid(z);
}

// ─── Feature extraction ──────────────────────────────────────────────────────

const OI_FEATURE_NAMES = [
  'clusterOi', 'oiChange', 'volumeConfirmation', 'proximity', 'persistence', 'regimeFit',
] as const;

const PRICE_FEATURE_NAMES = [
  'priceHoldRate', 'priceTouches', 'priceBounceAtr', 'priceRecency', 'priceDistance',
] as const;

function oiFeatureVector(f: LevelFeatures): number[] {
  return OI_FEATURE_NAMES.map((name) => f[name]);
}

function priceFeatureVector(f: PriceSRFeatureVector): number[] {
  return PRICE_FEATURE_NAMES.map((name) => f[name] as number);
}

function hybridFeatureVector(oi: LevelFeatures, price: PriceSRFeatureVector): number[] {
  return [
    ...oiFeatureVector(oi),
    ...priceFeatureVector(price),
    price.isConfluent ? 1 : 0,
  ];
}

// ─── Validation metrics ──────────────────────────────────────────────────────

function computeMetrics(
  model: FittedModel,
  features: number[][],
  labels: boolean[],
): { balancedAccuracy: number; brierScore: number } {
  let truePositive = 0;
  let trueNegative = 0;
  let positive = 0;
  let negative = 0;
  let brier = 0;

  for (let i = 0; i < features.length; i++) {
    const probability = predictModel(model, features[i]);
    const predicted = probability >= 0.5;
    if (labels[i]) {
      positive++;
      if (predicted) truePositive++;
    } else {
      negative++;
      if (!predicted) trueNegative++;
    }
    brier += (probability - Number(labels[i])) ** 2;
  }

  const sensitivity = positive ? truePositive / positive : 0.5;
  const specificity = negative ? trueNegative / negative : 0.5;
  return {
    balancedAccuracy: (sensitivity + specificity) / 2,
    brierScore: brier / Math.max(1, features.length),
  };
}

// ─── Training-only standardization ───────────────────────────────────────────

interface StandardizationParams {
  means: number[];
  stds: number[];
}

/**
 * Compute z-score standardisation parameters from training data ONLY.
 * Zero-variance features use std = 1.0 to prevent NaN/Infinity.
 */
function computeStandardization(features: number[][]): StandardizationParams {
  if (features.length === 0) return { means: [], stds: [] };
  const dim = features[0].length;
  const means: number[] = Array.from({ length: dim }, () => 0);
  const stds: number[] = Array.from({ length: dim }, () => 1);

  for (let j = 0; j < dim; j++) {
    let sum = 0;
    for (const row of features) sum += row[j];
    means[j] = sum / features.length;

    let variance = 0;
    for (const row of features) variance += (row[j] - means[j]) ** 2;
    variance /= Math.max(1, features.length - 1);
    stds[j] = Math.sqrt(variance) || 1.0; // fallback 1.0 for zero-variance
  }
  return { means, stds };
}

/** Apply z-score standardisation using pre-computed parameters. */
function standardize(features: number[][], params: StandardizationParams): number[][] {
  return features.map((row) =>
    row.map((val, j) => (val - params.means[j]) / params.stds[j]),
  );
}

// ─── Main comparison ─────────────────────────────────────────────────────────

/**
 * Run the three-model comparison on a set of historical wall observations.
 *
 * All three models use the exact same observations, same outcomes, same
 * chronological train/validation split with a 3-observation purge gap.
 *
 * @param observations  Array of ComparisonObservation, one per declared OI wall.
 *                      Must be from the same instrument's previous 6 months.
 * @returns ComparisonResult with reports for each model and the winner.
 */
export function runModelComparison(
  observations: ComparisonObservation[],
): ComparisonResult {
  // Sort chronologically — NEVER shuffle time-series
  const sorted = [...observations].sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
  const n = sorted.length;

  const insufficient: ComparisonResult = {
    oiOnly: emptyReport(sorted),
    priceOnly: emptyReport(sorted),
    hybrid: emptyReport(sorted),
    winner: 'insufficient',
    hybridApproved: false,
    coefficientContributions: null,
    hybridCoefficients: null,
    standardization: null,
    explanation: `Insufficient data: ${n} tested wall${n === 1 ? '' : 's'} available, need at least ${MIN_TOTAL_SAMPLES}. Current OI-based model remains active.`,
  };

  if (n < MIN_TOTAL_SAMPLES) return insufficient;

  // Chronological split: ~80% train, ~20% validation with purge gap
  const validationStart = Math.floor(n * 0.8);
  const trainEnd = Math.max(1, validationStart - PURGE_GAP);
  const train = sorted.slice(0, trainEnd);
  const validation = sorted.slice(validationStart);

  if (validation.length < MIN_VALIDATION_SAMPLES) {
    return {
      ...insufficient,
      explanation: `Insufficient validation data: ${validation.length} validation observations, need at least ${MIN_VALIDATION_SAMPLES}. Current OI-based model remains active.`,
    };
  }

  // Check both outcomes exist in train and validation
  const trainHeld = train.filter((o) => o.held).length;
  const trainBroken = train.length - trainHeld;
  const valHeld = validation.filter((o) => o.held).length;
  const valBroken = validation.length - valHeld;

  if (trainHeld === 0 || trainBroken === 0 || valHeld === 0 || valBroken === 0) {
    return {
      ...insufficient,
      explanation: 'Both held and broken outcomes must exist in training and validation sets. Current OI-based model remains active.',
    };
  }

  // Extract raw feature arrays
  const trainOiRaw = train.map((o) => oiFeatureVector(o.oiFeatures));
  const trainPriceRaw = train.map((o) => priceFeatureVector(o.priceFeatures));
  const trainHybridRaw = train.map((o) => hybridFeatureVector(o.oiFeatures, o.priceFeatures));
  const trainLabels = train.map((o) => o.held);

  const valOiRaw = validation.map((o) => oiFeatureVector(o.oiFeatures));
  const valPriceRaw = validation.map((o) => priceFeatureVector(o.priceFeatures));
  const valHybridRaw = validation.map((o) => hybridFeatureVector(o.oiFeatures, o.priceFeatures));
  const valLabels = validation.map((o) => o.held);

  // Compute standardisation from TRAINING data only
  const oiStd = computeStandardization(trainOiRaw);
  const priceStd = computeStandardization(trainPriceRaw);
  const hybridStd = computeStandardization(trainHybridRaw);

  // Apply training-derived standardisation to both train and validation
  const trainOi = standardize(trainOiRaw, oiStd);
  const trainPrice = standardize(trainPriceRaw, priceStd);
  const trainHybrid = standardize(trainHybridRaw, hybridStd);
  const valOi = standardize(valOiRaw, oiStd);
  const valPrice = standardize(valPriceRaw, priceStd);
  const valHybrid = standardize(valHybridRaw, hybridStd);

  // Fit three models on standardised features
  const oiModel = fitLogistic(trainOi, trainLabels);
  const priceModel = fitLogistic(trainPrice, trainLabels);
  const hybridModel = fitLogistic(trainHybrid, trainLabels);

  // Validate on standardised features
  const oiMetrics = computeMetrics(oiModel, valOi, valLabels);
  const priceMetrics = computeMetrics(priceModel, valPrice, valLabels);
  const hybridMetrics = computeMetrics(hybridModel, valHybrid, valLabels);

  // Build reports — sample counts from validation set, not full dataset
  const buildReport = (
    metrics: { balancedAccuracy: number; brierScore: number },
    trainObs: ComparisonObservation[],
    valObs: ComparisonObservation[],
  ): ModelReport => ({
    trainingSamples: trainObs.length,
    validationSamples: valObs.length,
    balancedAccuracy: metrics.balancedAccuracy,
    brierScore: metrics.brierScore,
    holdRate: valObs.filter((o) => o.held).length / Math.max(1, valObs.length),
    trainingSupportSamples: trainObs.filter((o) => o.side === 'support').length,
    trainingResistanceSamples: trainObs.filter((o) => o.side === 'resistance').length,
    validationSupportSamples: valObs.filter((o) => o.side === 'support').length,
    validationResistanceSamples: valObs.filter((o) => o.side === 'resistance').length,
    status: 'calibrated',
  });

  const oiReport = buildReport(oiMetrics, train, validation);
  const priceReport = buildReport(priceMetrics, train, validation);
  const hybridReport = buildReport(hybridMetrics, train, validation);

  // Safety gates for hybrid adoption
  const brierImprovesOverOi = (oiMetrics.brierScore - hybridMetrics.brierScore) >= BRIER_IMPROVEMENT_THRESHOLD;
  const brierImprovesOverPrice = (priceMetrics.brierScore - hybridMetrics.brierScore) >= BRIER_IMPROVEMENT_THRESHOLD;
  const balancedAccuracyNotWorse = hybridMetrics.balancedAccuracy >= (
    Math.max(oiMetrics.balancedAccuracy, priceMetrics.balancedAccuracy) - BALANCED_ACCURACY_DROP_TOLERANCE
  );

  const hybridApproved = brierImprovesOverOi && brierImprovesOverPrice && balancedAccuracyNotWorse;

  // Determine winner by Brier score (lower is better)
  let winner: ComparisonResult['winner'];
  if (hybridApproved) {
    winner = 'hybrid';
  } else if (oiMetrics.brierScore <= priceMetrics.brierScore) {
    winner = 'oi';
  } else {
    winner = 'price';
  }

  // Learned coefficient contributions (directional signed influence from hybrid)
  //
  // After standardisation, coefficients are on comparable scales.
  // We present the NET signed sum per group, NOT percentages, because:
  //   - Negative evidence must not be converted into positive trust
  //   - Aggregated |magnitudes| as % look like fixed trust allocations
  // The label warns that these are learned directional influences.
  let coefficientContributions: ComparisonResult['coefficientContributions'] = null;
  if (hybridModel.coefficients.length === 12) {
    const oiCoeffs = hybridModel.coefficients.slice(0, 6);
    const priceCoeffs = hybridModel.coefficients.slice(6, 11);
    const confluenceCoeff = hybridModel.coefficients[11];

    // Signed sum: positive = supports hold prediction, negative = supports break
    const oiNet = oiCoeffs.reduce((s, c) => s + c, 0);
    const priceNet = priceCoeffs.reduce((s, c) => s + c, 0);

    coefficientContributions = {
      oi: oiNet,
      price: priceNet,
      confluence: confluenceCoeff,
      label: 'Directional learned influence (z-scored features). Positive supports hold, negative supports break. Not a fixed weight allocation.',
    };
  }

  // Explanation
  let explanation: string;
  if (hybridApproved) {
    explanation = `Hybrid model beats both OI-only (Brier ${oiMetrics.brierScore.toFixed(3)} → ${hybridMetrics.brierScore.toFixed(3)}) and price-only (Brier ${priceMetrics.brierScore.toFixed(3)} → ${hybridMetrics.brierScore.toFixed(3)}) on ${validation.length} unseen validation observations. Validated Hybrid Confidence is displayed alongside the unchanged OI Strength.`;
  } else {
    const reasons: string[] = [];
    if (!brierImprovesOverOi) reasons.push(`Brier did not improve by ≥${BRIER_IMPROVEMENT_THRESHOLD} over OI-only`);
    if (!brierImprovesOverPrice) reasons.push(`Brier did not improve by ≥${BRIER_IMPROVEMENT_THRESHOLD} over price-only`);
    if (!balancedAccuracyNotWorse) reasons.push('balanced accuracy dropped too much');
    explanation = `No proven hybrid improvement yet. ${reasons.join('; ')}. Current OI-based model remains active.`;
  }

  return {
    oiOnly: oiReport,
    priceOnly: priceReport,
    hybrid: hybridReport,
    winner,
    hybridApproved,
    coefficientContributions,
    // Export hybrid model for live scoring only when approved
    hybridCoefficients: hybridApproved
      ? { weights: hybridModel.coefficients, bias: hybridModel.intercept }
      : null,
    standardization: hybridApproved ? hybridStd : null,
    explanation,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emptyReport(observations: ComparisonObservation[]): ModelReport {
  return {
    trainingSamples: 0,
    validationSamples: 0,
    balancedAccuracy: null,
    brierScore: null,
    holdRate: observations.length > 0
      ? observations.filter((o) => o.held).length / observations.length
      : 0,
    trainingSupportSamples: 0,
    trainingResistanceSamples: 0,
    validationSupportSamples: 0,
    validationResistanceSamples: 0,
    status: 'provisional',
  };
}
