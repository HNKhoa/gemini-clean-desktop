@echo off
chcp 65001 >nul
title Gemini Clean - Build Standalone (FULL: remove + add watermark + AI inpaint)
cd /d "%~dp0"

echo ==================================================
echo    GEMINI CLEAN  -  Build Standalone (FULL)
echo ==================================================
echo Builds a self-contained app that runs WITHOUT Node.js or Python.
echo Bundles: watermark removal + Add-watermark (numpy/Pillow) + AI inpaint
echo (onnxruntime CPU). ffmpeg (~100MB) and the AI model (~88MB) are NOT bundled
echo - the client downloads them once on first use. Output is a FOLDER
echo (release\win-unpacked) - zip it and send it.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install from https://nodejs.org then run again.
  pause & exit /b 1
)

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
  pause & exit /b 1
)

echo [1/5] Installing / updating Node packages...
call npm install
if errorlevel 1 ( echo. & echo [ERROR] npm install failed. & pause & exit /b 1 )

echo.
echo [2/5] Preparing an isolated Python build env (CPU onnxruntime, so the bundle
echo       runs on ANY machine and your CUDA setup is left untouched)...
set "VENV=backend\pybuild\venv"
set "VPY=%VENV%\Scripts\python.exe"
if not exist "%VPY%" (
  %PY% -m venv "%VENV%"
  if errorlevel 1 ( echo. & echo [ERROR] venv create failed. & pause & exit /b 1 )
)
"%VPY%" -m pip install -q --upgrade pip
"%VPY%" -m pip install -q -r backend\requirements.txt "onnxruntime>=1.20.0" pyinstaller
if errorlevel 1 ( echo. & echo [ERROR] pip install into build env failed. & pause & exit /b 1 )

echo.
echo [3/5] Building frontend with LATEST data (Vite)...
call npm run build
if errorlevel 1 ( echo. & echo [ERROR] Frontend build failed. & pause & exit /b 1 )

echo.
echo [4/5] Bundling Python backend into gcd-backend (PyInstaller --onedir)...
if exist "backend\pybuild\gcd-backend" rmdir /s /q "backend\pybuild\gcd-backend"
if exist "backend\pybuild\work" rmdir /s /q "backend\pybuild\work"
if exist "backend\pybuild\ffmpeg" rmdir /s /q "backend\pybuild\ffmpeg"
"%VPY%" -m PyInstaller --onedir --noconsole --noconfirm --name gcd-backend ^
  --distpath backend\pybuild --workpath backend\pybuild\work --specpath backend\pybuild ^
  --paths backend ^
  --collect-submodules uvicorn --collect-submodules fastapi --collect-submodules starlette ^
  --hidden-import h11 --hidden-import python_multipart --hidden-import multipart --hidden-import anyio ^
  --hidden-import lama_video --collect-submodules watermark ^
  --collect-all onnxruntime ^
  --hidden-import PIL.Image --hidden-import PIL.ImageDraw --hidden-import PIL.ImageFont ^
  --hidden-import PIL.ImageFilter --hidden-import PIL.ImageColor ^
  --add-data "%~dp0backend\lama_alpha96.f32;." ^
  backend\server.py
if errorlevel 1 ( echo. & echo [ERROR] PyInstaller failed. & pause & exit /b 1 )

echo.
echo [5/5] Packaging standalone app folder...
set CSC_IDENTITY_AUTO_DISCOVERY=false
call npx --yes electron-builder --win dir
if errorlevel 1 ( echo. & echo [ERROR] electron-builder failed. & pause & exit /b 1 )

echo.
echo ==================================================
echo  DONE (folder build)
echo  App:    release\win-unpacked\Gemini Clean.exe
echo  Share:  ZIP the whole  release\win-unpacked  folder and send it.
echo          The other PC needs NOTHING installed.
echo  Note:   On first use, AI inpaint downloads its model (~88MB) and the app
echo          downloads ffmpeg (~100MB) - both once, needs internet that one time.
echo          AI inpaint runs on CPU; for NVIDIA speed run setup-gpu.bat on source.
echo ==================================================
echo.
pause
