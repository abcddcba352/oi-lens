import type { HistoricalLevelObservation, LevelFeatures, MarketSnapshot, PriceSession } from './market-types.ts';

const snapshots: Record<string, MarketSnapshot> = {
  'NSE:NIFTY50-INDEX': makeSnapshot('NSE:NIFTY50-INDEX', 'NIFTY 50', 'index', 24_964.25, 50, 168),
  'NSE:NIFTYBANK-INDEX': makeSnapshot('NSE:NIFTYBANK-INDEX', 'NIFTY BANK', 'index', 52_184.7, 100, 412),
  'NSE:RELIANCE-EQ': makeSnapshot('NSE:RELIANCE-EQ', 'RELIANCE', 'stock', 1_462.4, 20, 34),
};

function makeSnapshot(
  symbol: string,
  displayName: string,
  instrumentType: 'index' | 'stock',
  spot: number,
  step: number,
  atr14: number,
): MarketSnapshot {
  const center = Math.round(spot / step) * step;
  const chain = Array.from({ length: 15 }, (_, index) => {
    const offset = index - 7;
    const strike = center + offset * step;
    const supportWall = Math.exp(-((offset + 1.3) ** 2) / 4.5);
    const resistanceWall = Math.exp(-((offset - 2.1) ** 2) / 4.2);
    const activity = 1 + ((index * 17) % 9) / 20;
    return {
      strike,
      callOi: Math.round((42_000 + 248_000 * resistanceWall) * activity),
      callOiChange: Math.round((-5_000 + 68_000 * resistanceWall) * activity),
      callVolume: Math.round(18_000 + 126_000 * resistanceWall),
      callIv: 13.8 + Math.abs(offset) * 0.35,
      putOi: Math.round((48_000 + 224_000 * supportWall) * activity),
      putOiChange: Math.round((-4_000 + 61_000 * supportWall) * activity),
      putVolume: Math.round(21_000 + 118_000 * supportWall),
      putIv: 14.1 + Math.abs(offset) * 0.32,
    };
  });
  return {
    symbol,
    displayName,
    instrumentType,
    spot,
    spotChangePercent: 0.42,
    expiry: '03 Sep 2026',
    strikeStep: step,
    atr14,
    ivPercentile: 0.46,
    asOf: '2026-08-30T09:15:00.000Z',
    source: 'demo',
    chain,
  };
}

function demoFeatures(index: number): LevelFeatures {
  const wave = (Math.sin(index * 1.17) + 1) / 2;
  return {
    clusterOi: 0.25 + 0.72 * ((index % 11) / 10),
    oiChange: -0.3 + 1.2 * ((index % 9) / 8),
    volumeConfirmation: 0.2 + 0.75 * ((index % 7) / 6),
    proximity: 0.25 + 0.72 * ((index % 13) / 12),
    persistence: 0.3 + 0.66 * wave,
    regimeFit: 0.55 + 0.4 * ((index % 5) / 4),
  };
}

export function getDemoSnapshot(symbol = 'NSE:NIFTY50-INDEX') {
  return structuredClone(snapshots[symbol] ?? snapshots['NSE:NIFTY50-INDEX']);
}

export function getDemoPriceHistory(symbol: string, asOf: string): PriceSession[] {
  const snapshot = getDemoSnapshot(symbol);
  const end = new Date(asOf);
  const result: PriceSession[] = [];
  for (let offset = 182; offset >= 1; offset -= 1) {
    const date = new Date(end.getTime() - offset * 86_400_000);
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    const index = result.length;
    const center = snapshot.spot + Math.sin(index * 0.19) * snapshot.atr14 * 1.45 + Math.sin(index * 0.047) * snapshot.atr14 * 1.8;
    const open = center - Math.sin(index * 0.31) * snapshot.atr14 * 0.18;
    const close = center + Math.cos(index * 0.23) * snapshot.atr14 * 0.22;
    const spread = snapshot.atr14 * (0.42 + ((index * 7) % 9) / 25);
    result.push({
      date: date.toISOString().slice(0, 10),
      open,
      high: Math.max(open, close) + spread,
      low: Math.min(open, close) - spread,
      close,
      volume: 1_000_000 + ((index * 7919) % 2_400_000),
    });
  }
  return result;
}

export function getDemoObservations(symbol: string, asOf: string): HistoricalLevelObservation[] {
  const end = Date.parse(asOf);
  return Array.from({ length: 112 }, (_, index) => {
    const features = demoFeatures(index);
    const latent =
      features.clusterOi * 1.5 +
      features.oiChange * 0.85 +
      features.volumeConfirmation * 0.35 +
      features.proximity * 0.45 +
      features.persistence * 0.9 +
      features.regimeFit * 0.25;
    const held = latent + ((index * 29) % 19) / 15 > 2.75;
    const date = new Date(end - (174 - index) * 86_400_000).toISOString().slice(0, 10);
    return {
      instrument: symbol,
      sessionDate: date,
      side: index % 2 ? 'support' : 'resistance',
      strike: 24_000 + (index % 21) * 50,
      tested: index % 8 !== 0,
      held,
      features,
    };
  });
}

export function getDemoPersistence(snapshot: MarketSnapshot) {
  return Object.fromEntries(
    snapshot.chain.flatMap((row, index) => [
      [`support:${row.strike}`, 0.38 + ((index * 7) % 11) / 20],
      [`resistance:${row.strike}`, 0.36 + ((index * 5) % 13) / 22],
    ]),
  );
}
