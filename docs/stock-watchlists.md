# Stock watchlists

Open **Stock Watchlists** in the dashboard. Select 5–20 sessions (Short-term) or 3–6 months (Positional Research).
These screens use real stored daily candles, not live quotes. The positional horizon
is a technical research shortlist, not a fundamentals-based investment recommendation.

## Architecture and Four-Group Classification

The watchlist engine separates eligibility, ranking, and evidence coverage into four distinct groups:

1. **Priority setups**: Fully confirmed technical setups meeting all moving-average trend rules, tight consolidation/breakout conditions, positive meaningful risk distance (≥0.5 ATR), and verified participation evidence (cash volume ≥1.3× and delivery ≥1.2× vs. own 20-session median baselines, or futures long buildup).
2. **Developing setups**: Technically constructive candidates that are either approaching overhead resistance, consolidating within a base, extended beyond initial entry (waiting for pullback/retest), or pending volume/OI participation confirmation.
3. **Data incomplete**: Active F&O symbols that currently lack the required historical depth (minimum 60 sessions for short-term, 120 sessions for positional) or baseline observations. Missing delivery, sector, or futures data remains **Unavailable** and is never treated as zero, bearish, or confirmation.
4. **Excluded (with explicit reasons)**: Disqualified symbols with clear reasons, such as unconfirmed rising trends, stale prices (>7 days), corporate action discontinuities (>25% overnight move), or invalid risk distance (invalidation ≥ entry).

## Short-Term List (5–20 Sessions)

- **Trend requirement**: Price must exceed a rising 20-session moving average (`average > olderAverage` over the prior 10 sessions).
- **Four distinct stages**:
  - `Approaching resistance`: Close is within 1 ATR below prior 20-session resistance and below entry trigger.
  - `Breakout with participation`: Close exceeds entry trigger (`resistance + 0.25 ATR`) with above-normal volume (≥1.3× 20d median) and delivery (≥1.2× 20d median), or active futures long buildup.
  - `Successful breakout retest`: Evaluated chronologically without future leakage. A prior candle broke out above resistance, a subsequent pullback tested resistance (low within 0.5 ATR of resistance) while strictly holding above invalidation, and the latest candle closes back above resistance.
  - `Extended beyond reasonable entry area`: Close exceeds `entryTrigger + 1.5 ATR`. Tracked in Developing Setups to await a pullback or retest.
- **Participation baselines**: Compare against the stock's own 20-session median volume and delivery quantity. Option volume never substitutes for cash volume.
- **Rollover protection**: Exclude futures contracts with ≤5 calendar days remaining to expiry to avoid expiry rollover distortions. Same-contract price and OI changes separate genuine long buildup from short covering, short buildup, and long unwinding.

## Positional List (3–6 Months)

- Minimum 120 valid trading sessions.
- Rising 50-session moving average.
- Structural higher lows (`recentLow > oldLow`) and contained consolidation base (`(resistance - baseLow) / ATR <= 10`).
- 63-session relative strength vs. NIFTY on matching start and end dates.
- Sector benchmark comparisons with valid dated constituent membership.
- Label: **Positional technical research**.
- Fundamentals, valuation, and management quality are explicitly labeled as **Unassessed**.
- Notice: Stored history covers up to 183 calendar days and does not validate a 6-month holding strategy.

## Risk and Ranking Transparency

- **Indicative invalidation**: `recentLow - 0.25 ATR` (where `recentLow` is the lowest low of the prior 10 sessions).
- **Indicative entry**: `max(latest.close, entryTrigger)`.
- **Meaningful risk distance**: `risk = indicativeEntry - invalidation`. Must be strictly positive and ≥0.5 ATR. If non-positive, the setup is excluded.
- **Overhead resistance & targets**: Nearest older confirmed pivot high (at least 2 sessions on either side with lower highs).
  - When unmapped (e.g. stock at all-time highs / blue-sky territory), the system flags **Target review required** with `nextResistance: null` and `rewardRisk: null`. It never fabricates arbitrary targets or infinite reward/risk ratios.
- **Technical score (0–100)**: Purely reflective of price-action structure (rising trend 25, higher lows 15, range contraction 15, compact base 10, relative strength 15, strong close beyond resistance 10, overhead room ≥2× risk 10). Correlated signals are not double-counted.
- **Evidence coverage**: Evaluated separately (0–100%) across cash volume baseline, delivery baseline, futures positioning, and sector benchmark history.
- **Headwinds**: Below-normal volume (<0.8× median), subdued delivery, futures short buildup, long unwinding, and lagging sector benchmarks are surfaced as opposing evidence.

## Snapshot Materialization & Cloudflare D1 Performance

Page loads serve precomputed snapshots directly from the `watchlist_snapshots` table:
- **Fast serving**: Queries a single row by `(horizon, as_of)`, responding in <20ms instead of running a 200,000-row table scan during user requests.
- **Atomic insertion**: Ingestion or initial request computes and stores the full payload atomically.
- **Stale fallback**: If generation fails or encounters transient timeouts, the API falls back to the most recent cached snapshot with an explicit notice (`staleFallback: true`), guaranteeing high availability.
- **Retention**: Preserves the rolling 183-calendar-day retention. Expired snapshots are purged alongside older market sessions and evidence rows.

## API

`GET /api/market/watchlist?horizon=short` or `horizon=positional`
Optional parameter `?force=true` forces a fresh recalculation.
Returns `prioritySetups`, `developingSetups`, `dataIncomplete`, `excluded`, `candidates`, `asOf`, `scannedCount`, and `exclusions`.

