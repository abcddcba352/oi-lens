@echo off
setlocal
cd /d "%~dp0"

echo ========================================================
echo  [OI-LENS] Deploying Application to Cloudflare
echo ========================================================

echo [1/3] Building frontend & server bundles...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Build failed. Please fix any build errors above.
    exit /b %ERRORLEVEL%
)

echo.
echo [2/3] Verifying Wrangler configuration...
node -e "const fs = require('fs'); const p = 'dist/server/wrangler.json'; if (fs.existsSync(p)) { const cfg = JSON.parse(fs.readFileSync(p, 'utf8')); if (Array.isArray(cfg.d1_databases)) { const seen = new Set(); cfg.d1_databases = cfg.d1_databases.filter(d => seen.has(d.binding) ? false : seen.add(d.binding)); } fs.writeFileSync(p, JSON.stringify(cfg, null, 2)); }"

echo.
echo [3/3] Publishing to Cloudflare Workers...
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
