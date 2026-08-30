import { getDemoPriceHistory, getDemoSnapshot } from '../demo-data';
import type { ChainRequest, MarketDataProvider } from './types';

export class DemoProvider implements MarketDataProvider {
  readonly id = 'demo' as const;

  isConfigured() {
    return true;
  }

  async fetchOptionChain(request: ChainRequest) {
    return getDemoSnapshot(request.symbol);
  }

  async fetchSixMonthHistory(symbol: string, asOf: string) {
    return getDemoPriceHistory(symbol, asOf);
  }
}
