# Strategy comparison — 11 September 2026 cutoff

Decision: **no dependable winner**. Trend baseline was selected using earlier results only, but failed the later check. The short-term watchlist implements it for observation, with no priority recommendation or fitted probability. Positional research is unchanged and not validated by this study.

| Fixed rules | Earlier trades | Earlier mean net R | Later trades | Later mean net R |
| --- | ---: | ---: | ---: | ---: |
| Trend baseline | 104 | +0.193 | 54 | -0.284 |
| Price breakout | 47 | +0.101 | 27 | -0.232 |
| Pullback and recovery | 53 | +0.125 | 22 | -0.306 |
| Pullback with OI room | 4 | +0.130 | 3 | +0.469 |

R means entry-to-stop risk, not a percentage return. OI's three later trades do not establish an edge. Changing to that variant after seeing these results would be selection on the evaluation period.

## Data and timing

219 stocks; 125 official NSE archive sessions, 12 March–11 September 2026. Cash OHLC/volume and all available stock-option strikes/expiries were downloaded locally, not inserted into D1. The NIFTY benchmark was read from official-source daily sessions in D1. Require an available stock-option chain on the signal date; cash prices continue to be used for subsequent stock-trade exits. This is a cash-stock hypothetical strategy, not option premium or leveraged futures P&L.

60 sessions of warmup. Signal uses EOD information; entry is next-session open, skipped if outside frozen stop/target. All variants use stop = signal close − 2 ATR and target = close + 4 ATR. These projected levels are not observed support/resistance. Gaps affect actual reward/risk. Exit at stop, target or the twentieth session's close. If both levels are touched in one daily candle, conservatively take the stop. Opening gaps use opening price. Deduct assumed 0.2% round-trip entry notional; this is not an instrument/account-specific fee estimate.

One signal per strategy/stock per 20-session window, even when a trade exits early. Require all 20 subsequent sessions before comparing outcomes, including trades which exit earlier. Windows ending before 1 August enter selection; signals on/after 1 August enter the later test. Windows crossing this boundary are purged. This leaves a short later sample and can suppress new later entries while a preceding window is active.

Selection: highest earlier mean net R with at least 30 trades across 10 stocks. Later results may reject but cannot switch the chosen rules. Minimum later gate: 30 trades, 10 stocks, positive average and positive lower 95% stock-cluster bootstrap bound. The checked-in study fails. Confidence intervals use 1,000 deterministic stock-cluster resamples, not market-date blocks; contemporaneous market dependence remains.

## Exact rules

Shared `lib/research-strategy.ts` evaluates live/research signals: close above MA20; MA20 above MA50 and above its value five sessions earlier; 20-session stock return exceeding NIFTY on matching dates; prior 20-session median volume at least 25,000 shares. ATR is the mean of the last 14 true ranges. Missing current price, benchmark, liquidity history or invalid prices cannot qualify. A >25% one-session price discontinuity in the input requires corporate-action review.

Breakout: close above prior 20-session high plus 0.25 ATR, but no more than 1.5 ATR above that high. Pullback: during the prior five sessions, at least one low reached its contemporaneous MA20 + 0.5 signal-date ATR and closed above that MA20 − ATR; signal close exceeds previous high and its own open, and is within 1.5 ATR above current MA20. OI variant also requires the strongest traded put below spot within 1 ATR and strongest traded call above spot at least 2 ATR away, from the nearest unexpired full chain. OI does not establish buyer/writer intent or attract price mechanically.

## Limits and deployment policy

- Exploratory six-month sample already inspected in previous research, **not an untouched holdout**. No global claim about the best strategy.
- Corporate actions are not normalized. Future >25% discontinuities are separately excluded for review (zero in these compared usable groups); smaller actions can still distort results.
- No portfolio allocation, capital constraints, market-date clustering, drawdown estimate, dividends or precise instrument fees. Aggregate trade averages are not an investable portfolio return.
- Full archived chains support the OI comparison. Live retained chains can be truncated, so the OI variant is **not** activated as an equivalent live entry filter.
- Live trend candidates are sorted descriptively by relative strength. Buying only top-ranked names is untested. No orders are placed. A separate prospective ledger was added on 15 September 2026; its recorded outcomes are not part of this historical comparison.
- Official daily ingestion continues to refresh candidates through existing materialization. This frozen study does **not** automatically rerun or gain validation as new data arrives.
- Six months of input history cannot validate a six-month holding strategy.

The [AQR time-series momentum paper](https://www.aqr.com/Insights/Research/Journal-Article/Time-Series-Momentum) studies 12-month signals across diversified futures/forwards. It motivates examining trend but does **not** validate this shorter Indian-stock rule or its OI filter.

## Reproduction

Run `python scripts/prepare-strategy-input.py <archive-directory>` followed by `node --experimental-strip-types scripts/compare-strategies.mjs <archive-directory>`.

Preparation expects dated `YYYY-MM-DD.json.gz` files with `{date, chains: [{symbol, expiry, chain: [{strike, call_oi, put_oi, call_volume, put_volume}]}], cash: [{symbol, date, open, high, low, close, volume, delivery}]}`. They come from official NSE FO bhavcopies and cash delivery reports, not synthetic fixtures. All archives remain local research inputs, outside the source repository.

The runner reuses `strategy-benchmark.json`, or reads it from D1 when absent. `--refresh-benchmark` explicitly refreshes that read-only input. Outputs: `strategy-comparison.json` (including individual trades) and CSV. `lib/strategy-study.json` contains the reviewed dated summary used in the UI. Review before replacing it; live entry rules and deployment status are deliberately not automatically retuned by this research command.
