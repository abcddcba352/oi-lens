"""NSE participation and sector evidence. Missing values remain missing."""
import csv
import datetime as dt
import io
import math
import zipfile

SECTORS = {
    'NIFTY IT': 'ind_niftyitlist.csv',
    'NIFTY BANK': 'ind_niftybanklist.csv',
    'NIFTY AUTO': 'ind_niftyautolist.csv',
    'NIFTY FMCG': 'ind_niftyfmcglist.csv',
    'NIFTY METAL': 'ind_niftymetallist.csv',
    'NIFTY PHARMA': 'ind_niftypharmalist.csv',
    'NIFTY REALTY': 'ind_niftyrealtylist.csv',
    'NIFTY ENERGY': 'ind_niftyenergylist.csv',
}

DDL = [
    'CREATE TABLE IF NOT EXISTS cash_participation (symbol TEXT NOT NULL, date TEXT NOT NULL, volume REAL NOT NULL, delivery REAL, source TEXT NOT NULL, PRIMARY KEY(symbol,date))',
    'CREATE TABLE IF NOT EXISTS futures_daily (symbol TEXT NOT NULL, date TEXT NOT NULL, expiry TEXT NOT NULL, close REAL NOT NULL, previous_close REAL NOT NULL, oi REAL NOT NULL, oi_change REAL NOT NULL, volume REAL NOT NULL, lot_size REAL NOT NULL, source TEXT NOT NULL, PRIMARY KEY(symbol,date,expiry))',
    'CREATE TABLE IF NOT EXISTS sector_prices (benchmark TEXT NOT NULL, date TEXT NOT NULL, close REAL NOT NULL, PRIMARY KEY(benchmark,date))',
    'CREATE TABLE IF NOT EXISTS sector_membership (symbol TEXT NOT NULL, benchmark TEXT NOT NULL, observed_date TEXT NOT NULL, PRIMARY KEY(symbol,benchmark,observed_date))',
    'CREATE TABLE IF NOT EXISTS sector_imports (benchmark TEXT NOT NULL, observed_date TEXT NOT NULL, PRIMARY KEY(benchmark,observed_date))',
]

def text(value):
    return "'" + str(value).replace("'", "''") + "'"

def numeric(value):
    number = float(str(value).strip().replace(',', ''))
    if not math.isfinite(number):
        raise ValueError('Non-finite value')
    return number

def rows(data):
    if not data:
        return []
    return [{k.strip(): (v or '').strip() for k, v in row.items() if k}
            for row in csv.DictReader(io.StringIO(data.decode('utf-8-sig')))]

def selected(ticker, tickers):
    return 'ALL' in tickers or ticker in tickers

def parse_delivery(data, date, tickers):
    result = {}
    for row in rows(data):
        if row.get('SERIES') != 'EQ' or not selected(row.get('SYMBOL'), tickers):
            continue
        try:
            if dt.datetime.strptime(row['DATE1'], '%d-%b-%Y').date() != date:
                continue
            volume = numeric(row['TTL_TRD_QNTY'])
            delivery = None if row.get('DELIV_QTY', '') in ('', '-') else numeric(row['DELIV_QTY'])
            if volume < 0 or delivery is not None and not 0 <= delivery <= volume:
                continue
        except (KeyError, ValueError):
            continue
        result['NSE:' + row['SYMBOL'] + '-EQ'] = {'volume': volume, 'delivery': delivery}
    return result

def parse_futures(data, date, tickers):
    result = {}
    if not data:
        return result
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for name in archive.namelist():
            if not name.lower().endswith('.csv'):
                continue
            for row in rows(archive.read(name)):
                if row.get('FinInstrmTp') != 'STF' or row.get('TradDt') != date.isoformat() or not selected(row.get('TckrSymb'), tickers):
                    continue
                try:
                    expiry = dt.date.fromisoformat(row['XpryDt']).isoformat()
                    values = {key: numeric(row[field]) for key, field in {
                        'close': 'ClsPric', 'previous_close': 'PrvsClsgPric', 'oi': 'OpnIntrst',
                        'oi_change': 'ChngInOpnIntrst', 'volume': 'TtlTradgVol', 'lot_size': 'NewBrdLotQty',
                    }.items()}
                    if expiry < date.isoformat() or min(values['close'], values['previous_close'], values['lot_size']) <= 0 or min(values['oi'], values['volume']) < 0:
                        continue
                except (KeyError, ValueError):
                    continue
                result.setdefault('NSE:' + row['TckrSymb'] + '-EQ', []).append({'expiry': expiry, **values})
    return result

def parse_sector_prices(data, date):
    result = {}
    for row in rows(data):
        name = row.get('Index Name', '').upper()
        if name not in SECTORS:
            continue
        try:
            if dt.datetime.strptime(row['Index Date'], '%d-%m-%Y').date() != date:
                continue
            value = numeric(row['Closing Index Value'])
            if value > 0:
                result[name] = value
        except (KeyError, ValueError):
            continue
    return result

def evidence_sql(symbol, session):
    result = []
    date = text(session['date'])
    cash = session.get('participation')
    if cash:
        delivery = 'NULL' if cash['delivery'] is None else str(cash['delivery'])
        result.append(f"INSERT INTO cash_participation VALUES ({text(symbol)},{date},{cash['volume']},{delivery},'nse-delivery') ON CONFLICT(symbol,date) DO UPDATE SET volume=excluded.volume,delivery=coalesce(excluded.delivery,cash_participation.delivery),source=excluded.source;")
    for future in session.get('futures', []):
        values = ','.join(str(future[k]) for k in ('close', 'previous_close', 'oi', 'oi_change', 'volume', 'lot_size'))
        result.append(f"INSERT INTO futures_daily VALUES ({text(symbol)},{date},{text(future['expiry'])},{values},'nse-bhavcopy') ON CONFLICT(symbol,date,expiry) DO UPDATE SET close=excluded.close,previous_close=excluded.previous_close,oi=excluded.oi,oi_change=excluded.oi_change,volume=excluded.volume,lot_size=excluded.lot_size;")
    for benchmark, close in session.get('sector_prices', {}).items():
        result.append(f"INSERT INTO sector_prices VALUES ({text(benchmark)},{date},{close}) ON CONFLICT(benchmark,date) DO UPDATE SET close=excluded.close;")
    return result

def membership_sql(download):
    """Current constituent snapshots; no historical membership is inferred."""
    observed = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=330)).date().isoformat()
    statements = []
    for benchmark, filename in SECTORS.items():
        data = download('https://www.niftyindices.com/IndexConstituent/' + filename)
        members = sorted({r['Symbol'] for r in rows(data) if r.get('Series') == 'EQ' and r.get('Symbol')})
        if not members:
            print(f'Warning: sector membership unavailable: {benchmark}')
            continue
        # Replace only this day's snapshot; older observations are retained.
        statements.append(f'DELETE FROM sector_membership WHERE benchmark={text(benchmark)} AND observed_date={text(observed)};')
        for ticker in members:
            statements.append(f'INSERT INTO sector_membership VALUES ({text("NSE:" + ticker + "-EQ")},{text(benchmark)},{text(observed)}) ON CONFLICT DO NOTHING;')
        statements.append(f'INSERT INTO sector_imports VALUES ({text(benchmark)},{text(observed)}) ON CONFLICT DO NOTHING;')
    return statements
