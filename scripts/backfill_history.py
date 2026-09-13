"""Build a D1 import from official NSE F&O and Cash Market UDiFF bhavcopies.

Features:
- Downloads option chain snapshots & daily price sessions (OHLC + ATR14) directly from official NSE archives.
- Smart trading-day discovery: `--days N` targets N valid trading sessions (not raw calendar days).
- Holiday & weekend resilience: handles 404s cleanly, logs staleness warnings if data is >2-3 weekdays old.
- Warm-up preservation: retrieves 15 prior sessions of price candles so ATR-14 is mathematically accurate.
- Safe D1 no-op: outputs `SELECT 1;` when no new records exist so wrangler executions never fail.

Examples:
  python scripts/backfill_history.py --symbols ALL --days 3 --output nse_oi_update.sql
  python scripts/backfill_history.py --symbols TCS,RELIANCE,NIFTY --days 1
  python scripts/backfill_history.py --symbols ALL --days 183
"""

import argparse
import csv
import datetime
import io
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from nse_evidence import DDL, parse_delivery, parse_futures, parse_sector_prices, evidence_sql, membership_sql, retention_sql


INDEX_SYMBOLS = {
    "NIFTY": ("NSE:NIFTY50-INDEX", "NIFTY 50", 50.0),
    "BANKNIFTY": ("NSE:NIFTYBANK-INDEX", "NIFTY BANK", 100.0),
    "FINNIFTY": ("NSE:FINNIFTY-INDEX", "NIFTY FIN", 50.0),
    "MIDCPNIFTY": ("NSE:MIDCPNIFTY-INDEX", "NIFTY MID SELECT", 25.0),
}

DEFAULT_SYMBOLS = [
    "NIFTY", "BANKNIFTY", "FINNIFTY",
    "RELIANCE", "HDFCBANK", "ICICIBANK", "SBIN", "TCS", "INFY", "ITC",
    "AXISBANK", "KOTAKBANK", "BAJFINANCE", "MARUTI", "LT", "WIPRO",
    "TATAMOTORS", "TATASTEEL", "NTPC", "POWERGRID", "ONGC", "M&M", "ASIANPAINT",
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) OI-Lens/1.0",
    "Accept": "application/zip,application/octet-stream,text/csv,*/*",
    "Accept-Language": "en-US,en;q=0.9",
}

HISTORY_RETENTION_DAYS = 183
MAX_STORED_STRIKES = 30


def parse_date(value):
    for date_format in ("%d-%m-%Y", "%Y-%m-%d", "%d-%b-%Y"):
        try:
            return datetime.datetime.strptime(value.strip(), date_format).strftime("%Y-%m-%d")
        except ValueError:
            pass
    raise ValueError(f"Unrecognized date format: {value}")


def expiry_epoch(expiry_date):
    parsed = datetime.datetime.strptime(expiry_date, "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc)
    return int(parsed.timestamp())


def sql_text(value):
    return "'" + str(value).replace("'", "''") + "'"


def normalize_ticker(value):
    ticker = value.strip().upper()
    if ticker.startswith("NSE:"):
        ticker = ticker[4:]
    if ticker.endswith("-EQ"):
        ticker = ticker[:-3]
    if ticker == "NIFTY50-INDEX":
        return "NIFTY"
    if ticker == "NIFTYBANK-INDEX":
        return "BANKNIFTY"
    return ticker


def ticker_from_instrument_id(instrument_id):
    """Convert a stored instrument id back to the archive ticker used by parsers."""
    for ticker, metadata in INDEX_SYMBOLS.items():
        if metadata[0] == instrument_id:
            return ticker
    return normalize_ticker(instrument_id)


def resolve_archive_tickers(requested_tickers, records):
    """Resolve ALL to the F&O instruments actually present in an FO archive."""
    if "ALL" not in requested_tickers or not records:
        return requested_tickers
    return {ticker_from_instrument_id(record["instrument_id"]) for record in records}


def symbol_metadata(ticker, inferred_step=None):
    if ticker in INDEX_SYMBOLS:
        instrument_id, display_name, step = INDEX_SYMBOLS[ticker]
        return instrument_id, display_name, "index", step
    step = inferred_step if inferred_step and inferred_step > 0 else 1.0
    return f"NSE:{ticker}-EQ", ticker, "stock", step


def infer_strike_step(strikes):
    ordered = sorted(set(strikes))
    differences = [b - a for a, b in zip(ordered, ordered[1:]) if b > a]
    return min(differences) if differences else 1.0


def download_url(url):
    request = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        print(f"Warning: HTTP {error.code} for {url}")
    except Exception as error:
        print(f"Warning: failed to download {url}: {error}")
    return None


def download_bhavcopy_fo(trade_date):
    """Download official NSE F&O UDiFF bhavcopy."""
    date_string = trade_date.strftime("%Y%m%d")
    url = (
        "https://nsearchives.nseindia.com/content/fo/"
        f"BhavCopy_NSE_FO_0_0_0_{date_string}_F_0000.csv.zip"
    )
    return download_url(url)


def download_bhavcopy_cm(trade_date):
    """Download official NSE Cash Market (CM) bhavcopy."""
    date_string = trade_date.strftime("%Y%m%d")
    url_udiff = (
        "https://nsearchives.nseindia.com/content/cm/"
        f"BhavCopy_NSE_CM_0_0_0_{date_string}_F_0000.csv.zip"
    )
    data = download_url(url_udiff)
    if data:
        return data

    # Fallback: Legacy CM format
    year = trade_date.strftime("%Y")
    month_upper = trade_date.strftime("%b").upper()
    day_string = trade_date.strftime("%d")
    url_legacy = (
        f"https://archives.nseindia.com/content/historical/EQUITIES/{year}/{month_upper}/"
        f"cm{day_string}{month_upper}{year}bhav.csv.zip"
    )
    return download_url(url_legacy)


def download_indices_daily(trade_date):
    """Download official NSE daily indices summary (OHLC for NIFTY, BANKNIFTY, etc.)."""
    date_dmy = trade_date.strftime("%d%m%Y")
    url = f"https://nsearchives.nseindia.com/content/indices/ind_close_all_{date_dmy}.csv"
    data = download_url(url)
    if data:
        return data

    url_fallback = f"https://archives.nseindia.com/content/indices/ind_close_all_{date_dmy}.csv"
    return download_url(url_fallback)


def parse_cm_bhavcopy(zip_bytes, requested_tickers):
    """Extract Open, High, Low, Close for common equity series ('EQ')."""
    if not zip_bytes:
        return {}
    prices = {}
    try:
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
            csv_names = [name for name in archive.namelist() if name.lower().endswith(".csv")]
            for name in csv_names:
                content = archive.read(name).decode("utf-8-sig", errors="replace")
                delimiter = "\t" if "\t" in content[:1000] else ","
                reader = csv.DictReader(io.StringIO(content), delimiter=delimiter)
                for row in reader:
                    ticker = (row.get("TckrSymb") or row.get("SYMBOL") or "").strip().upper()
                    series = (row.get("SctySrs") or row.get("SERIES") or "").strip().upper()
                    if series != "EQ":
                        continue
                    if "ALL" not in requested_tickers and ticker not in requested_tickers:
                        continue
                    try:
                        open_p = float(row.get("OpnPric") or row.get("OPEN") or 0)
                        high_p = float(row.get("HghPric") or row.get("HIGH") or 0)
                        low_p = float(row.get("LwPric") or row.get("LOW") or 0)
                        close_p = float(row.get("ClsPric") or row.get("CLOSE") or 0)
                    except (ValueError, TypeError):
                        continue
                    if open_p > 0 and close_p > 0:
                        instrument_id = f"NSE:{ticker}-EQ"
                        prices[instrument_id] = {
                            "open": open_p,
                            "high": high_p if high_p > 0 else max(open_p, close_p),
                            "low": low_p if low_p > 0 else min(open_p, close_p),
                            "close": close_p,
                        }
    except Exception as err:
        print(f"Warning: failed parsing CM bhavcopy: {err}")
    return prices


def parse_indices_csv(csv_bytes, requested_tickers):
    """Extract Open, High, Low, Close for indices."""
    if not csv_bytes:
        return {}
    prices = {}
    try:
        content = csv_bytes.decode("utf-8-sig", errors="replace")
        delimiter = "\t" if "\t" in content[:1000] else ","
        reader = csv.DictReader(io.StringIO(content), delimiter=delimiter)
        for row in reader:
            name = (row.get("Index Name") or row.get("INDEX_NAME") or "").strip().lower()
            if not name:
                continue
            matched_key = None
            if name == "nifty 50":
                matched_key = "NIFTY"
            elif name == "nifty bank":
                matched_key = "BANKNIFTY"
            elif name == "nifty financial services":
                matched_key = "FINNIFTY"
            elif "midcap select" in name or "mid select" in name:
                matched_key = "MIDCPNIFTY"

            if not matched_key:
                continue
            if "ALL" not in requested_tickers and matched_key not in requested_tickers:
                continue

            try:
                open_p = float(row.get("Open Index Value") or row.get("Open") or row.get("OPEN") or 0)
                high_p = float(row.get("High Index Value") or row.get("High") or row.get("HIGH") or 0)
                low_p = float(row.get("Low Index Value") or row.get("Low") or row.get("LOW") or 0)
                close_p = float(row.get("Closing Index Value") or row.get("Close") or row.get("CLOSE") or 0)
            except (ValueError, TypeError):
                continue

            if close_p > 0:
                instrument_id, _, _, _ = symbol_metadata(matched_key)
                prices[instrument_id] = {
                    "open": open_p if open_p > 0 else close_p,
                    "high": high_p if high_p > 0 else max(open_p, close_p),
                    "low": low_p if low_p > 0 else min(open_p, close_p),
                    "close": close_p,
                }
    except Exception as err:
        print(f"Warning: failed parsing indices csv: {err}")
    return prices


def process_fo_csv(trade_date, zip_bytes, requested_tickers):
    if not zip_bytes:
        return [], {}

    grouped = {}
    underlying_spots = {}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        csv_names = [name for name in archive.namelist() if name.lower().endswith(".csv")]
        for name in csv_names:
            content = archive.read(name).decode("utf-8-sig", errors="replace")
            delimiter = "\t" if "\t" in content[:1000] else ","
            for row in csv.DictReader(io.StringIO(content), delimiter=delimiter):
                ticker = row.get("TckrSymb", "").strip().upper()
                if "ALL" not in requested_tickers and ticker not in requested_tickers:
                    continue
                option_type = row.get("OptnTp", "").strip().upper()
                try:
                    spot = float(row.get("UndrlygPric") or 0)
                except (ValueError, TypeError):
                    spot = 0.0

                if spot > 0:
                    underlying_spots[ticker] = spot

                if option_type not in ("CE", "PE"):
                    continue
                try:
                    expiry = parse_date(row["XpryDt"])
                    strike = float(row["StrkPric"])
                    oi = int(float(row.get("OpnIntrst") or 0))
                    oi_change = int(float(row.get("ChngInOpnIntrst") or 0))
                    volume = int(float(row.get("TtlTradgVol") or 0))
                except (KeyError, TypeError, ValueError):
                    continue
                if strike <= 0 or oi < 0:
                    continue
                key = (ticker, expiry)
                group = grouped.setdefault(key, {"spot": 0.0, "strikes": {}})
                if spot > 0:
                    group["spot"] = spot
                strike_row = group["strikes"].setdefault(
                    strike,
                    {
                        "call_oi": 0,
                        "call_oi_change": 0,
                        "call_volume": 0,
                        "put_oi": 0,
                        "put_oi_change": 0,
                        "put_volume": 0,
                    },
                )
                prefix = "call" if option_type == "CE" else "put"
                strike_row[f"{prefix}_oi"] = oi
                strike_row[f"{prefix}_oi_change"] = oi_change
                strike_row[f"{prefix}_volume"] = volume

    records = []
    trade_date_iso = trade_date.strftime("%Y-%m-%d")

    actual_tickers = set(item_ticker for item_ticker, _ in grouped.keys()) if "ALL" in requested_tickers else requested_tickers

    for ticker in actual_tickers:
        expiries = sorted(expiry for item_ticker, expiry in grouped if item_ticker == ticker)
        if not expiries:
            continue
        nearest_expiry = expiries[0]
        group = grouped[(ticker, nearest_expiry)]
        spot = group["spot"]
        if spot <= 0:
            continue
        all_strikes = list(group["strikes"])
        selected = sorted(all_strikes, key=lambda strike: abs(strike - spot))[:MAX_STORED_STRIKES]
        step = infer_strike_step(selected)
        instrument_id, display_name, instrument_type, known_step = symbol_metadata(ticker, step)
        records.append(
            {
                "instrument_id": instrument_id,
                "display_name": display_name,
                "instrument_type": instrument_type,
                "strike_step": known_step,
                "trade_date": trade_date_iso,
                "expiry": nearest_expiry,
                "spot": spot,
                "chain": [
                    {"strike": strike, **group["strikes"][strike]}
                    for strike in sorted(selected)
                ],
            }
        )
    return records, underlying_spots


def download_and_process_day(trade_date, requested_tickers, fetch_fo=True, include_evidence=True):
    """Download F&O bhavcopy (if requested), Cash bhavcopy, and Indices summary for trade_date."""
    trade_date_iso = trade_date.strftime("%Y-%m-%d")
    records = []
    underlying_spots = {}
    fo_bytes = None

    if fetch_fo:
        fo_bytes = download_bhavcopy_fo(trade_date)
        if fo_bytes:
            records, underlying_spots = process_fo_csv(trade_date, fo_bytes, requested_tickers)

    # ALL means every F&O underlying, not every cash-market security. Resolve the
    # universe from the day's derivatives archive before parsing the much larger
    # cash and delivery files. This keeps daily SQL bounded to tradable F&O names.
    effective_tickers = resolve_archive_tickers(requested_tickers, records)

    cm_bytes = download_bhavcopy_cm(trade_date)
    stock_prices = parse_cm_bhavcopy(cm_bytes, effective_tickers)
    participation = {}
    futures = {}
    if include_evidence:
        delivery_bytes = download_url(f'https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{trade_date:%d%m%Y}.csv')
        participation = parse_delivery(delivery_bytes, trade_date, effective_tickers)
        futures = parse_futures(fo_bytes, trade_date, effective_tickers)

    idx_bytes = download_indices_daily(trade_date)
    index_prices = parse_indices_csv(idx_bytes, effective_tickers)

    # Combine price sessions
    daily_sessions = {}
    for inst_id, ohlc in stock_prices.items():
        daily_sessions[inst_id] = {
            "date": trade_date_iso,
            "open": ohlc["open"],
            "high": ohlc["high"],
            "low": ohlc["low"],
            "close": ohlc["close"],
        }

    for inst_id, ohlc in index_prices.items():
        daily_sessions[inst_id] = {
            "date": trade_date_iso,
            "open": ohlc["open"],
            "high": ohlc["high"],
            "low": ohlc["low"],
            "close": ohlc["close"],
        }

    # Never fabricate an OHLC candle from a single derivative underlying quote.
    for inst_id, session in daily_sessions.items():
        session['participation'] = participation.get(inst_id)
        session['futures'] = futures.get(inst_id, [])
    if daily_sessions:
        next(iter(daily_sessions.values()))['sector_prices'] = parse_sector_prices(idx_bytes, trade_date)

    has_data = bool(records or daily_sessions or fo_bytes or cm_bytes)
    return trade_date, records, daily_sessions, has_data


def compute_atr14_series(sessions):
    """Compute Wilder's 14-period ATR across chronological daily sessions."""
    if not sessions:
        return []
    trs = []
    for i, s in enumerate(sessions):
        h = s["high"]
        l = s["low"]
        if i == 0:
            tr = max(h - l, 0.0)
        else:
            prev_c = sessions[i - 1]["close"]
            tr = max(h - l, abs(h - prev_c), abs(l - prev_c))
        trs.append(tr)

    atrs = []
    running_atr = 0.0
    for i, tr in enumerate(trs):
        if i < 14:
            running_atr = sum(trs[:i + 1]) / (i + 1)
        else:
            running_atr = (running_atr * 13.0 + tr) / 14.0
        atrs.append(round(running_atr, 2))

    for s, atr in zip(sessions, atrs):
        s["atr14"] = atr
    return sessions


def number(value):
    return str(int(value)) if float(value).is_integer() else str(value)


def count_weekdays_between(d1, d2):
    """Count business days strictly between d1 and d2 (exclusive of start, inclusive of end)."""
    if d1 >= d2:
        return 0
    cur = d1 + datetime.timedelta(days=1)
    cnt = 0
    while cur <= d2:
        if cur.weekday() < 5:
            cnt += 1
        cur += datetime.timedelta(days=1)
    return cnt


def generate_sql(
    records,
    sessions_by_instrument,
    target_date_strings,
    retention_cutoff_date=None,
    include_evidence=True,
    update_existing_sessions=True,
):
    statements = [statement + ';' for statement in DDL]
    statements.append('CREATE INDEX IF NOT EXISTS oi_snapshots_captured_idx ON oi_snapshots(captured_at);')
    if retention_cutoff_date:
        statements.extend(retention_sql(retention_cutoff_date))
    latest_metadata = {record["instrument_id"]: record for record in records}
    generated_at = datetime.datetime.now(datetime.timezone.utc).isoformat()

    # 1. Instruments metadata
    all_instruments = set(latest_metadata.keys()).union(sessions_by_instrument.keys())
    for instrument_id in sorted(all_instruments):
        if instrument_id in latest_metadata:
            record = latest_metadata[instrument_id]
            display_name = record["display_name"]
            instrument_type = record["instrument_type"]
            strike_step = record["strike_step"]
        else:
            ticker = next((key for key, value in INDEX_SYMBOLS.items() if value[0] == instrument_id), instrument_id[4:-3] if instrument_id.startswith("NSE:") and instrument_id.endswith("-EQ") else instrument_id)
            _, display_name, instrument_type, strike_step = symbol_metadata(ticker)

        statements.append(
            "INSERT INTO instruments (id, symbol, display_name, instrument_type, strike_step, updated_at) VALUES "
            f"({sql_text(instrument_id)}, {sql_text(instrument_id)}, {sql_text(display_name)}, "
            f"{sql_text(instrument_type)}, {number(strike_step)}, {sql_text(generated_at)}) "
            "ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, "
            "instrument_type=excluded.instrument_type, strike_step=excluded.strike_step, updated_at=excluded.updated_at;"
        )

    # 2. Daily Price Sessions (market_sessions) with Wilder's ATR-14
    for instrument_id, sessions in sorted(sessions_by_instrument.items()):
        sessions = sorted({s['date']: s for s in sessions}.values(), key=lambda s: s['date'])
        compute_atr14_series(sessions)
        for s in sessions:
            # Probe padding and ATR warm-up sessions are calculation inputs only.
            # Rewriting them on every daily run wastes D1's row-write allowance.
            if s['date'] not in target_date_strings:
                continue
            if retention_cutoff_date and s['date'] < retention_cutoff_date:
                continue
            if include_evidence:
                statements.extend(evidence_sql(instrument_id, s))
            session_id = f"{instrument_id}:{s['date']}"
            atr_val = number(s["atr14"]) if s.get("atr14") is not None else "NULL"
            conflict_sql = (
                "ON CONFLICT(id) DO UPDATE SET "
                "open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, "
                "atr14=coalesce(excluded.atr14, market_sessions.atr14), source=excluded.source;"
                if update_existing_sessions else
                "ON CONFLICT(id) DO NOTHING;"
            )
            statements.append(
                "INSERT INTO market_sessions (id, instrument_id, session_date, open, high, low, close, atr14, source) VALUES "
                f"({sql_text(session_id)}, {sql_text(instrument_id)}, {sql_text(s['date'])}, "
                f"{number(s['open'])}, {number(s['high'])}, {number(s['low'])}, {number(s['close'])}, "
                f"{atr_val}, 'nse-bhavcopy') "
                + conflict_sql
            )

    # 3. OI Snapshots & Strikes
    for record in sorted(records, key=lambda item: (item["trade_date"], item["instrument_id"])):
        instrument_id = record["instrument_id"]
        expiry = record["expiry"]
        expiry_value = expiry_epoch(expiry)
        captured_at = f"{record['trade_date']}T10:00:00.000Z"
        snapshot_id = f"{instrument_id}:{expiry_value}:{captured_at}"
        stock_atr_proxy = max(record["strike_step"] * 2.5, record["spot"] * 0.018)
        if instrument_id == "NSE:NIFTY50-INDEX":
            atr_proxy = 168.0
        elif instrument_id == "NSE:NIFTYBANK-INDEX":
            atr_proxy = 412.0
        else:
            atr_proxy = stock_atr_proxy
        statements.append(
            "INSERT OR IGNORE INTO oi_snapshots "
            "(id, instrument_id, captured_at, expiry, expiry_epoch, spot, spot_change_percent, atr14, iv_percentile, source) VALUES "
            f"({sql_text(snapshot_id)}, {sql_text(instrument_id)}, {sql_text(captured_at)}, {sql_text(expiry)}, "
            f"{expiry_value}, {number(record['spot'])}, 0, {number(atr_proxy)}, 0.5, 'nse-bhavcopy');"
        )
        for strike in record["chain"]:
            strike_id = f"{snapshot_id}:{number(strike['strike'])}"
            statements.append(
                "INSERT OR IGNORE INTO oi_strikes "
                "(id, snapshot_id, strike, call_oi, call_oi_change, call_volume, call_iv, "
                "put_oi, put_oi_change, put_volume, put_iv) VALUES "
                f"({sql_text(strike_id)}, {sql_text(snapshot_id)}, {number(strike['strike'])}, "
                f"{strike['call_oi']}, {strike['call_oi_change']}, {strike['call_volume']}, NULL, "
                f"{strike['put_oi']}, {strike['put_oi_change']}, {strike['put_volume']}, NULL);"
            )
    return statements


def discover_trading_dates(target_sessions_count, max_lookback_days=45):
    """Walk backwards from today to discover target_sessions_count valid trading dates."""
    today = datetime.date.today()
    candidate_dates = []
    cur = today
    checked_calendar_days = 0

    while len(candidate_dates) < target_sessions_count and checked_calendar_days < max_lookback_days:
        if cur.weekday() < 5:  # Monday to Friday
            candidate_dates.append(cur)
        cur -= datetime.timedelta(days=1)
        checked_calendar_days += 1

    return candidate_dates


def resolve_latest_fo_universe(candidate_dates):
    """Resolve the current stock-futures universe without building option chains."""
    for trade_date in candidate_dates[:15]:
        fo_bytes = download_bhavcopy_fo(trade_date)
        futures = parse_futures(fo_bytes, trade_date, {'ALL'})
        if futures:
            tickers = {ticker_from_instrument_id(instrument_id) for instrument_id in futures}
            # Indices do not use the STF futures rows parsed above, but their daily
            # candles are required as benchmarks and should be included with ALL.
            return tickers.union(INDEX_SYMBOLS), trade_date
    raise RuntimeError('Unable to resolve the current NSE F&O universe from recent archives.')


def main():
    parser = argparse.ArgumentParser(description="Prepare official NSE EOD option OI and daily price history for Cloudflare D1.")
    parser.add_argument(
        "--symbols",
        default=",".join(DEFAULT_SYMBOLS),
        help="Comma-separated NSE F&O underlyings (default: tracked stocks, or ALL)",
    )
    parser.add_argument("--days", type=int, default=183, help="Trading-session count to ingest (default: 183)")
    parser.add_argument("--workers", type=int, default=4, help="Parallel NSE downloads, 1-6 (default: 4)")
    parser.add_argument("--output", default="nse_oi_backfill.sql", help="Generated SQL path")
    parser.add_argument(
        "--price-history-only",
        action="store_true",
        help="Backfill daily OHLC for the current F&O universe without rewriting option snapshots or evidence tables",
    )
    parser.add_argument("--warmup", type=int, default=16, help="Prior sessions for ATR-14 warm-up calculation (default: 16)")
    args = parser.parse_args()

    tickers = {normalize_ticker(value) for value in args.symbols.split(",") if value.strip()}
    if not tickers:
        raise SystemExit("Enter at least one symbol with --symbols.")
    if args.days < 1 or args.days > 370:
        raise SystemExit("--days must be between 1 and 370.")

    today = datetime.date.today()
    max_lookback = max(args.days * 3 + 30, 60)
    target_sessions = args.days
    warmup_sessions = 0 if args.price_history_only else max(25, args.warmup) if target_sessions < 50 else 0

    print(f"Scanning for {target_sessions} trading sessions (with {warmup_sessions} warm-up sessions for ATR-14)...")

    # Probe backwards in small batches to find valid trading days
    valid_target_dates = []
    valid_warmup_dates = []
    cur = today
    checked_days = 0
    workers = max(1, min(6, args.workers))

    # Candidate weekday pool
    weekdays = []
    while checked_days < max_lookback:
        if cur.weekday() < 5:
            weekdays.append(cur)
        cur -= datetime.timedelta(days=1)
        checked_days += 1

    scan_tickers = tickers
    if args.price_history_only and "ALL" in tickers:
        scan_tickers, universe_date = resolve_latest_fo_universe(weekdays)
        print(f"Resolved {len(scan_tickers)} current F&O underlyings/indices from {universe_date}.")

    # First pass: probe target dates with F&O
    records = []
    sessions_by_instrument = {}
    found_trading_days = set()

    with ThreadPoolExecutor(max_workers=workers) as executor:
        # Submit first batch of candidate weekdays
        futures = {
            executor.submit(
                download_and_process_day,
                date,
                scan_tickers,
                not args.price_history_only,
                not args.price_history_only,
            ): date
            for date in weekdays[: target_sessions + 10]
        }
        for future in as_completed(futures):
            trade_date, day_records, day_sessions, has_data = future.result()
            if has_data and (day_records or day_sessions):
                found_trading_days.add(trade_date)
                records.extend(day_records)
                for inst_id, session_data in day_sessions.items():
                    sessions_by_instrument.setdefault(inst_id, []).append(session_data)

    sorted_found_dates = sorted(found_trading_days, reverse=True)
    valid_target_dates = sorted_found_dates[:target_sessions]

    # Resolve ALL once from the target F&O records so warm-up downloads stay on
    # the same bounded derivatives universe even though they intentionally skip FO.
    resolved_tickers = scan_tickers if args.price_history_only else resolve_archive_tickers(tickers, records)

    # If we need warm-up price sessions for accurate ATR-14, fetch CM/Index data for prior weekdays
    if warmup_sessions > 0 and valid_target_dates:
        earliest_target = min(valid_target_dates)
        warmup_candidates = [d for d in weekdays if d < earliest_target][:warmup_sessions + 5]
        with ThreadPoolExecutor(max_workers=workers) as executor:
            warmup_futures = [
                executor.submit(download_and_process_day, date, resolved_tickers, False)
                for date in warmup_candidates
            ]
            for future in as_completed(warmup_futures):
                trade_date, _, day_sessions, has_data = future.result()
                if has_data and day_sessions:
                    valid_warmup_dates.append(trade_date)
                    for inst_id, session_data in day_sessions.items():
                        sessions_by_instrument.setdefault(inst_id, []).append(session_data)

    output = Path(args.output)

    # Check for staleness or upstream issues
    if sorted_found_dates:
        latest_date = sorted_found_dates[0]
        gap_weekdays = count_weekdays_between(latest_date, today)
        if gap_weekdays >= 3:
            print(f"\n[STALENESS WARNING] Most recent available NSE data is from {latest_date} ({gap_weekdays} weekdays ago).")
            print("  If markets were open recently, verify whether NSE archives are delayed or upstream changed.")
        else:
            print(f"\nLatest available NSE session: {latest_date} (gap: {gap_weekdays} weekdays).")
    else:
        print("\n[STALENESS WARNING] No NSE data found in the scanned range. Market closed, holiday, or upstream unavailable.")

    # Filter records to target dates only
    latest_target_date = max(valid_target_dates) if valid_target_dates else today
    retention_cutoff_date = (latest_target_date - datetime.timedelta(days=HISTORY_RETENTION_DAYS)).isoformat()
    target_date_strings = {
        d.strftime("%Y-%m-%d") for d in valid_target_dates
        if d.isoformat() >= retention_cutoff_date
    }
    target_records = [r for r in records if r["trade_date"] in target_date_strings]

    # If no records found, output safe SELECT 1; no-op
    if not target_records and not sessions_by_instrument:
        safe_noop = "-- Market closed, holiday, or no new records found\nSELECT 1;\n"
        output.write_text(safe_noop, encoding="utf-8")
        print(f"No new trading records. Generated safe no-op statement in {output.resolve()}.")
        return

    # Sort each instrument's sessions chronologically before ATR calculation
    for inst_id in sessions_by_instrument:
        sessions_by_instrument[inst_id].sort(key=lambda s: s["date"])

    statements = generate_sql(
        target_records,
        sessions_by_instrument,
        target_date_strings,
        retention_cutoff_date,
        include_evidence=not args.price_history_only,
        update_existing_sessions=not args.price_history_only,
    )
    if not args.price_history_only:
        statements.extend(membership_sql(download_url))
    if not statements:
        statements = ["-- Market closed, holiday, or no new updates\nSELECT 1;"]

    output.write_text("\n".join(statements), encoding="utf-8")

    oi_counts = {}
    for record in target_records:
        oi_counts[record["instrument_id"]] = oi_counts.get(record["instrument_id"], 0) + 1

    stored_session_counts = {
        instrument_id: sum(1 for session in sessions if session['date'] in target_date_strings)
        for instrument_id, sessions in sessions_by_instrument.items()
    }
    total_sessions = sum(stored_session_counts.values())
    print(f"Generated {output.resolve()} with {len(statements)} idempotent statements.")
    print(f"Total target trading sessions found: {len(valid_target_dates)}")
    print(f"Rolling retention cutoff: {retention_cutoff_date} ({HISTORY_RETENTION_DAYS} calendar days)")
    print(f"Total requested price sessions written: {total_sessions}")
    for instrument_id in sorted(set(list(oi_counts.keys()) + list(sessions_by_instrument.keys()))):
        oi_c = oi_counts.get(instrument_id, 0)
        sess_c = stored_session_counts.get(instrument_id, 0)
        print(f"  {instrument_id}: {oi_c} EOD snapshots, {sess_c} daily price sessions")


if __name__ == "__main__":
    main()
