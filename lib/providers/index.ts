import { DemoProvider } from './demo';
import { FyersProvider } from './fyers';

export function getMarketProvider() {
  const requested = process.env.OI_PROVIDER?.toLowerCase();
  const fyers = new FyersProvider();
  if ((requested === 'fyers' || !requested) && fyers.isConfigured()) return fyers;
  return new DemoProvider();
}
