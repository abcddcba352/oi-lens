@echo off
setlocal
cd /d "%~dp0"

echo ========================================================
echo  [OI-LENS] Deploying Application to Cloudflare
echo ========================================================

echo [1/2] Building frontend & server bundles...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Build failed. Please fix any build errors above.
    exit /b %ERRORLEVEL%
)

echo.
echo [2/2] Publishing to Cloudflare Workers...
call npx wrangler deploy --config dist/server/wrangler.json
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Wrangler deploy failed.
    echo If this is your first time deploying from this machine, run:
    echo     npx wrangler login
    echo and then try again.
    exit /b %ERRORLEVEL%
)

echo.
echo ========================================================
echo  [SUCCESS] OI-Lens is live on Cloudflare!
echo ========================================================
endlocal
