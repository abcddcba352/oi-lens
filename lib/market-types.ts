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
  source: 'fyers' | 'demo';
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
  probability: number;
  oi: number;
  oiChange: number;
  features: LevelFeatures;
}

export interface MarketAnalysis {
  snapshot: MarketSnapshot;
  levels: LevelSignal[];
  primarySupport: LevelSignal | null;
  primaryResistance: LevelSignal | null;
  putCallRatio: number;
  maxPain: number | null;
  rangePosition: number | null;
  diagnostics: ModelDiagnostics;
}

export interface PriceSession {
  date: string;
  open?: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}
