@echo off
REM Builds the Chrome extension into extension\dist and extension\mailblaster-extension.zip
setlocal
cd /d "%~dp0"
if not exist node_modules call INSTALL.bat
call npm run build:extension
if errorlevel 1 ( echo Build failed & pause & exit /b 1 )
echo.
echo Extension built. In Chrome open chrome://extensions, enable Developer mode, click "Load unpacked" and choose:
echo   %~dp0extension\dist
pause
