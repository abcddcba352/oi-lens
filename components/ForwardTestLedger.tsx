'use client';
import { useEffect, useState } from 'react';
import type { ForwardLedgerPayload } from '@/lib/forward-test-store';
import { Button } from '@/components/ui/button';

const money = (n: number | null) =>
  n === null
    ? '—'
    : `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const time = (s: string) =>
  new Date(s).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  }) + ' IST';
export function ForwardTestLedger() {
  const [data, setData] = useState<ForwardLedgerPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetch('/api/market/forward-test', {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (r) => {
        const body = await r.json() as ForwardLedgerPayload & {error?: string};
        if (!r.ok) throw Error(body.error ?? 'Ledger unavailable');
        return body;
      })
      .then((body) => {
        if (!controller.signal.aborted) setData(body);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refresh]);
  const stale =
    !!data?.state &&
    Date.now() - Date.parse(data.state.lastRunAt) > 36 * 3600000;
  let runNote = '';
  if (data?.state) {
    try {
      const note = JSON.parse(data.state.note);
      runNote = note.missingBenchmark
        ? 'Matching NIFTY data missing; new recording paused.'
        : (note.capture ?? '');
    } catch {
      runNote = data.state.note;
    }
  }
  return (
    <section
      className="rounded-xl border border-sky-500/30 bg-card p-4 space-y-3"
      aria-label="Forward test ledger"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            Forward test — recorded before entry
          </h2>
          <p className="text-sm text-muted-foreground">
            Trend baseline · hypothetical cash-stock trades · separate from
            historical backtests
          </p>
        </div>
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => setRefresh((n) => n + 1)}
        >
          Reload ledger
        </Button>
      </div>
      <p className="text-sm text-amber-200">
        Research only. No real orders and no validated win probability.
        Recording a candidate is not a buy recommendation.
      </p>
      {loading && (
        <p className="text-sm" role="status">
          Loading recorded signals…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-rose-200">
          {error}
        </p>
      )}
      {!loading && !error && data && (
        <>
          {!data.state ? (
            <p className="text-sm">
              Not started yet. The daily updater will initialise the ledger; no
              historical trades will be inserted.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Started {time(data.state.startedAt)} · Last updater run{' '}
                {time(data.state.lastRunAt)} · Evaluated through{' '}
                {data.state.lastEod ?? 'Unavailable'}
              </p>
              {stale && (
                <p role="alert" className="text-sm text-amber-200">
                  Daily updater has not checked in for over 36 hours. Results
                  may be stale.
                </p>
              )}
              <p className="text-sm text-muted-foreground">{runNote}</p>
            </>
          )}
          <div className="flex flex-wrap gap-3 text-sm">
            <span>
              Awaiting entry: <strong>{data.counts.pending ?? 0}</strong>
            </span>
            <span>
              Open: <strong>{data.counts.open ?? 0}</strong>
            </span>
            <span>
              Completed: <strong>{data.results.closed}</strong>
            </span>
            <span>
              Skipped entry: <strong>{data.counts.skipped ?? 0}</strong>
            </span>
            <span>
              Review: <strong>{data.counts.review ?? 0}</strong>
            </span>
            <span>
              Missing candles: <strong>{data.results.needsData}</strong>
            </span>
          </div>
          <p className="text-sm">
            {data.results.meanNetR === null
              ? 'No completed forward trades yet.'
              : `Completed trades: average ${data.results.meanNetR.toFixed(2)}R after assumed costs; ${data.results.positive}/${data.results.closed} positive. ${data.results.ambiguous} ambiguous candles treated as stop-outs.`}
          </p>
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              Recorded signals ({data.records.length} most recent shown)
            </summary>
            {data.records.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                No signals recorded yet. Late or missing-data signals are not
                reconstructed after the entry open.
              </p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="p-2">Stock / signal date</th>
                      <th className="p-2">Recorded</th>
                      <th className="p-2">State</th>
                      <th className="p-2">Entry</th>
                      <th className="p-2">Frozen stop / target</th>
                      <th className="p-2">Exit / net R</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.records.map(({ signal: s, outcome: o }) => (
                      <tr
                        key={s.id}
                        className="border-b border-border/50 align-top"
                      >
                        <th className="p-2 font-medium">
                          {s.name}
                          <div className="text-xs font-normal text-muted-foreground">
                            {s.signalDate}
                          </div>
                        </th>
                        <td className="p-2 text-xs">{time(s.recordedAt)}</td>
                        <td className="p-2">
                          {o.needsData ? 'Waiting for data' : o.status}
                          <div className="text-xs text-muted-foreground">
                            {o.needsData ??
                              o.reason ??
                              `${o.sessions}/20 sessions observed`}
                          </div>
                        </td>
                        <td className="p-2">
                          {money(o.entry)}
                          <div className="text-xs text-muted-foreground">
                            {o.entryDate ?? `Expected ${s.sessionDates[0]}`}
                          </div>
                        </td>
                        <td className="p-2 whitespace-nowrap">
                          {money(s.stop)} / {money(s.target)}
                        </td>
                        <td className="p-2">
                          {money(o.exit)}
                          <div className="text-xs">
                            {o.netR === null
                              ? 'Not completed'
                              : `${o.netR.toFixed(2)}R · ${o.exitDate}`}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        </>
      )}
      <details className="text-sm text-muted-foreground">
        <summary className="cursor-pointer">
          Fixed tracking rules and limitations
        </summary>
        <p className="mt-2">
          Signals must be saved after EOD and before the next regular session
          opens. Entry is that session’s open, only between the frozen stop
          (signal close − 2 ATR) and projected target (close + 4 ATR). Exit at
          stop, target or session 20. Price gaps use opening price; both levels
          touched in one daily candle count as a stop.
        </p>
        <p className="mt-2">
          A 0.2% round-trip cost assumption is deducted at exit. R means
          entry-to-stop risk, not percent return. No overlapping stock trades;
          an accepted entry keeps its 20-session cooldown even after an early
          exit. Missing candles pause tracking. Large discontinuities and
          revisions need review, are reported separately and are excluded from
          completed-trade averages.
        </p>
        <p className="mt-2">
          Regular NSE sessions only; the reviewed holiday calendar currently
          covers 2026. NIFTY daily history may come from NSE or saved FYERS
          data; the source is frozen with each signal. Not a capital-constrained
          portfolio, not a 3–6 month strategy, and not an automatic validation
          gate. Both site links read the same ledger.
        </p>
      </details>
    </section>
  );
}
