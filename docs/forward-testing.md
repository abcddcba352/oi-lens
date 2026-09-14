# Prospective trend research ledger

`trend-forward-v1` records hypothetical cash-stock trades only. It does not place orders, auto-promote a strategy, or turn the failed historical comparison into a validated result.

## Recording and timing

The existing GitHub EOD workflow runs the writer after a successful import, including weekend maintenance. It uses the existing scoped Cloudflare token; there is no public write API. The Windows fallback and `daily:update` also invoke it. The installer script now schedules 18:45 IST; changing that script does not change an already-installed Windows task. The cloud schedule is the authoritative daily job.

The writer defaults to a read-only dry run. `npm run forward:update` explicitly writes. It accepts no arbitrary signal date or simulated clock. Each declaration must be generated after 18:30 IST on its signal session and saved before the next regular session opens; SQL also enforces the deadline using D1's clock. The first eligible run can record the most recent EOD signal over a weekend/holiday provided the next session has not opened. It cannot reconstruct a missed entry after the deadline.

Cash prices must be official NSE bhavcopy, with matching cash-volume history and a same-day stock-option snapshot. Signals reuse `evaluateResearchStrategies` for trend. NIFTY may use NSE or saved FYERS daily data, with the benchmark source recorded. An immutable record contains the signal close, exact ATR/stop/target, relative strength, liquidity, capture time, rules and input hashes. The first run locks the rules hash; edits require an explicit new version, not silent rewriting of the old experiment.

## Outcomes

- Entry: next regular session open, strictly between stop and target; otherwise skipped with no P&L.
- Frozen stop: signal close minus 2 ATR. Projected target: close plus 4 ATR. Not historical resistance.
- Exit: stop, target, or the close of session 20. Gaps use actual opening price; ambiguous stop-and-target candles conservatively take the stop.
- Cost: 0.2% of entry value, charged at exit. Net R = (exit − entry − cost) / (entry − stop). This is an assumed total friction, not account-specific brokerage or a percent-return figure.
- One pending/open/review record blocks another for that stock. Accepted entries retain the original 20-session cooldown after early closure. Skipped entries can qualify on a later date.
- Missing or invalid official candles pause in chronological order: later bars cannot bypass missing entry or stop observations. Observed bars are frozen. Revisions to observed open-trade bars and >25% opening/closing discontinuities create visible review cases excluded from completed averages, not automatic corporate-action adjustments.
- Closed/skipped/review records are not automatically rewritten. No portfolio capital or drawdown model. Review cases can include genuine extreme moves, so excluding them can bias averages; no performance recommendation is inferred.

The reviewed calendar covers regular 2026 weekdays/holidays only. Special sessions are excluded. New captures fail closed when the 20-session schedule would extend beyond the reviewed calendar. Update the calendar from official exchange notices before that boundary. Market-hour reference: [NSE market timings](https://www.nseindia.com/static/market-data/market-timings).

## Storage, scheduling and display

Drizzle migration `0003_colorful_gambit.sql` adds only new ledger tables and adopts the existing watchlist table idempotently. Do not add these tables to runtime DDL or the six-month raw-data deletion list. Compact declarations/outcomes are intentionally retained across raw-data cleanup; they contain at most 20 observed candles per signal, not full chains or all historical inputs.

The writer uses indexed, 30-symbol bounded reads, insert-only declarations, unique keys, a SQL cooldown guard, and optimistic updates for outcomes. Repeated runs cannot replace a declaration or turn an old observation into a new signal. GitHub serializes daily jobs. Apply the new migration once to the primary Cloudflare database before running the writer; Sites applies its checked-in migration during publication.

`GET /api/market/forward-test` is read-only. The private Sites copy proxies only the fixed public OI Lens ledger URL and forwards no credentials or incoming headers. Both links show one ledger rather than two independent experiments. The page displays pending/open/completed/skipped/review totals, missing-candle counts, dated scheduler status, and up to 60 recent records. A missing check-in for 36 hours is a warning, not fabricated freshness. Reloading the page does not run the writer.

Once deployed, run the writer once to initialise it. Check that repeat runs leave signal IDs and capture timestamps unchanged and that zero completed results are shown until a genuinely subsequent candle arrives. Do not dispatch a hindsight replay or seed fake outcomes to populate the page.
# Quota recovery

A weekday ledger-only retry is scheduled at 00:10 UTC (05:40 IST), after the daily D1 quota reset and before the regular market open. It does not repeat the bulk NSE import. GitHub schedules can be delayed; the capture deadline remains enforced even if the job starts late. A failed run never means that new signals have been recorded or that the database is up to date.
