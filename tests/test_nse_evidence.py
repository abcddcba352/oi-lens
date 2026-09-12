import datetime as dt
import io
from pathlib import Path
import sqlite3
import sys
import unittest
import zipfile
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from nse_evidence import DDL, parse_delivery, parse_futures, evidence_sql, retention_sql
from backfill_history import MAX_STORED_STRIKES, generate_sql, resolve_archive_tickers

class EvidenceTest(unittest.TestCase):
    def test_retention_removes_old_rows_in_dependency_order(self):
        db = sqlite3.connect(':memory:')
        for statement in DDL:
            db.execute(statement)
        db.executescript('''
            CREATE TABLE oi_snapshots (id TEXT PRIMARY KEY, captured_at TEXT);
            CREATE TABLE oi_strikes (id TEXT PRIMARY KEY, snapshot_id TEXT);
            CREATE TABLE level_outcomes (id TEXT PRIMARY KEY, snapshot_id TEXT, session_date TEXT);
            CREATE TABLE wall_predictions (id TEXT PRIMARY KEY, snapshot_id TEXT, declared_date TEXT);
            CREATE TABLE market_sessions (id TEXT PRIMARY KEY, session_date TEXT);
            CREATE TABLE model_calibrations (id TEXT PRIMARY KEY, lookback_end TEXT);
            INSERT INTO oi_snapshots VALUES ('old','2026-03-01T10:00:00Z'),('keep','2026-03-12T10:00:00Z');
            INSERT INTO oi_strikes VALUES ('old-k','old'),('keep-k','keep');
            INSERT INTO level_outcomes VALUES ('old-o','old','2026-03-01'),('keep-o','keep','2026-03-12');
            INSERT INTO wall_predictions VALUES ('old-w','old','2026-03-01'),('keep-w','keep','2026-03-12');
            INSERT INTO market_sessions VALUES ('old-m','2026-03-01'),('keep-m','2026-03-12');
            INSERT INTO model_calibrations VALUES ('old-c','2026-03-01'),('keep-c','2026-03-12');
            INSERT INTO cash_participation VALUES ('OLD','2026-03-01',1,1,'test'),('KEEP','2026-03-12',1,1,'test');
            INSERT INTO futures_daily VALUES ('OLD','2026-03-01','2026-03-20',1,1,1,1,1,1,'test'),('KEEP','2026-03-12','2026-03-20',1,1,1,1,1,1,'test');
            INSERT INTO sector_prices VALUES ('OLD','2026-03-01',1),('KEEP','2026-03-12',1);
            INSERT INTO sector_membership VALUES ('OLD','X','2026-03-01'),('KEEP','X','2026-03-12');
            INSERT INTO sector_imports VALUES ('OLD','2026-03-01'),('KEEP','2026-03-12');
        ''')
        for statement in retention_sql('2026-03-12'):
            db.execute(statement)
        for table in ('oi_snapshots', 'oi_strikes', 'level_outcomes', 'wall_predictions',
                      'market_sessions', 'model_calibrations', 'cash_participation',
                      'futures_daily', 'sector_prices', 'sector_membership', 'sector_imports'):
            self.assertEqual(db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0], 1, table)

    def test_stored_chain_is_bounded(self):
        self.assertEqual(MAX_STORED_STRIKES, 30)

    def test_generator_never_reinserts_sessions_before_retention_cutoff(self):
        sessions = {'NSE:TCS-EQ': [
            {'date': '2026-03-11', 'open': 99, 'high': 102, 'low': 98, 'close': 101},
            {'date': '2026-03-12', 'open': 101, 'high': 104, 'low': 100, 'close': 103},
        ]}
        statements = generate_sql([], sessions, set(), '2026-03-12')
        inserts = [statement for statement in statements if statement.startswith('INSERT INTO market_sessions')]
        self.assertEqual(len(inserts), 1)
        self.assertIn('2026-03-12', inserts[0])

    def test_all_resolves_to_actual_fo_universe(self):
        records = [
            {'instrument_id': 'NSE:TCS-EQ'},
            {'instrument_id': 'NSE:NIFTY50-INDEX'},
        ]
        self.assertEqual(resolve_archive_tickers({'ALL'}, records), {'TCS', 'NIFTY'})
        self.assertEqual(resolve_archive_tickers({'TCS'}, records), {'TCS'})

    def test_delivery_date_missing_and_bounds(self):
        content = b'SYMBOL, SERIES, DATE1, TTL_TRD_QNTY, DELIV_QTY\nTCS, EQ, 11-Sep-2026, 100, -\nBAD, EQ, 11-Sep-2026, 100, 120\nOLD, EQ, 10-Sep-2026, 100, 50\n'
        result = parse_delivery(content, dt.date(2026, 9, 11), {'ALL'})
        self.assertEqual(result, {'NSE:TCS-EQ': {'volume': 100, 'delivery': None}})

    def test_futures_excludes_options_and_preserves_expiries(self):
        content = 'FinInstrmTp,TradDt,TckrSymb,XpryDt,ClsPric,PrvsClsgPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,NewBrdLotQty\n'
        content += 'STF,2026-09-11,TCS,2026-09-29,100,99,1000,100,20,100\n'
        content += 'STF,2026-09-11,TCS,2026-10-29,101,100,2000,200,30,100\n'
        content += 'STO,2026-09-11,TCS,2026-09-29,5,4,5000,500,50,100\n'
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr('test.csv', content)
        result = parse_futures(buffer.getvalue(), dt.date(2026, 9, 11), {'TCS'})
        self.assertEqual(len(result['NSE:TCS-EQ']), 2)
        self.assertEqual(result['NSE:TCS-EQ'][1]['expiry'], '2026-10-29')

    def test_sql_reimport_is_idempotent_and_missing_delivery_preserves_known(self):
        db = sqlite3.connect(':memory:')
        for statement in DDL:
            db.execute(statement)
        session = {'date': '2026-09-11', 'participation': {'volume': 100, 'delivery': 50}}
        for _ in range(2):
            db.executescript('\n'.join(evidence_sql('NSE:TCS-EQ', session)))
        session['participation']['delivery'] = None
        db.executescript('\n'.join(evidence_sql('NSE:TCS-EQ', session)))
        self.assertEqual(db.execute('SELECT volume,delivery FROM cash_participation').fetchall(), [(100, 50)])

if __name__ == '__main__':
    unittest.main()
