import datetime as dt
import io
from pathlib import Path
import sqlite3
import sys
import unittest
import zipfile
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from nse_evidence import DDL, parse_delivery, parse_futures, evidence_sql
from backfill_history import resolve_archive_tickers

class EvidenceTest(unittest.TestCase):
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
