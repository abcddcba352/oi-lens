/** Shared live/research rules. A signal is not a fitted probability. */
export type ResearchStrategyId =
  | 'trend'
  | 'breakout'
  | 'pullback'
  | 'pullback_oi';
export const RESEARCH_STRATEGIES: Record<ResearchStrategyId, string> = {
  trend: 'Trend baseline',
  breakout: 'Price breakout',
  pullback: 'Pullback and recovery',
  pullback_oi: 'Pullback with OI room',
};
export interface ResearchCandle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}
export interface ResearchSignal {
  eligible: boolean;
  reason: string;
  atr: number;
  relativeStrength: number | null;
  support: number;
  resistance: number;
  stop: number;
  target: number;
  matches: Record<ResearchStrategyId, boolean>;
}
const mean = (a: number[]) => a.reduce((sum, n) => sum + n, 0) / a.length;

export function evaluateResearchStrategies(
  input: ResearchCandle[],
  benchmark: ResearchCandle[],
  asOf: string,
  medianVolume: number | null,
  oi?: { support: number; resistance: number; date: string },
): ResearchSignal {
  const rows = [
    ...new Map(
      input
        .filter(
          (r) =>
            r.date <= asOf &&
            [r.open, r.high, r.low, r.close].every(
              (n) => Number.isFinite(n) && n > 0,
            ) &&
            r.low <= Math.min(r.open, r.close) &&
            r.high >= Math.max(r.open, r.close),
        )
        .map((r) => [r.date, r]),
    ).values(),
  ]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-60);
  const result: ResearchSignal = {
    eligible: false,
    reason: 'Needs 60 valid sessions',
    atr: 0,
    relativeStrength: null,
    support: 0,
    resistance: 0,
    stop: 0,
    target: 0,
    matches: {
      trend: false,
      breakout: false,
      pullback: false,
      pullback_oi: false,
    },
  };
  if (rows.length < 60) return result;
  const latest = rows.at(-1)!;
  if (latest.date !== asOf)
    return { ...result, reason: 'Latest official price session missing' };
  if (
    rows.some(
      (r, i) => i > 0 && Math.abs(r.close / rows[i - 1].close - 1) > 0.25,
    )
  ) {
    return {
      ...result,
      reason: 'Large price discontinuity: review corporate actions',
    };
  }
  const atr = mean(
    rows.slice(-14).map((r, i) => {
      const prev = rows[rows.length - 15 + i].close;
      return Math.max(
        r.high - r.low,
        Math.abs(r.high - prev),
        Math.abs(r.low - prev),
      );
    }),
  );
  const ma20 = mean(rows.slice(-20).map((r) => r.close));
  const ma50 = mean(rows.slice(-50).map((r) => r.close));
  const oldMa20 = mean(rows.slice(-25, -5).map((r) => r.close));
  const bench = new Map(
    benchmark.filter((r) => r.date <= asOf).map((r) => [r.date, r.close]),
  );
  const start = rows.at(-21)!;
  const b0 = bench.get(start.date),
    b1 = bench.get(latest.date);
  const rs =
    b0 && b1 && Number.isFinite(b0) && Number.isFinite(b1) && b0 > 0 && b1 > 0
      ? 100 * (latest.close / start.close - b1 / b0)
      : null;
  const support = Math.min(...rows.slice(-10, -1).map((r) => r.low));
  const resistance = Math.max(...rows.slice(-21, -1).map((r) => r.high));
  Object.assign(result, {
    atr,
    relativeStrength: rs,
    support,
    resistance,
    stop: latest.close - 2 * atr,
    target: latest.close + 4 * atr,
  });
  if (!(atr > 0) || result.stop <= 0)
    return { ...result, reason: 'Invalid volatility or stop' };
  if (
    medianVolume === null ||
    !Number.isFinite(medianVolume) ||
    medianVolume < 25000
  )
    return { ...result, reason: 'Needs liquid cash-volume history' };
  if (rs === null)
    return { ...result, reason: 'Matching benchmark history unavailable' };
  const trend = latest.close > ma20 && ma20 > ma50 && ma20 > oldMa20 && rs > 0;
  if (!trend)
    return {
      ...result,
      reason: 'Rising trend and NIFTY outperformance not confirmed',
    };
  const previous = rows.at(-2)!;
  // Pullback must precede today's recovery; all moving averages are dated locally.
  const touched = rows.slice(-6, -1).some((r, offset) => {
    const index = rows.length - 6 + offset;
    const avg = mean(rows.slice(index - 19, index + 1).map((c) => c.close));
    return r.low <= avg + 0.5 * atr && r.close >= avg - atr;
  });
  const pullback =
    touched &&
    latest.close > previous.high &&
    latest.close > latest.open &&
    latest.close <= ma20 + 1.5 * atr;
  const breakout =
    latest.close > resistance + 0.25 * atr &&
    latest.close <= resistance + 1.5 * atr;
  const oiRoom =
    !!oi &&
    [oi.support, oi.resistance].every((n) => Number.isFinite(n) && n > 0) &&
    oi.date === asOf &&
    oi.support <= latest.close &&
    latest.close - oi.support <= atr &&
    oi.resistance - latest.close >= 2 * atr;
  return {
    ...result,
    eligible: true,
    reason: 'Trend and relative strength qualify',
    matches: {
      trend: true,
      breakout,
      pullback,
      pullback_oi: pullback && oiRoom,
    },
  };
}
