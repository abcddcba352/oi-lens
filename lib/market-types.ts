export type LevelSide = 'support' | 'resistance';

export interface ChainStrike {
  strike: number;
  callOi: number;
  callOiChange: number;
  callVolume: number;
  callIv?: number;
  putOi: number;
  putOiChange: number;
  putVolume: number;
  putIv?: number;
}

export interface MarketSnapshot {
  symbol: string;
  displayName: string;
  instrumentType: 'index' | 'stock';
  spot: number;
  spotChangePercent: number;
  expiry: string;
  expiryEpoch?: number;
  strikeStep: number;
  atr14: number;
  ivPercentile: number;
  asOf: string;
  source: 'fyers' | 'demo' | 'nse-bhavcopy';
  chain: ChainStrike[];
}

export interface LevelFeatures {
  clusterOi: number;
  oiChange: number;
  volumeConfirmation: number;
  proximity: number;
  persistence: number;
  regimeFit: number;
}

export const featureNames = [
  'clusterOi',
  'oiChange',
  'volumeConfirmation',
  'proximity',
  'persistence',
  'regimeFit',
] as const satisfies readonly (keyof LevelFeatures)[];

export interface HistoricalLevelObservation {
  instrument: string;
  sessionDate: string;
  side: LevelSide;
  strike: number;
  tested: boolean;
  held: boolean;
  features: LevelFeatures;
}

export interface ModelDiagnostics {
  mode: 'calibrated' | 'historical' | 'provisional';
  lookbackStart: string;
  lookbackEnd: string;
  samples: number;
  validationSamples: number;
  holdRate: number;
  balancedAccuracy: number | null;
  brierScore: number | null;
  note: string;
}

export interface LevelSignal {
  side: LevelSide;
  rank: number;
  strike: number;
  distancePoints: number;
  distancePercent: number;
  score: number;
  /**
   * Only populated when a model has been empirically calibrated.  Live and
   * price-zone analyses deliberately expose a strength score instead: a
   * candidate wall is not a guaranteed probability of a future reaction.
   */
  probability: number | null;
  oi: number;
  oiChange: number;
  features: LevelFeatures;
  zoneLow?: number;
  zoneHigh?: number;
  invalidation?: number;
  historicalTests?: number;
  historicalHoldRate?: number | null;
  oiHistorySnapshots?: number;
}

export type AnalysisHorizon = 'intraday' | 'positional';

/** A previously saved option-chain snapshot. It is used on the server only. */
export interface OiHistorySnapshot {
  capturedAt: string;
  spot: number;
  chain: ChainStrike[];
}

/**
 * Same-expiry OI evidence accumulated by this application.  Intraday and
 * positional windows remain separate so a weekly-expiry rollover is never
 * silently treated as persistence in the same contract.
 */
export interface OiHistoryContext {
  intraday: OiHistorySnapshot[];
  positional: OiHistorySnapshot[];
}

export interface TimeframeAnalysis {
  horizon: AnalysisHorizon;
  label: string;
  horizonLabel: string;
  levels: LevelSignal[];
  primarySupport: LevelSignal | null;
  primaryResistance: LevelSignal | null;
  rangePosition: number | null;
  zoneWidth: number;
  invalidationDistance: number;
  oiHistorySnapshots: number;
  historicalTests: number;
  historicalHoldRate: number | null;
  note: string;
}

export interface MarketAnalysis {
  snapshot: MarketSnapshot;
  /**
   * The two views intentionally use different evidence and time horizons.
   * `levels` and the primary fields below remain aliases of `positional` for
   * backward compatibility with existing callers.
   */
  intraday: TimeframeAnalysis;
  positional: TimeframeAnalysis;
  levels: LevelSignal[];
  primarySupport: LevelSignal | null;
  primaryResistance: LevelSignal | null;
  putCallRatio: number;
  maxPain: number | null;
  rangePosition: number | null;
  diagnostics: ModelDiagnostics;
  modelComparison?: ModelComparisonReport;
  currentConfluence?: CurrentConfluenceReport;
}

export interface PriceSession {
  date: string;
  open?: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

// ─── Model comparison types ──────────────────────────────────────────────────

export interface ModelReport {
  trainingSamples: number;
  validationSamples: number;
  balancedAccuracy: number | null;
  brierScore: number | null;
  holdRate: number;
  supportSamples: number;
  resistanceSamples: number;
  status: 'calibrated' | 'provisional';
}

export interface ModelComparisonReport {
  oiOnly: ModelReport;
  priceOnly: ModelReport;
  hybrid: ModelReport;
  winner: 'oi' | 'price' | 'hybrid' | 'insufficient';
  hybridApproved: boolean;
  coefficientContributions: { oi: number; price: number; confluence: number } | null;
  explanation: string;
}

export interface ConfluenceDetail {
  oiWall: number;
  oiStrength: number;
  nearestPriceLevel: number | null;
  priceLevelType: 'Confirmed' | 'Projected';
  distance: number;
  confluenceTolerance: number;
  isConfluent: boolean;
  priceTouches: number;
  historicalHoldRate: number | null;
  historicalBreakRate: number | null;
  sampleCount: number;
}

export interface CurrentConfluenceReport {
  support: ConfluenceDetail | null;
  resistance: ConfluenceDetail | null;
}
