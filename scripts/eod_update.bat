@echo off
setlocal
cd /d "%~dp0\.."

echo ===================================================
echo [OI-LENS] Running End-of-Day NSE Data Update
echo ===================================================

python scripts\backfill_history.py --symbols ALL --days 3 --output nse_oi_update.sql
if %ERRORLEVEL% NEQ 0 (
  echo [ERROR] Python backfill script failed.
  exit /b %ERRORLEVEL%
)

echo [OI-LENS] Applying idempotent updates to Cloudflare D1...
call npx wrangler d1 execute site-creator-d1 --config wrangler.d1.json --remote --file nse_oi_update.sql
if %ERRORLEVEL% NEQ 0 (
  echo [ERROR] Cloudflare D1 execution failed.
  exit /b %ERRORLEVEL%
)

echo [OI-LENS] EOD Update complete!
endlocal
