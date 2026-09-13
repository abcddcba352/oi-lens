"""Saturday gap filling for delivery, stock futures and sector daily prices.

Only missing keys within rolling retention are inserted. Limit each run to
12,000 new data rows (indexes also consume D1 writes). Repeated runs resume
from actual stored keys, including after a failed import.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import subprocess

from backfill_history import (
    HISTORY_RETENTION_DAYS, download_bhavcopy_fo, download_indices_daily,
    download_url, resolve_latest_fo_universe,
)
from nse_evidence import parse_delivery, parse_futures, parse_sector_prices, text

MAX_NEW_ROWS = 12000


def read_existing_keys(database, cutoff):
    # The existing date indexes bound these reads to the retained window.
    query = ' '.join(
        f"SELECT {columns} FROM {table} WHERE date >= {text(cutoff)};"
        for table, columns in (
            ('cash_participation', 'symbol,date'),
            ('futures_daily', 'symbol,date,expiry'),
            ('sector_prices', 'benchmark,date'),
        )
    )
    executable = 'npx.cmd' if os.name == 'nt' else 'npx'
    result = subprocess.run(
        [executable, 'wrangler', 'd1', 'execute', database, '--config',
         'wrangler.d1.json', '--remote', '--command', query, '--json'],
        check=True, capture_output=True, text=True,
    )
    payload = json.loads(result.stdout)
    if len(payload) != 3 or any(not item.get('success') for item in payload):
        raise RuntimeError('Cannot read existing evidence keys; refusing a blind backfill.')
    return {
        'cash': {(r['symbol'], r['date']) for r in payload[0]['results']},
        'futures': {(r['symbol'], r['date'], r['expiry']) for r in payload[1]['results']},
        'sectors': {(r['benchmark'], r['date']) for r in payload[2]['results']},
    }


def missing_statements(date, cash, futures, sectors, existing):
    """Emit insert-only SQL; stored observations and memberships stay intact."""
    for symbol, row in sorted(cash.items()):
        if (symbol, date) not in existing['cash']:
            delivery = 'NULL' if row['delivery'] is None else str(row['delivery'])
            yield (
                'cash',
                'INSERT INTO cash_participation (symbol,date,volume,delivery,source) '
                f"VALUES ({text(symbol)},{text(date)},{row['volume']},{delivery},'nse-delivery') "
                'ON CONFLICT(symbol,date) DO NOTHING;',
            )
    for symbol, contracts in sorted(futures.items()):
        for row in sorted(contracts, key=lambda r: r['expiry']):
            if (symbol, date, row['expiry']) not in existing['futures']:
                values = ','.join(str(row[k]) for k in (
                    'close', 'previous_close', 'oi', 'oi_change', 'volume', 'lot_size',
                ))
                yield (
                    'futures',
                    'INSERT INTO futures_daily '
                    '(symbol,date,expiry,close,previous_close,oi,oi_change,volume,lot_size,source) '
                    f"VALUES ({text(symbol)},{text(date)},{text(row['expiry'])},{values},'nse-bhavcopy') "
                    'ON CONFLICT(symbol,date,expiry) DO NOTHING;',
                )
    for benchmark, close in sorted(sectors.items()):
        if (benchmark, date) not in existing['sectors']:
            yield (
                'sectors',
                'INSERT INTO sector_prices (benchmark,date,close) '
                f'VALUES ({text(benchmark)},{text(date)},{close}) '
                'ON CONFLICT(benchmark,date) DO NOTHING;',
            )


def collect_missing(latest, cutoff, tickers, existing, max_rows, loader):
    statements = []
    counts = {'cash': 0, 'futures': 0, 'sectors': 0}
    successful = 0
    date = latest
    while date >= cutoff:
        if date.weekday() < 5:
            cash, futures, sectors = loader(date, tickers)
            successful += bool(cash or futures or sectors)
            for kind, statement in missing_statements(date.isoformat(), cash, futures, sectors, existing):
                statements.append(statement)
                counts[kind] += 1
                if len(statements) >= max_rows:
                    return statements, counts, True
        date -= dt.timedelta(days=1)
    if not successful:
        raise RuntimeError('No valid evidence archives returned; cannot confirm history coverage.')
    return statements, counts, False


def download_evidence(date, tickers):
    cash = parse_delivery(download_url(
        f'https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{date:%d%m%Y}.csv',
    ), date, tickers)
    futures = parse_futures(download_bhavcopy_fo(date), date, tickers)
    sectors = parse_sector_prices(download_indices_daily(date), date)
    return cash, futures, sectors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', default='site-creator-d1')
    parser.add_argument('--output', default='nse_oi_update.sql')
    parser.add_argument('--max-new-rows', type=int, default=MAX_NEW_ROWS)
    args = parser.parse_args()
    if not 1 <= args.max_new_rows <= MAX_NEW_ROWS:
        parser.error(f'--max-new-rows must be between 1 and {MAX_NEW_ROWS}')
    today = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=330)).date()
    dates = [today - dt.timedelta(days=i) for i in range(30)
             if (today - dt.timedelta(days=i)).weekday() < 5]
    tickers, latest = resolve_latest_fo_universe(dates)
    cutoff = latest - dt.timedelta(days=HISTORY_RETENTION_DAYS)
    existing = read_existing_keys(args.database, cutoff.isoformat())
    print(f'Backfilling missing evidence {cutoff} through {latest}; cap {args.max_new_rows} new rows.', flush=True)
    statements, counts, capped = collect_missing(
        latest, cutoff, tickers, existing, args.max_new_rows, download_evidence,
    )
    Path(args.output).write_text('\n'.join(statements or [
        '-- No missing rows found in the available archives.\nSELECT 1;',
    ]), encoding='utf-8')
    print(f'Generated {len(statements)} inserts: {counts}.')
    print('Batch cap reached; next Saturday resumes from stored keys.' if capped else
          'Retained dates scanned. Unavailable NSE archives remain missing and will be retried.')


if __name__ == '__main__':
    main()
