@echo off
chcp 65001 >nul
title Gemini Clean
cd /d "%~dp0"

REM --- Quick launcher: opens the already-built app (no rebuild). ---
REM --- After changing/updating code, run update.bat instead.      ---

where node >nul 2>nul
if errorlevel 1 ( echo [ERROR] Node.js not found. Install from https://nodejs.org & echo. & pause & exit /b 1 )

REM Find a REAL Python (a plain "where python" is fooled by the Microsoft Store alias).
set "PY="
for %%I in ("py -3" "python" "py" "python3") do (
  if not defined PY (
    %%~I -c "import sys" >nul 2>nul && set "PY=%%~I"
  )
)
if not defined PY (
  echo [ERROR] No real Python found. Install Python from https://python.org and TICK "Add Python to PATH",
  echo         or turn off the Store alias in Settings ^> Apps ^> App execution aliases.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" ( echo First time here - run update.bat once to set up. & echo. & pause & exit /b 1 )
if not exist "dist" ( echo No build found - run update.bat once to build the app. & echo. & pause & exit /b 1 )

echo Starting Gemini Clean...
echo (Keep this window open while using the app. Closing it stops the app.)
echo.
for /f "delims=" %%E in ('%PY% -c "import sys;print(sys.executable)" 2^>nul') do set "GCD_PYTHON=%%E"
call npm start

echo.
echo App closed. You can close this window.
