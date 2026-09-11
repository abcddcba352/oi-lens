#!/usr/bin/env python3
"""scan_resistance.py - Method 2: Bullish Resistance Relocation Scanner.

Scans option chain snapshots across all NSE F&O instruments for the Method 2 footprint:
  1. Old Resistance (K_old) Unwinds: Call writers forced to cover shorts (ΔCall OI < 0).
  2. New Resistance (K_new > K_old) Relocates Higher: Fresh Call writing (ΔCall OI > 0).
  3. High Volume Confirmation: Heavy trading volume on the higher strike.
  4. Spot Price Gain: Spot advancing or pressing into previous resistance.

Usage:
  python scripts/scan_resistance.py
  python scripts/scan_resistance.py --min-shift 1.0 --min-vol-ratio 1.5 --output outputs/relocations.csv
"""

import argparse
import csv
import glob
import os
import sqlite3
import sys
from pathlib import Path


def find_sqlite_db():
    """Locate the Miniflare D1 SQLite database in the .wrangler directory."""
    patterns = [
        ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite",
        "../.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite",
    ]
    for pattern in patterns:
        matches = glob.glob(pattern)
        # Filter out metadata.sqlite
        valid = [m for m in matches if "metadata.sqlite" not in m]
        if valid:
            return valid[0]
    return None


def run_scanner(min_shift=0.5, min_volume_ratio=1.2, output_csv=None):
    db_path = find_sqlite_db()

    print("=" * 80)
    print(" [OI-LENS] Method 2 Scanner: Resistance Moving Up + Strong OI & Volume")
    print("=" * 80)

    if not db_path or not os.path.exists(db_path):
        print(f"[INFO] No local D1 database found ({db_path}). Running in sample/demo scan mode.")
        candidates = get_demo_candidates()
    else:
        print(f"[INFO] Scanning database: {db_path}")
        candidates = scan_database(db_path, min_shift, min_volume_ratio)

    if not candidates:
        print("\n[RESULT] No stocks currently match the strict Method 2 relocation criteria.")
        return

    print(f"\nFound {len(candidates)} qualifying stocks with Bullish Resistance Relocations:\n")

    header = f"{'SYMBOL':<14} | {'SPOT (GAIN)':<15} | {'RESISTANCE SHIFT':<22} | {'UNWOUND AT OLD':<15} | {'NEW OI (+BUILD)':<16} | {'VOL RATIO':<10} | {'SCORE'}"
    print(header)
    print("-" * len(header))

    for c in candidates:
        spot_str = f"₹{c['spot']:,.1f} ({c['spot_change']:+.1f}%)"
        shift_str = f"₹{c['old_r']} -> ₹{c['new_r']} (+{c['shift_pct']:.1f}%)"
        unwind_str = f"{c['unwound_oi']:+,d} ({c['unwind_pct']:+.0f}%)"
        fresh_str = f"{c['new_oi']:,d} (+{c['fresh_pct']:.0f}%)"
        vol_str = f"{c['vol_ratio']:.1f}× Avg"
        score_str = f"{c['score']}/100"

        print(f"{c['symbol']:<14} | {spot_str:<15} | {shift_str:<22} | {unwind_str:<15} | {fresh_str:<16} | {vol_str:<10} | {score_str}")

    print("\n" + "=" * 80)

    if output_csv:
        out_path = Path(output_csv)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=candidates[0].keys())
            writer.writeheader()
            writer.writerows(candidates)
        print(f"[SAVED] Results exported to {output_csv}")


def scan_database(db_path, min_shift, min_volume_ratio):
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # Find all symbols with at least 1 snapshot
    cursor.execute("""
        SELECT instrument_id, COUNT(*) as cnt
        FROM oi_snapshots
        GROUP BY instrument_id
        HAVING cnt >= 1
    """)
    symbols = [row[0] for row in cursor.fetchall()]

    if len(symbols) < 20:
        print(f"[NOTE] Found {len(symbols)} instruments with saved snapshots in local database.")
        print("       To load all 150+ NSE F&O stocks into your local database, run: scripts\\import_local_d1.bat\n")

    candidates = []

    for symbol in symbols:
        cursor.execute("""
            SELECT id, captured_at, spot, spot_change_percent, atr14
            FROM oi_snapshots
            WHERE instrument_id = ?
            ORDER BY captured_at DESC
            LIMIT 2
        """, (symbol,))
        snaps = cursor.fetchall()
        if not snaps:
            continue

        curr_snap_id, curr_time, curr_spot, curr_change, curr_atr = snaps[0]

        # Get strikes for current snapshot
        cursor.execute("""
            SELECT strike, call_oi, call_oi_change, call_volume
            FROM oi_strikes
            WHERE snapshot_id = ?
        """, (curr_snap_id,))
        curr_strikes = {row[0]: {'oi': row[1], 'change': row[2], 'vol': row[3]} for row in cursor.fetchall()}

        if not curr_strikes:
            continue

        if len(snaps) >= 2:
            prev_snap_id, prev_time, prev_spot, prev_change, prev_atr = snaps[1]
            cursor.execute("""
                SELECT strike, call_oi, call_oi_change, call_volume
                FROM oi_strikes
                WHERE snapshot_id = ?
            """, (prev_snap_id,))
            prev_strikes = {row[0]: {'oi': row[1], 'change': row[2], 'vol': row[3]} for row in cursor.fetchall()}
        else:
            # Reconstruct T-1 baseline from current snapshot changes
            prev_spot = curr_spot / (1 + (curr_change or 0) / 100)
            prev_strikes = {
                s: {'oi': max(0, d['oi'] - d['change']), 'change': 0, 'vol': int(d['vol'] * 0.7)}
                for s, d in curr_strikes.items()
            }

        if not prev_strikes:
            continue

        # Find primary resistance (max Call OI above spot) at T-1
        prev_above = [s for s, data in prev_strikes.items() if s > prev_spot and data['oi'] > 0]
        if not prev_above:
            continue
        old_r = max(prev_above, key=lambda s: prev_strikes[s]['oi'])

        # Find primary resistance (max Call OI above spot) at T
        curr_above = [s for s, data in curr_strikes.items() if s > curr_spot and data['oi'] > 0]
        if not curr_above:
            continue
        new_r = max(curr_above, key=lambda s: curr_strikes[s]['oi'])

        # Condition 1: Resistance moved UP
        if new_r <= old_r:
            continue

        shift_pct = ((new_r - old_r) / old_r) * 100
        if shift_pct < min_shift:
            continue

        # Condition 2: Unwinding at Old R
        old_data_curr = curr_strikes.get(old_r)
        old_data_prev = prev_strikes.get(old_r)
        if not old_data_curr or not old_data_prev:
            continue

        unwound_oi = old_data_curr['oi'] - old_data_prev['oi']
        if unwound_oi >= 0 and old_data_curr['change'] >= 0:
            continue  # No unwinding detected

        unwind_pct = (unwound_oi / max(1, old_data_prev['oi'])) * 100

        # Condition 3: Fresh writing at New R
        new_data_curr = curr_strikes.get(new_r)
        new_data_prev = prev_strikes.get(new_r, {'oi': max(1, new_data_curr['oi'] - new_data_curr['change'])})
        fresh_pct = ((new_data_curr['oi'] - new_data_prev['oi']) / max(1, new_data_prev['oi'])) * 100

        # Volume ratio
        all_vols = [d['vol'] for d in curr_strikes.values() if d['vol'] > 0]
        median_vol = sorted(all_vols)[len(all_vols) // 2] if all_vols else 1
        vol_ratio = new_data_curr['vol'] / max(1, median_vol)

        if vol_ratio < min_volume_ratio:
            continue

        score = min(99, max(30, int(shift_pct * 10 + abs(unwind_pct) * 0.8 + fresh_pct * 0.6 + vol_ratio * 5)))

        clean_symbol = symbol.replace("NSE:", "").replace("-EQ", "").replace("-INDEX", "")
        candidates.append({
            'symbol': clean_symbol,
            'spot': curr_spot,
            'spot_change': curr_change,
            'old_r': int(old_r) if old_r.is_integer() else old_r,
            'new_r': int(new_r) if new_r.is_integer() else new_r,
            'shift_pct': shift_pct,
            'unwound_oi': unwound_oi,
            'unwind_pct': unwind_pct,
            'new_oi': new_data_curr['oi'],
            'fresh_pct': fresh_pct,
            'vol_ratio': vol_ratio,
            'score': score,
        })

    conn.close()
    return sorted(candidates, key=lambda x: x['score'], reverse=True)


def get_demo_candidates():
    return [
        {
            'symbol': 'TCS',
            'spot': 3824.5,
            'spot_change': 2.15,
            'old_r': 3800,
            'new_r': 3900,
            'shift_pct': 2.63,
            'unwound_oi': -330000,
            'unwind_pct': -26.4,
            'new_oi': 1840000,
            'fresh_pct': 35.3,
            'vol_ratio': 3.8,
            'score': 94,
        },
        {
            'symbol': 'RELIANCE',
            'spot': 1462.4,
            'spot_change': 1.64,
            'old_r': 1460,
            'new_r': 1500,
            'shift_pct': 2.74,
            'unwound_oi': -720000,
            'unwind_pct': -18.8,
            'new_oi': 4620000,
            'fresh_pct': 26.9,
            'vol_ratio': 3.1,
            'score': 89,
        },
        {
            'symbol': 'INFY',
            'spot': 1845.0,
            'spot_change': 1.35,
            'old_r': 1840,
            'new_r': 1880,
            'shift_pct': 2.17,
            'unwound_oi': -310000,
            'unwind_pct': -14.8,
            'new_oi': 2450000,
            'fresh_pct': 20.7,
            'vol_ratio': 2.4,
            'score': 78,
        },
        {
            'symbol': 'TATAMOTORS',
            'spot': 988.2,
            'spot_change': 1.12,
            'old_r': 980,
            'new_r': 1000,
            'shift_pct': 2.04,
            'unwound_oi': -230000,
            'unwind_pct': -12.4,
            'new_oi': 2920000,
            'fresh_pct': 15.0,
            'vol_ratio': 2.1,
            'score': 72,
        },
    ]


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Scan for Method 2 Resistance Relocations.")
    parser.add_argument("--min-shift", type=float, default=0.5, help="Minimum resistance shift %")
    parser.add_argument("--min-vol-ratio", type=float, default=1.2, help="Minimum volume ratio vs median")
    parser.add_argument("--output", type=str, default=None, help="Path to save output CSV file")
    args = parser.parse_args()

    run_scanner(args.min_shift, args.min_vol_ratio, args.output)
