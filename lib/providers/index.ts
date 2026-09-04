import { DemoProvider } from './demo';
import { FyersProvider } from './fyers';

export { DemoProvider, FyersProvider };

export function getMarketProvider(authorization?: string | null) {
  const requested = process.env.OI_PROVIDER?.toLowerCase();
  const fyers = new FyersProvider(authorization);
  if (authorization || ((requested === 'fyers' || !requested) && fyers.isConfigured())) return fyers;
  return new DemoProvider();
}
