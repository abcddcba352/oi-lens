# OI Lens six-month model

OI Lens treats current open-interest walls as candidates, not automatic support or resistance. It fetches the live FYERS option chain and the underlying instrument's previous 183 calendar days of daily candles on each request. Historical values are not stored.

## Current option-chain evidence

For each put strike below spot and call strike above spot, the engine measures:

1. Five-strike clustered OI using weights `0.25, 0.60, 1.00, 0.60, 0.25`.
2. Signed OI change relative to existing OI, so buildup strengthens a wall and unwinding weakens it.
3. Option-volume confirmation normalized across the loaded chain.
4. Distance from spot normalized by the 14-session ATR and strike step.
5. PCR and max pain as context rather than standalone support/resistance rules.

## Six-month price-zone evidence

The FYERS `/data/history` endpoint supplies daily OHLCV candles. ATR14 is calculated from those candles. Each current strike is then tested against the six-month history:

- A support test requires price to approach the strike from above and trade within the larger of `0.18 × ATR` or `0.35 × strike step`.
- Resistance uses the mirrored rule from below.
- The following three sessions must avoid a closing breach beyond `0.25 × ATR` and finish on the expected side.
- Repeated observations within three sessions are collapsed to avoid counting one interaction several times.
- Recent tests receive more weight, with an approximately 63-session decay horizon.
- Untested zones receive a neutral historical prior rather than an invented success rate.

## Transparent confidence score

The final 0–100 confidence combines current and historical evidence:

- 30% clustered OI
- 16% signed OI change
- 12% option-volume confirmation
- 12% ATR-normalized proximity
- 24% six-month price-zone defence
- 6% current-versus-historical volatility regime fit

This is an evidence confidence score, not a guaranteed probability of a future hold. The UI shows the exact history window, number of daily sessions, number of zone tests, observed defence rate, distance from spot, PCR, and max pain.

## Data architecture

- The live option chain and six-month daily history are fetched server-side from FYERS.
- No option-chain snapshots or historical candles are saved in the site database.
- The provider interface remains broker-neutral so another licensed data source can be added later.
- Scraping exchange pages is intentionally excluded.
