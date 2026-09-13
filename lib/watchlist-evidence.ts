export interface Participation {
  symbol: string;
  date: string;
  volume: number;
  delivery: number | null;
}

export interface FutureRow {
  symbol: string;
  date: string;
  expiry: string;
  close: number;
  previous_close: number;
  oi: number;
  oi_change: number;
  volume: number;
  lot_size: number;
}

export interface Membership {
  symbol: string;
  benchmark: string;
  observed_date: string;
}

export interface SectorPrice {
  benchmark: string;
  date: string;
  close: number;
}

export interface EvidenceCoverageItem {
  field: string;
  label: string;
  status: 'available' | 'unavailable';
  detail?: string;
}

export interface EvidenceCoverage {
  availableCount: number;
  totalCount: number;
  coveragePercent: number;
  items: EvidenceCoverageItem[];
}

export type FuturesPattern =
  | 'Long buildup'
  | 'Short covering'
  | 'Short buildup'
  | 'Long unwinding'
  | 'Neutral / small change';

export interface WatchEvidence {
  volumeRatio: number | null;
  deliveryRatio: number | null;
  deliveryPercent: number | null;
  medianVolume: number | null;
  medianDelivery: number | null;
  futuresPattern: FuturesPattern | null;
  futuresExpiry: string | null;
  futuresOiChangePercent: number | null;
  futuresPriceChangePercent: number | null;
  sector: string | null;
  stockVsSector: number | null;
  sectorVsNifty: number | null;
  supportingEvidence: string[];
  opposingEvidence: string[];
  confirmations: string[];
  missing: string[];
  coverage: EvidenceCoverage;
}

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

const round = (n: number) => Math.round(n * 100) / 100;

export function buildEvidence(
  symbol: string,
  date: string,
  startDate: string,
  startClose: number,
  close: number,
  cash: Participation[],
  futures: FutureRow[],
  memberships: Membership[],
  sectors: SectorPrice[],
  nifty: { date: string; close: number }[],
): WatchEvidence {
  const supportingEvidence: string[] = [];
  const opposingEvidence: string[] = [];
  const confirmations: string[] = [];
  const missing: string[] = [];
  const coverageItems: EvidenceCoverageItem[] = [];

  let volumeRatio: number | null = null;
  let deliveryRatio: number | null = null;
  let deliveryPercent: number | null = null;
  let medianVolume: number | null = null;
  let medianDelivery: number | null = null;

  const cashRows = cash
    .filter(r => r.symbol === symbol && r.date <= date)
    .sort((a, b) => a.date.localeCompare(b.date));

  const current = cashRows.find(r => r.date === date);
  const previous = cashRows.filter(r => r.date < date).slice(-20);

  if (current && previous.length === 20) {
    const baseVol = median(previous.map(r => r.volume));
    medianVolume = round(baseVol);
    if (baseVol > 0) {
      volumeRatio = round(current.volume / baseVol);
    }
    const deliveries = previous.flatMap(r => (r.delivery === null ? [] : [r.delivery]));
    if (current.delivery !== null && deliveries.length === 20 && median(deliveries) > 0) {
      const baseDel = median(deliveries);
      medianDelivery = round(baseDel);
      deliveryRatio = round(current.delivery / baseDel);
    }
  }

  if (current?.delivery !== null && current?.delivery !== undefined && current.volume > 0) {
    deliveryPercent = round((current.delivery / current.volume) * 100);
  }

  // 1. Cash Volume Baseline coverage
  if (volumeRatio !== null) {
    coverageItems.push({
      field: 'volumeRatio',
      label: 'Cash Volume Baseline',
      status: 'available',
      detail: `${volumeRatio}× 20-session median`,
    });
    if (volumeRatio >= 1.3) {
      supportingEvidence.push(`Above-normal cash volume (${volumeRatio}× 20d median)`);
    } else if (volumeRatio < 0.8) {
      opposingEvidence.push(`Below-normal cash volume (${volumeRatio}× 20d median)`);
    }
  } else {
    coverageItems.push({
      field: 'volumeRatio',
      label: 'Cash Volume Baseline',
      status: 'unavailable',
      detail: 'Requires 20 previous trading sessions',
    });
    missing.push('20-session cash volume baseline');
  }

  // 2. Delivery Baseline coverage
  if (deliveryRatio !== null) {
    coverageItems.push({
      field: 'deliveryRatio',
      label: 'Delivery Baseline',
      status: 'available',
      detail: `${deliveryRatio}× 20-session median`,
    });
    if (deliveryRatio >= 1.2) {
      supportingEvidence.push(`Elevated delivery volume (${deliveryRatio}× 20d median)`);
    } else if (deliveryRatio < 0.8) {
      opposingEvidence.push(`Subdued delivery participation (${deliveryRatio}× 20d median)`);
    }
  } else {
    coverageItems.push({
      field: 'deliveryRatio',
      label: 'Delivery Baseline',
      status: 'unavailable',
      detail: 'Requires 20 previous trading sessions with delivery',
    });
    missing.push('20-session delivery baseline');
  }

  if ((volumeRatio ?? 0) >= 1.5 && (deliveryRatio ?? 0) >= 1.3) {
    confirmations.push('Elevated volume and delivery quantity');
  }

  // 3. Futures Positioning coverage (Use one contract with >5 calendar days to expiry; never splice expiries)
  let futuresPattern: FuturesPattern | null = null;
  let futuresExpiry: string | null = null;
  let futuresOiChangePercent: number | null = null;
  let futuresPriceChangePercent: number | null = null;

  const contract = futures
    .filter(
      r =>
        r.symbol === symbol &&
        r.date === date &&
        r.volume > 0 &&
        r.oi > 0 &&
        Date.parse(r.expiry) - Date.parse(date) > 5 * 86400000,
    )
    .sort((a, b) => a.expiry.localeCompare(b.expiry))[0];

  if (contract && contract.previous_close > 0 && contract.oi - contract.oi_change > 0) {
    futuresExpiry = contract.expiry;
    const priceChange = contract.close / contract.previous_close - 1;
    const oiChange = contract.oi_change / (contract.oi - contract.oi_change);
    futuresPriceChangePercent = round(priceChange * 100);
    futuresOiChangePercent = round(oiChange * 100);

    futuresPattern =
      Math.abs(priceChange) < 0.005 || Math.abs(oiChange) < 0.01
        ? 'Neutral / small change'
        : priceChange > 0
          ? oiChange > 0
            ? 'Long buildup'
            : 'Short covering'
          : oiChange > 0
            ? 'Short buildup'
            : 'Long unwinding';

    coverageItems.push({
      field: 'futuresPattern',
      label: 'Futures Positioning',
      status: 'available',
      detail: `${futuresPattern} (${futuresExpiry})`,
    });

    if (futuresPattern === 'Long buildup') {
      supportingEvidence.push(`Futures long buildup (OI ${futuresOiChangePercent > 0 ? '+' : ''}${futuresOiChangePercent}%)`);
      confirmations.push('Futures price and OI rising');
    } else if (futuresPattern === 'Short covering') {
      supportingEvidence.push('Futures short covering');
    } else if (futuresPattern === 'Short buildup') {
      opposingEvidence.push(`Futures short buildup (OI ${futuresOiChangePercent > 0 ? '+' : ''}${futuresOiChangePercent}%, price down)`);
    } else if (futuresPattern === 'Long unwinding') {
      opposingEvidence.push(`Futures long unwinding (OI ${futuresOiChangePercent}%, price down)`);
    }
  } else {
    coverageItems.push({
      field: 'futuresPattern',
      label: 'Futures Positioning',
      status: 'unavailable',
      detail: 'No matching traded contract >5d from expiry',
    });
    missing.push('Matching futures contract');
  }

  // 4. Sector Benchmark coverage
  let sector: string | null = null;
  let stockVsSector: number | null = null;
  let sectorVsNifty: number | null = null;

  const mapping = memberships
    .filter(r => r.symbol === symbol && r.observed_date <= date)
    .sort(
      (a, b) =>
        b.observed_date.localeCompare(a.observed_date) ||
        a.benchmark.localeCompare(b.benchmark),
    )[0];

  if (mapping) {
    sector = mapping.benchmark;
    const series = sectors.filter(r => r.benchmark === mapping.benchmark);
    const first = series.find(r => r.date === startDate);
    const last = series.find(r => r.date === date);
    const nFirst = nifty.find(r => r.date === startDate);
    const nLast = nifty.find(r => r.date === date);

    if (first && last && first.close > 0 && startClose > 0) {
      const sectorReturn = last.close / first.close - 1;
      stockVsSector = round(((close / startClose - 1) - sectorReturn) * 100);

      if (nFirst && nLast && nFirst.close > 0) {
        sectorVsNifty = round((sectorReturn - (nLast.close / nFirst.close - 1)) * 100);
      }

      if (stockVsSector > 0 && (sectorVsNifty ?? -Infinity) > 0) {
        supportingEvidence.push('Stock and sector outperforming benchmark');
        confirmations.push('Stock and sector outperforming');
      }
      if (stockVsSector < -5) {
        opposingEvidence.push(`Lagging sector benchmark by ${Math.abs(stockVsSector)} pp`);
      }
      if (sectorVsNifty !== null && sectorVsNifty < -5) {
        opposingEvidence.push(`Sector lagging NIFTY by ${Math.abs(sectorVsNifty)} pp`);
      }
    }
  }

  if (stockVsSector === null || sectorVsNifty === null) {
    coverageItems.push({
      field: 'sector',
      label: 'Sector Benchmark',
      status: 'unavailable',
      detail: sector ? 'Dated sector price history incomplete' : 'Sector unmapped',
    });
    missing.push('Dated sector membership / benchmark history');
  } else {
    coverageItems.push({
      field: 'sector',
      label: 'Sector Benchmark',
      status: 'available',
      detail: `${sector} (Stock: ${stockVsSector > 0 ? '+' : ''}${stockVsSector} pp)`,
    });
  }

  const availableCount = coverageItems.filter(i => i.status === 'available').length;
  const coverage: EvidenceCoverage = {
    availableCount,
    totalCount: coverageItems.length,
    coveragePercent: round((availableCount / coverageItems.length) * 100),
    items: coverageItems,
  };

  return {
    volumeRatio,
    deliveryRatio,
    deliveryPercent,
    medianVolume,
    medianDelivery,
    futuresPattern,
    futuresExpiry,
    futuresOiChangePercent,
    futuresPriceChangePercent,
    sector,
    stockVsSector,
    sectorVsNifty,
    supportingEvidence,
    opposingEvidence,
    confirmations,
    missing,
    coverage,
  };
}
