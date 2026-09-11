@echo off
setlocal
cd /d "%~dp0\.."

echo =========================================================
echo  [OI-LENS] Importing NSE Data into Local SQLite/D1 Cache
echo =========================================================

if exist nse_oi_update.sql (
    echo Applying nse_oi_update.sql to local Miniflare D1...
    call npx wrangler d1 execute site-creator-d1 --config wrangler.d1.json --local --file nse_oi_update.sql
) else (
    echo Downloading latest NSE Bhavcopy and generating nse_oi_update.sql...
    python scripts\backfill_history.py --symbols ALL --days 3 --output nse_oi_update.sql
    call npx wrangler d1 execute site-creator-d1 --config wrangler.d1.json --local --file nse_oi_update.sql
)

if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Local import failed.
    exit /b %ERRORLEVEL%
)

echo =========================================================
echo  [SUCCESS] All 150+ NSE F&O stocks loaded into local D1!
echo =========================================================
endlocal
