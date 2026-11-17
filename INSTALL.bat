@echo off
REM MailBlaster AI - install dependencies (Windows)
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the free LTS version from https://nodejs.org and run this again.
  pause & exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -v') do set NODEMAJOR=%%v
echo Using Node %NODEMAJOR%
if not exist .env (
  copy .env.example .env >nul
  echo Created .env from .env.example - open it in Notepad and fill in your values later.
)
call npm install --no-audit --no-fund
if errorlevel 1 ( echo npm install failed & pause & exit /b 1 )
echo.
echo Done. Next: follow INSTALL.md (Supabase, Google, Cloudflare), then run DEPLOY_WORKER.bat
pause
