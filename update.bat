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
REM --- Find a REAL Python (a plain "where python" is fooled by the Microsoft
REM     Store alias, which then prints "Python was not found" and does nothing). ---
set "PY="
for %%I in ("py -3" "python" "py" "python3") do (
  if not defined PY (
    %%~I -c "import sys" >nul 2>nul && set "PY=%%~I"
  )
)
if not defined PY (
  echo [ERROR] No real Python found. Either:
  echo   1^) Install Python from https://python.org and TICK "Add Python to PATH", or
  echo   2^) Turn off the Store alias: Settings ^> Apps ^> Advanced app settings
  echo      ^> App execution aliases ^> turn off "python.exe" and "python3.exe".
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
%PY% -m pip install -q -r backend\requirements.txt
if errorlevel 1 (
  echo.
  echo [ERROR] "pip install" failed. See messages above.
  pause
  exit /b 1
)
%PY% -m pip show onnxruntime-gpu >nul 2>nul
if errorlevel 1 (
  echo       Installing optional AI inpaint packages ^(safe to skip on failure^)...
  %PY% -m pip install -q -r backend\requirements-ai.txt
  if errorlevel 1 (
    echo [WARN] AI inpaint packages not installed ^(needs Python 3.10+^). App runs without AI inpaint.
  )
) else (
  echo       NVIDIA CUDA build detected - keeping it ^(run setup-gpu.bat to reinstall^).
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
REM Pass the exact Python we found to the app (so the backend launches even when
REM only the `py` launcher exists or `python` isn't on PATH).
for /f "delims=" %%E in ('%PY% -c "import sys;print(sys.executable)" 2^>nul') do set "GCD_PYTHON=%%E"
call npm start

echo.
echo App closed. You can close this window.
