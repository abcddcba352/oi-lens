import type { MarketSnapshot, PriceSession } from '../market-types';

export interface ChainRequest {
  symbol: string;
  expiryEpoch?: number;
  strikeCount?: number;
}

export interface MarketDataProvider {
  readonly id: 'fyers' | 'demo';
  isConfigured(): boolean;
  fetchOptionChain(request: ChainRequest): Promise<MarketSnapshot>;
  fetchPriceHistory(symbol: string, fromDate: string, toDate: string): Promise<PriceSession[]>;
}
