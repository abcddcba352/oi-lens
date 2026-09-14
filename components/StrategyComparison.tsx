import study from '@/lib/strategy-study.json';

export function StrategyComparison() {
  const r = (n: number | null) =>
    n === null ? 'Unavailable' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}R`;
  return (
    <details className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
      <summary className="cursor-pointer font-semibold text-amber-200">
        Strategy comparison: no dependable winner
      </summary>
      <p className="mt-3 text-muted-foreground">
        {study.stockCount} stocks examined through {study.asOf}. Trend baseline
        led the earlier period, but failed the later check. It is enabled for
        research observation only. No buy probability is claimed.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <caption className="pb-2 text-left text-muted-foreground">
            Average net result per completed trade; R = initial entry-to-stop
            risk.
          </caption>
          <thead>
            <tr className="border-b border-border">
              <th className="py-2">Fixed rules</th>
              <th>Earlier trades</th>
              <th>Earlier avg.</th>
              <th>Later trades</th>
              <th>Later avg.</th>
            </tr>
          </thead>
          <tbody>
            {study.summaries.map((row) => (
              <tr key={row.id} className="border-b border-border/50">
                <th className="py-2 pr-3 font-medium">
                  {row.name}
                  {row.id === study.selectedId ? ' (selected earlier)' : ''}
                </th>
                <td>{row.selection.count}</td>
                <td>{r(row.selection.meanNetR)}</td>
                <td>{row.later.count}</td>
                <td>{r(row.later.meanNetR)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Signals use EOD data; hypothetical entry is next-session open, with stop
        at signal close minus 2 ATR, target at close plus 4 ATR and a maximum
        20-session hold. Assumed round-trip friction: 0.2% of entry value.
        Same-stock signals are spaced 20 sessions apart. Earlier outcomes end
        before 1 August 2026; later signals start on or after that date.
        Crossing windows are excluded.
      </p>
      <p className="mt-2 text-xs text-amber-200">
        The OI version has only 3 later trades: not enough evidence, despite its
        positive average. This was exploratory data already inspected
        previously, not an untouched holdout. No portfolio drawdown/capital
        model or corporate-action normalization. No 3–6 month validation. This
        dated study does not automatically rerun when daily prices update.
      </p>
    </details>
  );
}
