@echo off
chcp 65001 >nul
title Gemini Clean - Build Standalone EXE
cd /d "%~dp0"

echo ==================================================
echo    GEMINI CLEAN  -  Build Standalone .exe
echo ==================================================
echo This rebuilds everything (latest code + engine + data)
echo then packages a standalone .exe that runs WITHOUT
echo Node.js or Python installed.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install from https://nodejs.org then run again.
  pause
  exit /b 1
)
where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found. Install from https://python.org then run again.
  pause
  exit /b 1
)

echo [1/5] Installing / updating Node packages...
call npm install
if errorlevel 1 ( echo. & echo [ERROR] npm install failed. & pause & exit /b 1 )

echo.
echo [2/5] Installing Python packages + PyInstaller...
python -m pip install -q -r backend\requirements.txt
if errorlevel 1 ( echo. & echo [ERROR] pip install failed. & pause & exit /b 1 )
python -m pip install -q pyinstaller
if errorlevel 1 ( echo. & echo [ERROR] PyInstaller install failed. & pause & exit /b 1 )

echo.
echo [3/5] Building frontend with LATEST data (Vite)...
call npm run build
if errorlevel 1 ( echo. & echo [ERROR] Frontend build failed. & pause & exit /b 1 )

echo.
echo [4/5] Bundling Python backend into gcd-backend.exe...
if exist "backend\pybuild" rmdir /s /q "backend\pybuild"
python -m PyInstaller --onefile --noconsole --noconfirm --name gcd-backend --distpath backend\pybuild --workpath backend\pybuild\work --specpath backend\pybuild --collect-submodules uvicorn --collect-submodules fastapi --collect-submodules starlette --hidden-import h11 --hidden-import python_multipart --hidden-import multipart --hidden-import anyio backend\server.py
if errorlevel 1 ( echo. & echo [ERROR] PyInstaller failed. & pause & exit /b 1 )

echo.
echo [5/5] Packaging standalone app...
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npm run package
if errorlevel 1 (
  echo.
  echo [WARN] Single-file build failed - usually Windows Developer Mode is OFF.
  echo        Falling back to an unpacked app folder ^(works without Developer Mode^)...
  echo.
  call npx --yes electron-builder --win dir
  if errorlevel 1 ( echo. & echo [ERROR] Packaging failed completely. & pause & exit /b 1 )
  echo.
  echo ==================================================
  echo  DONE ^(folder build^)
  echo  Run:    "release\win-unpacked\Gemini Clean.exe"
  echo  Share:  zip the whole  release\win-unpacked  folder.
  echo.
  echo  Want ONE single .exe instead? Turn ON:
  echo    Settings ^> Privacy ^& security ^> For developers ^> Developer Mode
  echo  then run this file again.
  echo ==================================================
) else (
  echo.
  echo ==================================================
  echo  DONE ^(single file^)
  echo  File:  release\GeminiClean-1.0.0-portable.exe
  echo  Copy that one .exe to any Windows PC and run it.
  echo ==================================================
)
echo.
pause
