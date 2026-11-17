@echo off
REM Builds and deploys the dashboard to Cloudflare Pages (free)
setlocal
cd /d "%~dp0"
if not exist node_modules call INSTALL.bat
call npx wrangler whoami >nul 2>nul
if errorlevel 1 call npx wrangler login
call npm run deploy:dashboard
pause
