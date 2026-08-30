# OI Lens six-month model

OI Lens treats open-interest walls as **candidates**, not automatic support or resistance. Every instrument is calibrated separately using the 183 calendar days before the prediction date (normally about 126 NSE trading sessions).

## Current-chain features

For every put strike below spot and call strike above spot, the engine calculates:

1. **Clustered OI** — a five-strike weighted cluster (`0.25, 0.60, 1.00, 0.60, 0.25`) so one isolated print does not dominate.
2. **Fresh OI activity** — signed change in OI, scaled by existing OI. Positive buildup strengthens a wall; unwinding weakens it.
3. **Volume confirmation** — option volume normalized across the loaded chain.
4. **Proximity** — `exp(-distance / max(ATR14, 2 × strike step))`, so distance is compared with normal movement rather than raw points.
5. **Persistence** — how consistently the strike/zone remained an OI wall in earlier snapshots.
6. **Regime fit** — whether the current volatility regime resembles the observations behind that pattern.

## Historical labels

A candidate is evaluated over the next three sessions. A support is *tested* when price trades to within `0.15 × ATR` of it; resistance uses the mirrored rule. A level is a *hold* only if no close breaches it by more than `0.25 × ATR` and price ends back on the expected side. Untested levels are excluded from training.

## Calibration and leakage control

The six-month observations are sorted by date. The last 20% is held out for time-ordered validation, while three observations before that boundary are purged because their three-session labels could overlap the validation period. A regularized logistic model converts features into a hold probability. It is re-fit on the complete past window only after validation metrics are measured.

Fewer than 40 tested observations produces a clearly marked **provisional score**. It must not be described as a historical success rate. The UI reports evidence count, validation count, balanced accuracy, and Brier score when available.

## Data architecture

- **FYERS first:** current option chain and available history are fetched server-side using `FYERS_AUTH_TOKEN`.
- **Broker-neutral:** the `MarketDataProvider` interface allows Zerodha, Upstox, Angel One, or a licensed vendor to be added without changing the model or UI.
- **Broker-independent baseline:** official NSE derivative archives can bootstrap end-of-day history after confirming the permitted usage and redistribution terms.
- **D1:** stores sessions, timestamped chains, strike OI, labeled outcomes, and calibration records. Credentials are never stored in D1.

Live broker-free full-chain data should come from an exchange-authorized/licensed market-data feed. Scraping exchange pages is intentionally not part of this design.
