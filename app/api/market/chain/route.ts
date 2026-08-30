import { getDemoObservations, getDemoPersistence } from '@/lib/demo-data';
import { loadHistoricalObservations, persistSnapshot } from '@/lib/history-store';
import { analyzeSnapshot } from '@/lib/oi-model';
import { getMarketProvider } from '@/lib/providers';

const SYMBOL = /^(NSE|BSE):[A-Z0-9&._-]+-(EQ|INDEX)$/;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get('symbol') ?? 'NSE:NIFTY50-INDEX').toUpperCase();
  if (!SYMBOL.test(symbol)) return Response.json({ error: 'Use a valid exchange symbol such as NSE:NIFTY50-INDEX.' }, { status: 400 });
  const expiryRaw = url.searchParams.get('expiry');
  const expiryEpoch = expiryRaw ? Number(expiryRaw) : undefined;
  if (expiryRaw && (!Number.isInteger(expiryEpoch) || (expiryEpoch ?? 0) <= 0)) return Response.json({ error: 'Expiry must be a positive Unix timestamp.' }, { status: 400 });
  try {
    const provider = getMarketProvider();
    const snapshot = await provider.fetchOptionChain({ symbol, expiryEpoch, strikeCount: 25 });
    let observations = getDemoObservations(snapshot.symbol, snapshot.asOf);
    let storageWarning: string | null = null;
    if (snapshot.source === 'fyers') {
      try {
        await persistSnapshot(snapshot);
        observations = await loadHistoricalObservations(snapshot.symbol, snapshot.asOf);
      } catch {
        observations = [];
        storageWarning = 'Live chain loaded, but historical storage is not initialized yet.';
      }
    }
    const analysis = analyzeSnapshot(snapshot, observations, getDemoPersistence(snapshot));
    return Response.json({ analysis, provider: provider.id, storageWarning }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to analyze the option chain.';
    return Response.json({ error: message }, { status: 502 });
  }
}
