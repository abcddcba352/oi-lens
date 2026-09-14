import { NSE_FO_HOLIDAYS_2026 } from './nse-market-calendar.ts';
import type { ResearchCandle, ResearchSignal } from './research-strategy.ts';

export const FORWARD_VERSION = 'trend-forward-v1';
export const FORWARD_RULES = {
  version: FORWARD_VERSION,
  strategy: 'trend',
  holdSessions: 20,
  stopAtr: 2,
  targetAtr: 4,
  roundTripCost: 0.002,
  entry: 'Next regular session open, strictly inside frozen stop/target',
  reentry:
    'No overlapping signals; keep a 20-session cooldown after accepted entries',
} as const;
export type ForwardStatus =
  | 'pending'
  | 'open'
  | 'closed'
  | 'skipped'
  | 'review';
export interface ForwardSignal {
  id: string;
  symbol: string;
  name: string;
  signalDate: string;
  recordedAt: string;
  version: string;
  rulesHash: string;
  inputHash: string;
  close: number;
  stop: number;
  target: number;
  atr: number;
  relativeStrength: number;
  medianVolume: number;
  sessionDates: string[];
  rules: typeof FORWARD_RULES;
  benchmarkSource: string;
}
export interface ForwardOutcome {
  status: ForwardStatus;
  entry: number | null;
  entryDate: string | null;
  exit: number | null;
  exitDate: string | null;
  reason: string | null;
  netR: number | null;
  grossR: number | null;
  cost: number | null;
  sessions: number;
  ambiguous: boolean;
  needsData: string | null;
  bars: ResearchCandle[];
}
export const emptyForwardOutcome = (): ForwardOutcome => ({
  status: 'pending',
  entry: null,
  entryDate: null,
  exit: null,
  exitDate: null,
  reason: null,
  netR: null,
  grossR: null,
  cost: null,
  sessions: 0,
  ambiguous: false,
  needsData: null,
  bars: [],
});
export function regularSession(date: string): boolean {
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  return (
    date.startsWith('2026-') &&
    day > 0 &&
    day < 6 &&
    !NSE_FO_HOLIDAYS_2026[date]
  );
}
/** Fail closed beyond the reviewed holiday calendar; special sessions are excluded. */
export function forwardSessionDates(date: string): string[] | null {
  const result: string[] = [];
  const time = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(time) || !regularSession(date)) return null;
  for (let i = 1; i <= 80 && result.length < 20; i++) {
    const next = new Date(time + i * 86400000).toISOString().slice(0, 10);
    if (!next.startsWith('2026-')) return null;
    if (regularSession(next)) result.push(next);
  }
  return result.length === 20 ? result : null;
}
export function captureWindow(
  date: string,
  now: string,
): { allowed: boolean; reason: string; sessions: string[] } {
  const sessions = forwardSessionDates(date);
  if (!sessions)
    return {
      allowed: false,
      reason: 'Reviewed regular-session calendar unavailable',
      sessions: [],
    };
  const t = Date.parse(now);
  // Only capture after the signal session's EOD publication window, before next open.
  if (!(t >= Date.parse(date + 'T13:00:00Z')))
    return { allowed: false, reason: 'EOD publication not due', sessions };
  if (!(t < Date.parse(sessions[0] + 'T03:45:00Z')))
    return {
      allowed: false,
      reason: 'Entry open has passed; no hindsight capture',
      sessions,
    };
  return {
    allowed: true,
    reason: 'Recorded before next-session open',
    sessions,
  };
}
export function createForwardSignal(
  input: {
    symbol: string;
    name: string;
    signalDate: string;
    recordedAt: string;
    close: number;
    medianVolume: number;
    rulesHash: string;
    inputHash: string;
    benchmarkSource: string;
  },
  signal: ResearchSignal,
): ForwardSignal | null {
  const window = captureWindow(input.signalDate, input.recordedAt);
  if (
    !window.allowed ||
    !signal.matches.trend ||
    signal.relativeStrength === null ||
    ![
      input.close,
      signal.stop,
      signal.target,
      signal.atr,
      input.medianVolume,
    ].every((n) => Number.isFinite(n) && n > 0)
  )
    return null;
  return {
    ...input,
    id: `${FORWARD_VERSION}:${input.symbol}:${input.signalDate}`,
    version: FORWARD_VERSION,
    stop: signal.stop,
    target: signal.target,
    atr: signal.atr,
    relativeStrength: signal.relativeStrength,
    sessionDates: window.sessions,
    rules: FORWARD_RULES,
  };
}
export function blocksNewSignal(
  signal: ForwardSignal,
  outcome: ForwardOutcome,
  date: string,
): boolean {
  if (date <= signal.signalDate) return true;
  if (outcome.status === 'skipped') return false;
  if (
    outcome.status === 'pending' ||
    outcome.status === 'open' ||
    outcome.status === 'review'
  )
    return true;
  return date <= signal.sessionDates.at(-1)!;
}
function validCandle(r: ResearchCandle) {
  return (
    [r.open, r.high, r.low, r.close].every(
      (n) => Number.isFinite(n) && n > 0,
    ) &&
    r.low <= Math.min(r.open, r.close) &&
    r.high >= Math.max(r.open, r.close)
  );
}
const sameBar = (a: ResearchCandle, b: ResearchCandle) =>
  a.date === b.date &&
  a.open === b.open &&
  a.high === b.high &&
  a.low === b.low &&
  a.close === b.close;

/** Incremental, frozen observed bars; no retroactive editing of closed results. */
export function advanceForwardSignal(
  signal: ForwardSignal,
  previous: ForwardOutcome,
  available: ResearchCandle[],
  asOf: string,
): ForwardOutcome {
  const out: ForwardOutcome = {
    ...previous,
    bars: [...previous.bars],
    needsData: null,
  };
  if (['closed', 'skipped', 'review'].includes(out.status)) return out;
  if (
    Date.parse(signal.recordedAt) >=
    Date.parse(signal.sessionDates[0] + 'T03:45:00Z')
  ) {
    return {
      ...out,
      status: 'review',
      reason: 'Signal was not recorded before entry open',
    };
  }
  const rows = new Map(
    available.filter((r) => r.date <= asOf).map((r) => [r.date, r]),
  );
  for (const bar of out.bars) {
    const current = rows.get(bar.date);
    if (current && !sameBar(bar, current))
      return {
        ...out,
        status: 'review',
        reason:
          'Previously observed candle was revised; manual review required',
      };
  }
  for (const date of signal.sessionDates) {
    if (date > asOf) break;
    if (out.bars.some((r) => r.date === date)) continue;
    const bar = rows.get(date);
    if (!bar || !validCandle(bar))
      return { ...out, needsData: `Missing valid official candle for ${date}` };
    const lastClose = out.bars.at(-1)?.close ?? signal.close;
    if (
      Math.abs(bar.close / lastClose - 1) > 0.25 ||
      Math.abs(bar.open / lastClose - 1) > 0.25
    ) {
      return {
        ...out,
        status: 'review',
        reason: `Large price discontinuity on ${date}; possible corporate action`,
        bars: [...out.bars, { ...bar }],
      };
    }
    out.bars.push({
      date: bar.date,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    });
    out.sessions = out.bars.length;
    if (out.entry === null) {
      if (bar.open <= signal.stop || bar.open >= signal.target)
        return {
          ...out,
          status: 'skipped',
          reason: 'Next open outside frozen stop/target; no entry',
        };
      out.entry = bar.open;
      out.entryDate = date;
      out.status = 'open';
    }
    let exit: number | null = null,
      reason: string | null = null;
    if (bar.open <= signal.stop) {
      exit = bar.open;
      reason = 'Gap below stop';
    } else if (bar.open >= signal.target) {
      exit = bar.open;
      reason = 'Gap above target';
    } else if (bar.low <= signal.stop && bar.high >= signal.target) {
      exit = signal.stop;
      reason = 'Both levels touched; conservative stop';
      out.ambiguous = true;
    } else if (bar.low <= signal.stop) {
      exit = signal.stop;
      reason = 'Stop reached';
    } else if (bar.high >= signal.target) {
      exit = signal.target;
      reason = 'Target reached';
    } else if (out.sessions === signal.rules.holdSessions) {
      exit = bar.close;
      reason = '20-session time exit';
    }
    if (exit !== null) {
      const risk = out.entry - signal.stop;
      const cost = signal.rules.roundTripCost * out.entry;
      return {
        ...out,
        status: 'closed',
        exit,
        exitDate: date,
        reason,
        cost,
        grossR: (exit - out.entry) / risk,
        netR: (exit - out.entry - cost) / risk,
      };
    }
  }
  return out;
}
