"""Build a D1 import from official NSE F&O UDiFF bhavcopies.

One end-of-day snapshot is retained for the nearest option expiry of every
requested underlying. Only Python's standard library is required.

Examples:
  python scripts/backfill_history.py --symbols RELIANCE,TCS,SBIN --days 183
  python scripts/backfill_history.py --symbols NIFTY,BANKNIFTY,INFY
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


INDEX_SYMBOLS = {
    "NIFTY": ("NSE:NIFTY50-INDEX", "NIFTY 50", 50.0),
    "BANKNIFTY": ("NSE:NIFTYBANK-INDEX", "NIFTY BANK", 100.0),
    "FINNIFTY": ("NSE:FINNIFTY-INDEX", "NIFTY FIN", 50.0),
    "MIDCPNIFTY": ("NSE:MIDCPNIFTY-INDEX", "NIFTY MID SELECT", 25.0),
}

DEFAULT_SYMBOLS = [
    "RELIANCE", "HDFCBANK", "ICICIBANK", "SBIN", "TCS", "INFY", "ITC",
    "AXISBANK", "KOTAKBANK", "BAJFINANCE", "MARUTI", "LT", "WIPRO",
    "TATAMOTORS", "TATASTEEL", "NTPC", "POWERGRID", "ONGC", "M&M", "ASIANPAINT",
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) OI-Lens/1.0",
    "Accept": "application/zip,application/octet-stream,*/*",
    "Accept-Language": "en-US,en;q=0.9",
}


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


def download_bhavcopy(trade_date):
    date_string = trade_date.strftime("%Y%m%d")
    url = (
        "https://nsearchives.nseindia.com/content/fo/"
        f"BhavCopy_NSE_FO_0_0_0_{date_string}_F_0000.csv.zip"
    )
    request = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        print(f"Warning: NSE returned HTTP {error.code} for {trade_date}")
    except Exception as error:
        print(f"Warning: failed to download {trade_date}: {error}")
    return None


def process_csv(trade_date, zip_bytes, requested_tickers):
    if not zip_bytes:
        return []

    grouped = {}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        csv_names = [name for name in archive.namelist() if name.lower().endswith(".csv")]
        for name in csv_names:
            content = archive.read(name).decode("utf-8-sig")
            delimiter = "\t" if "\t" in content[:1000] else ","
            for row in csv.DictReader(io.StringIO(content), delimiter=delimiter):
                ticker = row.get("TckrSymb", "").strip().upper()
                if "ALL" not in requested_tickers and ticker not in requested_tickers:
                    continue
                option_type = row.get("OptnTp", "").strip().upper()
                if option_type not in ("CE", "PE"):
                    continue
                try:
                    expiry = parse_date(row["XpryDt"])
                    strike = float(row["StrkPric"])
                    oi = int(float(row.get("OpnIntrst") or 0))
                    oi_change = int(float(row.get("ChngInOpnIntrst") or 0))
                    volume = int(float(row.get("TtlTradgVol") or 0))
                    spot = float(row.get("UndrlygPric") or 0)
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
    
    if "ALL" in requested_tickers:
        requested_tickers = set(item_ticker for item_ticker, _ in grouped.keys())

    for ticker in requested_tickers:
        expiries = sorted(expiry for item_ticker, expiry in grouped if item_ticker == ticker)
        if not expiries:
            continue
        nearest_expiry = expiries[0]
        group = grouped[(ticker, nearest_expiry)]
        spot = group["spot"]
        if spot <= 0:
            continue
        all_strikes = list(group["strikes"])
        selected = sorted(all_strikes, key=lambda strike: abs(strike - spot))[:50]
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
    return records


def download_and_process(trade_date, requested_tickers):
    return trade_date, process_csv(trade_date, download_bhavcopy(trade_date), requested_tickers)


def number(value):
    return str(int(value)) if float(value).is_integer() else str(value)


def generate_sql(records):
    statements = []
    latest_metadata = {record["instrument_id"]: record for record in records}
    generated_at = datetime.datetime.now(datetime.timezone.utc).isoformat()

    for instrument_id, record in sorted(latest_metadata.items()):
        statements.append(
            "INSERT INTO instruments (id, symbol, display_name, instrument_type, strike_step, updated_at) VALUES "
            f"({sql_text(instrument_id)}, {sql_text(instrument_id)}, {sql_text(record['display_name'])}, "
            f"{sql_text(record['instrument_type'])}, {number(record['strike_step'])}, {sql_text(generated_at)}) "
            "ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, "
            "instrument_type=excluded.instrument_type, strike_step=excluded.strike_step, updated_at=excluded.updated_at;"
        )

    for record in sorted(records, key=lambda item: (item["trade_date"], item["instrument_id"])):
        instrument_id = record["instrument_id"]
        expiry = record["expiry"]
        expiry_value = expiry_epoch(expiry)
        # UDiFF bhavcopy is EOD: 15:30 IST = 10:00 UTC.
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


def main():
    parser = argparse.ArgumentParser(description="Prepare official NSE EOD option OI for Cloudflare D1.")
    parser.add_argument(
        "--symbols",
        default=",".join(DEFAULT_SYMBOLS),
        help="Comma-separated NSE F&O underlyings (default: tracked stocks)",
    )
    parser.add_argument("--days", type=int, default=183, help="Calendar-day lookback (default: 183)")
    parser.add_argument("--workers", type=int, default=4, help="Parallel NSE downloads, 1-6 (default: 4)")
    parser.add_argument("--output", default="nse_oi_backfill.sql", help="Generated SQL path")
    args = parser.parse_args()

    tickers = {normalize_ticker(value) for value in args.symbols.split(",") if value.strip()}
    if not tickers:
        raise SystemExit("Enter at least one symbol with --symbols.")
    if args.days < 1 or args.days > 370:
        raise SystemExit("--days must be between 1 and 370.")

    end_date = datetime.date.today()
    start_date = end_date - datetime.timedelta(days=args.days)
    dates = []
    current = start_date
    while current <= end_date:
        if current.weekday() < 5:
            dates.append(current)
        current += datetime.timedelta(days=1)

    print(f"Downloading official NSE EOD OI for {', '.join(sorted(tickers))} ({len(dates)} weekdays)...")
    records = []
    workers = max(1, min(6, args.workers))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(download_and_process, date, tickers) for date in dates]
        for index, future in enumerate(as_completed(futures), start=1):
            trade_date, day_records = future.result()
            records.extend(day_records)
            print(f"[{index}/{len(dates)}] {trade_date}: {len(day_records)} symbols", end="\r")
    print()

    output = Path(args.output)
    statements = generate_sql(records)
    output.write_text("\n".join(statements), encoding="utf-8")
    counts = {}
    for record in records:
        counts[record["instrument_id"]] = counts.get(record["instrument_id"], 0) + 1
    print(f"Generated {output.resolve()} with {len(statements)} idempotent statements.")
    for instrument_id, count in sorted(counts.items()):
        print(f"  {instrument_id}: {count} EOD snapshots")
    if not records:
        print("No matching NSE records found; the symbol may not have traded F&O contracts in this period.")


if __name__ == "__main__":
    main()
