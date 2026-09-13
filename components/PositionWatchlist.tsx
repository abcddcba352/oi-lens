'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { WatchCandidate, WatchHorizon } from '@/lib/position-watchlist';
import type { WatchlistPayload, DataIncompleteCandidate, ExcludedCandidate } from '@/lib/watchlist-materializer';

type ActiveTab = 'priority' | 'developing' | 'incomplete' | 'excluded';

const price = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export function PositionWatchlist({ onSelectSymbol }: { onSelectSymbol: (symbol: string) => void }) {
  const [horizon, setHorizon] = useState<WatchHorizon>('short');
  const [activeTab, setActiveTab] = useState<ActiveTab>('priority');
  const [data, setData] = useState<WatchlistPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    void fetch(`/api/market/watchlist?horizon=${horizon}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async response => {
        const payload = (await response.json()) as WatchlistPayload & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? 'Unable to load watchlist.');
        if (!controller.signal.aborted) setData(payload);
      })
      .catch(reason => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'Unable to load watchlist.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [horizon, refresh]);

  const priorityMatches =
    data?.prioritySetups?.filter(c =>
      `${c.name} ${c.symbol}`.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  const developingMatches =
    data?.developingSetups?.filter(c =>
      `${c.name} ${c.symbol}`.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  const incompleteMatches =
    data?.dataIncomplete?.filter(c =>
      `${c.name} ${c.symbol} ${c.reason}`.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  const excludedMatches =
    data?.excluded?.filter(c =>
      `${c.name} ${c.symbol} ${c.reason}`.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];

  const getStageBadgeClass = (stage: string) => {
    switch (stage) {
      case 'Breakout with participation':
        return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
      case 'Successful breakout retest':
        return 'bg-sky-500/20 text-sky-300 border-sky-500/40';
      case 'Approaching resistance':
        return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
      case 'Extended beyond reasonable entry area':
        return 'bg-purple-500/20 text-purple-300 border-purple-500/40';
      default:
        return 'bg-secondary text-secondary-foreground border-border';
    }
  };

  return (
    <section className="space-y-5">
      <div className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Trading & Positional Watchlists</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Trend, consolidation base, relative strength, and verified participation evidence.
            </p>
          </div>
          <Button variant="outline" disabled={loading} onClick={() => setRefresh(x => x + 1)}>
            Refresh watchlist
          </Button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Holding horizon">
          <Button
            aria-pressed={horizon === 'short'}
            variant={horizon === 'short' ? 'default' : 'outline'}
            onClick={() => setHorizon('short')}
          >
            5–20 sessions (Short-term)
          </Button>
          <Button
            aria-pressed={horizon === 'positional'}
            variant={horizon === 'positional' ? 'default' : 'outline'}
            onClick={() => setHorizon('positional')}
          >
            3–6 months (Positional Research)
          </Button>
        </div>

        {horizon === 'positional' ? (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
            <p className="font-semibold">Positional Technical Research Notice:</p>
            <p className="mt-1 text-xs text-amber-200/90">
              Stored history covers up to 183 calendar days and does not validate a 6-month holding strategy.
              Corporate fundamentals, valuation and governance remain <strong className="underline">Unassessed</strong>.
              Technical scores are not win probabilities or promises of future returns.
            </p>
          </div>
        ) : (
          <p className="mt-3 text-sm text-amber-200">
            Short-term technical research watchlist. Breakouts require confirmed volume/OI participation and hold/retest confirmation. Scores are explainable ranking factors, not win probabilities.
          </p>
        )}

        {data?.staleFallback && (
          <p className="mt-3 text-xs text-amber-300">
            Notice: Serving cached snapshot from {data.asOf} while new calculation updates.
          </p>
        )}

        {data && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-3 text-xs text-muted-foreground">
            <div>
              <span>Cutoff {data.asOf} · </span>
              <span>{data.scannedCount} universe stocks evaluated · </span>
              <span>{data.prioritySetups?.length ?? 0} Priority · </span>
              <span>{data.developingSetups?.length ?? 0} Developing · </span>
              <span>{data.dataIncomplete?.length ?? 0} Data Incomplete</span>
            </div>
            <div className="text-amber-200/80">
              Missing inputs: {data.missingInputs.join(' ')}
            </div>
          </div>
        )}
      </div>

      {/* Group Navigation Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-border pb-2" role="tablist">
        <button
          role="tab"
          aria-selected={activeTab === 'priority'}
          onClick={() => setActiveTab('priority')}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'priority'
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted/50 text-muted-foreground hover:bg-muted'
          }`}
        >
          Priority Setups ({data?.prioritySetups?.length ?? 0})
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'developing'}
          onClick={() => setActiveTab('developing')}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'developing'
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted/50 text-muted-foreground hover:bg-muted'
          }`}
        >
          Developing Setups ({data?.developingSetups?.length ?? 0})
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'incomplete'}
          onClick={() => setActiveTab('incomplete')}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'incomplete'
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted/50 text-muted-foreground hover:bg-muted'
          }`}
        >
          Data Incomplete ({data?.dataIncomplete?.length ?? 0})
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'excluded'}
          onClick={() => setActiveTab('excluded')}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'excluded'
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted/50 text-muted-foreground hover:bg-muted'
          }`}
        >
          Excluded ({data?.excluded?.length ?? 0})
        </button>
      </div>

      <Input
        aria-label="Search watchlist"
        placeholder="Search by stock name, symbol, or status…"
        value={query}
        onChange={e => setQuery(e.target.value)}
      />

      {loading && <p role="status">Scanning saved market history and materialized snapshots…</p>}
      {error && (
        <p role="alert" className="rounded-xl border border-rose-400/30 p-4 text-rose-200">
          {error}
        </p>
      )}

      {/* Tab Content: Priority Setups */}
      {!loading && !error && activeTab === 'priority' && (
        <div className="space-y-4">
          {priorityMatches.length === 0 ? (
            <p className="rounded-xl border border-border p-5 text-sm text-muted-foreground">
              No priority setups currently meeting all trend, participation and risk-distance criteria for {horizon === 'short' ? 'short-term' : 'positional'}. Check the Developing Setups tab for emerging watch candidates.
            </p>
          ) : (
            priorityMatches.map(c => renderCandidateCard(c, onSelectSymbol))
          )}
        </div>
      )}

      {/* Tab Content: Developing Setups */}
      {!loading && !error && activeTab === 'developing' && (
        <div className="space-y-4">
          {developingMatches.length === 0 ? (
            <p className="rounded-xl border border-border p-5 text-sm text-muted-foreground">
              No developing setups match the current filter.
            </p>
          ) : (
            developingMatches.map(c => renderCandidateCard(c, onSelectSymbol))
          )}
        </div>
      )}

      {/* Tab Content: Data Incomplete */}
      {!loading && !error && activeTab === 'incomplete' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
            <p>
              These active F&O symbols are currently excluded from technical ranking due to incomplete session history or missing baseline observations. Missing delivery, futures, or sector data remains <strong>Unavailable</strong> and is never treated as bearish or zero.
            </p>
          </div>
          {incompleteMatches.length === 0 ? (
            <p className="rounded-xl border border-border p-5 text-sm text-muted-foreground">
              No symbols with incomplete data.
            </p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {incompleteMatches.map(item => (
                <div key={item.symbol} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold">{item.name} <span className="text-xs font-mono text-muted-foreground">({item.symbol})</span></h3>
                    <span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300">
                      {item.sessions} / {item.requiredSessions} sessions
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-rose-300">{item.reason}</p>
                  {item.missingDetails.length > 0 && (
                    <ul className="mt-2 list-inside list-disc text-xs text-muted-foreground">
                      {item.missingDetails.map((detail, i) => (
                        <li key={i}>{detail}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab Content: Excluded */}
      {!loading && !error && activeTab === 'excluded' && (
        <div className="space-y-4">
          {data?.exclusions && (
            <div className="rounded-xl border border-border bg-card p-4 text-sm">
              <h3 className="font-semibold text-foreground">Exclusion Breakdown</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {Object.entries(data.exclusions).map(([reason, count]) => (
                  <span
                    key={reason}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs"
                  >
                    <span className="text-muted-foreground">{reason}:</span>
                    <strong className="text-foreground">{count}</strong>
                  </span>
                ))}
              </div>
            </div>
          )}
          {excludedMatches.length === 0 ? (
            <p className="rounded-xl border border-border p-5 text-sm text-muted-foreground">
              No excluded symbols match the current search.
            </p>
          ) : (
            <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {excludedMatches.map(item => (
                <div key={item.symbol} className="rounded-lg border border-border bg-card p-3">
                  <div className="flex justify-between font-medium">
                    <span>{item.name}</span>
                    {item.close !== undefined && <span className="font-mono">{price(item.close)}</span>}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{item.reason}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Coverage and methodology details */}
      {data && (
        <details className="rounded-xl border border-border p-4 text-sm">
          <summary className="cursor-pointer font-medium">Screening Methodology & Coverage Guidelines</summary>
          <div className="mt-3 space-y-2 text-xs text-muted-foreground">
            <p>
              Short-term list requires 60 sessions and a rising 20-session moving average. Positional list requires 120 sessions and a rising 50-session moving average. Resistance is defined over the prior 20/40 sessions, excluding evaluated candles.
            </p>
            <p>
              Breakout retests are evaluated chronologically: a prior breakout must have held above invalidation, tested resistance within 0.5 ATR, and closed above resistance without future lookahead.
            </p>
            <p>
              Reward/risk uses the greater of latest close and breakout trigger as indicative entry. When overhead resistance has no older confirmed pivot high, targets and reward/risk remain <strong>Target review required</strong> rather than fabricating arbitrary upside.
            </p>
            <p>
              Participation and sector evidence are evaluated separately from the 0–100 technical score. Missing delivery or futures data remains <strong>Unavailable</strong> and is never treated as zero or bearish confirmation.
            </p>
            <p className="text-amber-200">{data.validation}</p>
          </div>
        </details>
      )}
    </section>
  );
}

function renderCandidateCard(c: WatchCandidate, onSelectSymbol: (symbol: string) => void) {
  return (
    <article key={c.symbol} className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-bold">
              {c.name} <span className="font-mono text-base font-normal">{price(c.close)}</span>
            </h2>
            <span
              className={`rounded border px-2 py-0.5 text-xs font-semibold ${
                c.group === 'priority'
                  ? 'border-emerald-500/40 bg-emerald-500/20 text-emerald-300'
                  : 'border-blue-500/40 bg-blue-500/20 text-blue-300'
              }`}
            >
              {c.group === 'priority' ? 'Priority Setup' : 'Developing Setup'}
            </span>
            <span
              className={`rounded border px-2 py-0.5 text-xs font-semibold ${
                c.stage === 'Breakout with participation'
                  ? 'border-emerald-500/40 bg-emerald-500/20 text-emerald-300'
                  : c.stage === 'Successful breakout retest'
                  ? 'border-sky-500/40 bg-sky-500/20 text-sky-300'
                  : c.stage === 'Approaching resistance'
                  ? 'border-amber-500/40 bg-amber-500/20 text-amber-300'
                  : c.stage === 'Extended beyond reasonable entry area'
                  ? 'border-purple-500/40 bg-purple-500/20 text-purple-300'
                  : 'border-border bg-secondary text-secondary-foreground'
              }`}
            >
              {c.stage}
            </span>
            {c.targetReviewRequired && (
              <span className="rounded border border-amber-500/40 bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-300">
                Target review required
              </span>
            )}
            {c.researchLabel && (
              <span className="rounded border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {c.researchLabel} · Fundamentals {c.fundamentalsStatus ?? 'Unassessed'}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            EOD {c.asOf} · {c.source} · {c.sessions} sessions · Risk: ₹{c.riskDistance} ({c.riskDistanceAtr} ATR)
          </p>
        </div>

        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-primary/10 px-2.5 py-1 text-xs font-bold text-primary">
              {c.score}/100 Technical Score
            </span>
            {c.evidenceCoverage && (
              <span
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  c.evidenceCoverage.coveragePercent >= 75
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : 'bg-amber-500/20 text-amber-300'
                }`}
              >
                {c.evidenceCoverage.coveragePercent}% Evidence Coverage ({c.evidenceCoverage.availableCount}/{c.evidenceCoverage.totalCount})
              </span>
            )}
          </div>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Prior price resistance</dt>
          <dd className="font-medium">{price(c.resistance)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Breakout trigger</dt>
          <dd className="font-medium">{price(c.entryTrigger)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Indicative invalidation</dt>
          <dd className="font-medium">{price(c.invalidation)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Next historical resistance</dt>
          <dd className="font-medium">
            {c.nextResistance === null ? 'Unmapped (ATH)' : price(c.nextResistance)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Distance to prior resistance</dt>
          <dd className="font-medium">
            {c.distancePercent}% / {c.distanceAtr} ATR
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Potential reward / risk</dt>
          <dd className="font-medium">
            {c.rewardRisk === null ? (
              <span className="text-amber-300">Target review required</span>
            ) : (
              `${c.rewardRisk}×`
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Return vs NIFTY</dt>
          <dd className="font-medium">
            {c.relativeStrength === null
              ? 'Benchmark missing'
              : `${c.relativeStrength > 0 ? '+' : ''}${c.relativeStrength} pp`}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Breakout probability</dt>
          <dd className="font-medium text-muted-foreground">Not validated</dd>
        </div>
      </dl>

      {/* Technical Score Breakdown */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Score factors:</span>
        {c.scoreBreakdown && c.scoreBreakdown.length > 0 ? (
          c.scoreBreakdown.map((item, idx) => (
            <span key={idx} className="rounded bg-muted px-1.5 py-0.5">
              {item.factor} (+{item.points})
            </span>
          ))
        ) : (
          <span>{c.reasons.join(' · ')}</span>
        )}
      </div>

      {/* Supporting & Opposing Evidence Chips */}
      {c.evidence && (
        <div className="mt-3 space-y-1.5">
          {c.evidence.supportingEvidence.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-medium text-emerald-300">Supporting:</span>
              {c.evidence.supportingEvidence.map((text, idx) => (
                <span
                  key={idx}
                  className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-200"
                >
                  ✓ {text}
                </span>
              ))}
            </div>
          )}
          {c.evidence.opposingEvidence.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-medium text-rose-300">Headwinds:</span>
              {c.evidence.opposingEvidence.map((text, idx) => (
                <span
                  key={idx}
                  className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-rose-200"
                >
                  ⚠ {text}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Participation and Sector Details */}
      {c.evidence && (
        <div className="mt-4 rounded-lg border border-border p-3 text-sm">
          <p className="font-semibold text-xs uppercase tracking-wider text-muted-foreground">
            Participation & Sector Checks
          </p>
          <dl className="mt-2 grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Cash volume / normal</dt>
              <dd className="font-medium">
                {c.evidence.volumeRatio === null ? (
                  <span className="text-amber-200">Unavailable</span>
                ) : (
                  `${c.evidence.volumeRatio}×`
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Delivery quantity / normal</dt>
              <dd className="font-medium">
                {c.evidence.deliveryRatio === null ? (
                  <span className="text-amber-200">Unavailable</span>
                ) : (
                  `${c.evidence.deliveryRatio}×`
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Delivery percentage</dt>
              <dd className="font-medium">
                {c.evidence.deliveryPercent === null ? (
                  <span className="text-amber-200">Unavailable</span>
                ) : (
                  `${c.evidence.deliveryPercent}%`
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Futures positioning</dt>
              <dd className="font-medium">
                {c.evidence.futuresPattern ?? (
                  <span className="text-amber-200">Unavailable</span>
                )}
                {c.evidence.futuresExpiry && ` · ${c.evidence.futuresExpiry}`}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Sector benchmark</dt>
              <dd className="font-medium">
                {c.evidence.sector ?? <span className="text-amber-200">Unmapped</span>}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Stock vs sector</dt>
              <dd className="font-medium">
                {c.evidence.stockVsSector === null ? (
                  <span className="text-amber-200">Unavailable</span>
                ) : (
                  `${c.evidence.stockVsSector > 0 ? '+' : ''}${c.evidence.stockVsSector} pp`
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Sector vs NIFTY</dt>
              <dd className="font-medium">
                {c.evidence.sectorVsNifty === null ? (
                  <span className="text-amber-200">Unavailable</span>
                ) : (
                  `${c.evidence.sectorVsNifty > 0 ? '+' : ''}${c.evidence.sectorVsNifty} pp`
                )}
              </dd>
            </div>
          </dl>

          {c.evidence.missing.length > 0 && (
            <p className="mt-2 text-xs text-amber-200/80">
              Missing evidence data: {c.evidence.missing.join(' · ')}
            </p>
          )}
        </div>
      )}

      <Button className="mt-4" variant="outline" onClick={() => onSelectSymbol(c.symbol)}>
        Inspect Level Map
      </Button>
    </article>
  );
}

