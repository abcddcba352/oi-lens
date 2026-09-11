@echo off
setlocal
cd /d "%~dp0"

echo ========================================================
echo  [OI-LENS] Pushing Updates to GitHub
echo ========================================================

echo [1/3] Adding modified and new files to git...
git add .

echo.
echo [2/3] Committing changes...
git commit -m "Add Resistance Screener Method 2 and GitHub-to-Cloudflare deployment workflow"

echo.
echo [3/3] Pushing to GitHub (origin/main)...
git push origin main

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Git push failed. Please check your git credentials or branch.
    exit /b %ERRORLEVEL%
)

echo.
echo ========================================================
echo  [SUCCESS] Pushed to GitHub!
echo  GitHub Actions will now build and deploy to Cloudflare.
echo ========================================================
endlocal
