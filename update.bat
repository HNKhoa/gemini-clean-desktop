@echo off
chcp 65001 >nul
title Gemini Clean - Update ^& Launch
cd /d "%~dp0"

echo ==================================================
echo    GEMINI CLEAN  -  Update ^& Launch
echo ==================================================
echo.

REM --- 0. Check prerequisites -----------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install it from https://nodejs.org then run again.
  echo.
  pause
  exit /b 1
)
where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found. Install it from https://python.org then run again.
  echo.
  pause
  exit /b 1
)

REM --- 1. Node dependencies -------------------------------------------
echo [1/4] Installing / updating Node packages...
call npm install
if errorlevel 1 (
  echo.
  echo [ERROR] "npm install" failed. See messages above.
  pause
  exit /b 1
)

REM --- 2. Python dependencies -----------------------------------------
echo.
echo [2/4] Installing / updating Python packages...
python -m pip install -q -r backend\requirements.txt
if errorlevel 1 (
  echo.
  echo [ERROR] "pip install" failed. See messages above.
  pause
  exit /b 1
)
echo       Installing optional AI inpaint packages ^(safe to skip on failure^)...
python -m pip install -q -r backend\requirements-ai.txt
if errorlevel 1 (
  echo [WARN] AI inpaint packages not installed ^(needs Python 3.10+^). App runs without AI inpaint.
)

REM --- 3. Build the frontend ------------------------------------------
echo.
echo [3/4] Building app (Vite)...
call npm run build
if errorlevel 1 (
  echo.
  echo [ERROR] Build failed. See messages above.
  pause
  exit /b 1
)

REM --- 4. Launch ------------------------------------------------------
echo.
echo [4/4] Starting Gemini Clean...
echo       (Keep this window open while you use the app. Closing it stops the app.)
echo.
call npm start

echo.
echo App closed. You can close this window.
