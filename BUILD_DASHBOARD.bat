@echo off
REM Builds the dashboard (dashboard\dist) with the URLs from .env
setlocal
cd /d "%~dp0"
if not exist node_modules call INSTALL.bat
if exist .env for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"
if "%API_BASE_URL%"=="" ( echo API_BASE_URL is empty in .env & pause & exit /b 1 )
set VITE_API_BASE_URL=%API_BASE_URL%
set VITE_SUPABASE_URL=%SUPABASE_URL%
set VITE_SUPABASE_ANON_KEY=%SUPABASE_ANON_KEY%
call npm run build:dashboard
if errorlevel 1 ( echo Build failed & pause & exit /b 1 )
echo Dashboard built in dashboard\dist
pause
