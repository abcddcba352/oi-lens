export interface Participation { symbol: string; date: string; volume: number; delivery: number | null }
export interface FutureRow { symbol: string; date: string; expiry: string; close: number; previous_close: number; oi: number; oi_change: number; volume: number; lot_size: number }
export interface Membership { symbol: string; benchmark: string; observed_date: string }
export interface SectorPrice { benchmark: string; date: string; close: number }
export interface WatchEvidence {
  volumeRatio: number | null; deliveryRatio: number | null; deliveryPercent: number | null;
  futuresPattern: string | null; futuresExpiry: string | null; futuresOiChangePercent: number | null;
  sector: string | null; stockVsSector: number | null; sectorVsNifty: number | null;
  confirmations: string[]; missing: string[];
}
const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y), m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const round = (n: number) => Math.round(n * 100) / 100;
export function buildEvidence(symbol: string, date: string, startDate: string, startClose: number, close: number,
  cash: Participation[], futures: FutureRow[], memberships: Membership[], sectors: SectorPrice[],
  nifty: { date: string; close: number }[]): WatchEvidence {
  const result: WatchEvidence = { volumeRatio: null, deliveryRatio: null, deliveryPercent: null,
    futuresPattern: null, futuresExpiry: null, futuresOiChangePercent: null,
    sector: null, stockVsSector: null, sectorVsNifty: null, confirmations: [], missing: [] };
  const cashRows = cash.filter(r => r.symbol === symbol && r.date <= date).sort((a,b) => a.date.localeCompare(b.date));
  const current = cashRows.find(r => r.date === date);
  const previous = cashRows.filter(r => r.date < date).slice(-20);
  if (current && previous.length === 20) {
    const base = median(previous.map(r => r.volume));
    if (base > 0) result.volumeRatio = round(current.volume / base);
    const deliveries = previous.flatMap(r => r.delivery === null ? [] : [r.delivery]);
    if (current.delivery !== null && deliveries.length === 20 && median(deliveries) > 0) {
      result.deliveryRatio = round(current.delivery / median(deliveries));
    }
  }
  if (current?.delivery !== null && current?.delivery !== undefined && current.volume > 0) result.deliveryPercent = round(current.delivery / current.volume * 100);
  if (result.volumeRatio === null) result.missing.push('20-session cash volume baseline');
  if (result.deliveryRatio === null) result.missing.push('20-session delivery baseline');
  if ((result.volumeRatio ?? 0) >= 1.5 && (result.deliveryRatio ?? 0) >= 1.3) result.confirmations.push('Elevated volume and delivery quantity');
  // Use one contract with >5 calendar days remaining. Never splice expiries.
  const contract = futures.filter(r => r.symbol === symbol && r.date === date && r.volume > 0 && r.oi > 0 &&
    Date.parse(r.expiry) - Date.parse(date) > 5 * 86400000).sort((a,b) => a.expiry.localeCompare(b.expiry))[0];
  if (contract && contract.previous_close > 0 && contract.oi - contract.oi_change > 0) {
    result.futuresExpiry = contract.expiry;
    const priceChange = contract.close / contract.previous_close - 1;
    const oiChange = contract.oi_change / (contract.oi - contract.oi_change);
    result.futuresOiChangePercent = round(oiChange * 100);
    result.futuresPattern = Math.abs(priceChange) < 0.005 || Math.abs(oiChange) < 0.01 ? 'Neutral / small change'
      : priceChange > 0 ? oiChange > 0 ? 'Long buildup' : 'Short covering'
      : oiChange > 0 ? 'Short buildup' : 'Long unwinding';
    if (result.futuresPattern === 'Long buildup') result.confirmations.push('Futures price and OI rising');
  } else result.missing.push('Matching futures contract');
  const mapping = memberships.filter(r => r.symbol === symbol && r.observed_date <= date)
    .sort((a,b) => b.observed_date.localeCompare(a.observed_date) || a.benchmark.localeCompare(b.benchmark))[0];
  if (mapping) {
    result.sector = mapping.benchmark;
    const series = sectors.filter(r => r.benchmark === mapping.benchmark);
    const first = series.find(r => r.date === startDate), last = series.find(r => r.date === date);
    const nFirst = nifty.find(r => r.date === startDate), nLast = nifty.find(r => r.date === date);
    if (first && last && first.close > 0 && startClose > 0) {
      const sectorReturn = last.close / first.close - 1;
      result.stockVsSector = round((close / startClose - 1 - sectorReturn) * 100);
      if (nFirst && nLast && nFirst.close > 0) result.sectorVsNifty = round((sectorReturn - (nLast.close / nFirst.close - 1)) * 100);
      if (result.stockVsSector > 0 && (result.sectorVsNifty ?? -Infinity) > 0) result.confirmations.push('Stock and sector outperforming');
    }
  }
  if (result.stockVsSector === null || result.sectorVsNifty === null) result.missing.push('Dated sector membership / benchmark history');
  return result;
}
