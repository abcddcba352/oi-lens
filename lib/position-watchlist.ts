/** EOD technical research rules. Scores are NOT fitted probabilities. */
export type WatchHorizon = 'short' | 'positional';
export interface WatchCandle {
  date: string; open: number; high: number; low: number; close: number; source: string;
}
export interface WatchCandidate {
  evidence?: import('./watchlist-evidence').WatchEvidence;
  symbol: string; name: string; horizon: WatchHorizon; asOf: string; source: string;
  close: number; sessions: number; score: number;
  stage: 'Breakout watch' | 'Approaching resistance' | 'Trend watch';
  resistance: number; entryTrigger: number; invalidation: number;
  nextResistance: number | null; rewardRisk: number | null;
  distancePercent: number; distanceAtr: number; atr: number;
  relativeStrength: number | null; reasons: string[];
  probability: null;
}
export interface WatchResult { candidate: WatchCandidate | null; reason: string | null }
const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
const round = (x: number) => Math.round(x * 100) / 100;

export function cleanCandles(rows: WatchCandle[], asOf: string): WatchCandle[] {
  const unique = new Map<string, WatchCandle>();
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || row.date > asOf || row.source === 'demo') continue;
    if (![row.open, row.high, row.low, row.close].every(x => Number.isFinite(x) && x > 0)) continue;
    if (row.low > Math.min(row.open, row.close) || row.high < Math.max(row.open, row.close)) continue;
    unique.set(row.date, row);
  }
  return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function evaluateWatchlist(
  symbol: string, name: string, input: WatchCandle[], benchmark: WatchCandle[],
  horizon: WatchHorizon, asOf: string,
): WatchResult {
  const rows = cleanCandles(input, asOf);
  const minimum = horizon === 'short' ? 60 : 130;
  const reject = (reason: string): WatchResult => ({ candidate: null, reason });
  if (rows.length < minimum) return reject(`Needs ${minimum} valid sessions`);
  const latest = rows.at(-1)!;
  if ((Date.parse(asOf) - Date.parse(latest.date)) / 86400000 > 7) return reject('Price history is stale');
  // Large discontinuities require corporate-action review before chart levels can be trusted.
  if (rows.slice(-minimum).some((r, i, a) => i > 0 && Math.abs(r.close / a[i - 1].close - 1) > 0.25)) {
    return reject('Large price discontinuity: review corporate actions');
  }
  const prior = rows.slice(0, -1);
  const ranges = prior.slice(-14).map((r, i) => {
    const previous = prior[prior.length - 15 + i];
    return Math.max(r.high - r.low, Math.abs(r.high - previous.close), Math.abs(r.low - previous.close));
  });
  const atr = mean(ranges);
  if (!(atr > 0)) return reject('Insufficient price variation');
  const period = horizon === 'short' ? 20 : 50;
  const average = mean(prior.slice(-period).map(r => r.close));
  const olderAverage = mean(prior.slice(-period - 10, -10).map(r => r.close));
  if (latest.close <= average || average <= olderAverage) return reject('Rising trend not confirmed');
  const baseLength = horizon === 'short' ? 20 : 40;
  const base = prior.slice(-baseLength);
  const resistance = Math.max(...base.map(r => r.high));
  const baseLow = Math.min(...base.map(r => r.low));
  const recentLow = Math.min(...prior.slice(-10).map(r => r.low));
  const oldLow = Math.min(...prior.slice(-20, -10).map(r => r.low));
  const compressed = mean(prior.slice(-5).map(r => r.high - r.low)) < mean(prior.slice(-20, -5).map(r => r.high - r.low)) * 0.8;
  const compactBase = (resistance - baseLow) / atr <= (horizon === 'short' ? 6 : 10);
  const entryTrigger = resistance + 0.25 * atr;
  const invalidation = recentLow - 0.25 * atr;
  if (latest.close > entryTrigger + 1.5 * atr) return reject('Extended beyond the entry area');
  // An older confirmed pivot is a potential overhead obstacle, never an invented target.
  const overhead = prior.flatMap((r, i) => {
    if (i < 2 || i + 2 >= prior.length || r.high <= Math.max(entryTrigger, latest.close) + 0.25 * atr) return [];
    return [prior[i - 2], prior[i - 1], prior[i + 1], prior[i + 2]].every(p => r.high > p.high) ? [r.high] : [];
  });
  const nextResistance = overhead.length ? Math.min(...overhead) : null;
  const indicativeEntry = Math.max(latest.close, entryTrigger);
  const risk = indicativeEntry - invalidation;
  const rewardRisk = nextResistance !== null && risk > 0 ? (nextResistance - indicativeEntry) / risk : null;
  const bench = new Map(cleanCandles(benchmark, latest.date).map(r => [r.date, r.close]));
  const start = rows[rows.length - (horizon === 'short' ? 21 : 64)];
  const startBench = bench.get(start.date), endBench = bench.get(latest.date);
  const relativeStrength = startBench && endBench
    ? ((latest.close / start.close - 1) - (endBench / startBench - 1)) * 100 : null;
  const breakout = latest.close > entryTrigger;
  const near = (resistance - latest.close) / atr <= 1;
  const strongClose = latest.high > latest.low && (latest.close - latest.low) / (latest.high - latest.low) >= 0.75;
  const reasons = ['Price above a rising moving average'];
  let score = 25;
  if (recentLow > oldLow) { score += 15; reasons.push('Higher recent lows'); }
  if (compressed) { score += 15; reasons.push('Daily ranges contracting'); }
  if (compactBase) { score += 10; reasons.push('Contained consolidation range'); }
  if (relativeStrength !== null && relativeStrength > 0) { score += 15; reasons.push('Outperforming NIFTY over matching dates'); }
  if (breakout && strongClose) { score += 10; reasons.push('Strong close beyond prior resistance'); }
  if (rewardRisk !== null && rewardRisk >= 2) { score += 10; reasons.push('Overhead room exceeds twice indicative risk'); }
  return { reason: null, candidate: {
    symbol, name, horizon, asOf: latest.date, source: latest.source, close: latest.close,
    sessions: rows.length, score, stage: breakout ? 'Breakout watch' : near ? 'Approaching resistance' : 'Trend watch',
    resistance: round(resistance), entryTrigger: round(entryTrigger), invalidation: round(invalidation),
    nextResistance: nextResistance === null ? null : round(nextResistance),
    rewardRisk: rewardRisk === null ? null : round(rewardRisk),
    distancePercent: round((resistance - latest.close) / latest.close * 100), distanceAtr: round((resistance - latest.close) / atr),
    atr: round(atr), relativeStrength: relativeStrength === null ? null : round(relativeStrength), reasons, probability: null,
  } };
}
