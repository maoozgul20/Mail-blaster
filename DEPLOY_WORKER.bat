@echo off
REM Deploys the backend (API + cron scheduler) to Cloudflare Workers FREE plan and stores secrets from .env
setlocal
cd /d "%~dp0"
if not exist node_modules call INSTALL.bat
call npm run check:free
if errorlevel 1 ( pause & exit /b 1 )
echo Checking Cloudflare login (a browser window opens the first time)...
call npx wrangler whoami >nul 2>nul
if errorlevel 1 call npx wrangler login
call npm run deploy:worker
pause
