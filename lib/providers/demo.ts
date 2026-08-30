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

  async fetchPriceHistory(symbol: string, fromDate: string, toDate: string) {
    return getDemoPriceHistory(symbol, `${toDate}T12:00:00.000Z`)
      .filter((session) => session.date >= fromDate && session.date <= toDate);
  }
}
