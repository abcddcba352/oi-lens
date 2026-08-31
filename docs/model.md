# OI Lens six-month model

OI Lens treats current open-interest walls as candidates, not automatic support or resistance. It fetches the live FYERS option chain on each request. The first request for an instrument backfills the previous 183 calendar days of daily candles; later requests re-fetch only a five-day overlap and retain the merged history.

## Current option-chain evidence

For each put strike at or below spot and call strike at or above spot, the
engine creates a *candidate* zone from:

1. Five-strike clustered OI using weights `0.25, 0.60, 1.00, 0.60, 0.25`.
2. Option-volume confirmation normalized across the loaded chain.
3. Distance from spot normalized by ATR and the strike step.
4. A same-expiry OI delta only when OI Lens has saved at least two earlier
   live snapshots. The provider's OI-change field is a previous-session input,
   not an intraday delta.
5. PCR and payout-minimising (`max pain`) values as limited, near-chain context
   rather than standalone support or resistance rules.

OI is participation data, not a directional guarantee. A put or call OI wall
therefore proposes a price zone that the two horizon-specific models evaluate.

## Six-month daily price-zone evidence

The FYERS `/data/history` endpoint supplies daily OHLCV candles. ATR14 is calculated from those candles. Each current strike is then tested against the six-month history:

- A support test requires price to approach the strike from above and trade within the larger of `0.18 × ATR` or `0.35 × strike step`.
- Resistance uses the mirrored rule from below.
- The following three sessions must avoid a closing breach beyond `0.25 × ATR` and finish on the expected side.
- Repeated observations within three sessions are collapsed to avoid counting one interaction several times.
- Recent tests receive more weight, with an approximately 63-session decay horizon.
- Untested zones receive a neutral historical prior rather than an invented success rate.

## Transparent strength scores

The application does not call a heuristic a probability. Both outputs are
0-100 strength scores that rank candidate zones within their own horizon.

- **Intraday:** 35% clustered OI, 23% option volume, 18% proximity, 15%
  application-saved OI flow, and 9% same-session OI persistence. When the
  snapshot archive is not yet populated, OI-flow evidence is neutral rather
  than invented.
- **Positional:** 26% clustered OI, 14% previous-session OI change, 10%
  volume, 10% proximity, 28% six-month price-zone defence, 8% same-expiry OI
  continuity, and 4% volatility-regime fit.

The UI shows the zone width, invalidation level, history window, daily test
count and observed defence rate for the two ranked primary zones, plus the
number of saved OI snapshots. A calibrated
hold probability should be added only after enough time-ordered,
out-of-sample observations exist for each horizon.

## Separate intraday and positional maps

The application returns two independent maps rather than stretching one score
across incompatible horizons.

- **Intraday map:** Uses the selected expiry's live OI clusters, option volume,
  distance from spot, and saved same-session OI snapshots.  A live OI change
  is used only after at least two application snapshots exist; the provider's
  previous-session OI change is not mislabeled as an intraday delta.  The map
  is a 0-100 positioning-strength score, not a backtested probability.
- **Positional map:** Uses current OI to propose zones, then adds six months of
  daily price-zone tests, current daily OI change, volatility regime, and
  same-expiry OI continuity.  Its stated horizon is capped by the selected
  option contract's expiry and never exceeds ten trading sessions.

Both maps show a zone around each strike and an ATR-aware invalidation level.
Put and call OI are treated as candidate positioning zones, not proof that a
particular strike will support or resist price. PCR and payout-minimising
(`max pain`) values are context from the loaded strike window only.

## F&O stock profile

Single-stock option chains use a separate profile from index chains. The
calibration set is restricted to the same FYERS stock symbol, so an index or a
different company's OI behaviour cannot train the selected stock. Historical
same-stock outcomes contribute a beta-shrunk hold prior while the sample is
small; after 40 tested outcomes, a time-ordered six-feature calibration is
activated. Stock ranking gives more weight to traded option volume, filters
isolated zero-volume strikes when enough liquid alternatives exist, limits the
candidate distance from spot, and uses wider ATR-aware zones and invalidations
to reflect single-stock gap and volatility risk. Expiry-specific live OI flow
remains separate from cross-expiry, normalized six-month outcome learning.

## Data architecture

- The live option chain and the newest daily candles are fetched server-side from FYERS.
- Daily candles are cached by instrument and session date. Recent rows are upserted so corrected candles replace older values.
- Live option-chain snapshots are retained at most once per instrument, expiry, and 15-minute window. Earlier same-expiry snapshots feed the live intraday OI-flow and positional continuity inputs; longer historical-OI calibration requires enough future, time-ordered outcomes.
- Recorded positional outcomes keep one updated support and resistance wall per instrument, expiry, and trading day. They are evaluated only after every declared future session exists, include a breach on the touch-day close, and never extend beyond the expiry's remaining weekdays.
- The provider interface remains broker-neutral so another licensed data source can be added later.
- Scraping exchange pages is intentionally excluded.

## Free NSE EOD OI import

The local `import:nse-oi` workflow downloads official NSE F&O UDiFF bhavcopy
archives and creates idempotent D1 inserts for explicitly selected underlyings.
It stores the nearest-expiry end-of-day chain with the exchange's reported OI,
change in OI, option volume and underlying price. This is daily EOD evidence,
not intraday history. Each stock or index is saved under its own FYERS-compatible
instrument id and is never used to calibrate another instrument.
