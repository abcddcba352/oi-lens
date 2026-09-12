'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { WatchCandidate, WatchHorizon } from '@/lib/position-watchlist';
interface Payload {
  candidates: WatchCandidate[]; scannedCount: number; asOf: string;
  exclusions: Record<string, number>; missingInputs: string[]; validation: string;
}
const price = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
export function PositionWatchlist({ onSelectSymbol }: { onSelectSymbol: (symbol: string) => void }) {
  const [horizon, setHorizon] = useState<WatchHorizon>('short');
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null); setData(null);
    void fetch(`/api/market/watchlist?horizon=${horizon}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const payload = await response.json() as Payload & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? 'Unable to load watchlist.');
        if (!controller.signal.aborted) setData(payload);
      }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Unable to load watchlist.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [horizon, refresh]);
  const visible = data?.candidates.filter(c => `${c.name} ${c.symbol}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <section className="space-y-5">
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-2xl font-bold">Trading & positional watchlists</h1><p className="mt-2 text-sm text-muted-foreground">Trend, consolidation, relative strength and resistance from completed daily candles.</p></div>
        <Button variant="outline" disabled={loading} onClick={() => setRefresh(x => x + 1)}>Refresh watchlist</Button>
      </div>
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Holding horizon">
        <Button aria-pressed={horizon === 'short'} variant={horizon === 'short' ? 'default' : 'outline'} onClick={() => setHorizon('short')}>5–20 sessions</Button>
        <Button aria-pressed={horizon === 'positional'} variant={horizon === 'positional' ? 'default' : 'outline'} onClick={() => setHorizon('positional')}>3–6 months</Button>
      </div>
      <p className="mt-4 text-sm text-amber-200">Technical research watchlist. Scores are not win probabilities. {horizon === 'positional' ? 'Six months is a review horizon. Business and sector checks remain necessary.' : 'Breakout watches require participation and hold/retest confirmation.'}</p>
      {data && <><p className="mt-3 text-xs text-muted-foreground">{data.candidates.length} matches / {data.scannedCount} stocks evaluated · Cutoff {data.asOf}. Each row shows its actual candle date. Level Map may use a newer quote and a different OI resistance.</p><p className="mt-2 text-xs text-amber-200">Unavailable confirmation: {data.missingInputs.join(' · ')}.</p></>}
    </div>
    <Input aria-label="Search watchlist" placeholder="Search stock…" value={query} onChange={e => setQuery(e.target.value)} />
    {loading && <p role="status">Scanning saved price history…</p>}
    {error && <p role="alert" className="rounded-xl border border-rose-400/30 p-4 text-rose-200">{error}</p>}
    {!loading && !error && visible.length === 0 && <p className="rounded-xl border border-border p-4">No matches for this horizon and search.</p>}
    {visible.map(c => <article key={c.symbol} className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap justify-between gap-3"><div><h2 className="text-lg font-bold">{c.name} <span className="font-mono">{price(c.close)}</span></h2><p className="text-xs text-muted-foreground">EOD {c.asOf} · {c.source} · {c.sessions} sessions</p></div><div className="text-right"><p className="font-bold text-primary">{c.score}/100 research score</p><p className="text-xs">{c.stage}</p></div></div>
      <dl className="mt-4 grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
        <div><dt className="text-muted-foreground">Prior price resistance</dt><dd>{price(c.resistance)}</dd></div>
        <div><dt className="text-muted-foreground">Breakout trigger</dt><dd>{price(c.entryTrigger)}</dd></div>
        <div><dt className="text-muted-foreground">Indicative invalidation</dt><dd>{price(c.invalidation)}</dd></div>
        <div><dt className="text-muted-foreground">Next historical resistance</dt><dd>{c.nextResistance === null ? 'Unmapped' : price(c.nextResistance)}</dd></div>
        <div><dt className="text-muted-foreground">Distance to prior resistance</dt><dd>{c.distancePercent}% / {c.distanceAtr} ATR</dd></div>
        <div><dt className="text-muted-foreground">Potential reward / risk</dt><dd>{c.rewardRisk === null ? 'Unavailable' : `${c.rewardRisk}×`}</dd></div>
        <div><dt className="text-muted-foreground">Return vs NIFTY</dt><dd>{c.relativeStrength === null ? 'Benchmark missing' : `${c.relativeStrength > 0 ? '+' : ''}${c.relativeStrength} percentage points`}</dd></div>
        <div><dt className="text-muted-foreground">Breakout probability</dt><dd>Not validated</dd></div>
      </dl>
      <p className="mt-4 text-sm text-muted-foreground">{c.reasons.join(' · ')}</p>
      {c.evidence && <div className="mt-4 rounded-lg border border-border p-3 text-sm">
        <p className="font-bold">Participation and sector checks</p>
        <dl className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div><dt>Cash volume / normal</dt><dd>{c.evidence.volumeRatio === null ? 'Unavailable' : `${c.evidence.volumeRatio}×`}</dd></div>
          <div><dt>Delivery quantity / normal</dt><dd>{c.evidence.deliveryRatio === null ? 'Unavailable' : `${c.evidence.deliveryRatio}×`}</dd></div>
          <div><dt>Delivery percentage</dt><dd>{c.evidence.deliveryPercent === null ? 'Unavailable' : `${c.evidence.deliveryPercent}%`}</dd></div>
          <div><dt>Futures positioning</dt><dd>{c.evidence.futuresPattern ?? 'Unavailable'}{c.evidence.futuresExpiry && ` · ${c.evidence.futuresExpiry}`}</dd></div>
          <div><dt>Sector benchmark membership</dt><dd>{c.evidence.sector ?? 'Unmapped'}</dd></div>
          <div><dt>Stock vs sector</dt><dd>{c.evidence.stockVsSector === null ? 'Unavailable' : `${c.evidence.stockVsSector} pp`}</dd></div>
          <div><dt>Sector vs NIFTY</dt><dd>{c.evidence.sectorVsNifty === null ? 'Unavailable' : `${c.evidence.sectorVsNifty} pp`}</dd></div>
        </dl>
        <p className="mt-3 text-emerald-200">{c.evidence.confirmations.join(' · ') || 'No additional confirmations.'}</p>
        {c.evidence.missing.length > 0 && <p className="mt-2 text-xs text-amber-200">Missing: {c.evidence.missing.join(' · ')}</p>}
        <p className="mt-2 text-xs text-muted-foreground">Ratios use 20 prior sessions. Futures labels are price/OI interpretations, not proof of buyer identity. Sector coverage uses observed index constituents, not every stock in an industry. These checks do not change the technical research score.</p>
      </div>}
      <Button className="mt-4" variant="outline" onClick={() => onSelectSymbol(c.symbol)}>Inspect Level Map</Button>
    </article>)}
    {data && <details className="rounded-xl border border-border p-4 text-sm"><summary>Coverage and methodology</summary>
      <p className="mt-3">Short-term requires 60 sessions and a rising 20-session average. Positional requires 120 sessions and a rising 50-session average. The prior 20/40 sessions define resistance. ATR is the mean of the prior 14 true ranges; trigger and invalidation use a 0.25 ATR buffer. Relative strength compares matching 20/63-session returns to NIFTY.</p>
      <p className="mt-2">Reward/risk uses the greater of the last close and breakout trigger as indicative entry, before costs and gaps. Unmapped resistance does not imply unlimited upside. Thresholds are research assumptions; missing inputs are not confirmations.</p>
      <ul className="mt-3 list-inside list-disc">{Object.entries(data.exclusions).map(([reason, count]) => <li key={reason}>{reason}: {count}</li>)}</ul><p className="mt-3">{data.validation}</p>
    </details>}
  </section>;
}
