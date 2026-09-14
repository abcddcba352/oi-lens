import {
  FORWARD_VERSION,
  type ForwardSignal,
  type ForwardOutcome,
} from './forward-test.ts';

export interface ForwardLedgerPayload {
  version: string;
  state: {
    startedAt: string;
    lastRunAt: string;
    lastEod: string | null;
    note: string;
  } | null;
  counts: Record<string, number>;
  results: {
    closed: number;
    positive: number;
    meanNetR: number | null;
    ambiguous: number;
    needsData: number;
  };
  records: {
    signal: ForwardSignal;
    outcome: ForwardOutcome;
    updatedAt: string;
  }[];
  source: string;
}
interface ReadDb {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
    };
  };
}
export async function readForwardLedger(
  db: ReadDb,
): Promise<ForwardLedgerPayload> {
  const [state, groups, results, records] = await Promise.all([
    db
      .prepare(
        'SELECT started_at,last_run_at,last_eod,note FROM forward_test_state WHERE version=?',
      )
      .bind(FORWARD_VERSION)
      .first<{
        started_at: string;
        last_run_at: string;
        last_eod: string | null;
        note: string;
      }>(),
    db
      .prepare(
        'SELECT status,COUNT(*) AS count FROM forward_signals WHERE version=? GROUP BY status',
      )
      .bind(FORWARD_VERSION)
      .all<{ status: string; count: number }>(),
    db
      .prepare(`SELECT SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) AS closed,
      SUM(CASE WHEN status='closed' AND net_r>0 THEN 1 ELSE 0 END) AS positive,
      AVG(CASE WHEN status='closed' THEN net_r END) AS meanNetR,
      SUM(CASE WHEN status='closed' AND json_extract(outcome_json,'$.ambiguous')=1 THEN 1 ELSE 0 END) AS ambiguous,
      SUM(CASE WHEN json_extract(outcome_json,'$.needsData') IS NOT NULL THEN 1 ELSE 0 END) AS needsData
      FROM forward_signals WHERE version=?`)
      .bind(FORWARD_VERSION)
      .first<{
        closed: number;
        positive: number;
        meanNetR: number | null;
        ambiguous: number;
        needsData: number;
      }>(),
    db
      .prepare(
        'SELECT signal_json,outcome_json,updated_at FROM forward_signals WHERE version=? ORDER BY signal_date DESC,symbol LIMIT 60',
      )
      .bind(FORWARD_VERSION)
      .all<{ signal_json: string; outcome_json: string; updated_at: string }>(),
  ]);
  return {
    version: FORWARD_VERSION,
    state: state
      ? {
          startedAt: state.started_at,
          lastRunAt: state.last_run_at,
          lastEod: state.last_eod,
          note: state.note,
        }
      : null,
    counts: Object.fromEntries(groups.results.map((r) => [r.status, r.count])),
    results: {
      closed: results?.closed ?? 0,
      positive: results?.positive ?? 0,
      meanNetR: results?.meanNetR ?? null,
      ambiguous: results?.ambiguous ?? 0,
      needsData: results?.needsData ?? 0,
    },
    records: records.results.map((r) => ({
      signal: JSON.parse(r.signal_json),
      outcome: JSON.parse(r.outcome_json),
      updatedAt: r.updated_at,
    })),
    source: 'Shared OI Lens daily research ledger',
  };
}
