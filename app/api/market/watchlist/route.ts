import { ensureDbSchema, getDb } from '@/db';
import { instruments, marketSessions } from '@/db/schema';
import { and, gte, lte, asc, ne, sql } from 'drizzle-orm';
import { env } from 'cloudflare:workers';
import { buildEvidence, type Participation, type FutureRow, type Membership, type SectorPrice } from '@/lib/watchlist-evidence';
import { cleanCandles, evaluateWatchlist, type WatchCandle, type WatchCandidate } from '@/lib/position-watchlist';

export async function GET(request: Request) {
  const mode = new URL(request.url).searchParams.get('horizon') ?? 'short';
  if (mode !== 'short' && mode !== 'positional') return Response.json({ error: 'Invalid watchlist horizon.' }, { status: 400 });
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    await ensureDbSchema();
    const db = getDb();
    // NSE bhavcopy rows are published only after the session is complete. Using
    // their latest stored date makes a successful EOD import visible immediately
    // without admitting an incomplete FYERS candle.
    const istDate = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const latestOfficial = await env.DB.prepare(
      "SELECT MAX(session_date) AS latest FROM market_sessions WHERE source='nse-bhavcopy' AND session_date<=?",
    ).bind(istDate).first<{ latest: string | null }>();
    const asOf = latestOfficial?.latest ?? new Date(Date.parse(istDate) - 86400000).toISOString().slice(0, 10);
    const start = new Date(Date.parse(asOf) - 420 * 86400000).toISOString().slice(0, 10);
    // Two bounded queries avoid per-symbol requests and oversized IN clauses.
    const [metadata, rows, cashResult, futuresResult, memberResult, sectorResult] = await Promise.all([
      db.select().from(instruments).where(sql`exists (select 1 from oi_snapshots where instrument_id = ${instruments.id})`),
      db.select({ symbol: marketSessions.instrumentId, date: marketSessions.sessionDate,
        open: marketSessions.open, high: marketSessions.high, low: marketSessions.low,
        close: marketSessions.close, source: marketSessions.source,
      }).from(marketSessions).where(and(gte(marketSessions.sessionDate, start), lte(marketSessions.sessionDate, asOf),
        ne(marketSessions.source, 'demo'), sql`(${marketSessions.instrumentId} = 'NSE:NIFTY50-INDEX' or exists (select 1 from oi_snapshots where instrument_id = ${marketSessions.instrumentId}))`)).orderBy(asc(marketSessions.sessionDate)).limit(100001),
      env.DB.prepare('SELECT * FROM cash_participation c WHERE date BETWEEN ? AND ? AND EXISTS (SELECT 1 FROM oi_snapshots s WHERE s.instrument_id=c.symbol) LIMIT 100001').bind(start, asOf).all<Participation>(),
      env.DB.prepare("SELECT * FROM futures_daily WHERE date BETWEEN date(?, '-10 days') AND ? LIMIT 20001").bind(asOf, asOf).all<FutureRow>(),
      env.DB.prepare('SELECT m.* FROM sector_membership m WHERE m.observed_date = (SELECT MAX(i.observed_date) FROM sector_imports i WHERE i.benchmark=m.benchmark AND i.observed_date<=?)').bind(asOf).all<Membership>(),
      env.DB.prepare('SELECT * FROM sector_prices WHERE date BETWEEN ? AND ? LIMIT 10001').bind(start, asOf).all<SectorPrice>(),
    ]);
    if (rows.length > 100000 || cashResult.results.length > 100000 || futuresResult.results.length > 20000 || sectorResult.results.length > 10000) return Response.json({ error: 'History exceeds the scan limit.' }, { status: 503, headers });
    const bySymbol = new Map<string, WatchCandle[]>();
    for (const row of rows) {
      const group = bySymbol.get(row.symbol) ?? [];
      group.push(row); bySymbol.set(row.symbol, group);
    }
    const benchmark = bySymbol.get('NSE:NIFTY50-INDEX') ?? [];
    const groupBySymbol = <T extends { symbol: string }>(items: T[]) => {
      const groups = new Map<string, T[]>();
      for (const item of items) {
        const group = groups.get(item.symbol) ?? [];
        group.push(item); groups.set(item.symbol, group);
      }
      return groups;
    };
    const cashBySymbol = groupBySymbol(cashResult.results);
    const futuresBySymbol = groupBySymbol(futuresResult.results);
    const membersBySymbol = groupBySymbol(memberResult.results);
    const candidates: WatchCandidate[] = [];
    const exclusions: Record<string, number> = {};
    const stocks = metadata.filter(m => m.instrumentType === 'stock' && m.id.startsWith('NSE:'));
    for (const stock of stocks) {
      const result = evaluateWatchlist(stock.id, stock.displayName, bySymbol.get(stock.id) ?? [], benchmark, mode, asOf);
      if (result.candidate) {
        const history = cleanCandles(bySymbol.get(stock.id) ?? [], result.candidate.asOf);
        const first = history[history.length - (mode === 'short' ? 21 : 64)];
        result.candidate.evidence = buildEvidence(stock.id, result.candidate.asOf, first.date, first.close, result.candidate.close,
          cashBySymbol.get(stock.id) ?? [], futuresBySymbol.get(stock.id) ?? [], membersBySymbol.get(stock.id) ?? [], sectorResult.results, benchmark);
        candidates.push(result.candidate);
      }
      else if (result.reason) exclusions[result.reason] = (exclusions[result.reason] ?? 0) + 1;
    }
    candidates.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
    return Response.json({ candidates, horizon: mode, scannedCount: stocks.length, exclusions, asOf,
      generatedAt: new Date().toISOString(), source: 'stored-eod',
      missingInputs: ['Fundamentals and valuation. Delivery, futures and sector coverage are shown per stock'],
      validation: 'Research rules; probabilities and six-month returns have not been validated.',
    }, { headers });
  } catch (error) {
    console.error('Watchlist scan failed', error);
    return Response.json({ error: 'Unable to read stored market history. Refresh or check the daily import.' }, { status: 503, headers });
  }
}
