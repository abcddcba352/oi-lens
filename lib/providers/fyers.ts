import type { ChainStrike, MarketSnapshot, PriceSession } from '../market-types';
import type { ChainRequest, MarketDataProvider } from './types';

interface FyersOptionRow {
  option_type?: 'CE' | 'PE' | '';
  strike_price: number;
  oi?: number;
  oich?: number;
  volume?: number;
  iv?: number;
  ltp?: number;
  chp?: number;
}

interface FyersChainResponse {
  code?: number;
  message?: string;
  s?: string;
  data?: {
    expiryData?: Array<{ date?: string; expiry?: number }>;
    optionsChain?: FyersOptionRow[];
  };
}

interface FyersHistoryResponse {
  s?: string;
  code?: number;
  message?: string;
  candles?: number[][];
}

const names: Record<string, { displayName: string; instrumentType: 'index' | 'stock'; step: number; atr: number }> = {
  'NSE:NIFTY50-INDEX': { displayName: 'NIFTY 50', instrumentType: 'index', step: 50, atr: 168 },
  'NSE:NIFTYBANK-INDEX': { displayName: 'NIFTY BANK', instrumentType: 'index', step: 100, atr: 412 },
};

export class FyersProvider implements MarketDataProvider {
  readonly id = 'fyers' as const;
  private readonly token: string | undefined;
  private readonly baseUrl = process.env.FYERS_API_BASE ?? 'https://api-t1.fyers.in';

  constructor(token?: string | null) {
    this.token = token ?? process.env.FYERS_AUTH_TOKEN;
  }

  isConfigured() {
    return Boolean(this.token);
  }

  async fetchOptionChain(request: ChainRequest): Promise<MarketSnapshot> {
    if (!this.token) throw new Error('FYERS_AUTH_TOKEN is not configured.');
    const url = new URL('/data/options-chain-v3', this.baseUrl);
    url.searchParams.set('symbol', request.symbol);
    url.searchParams.set('strikecount', String(Math.min(50, Math.max(1, request.strikeCount ?? 15))));
    url.searchParams.set('greeks', '1');
    if (request.expiryEpoch) url.searchParams.set('timestamp', String(request.expiryEpoch));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: this.token, Accept: 'application/json', 'User-Agent': 'OI-Lens/1.0 FYERS-API-Client' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const body = await response.text();
    let payload: FyersChainResponse;
    try {
      payload = JSON.parse(body) as FyersChainResponse;
    } catch {
      throw new Error(`FYERS returned an unexpected response for the option chain (${response.status}). Please reconnect FYERS and try again.`);
    }
    if (!response.ok || payload.s === 'error' || !payload.data?.optionsChain) {
      throw new Error(payload.message ?? `FYERS option-chain request failed (${response.status}).`);
    }

    const rows = payload.data.optionsChain;
    const underlying = rows.find((row) => row.strike_price === -1);
    const spot = underlying?.ltp;
    if (!spot || !Number.isFinite(spot)) throw new Error('FYERS response did not contain the underlying price.');
    const byStrike = new Map<number, ChainStrike>();
    for (const row of rows) {
      if (row.strike_price <= 0 || !row.option_type) continue;
      const value = byStrike.get(row.strike_price) ?? {
        strike: row.strike_price,
        callOi: 0,
        callOiChange: 0,
        callVolume: 0,
        putOi: 0,
        putOiChange: 0,
        putVolume: 0,
      };
      if (row.option_type === 'CE') {
        value.callOi = row.oi ?? 0;
        value.callOiChange = row.oich ?? 0;
        value.callVolume = row.volume ?? 0;
        value.callIv = row.iv;
      } else {
        value.putOi = row.oi ?? 0;
        value.putOiChange = row.oich ?? 0;
        value.putVolume = row.volume ?? 0;
        value.putIv = row.iv;
      }
      byStrike.set(row.strike_price, value);
    }
    const chain = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
    if (!chain.length) throw new Error('FYERS response contained no option strikes.');
    const known = names[request.symbol];
    const inferredStep = chain.length > 1 ? chain[1].strike - chain[0].strike : 50;
    const expiry = payload.data.expiryData?.find((item) => !request.expiryEpoch || item.expiry === request.expiryEpoch)
      ?? payload.data.expiryData?.[0];
    return {
      symbol: request.symbol,
      displayName: known?.displayName ?? request.symbol.replace(/^NSE:|-(EQ|INDEX)$/g, ''),
      instrumentType: known?.instrumentType ?? 'stock',
      spot,
      spotChangePercent: underlying?.chp ?? 0,
      expiry: expiry?.date ?? 'Nearest expiry',
      expiryEpoch: expiry?.expiry,
      strikeStep: known?.step ?? inferredStep,
      atr14: known?.atr ?? Math.max(inferredStep * 2.5, spot * 0.018),
      ivPercentile: 0.5,
      asOf: new Date().toISOString(),
      source: 'fyers',
      chain,
    };
  }

  async fetchPriceHistory(symbol: string, fromDate: string, toDate: string): Promise<PriceSession[]> {
    if (!this.token) throw new Error('Connect FYERS to load six-month history.');
    const url = new URL('/data/history', this.baseUrl);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('resolution', 'D');
    url.searchParams.set('date_format', '1');
    url.searchParams.set('range_from', fromDate);
    url.searchParams.set('range_to', toDate);
    url.searchParams.set('cont_flag', '0');
    const response = await fetch(url, {
      headers: { Authorization: this.token, Accept: 'application/json', 'User-Agent': 'OI-Lens/1.0 FYERS-API-Client' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    let payload: FyersHistoryResponse;
    try {
      payload = JSON.parse(body) as FyersHistoryResponse;
    } catch {
      throw new Error(`FYERS returned an unexpected response for six-month history (${response.status}).`);
    }
    if (!response.ok || payload.s === 'error' || !payload.candles) {
      throw new Error(payload.message ?? `FYERS history request failed (${response.status}).`);
    }
    const sessions = payload.candles
      .filter((row) => row.length >= 6 && row.slice(0, 6).every(Number.isFinite))
      .map((row) => ({
        date: new Date(row[0] * 1000).toISOString().slice(0, 10),
        open: row[1], high: row[2], low: row[3], close: row[4], volume: row[5],
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return sessions;
  }
}
