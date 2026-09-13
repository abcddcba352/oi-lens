# Stock watchlists

Open **Stock Watchlists** in the dashboard. Select 5–20 sessions or 3–6 months.
These screens use real stored daily candles, not live quotes. The latter horizon
is a technical research shortlist, not a fundamentals-based investment recommendation.

## Rules

- Minimum history: 60 / 120 valid sessions for short / positional. Six calendar
  months normally contain about 120â€“126 NSE trading sessions.
- Price must exceed a rising 20 / 50-session moving average.
- Prior 20 / 40-session highs define resistance, excluding the evaluated candle.
- Trigger: resistance + 0.25 prior ATR. Invalidation: prior 10-session low − 0.25 ATR.
- ATR is a simple average of the prior 14 true ranges, not Wilder's recursive ATR.
- Reject prices more than 1.5 ATR above trigger, data older than seven calendar
  days, and large price discontinuities requiring corporate-action review.
- Nearest older confirmed pivot high supplies potential overhead resistance.
  Without one, target and reward/risk remain unavailable.
- Compare 20 / 63-session returns against NIFTY on identical start/end dates.
- Score: trend 25, higher lows 15, compression 15, contained base 10,
  relative strength 15, strong breakout close 10, at least 2:1 overhead room 10.

## Limits

The NSE importer now stores cash volume, deliverable quantity, contract-specific
stock futures, sector benchmark closes and dated sector membership snapshots.
Run the importer and apply its SQL before expecting these fields to populate.
Point-in-time fundamentals remain unavailable. Option volume never substitutes
for cash volume, and option OI never substitutes for futures positioning.
No success probability is produced. Orders and position sizing are not automated.

## Participation and sector ingestion

The existing `update:nse-oi` command now also generates and imports five evidence
tables. No separate database migration command is needed: both the importer SQL
and application schema initialization create them idempotently.

- Delivery: official `sec_bhavdata_full_DDMMYYYY.csv`, EQ rows only; dates and
  quantity bounds are checked. Missing delivery stays NULL. Reimports with missing
  delivery retain an existing known value.
- Futures: UDiFF `STF` records only. Store price, previous close, OI, change,
  volume and lot size independently for every expiry. Quotes are not candles.
- Ratios require 20 previous observations. Short imports retrieve at least 25
  warm-up weekdays; missing trading sessions can still leave insufficient coverage.
- Futures classification requires matching candle date and a traded contract
  more than five calendar days from expiry; use its own previous close and OI
  change. A 0.5% price / 1% OI minimum avoids classifying tiny changes.
- Sector membership covers NIFTY IT, BANK, AUTO, FMCG, METAL, PHARMA, REALTY and
  ENERGY constituents. It is benchmark membership, not a comprehensive industry
  taxonomy. Multiple memberships use the newest observed mapping and alphabetical
  tie-breaking. Unmapped stocks are explicitly marked.
- Constituent snapshots are dated when downloaded; do not backdate them. The first
  snapshot can become usable only when the screening date reaches that date.
  Sector return calculations require matching stock and benchmark endpoints.
- Confirmations are displayed separately and do not alter the technical score.

The nightly workflow will use these changes after they are committed/published.
Tests: `python -m unittest discover -s tests -p test_nse_evidence.py` and `npm test`.

The database uses a rolling 183-calendar-day retention window. Each successful
import removes older OI strikes, snapshots, outcomes, price candles and evidence
rows in foreign-key-safe order before inserting new dates. Option chains retain
the 30 strikes nearest spot; distant strikes are not needed for the wall model.
This also means `--days 183` cannot refill dates outside the retention cutoff.

The weekday job writes only its three requested EOD sessions; archive-probing and
ATR warm-up candles are calculation inputs and are not rewritten. A Sunday
maintenance run uses `--price-history-only` to fill six-month OHLC coverage for
the current F&O universe. Existing candles use `ON CONFLICT DO NOTHING`, and the
maintenance file contains no option strikes or participation/futures rewrites.

The rules require walk-forward testing with several years of point-in-time data,
corporate-action adjustments, delisted instruments, transaction costs and purged
overlapping outcomes before making return or probability claims. Six months of
input history does not validate a six-month holding strategy.

## API

`GET /api/market/watchlist?horizon=short` or `horizon=positional` returns candidates,
coverage exclusions and missing inputs. The cutoff is the latest completed official
NSE bhavcopy date.
The scan has a 100,000-row guard; overflow returns a visible service error rather
than partial rankings. A full 420-calendar-day universe scan can be expensive;
production scaling should materialize a daily screening result after ingestion.
