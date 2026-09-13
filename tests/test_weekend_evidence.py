import datetime as dt
from pathlib import Path
import sqlite3
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from backfill_weekend_evidence import collect_missing, missing_statements
from nse_evidence import DDL


class WeekendEvidenceTest(unittest.TestCase):
    def empty_keys(self):
        return {'cash': set(), 'futures': set(), 'sectors': set()}

    def test_cap_and_resume_fill_remaining_rows_without_overwriting(self):
        db = sqlite3.connect(':memory:')
        for statement in DDL:
            db.execute(statement)
        cash = {s: {'volume': 100, 'delivery': 50} for s in ('A', 'B', 'C')}
        date = dt.date(2026, 9, 11)
        loader = lambda d, tickers: (cash, {}, {})
        first, counts, capped = collect_missing(date, date, {'ALL'}, self.empty_keys(), 2, loader)
        self.assertTrue(capped)
        self.assertEqual(counts['cash'], 2)
        db.executescript('\n'.join(first))
        existing = self.empty_keys()
        existing['cash'] = set(db.execute('SELECT symbol,date FROM cash_participation'))
        second, counts, capped = collect_missing(date, date, {'ALL'}, existing, 2, loader)
        self.assertFalse(capped)
        self.assertEqual(counts['cash'], 1)
        db.executescript('\n'.join(second))
        # A retry of the same SQL is safe, and an existing value is preserved.
        db.execute("UPDATE cash_participation SET delivery=70 WHERE symbol='A'")
        db.executescript('\n'.join(first + second))
        self.assertEqual(db.execute('SELECT COUNT(*) FROM cash_participation').fetchone()[0], 3)
        self.assertEqual(db.execute("SELECT delivery FROM cash_participation WHERE symbol='A'").fetchone()[0], 70)

    def test_retention_boundary_and_weekends(self):
        seen = []
        def loader(date, tickers):
            seen.append(date.isoformat())
            return {}, {}, {'NIFTY BANK': 100}
        statements, _, _ = collect_missing(
            dt.date(2026, 9, 13), dt.date(2026, 9, 10), {'ALL'}, self.empty_keys(), 10, loader,
        )
        self.assertEqual(seen, ['2026-09-11', '2026-09-10'])
        self.assertEqual(len(statements), 2)

    def test_futures_key_includes_expiry_and_sql_is_valid(self):
        db = sqlite3.connect(':memory:')
        for statement in DDL:
            db.execute(statement)
        contract = dict(close=100, previous_close=99, oi=1000, oi_change=10, volume=20, lot_size=100)
        futures = {'TCS': [dict(contract, expiry='2026-09-29'), dict(contract, expiry='2026-10-27')]}
        existing = self.empty_keys()
        existing['futures'].add(('TCS', '2026-09-11', '2026-09-29'))
        statements = list(missing_statements('2026-09-11', {}, futures, {'NIFTY BANK': 100}, existing))
        db.executescript('\n'.join(statement for _, statement in statements))
        self.assertEqual(db.execute('SELECT expiry FROM futures_daily').fetchall(), [('2026-10-27',)])
        self.assertEqual(db.execute('SELECT close FROM sector_prices').fetchone()[0], 100)

    def test_upstream_outage_does_not_report_complete(self):
        with self.assertRaisesRegex(RuntimeError, 'No valid evidence'):
            collect_missing(dt.date(2026, 9, 11), dt.date(2026, 9, 11), {'ALL'},
                            self.empty_keys(), 10, lambda d, t: ({}, {}, {}))


if __name__ == '__main__':
    unittest.main()
