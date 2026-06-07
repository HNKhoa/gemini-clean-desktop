@echo off
chcp 65001 >nul
title Gemini Clean - Enable NVIDIA GPU (CUDA) for AI inpaint
cd /d "%~dp0"

echo ==================================================
echo   Enable NVIDIA GPU (CUDA) for AI inpaint
echo ==================================================
echo For NVIDIA GPUs only (e.g. GTX 1660 Ti) with a recent driver.
echo DirectML cannot run this model; CUDA can and is much faster than CPU.
echo This downloads the CUDA libraries (a few hundred MB).
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python not found. Install from https://python.org then run again.
  pause
  exit /b 1
)

echo [1/2] Removing the CPU / DirectML onnxruntime builds (they conflict with CUDA)...
python -m pip uninstall -y onnxruntime onnxruntime-directml onnxruntime-gpu

echo.
echo [2/2] Installing the CUDA build + libraries...
python -m pip install -r backend\requirements-ai-cuda.txt
if errorlevel 1 (
  echo.
  echo [ERROR] CUDA install failed. You can still use AI inpaint on CPU (run update.bat).
  pause
  exit /b 1
)

echo.
echo ==================================================
echo  DONE. Launch the app with update.bat and enable AI inpaint.
echo  It will use your NVIDIA GPU; if CUDA can't start it safely
echo  falls back to CPU. Settings shows "GPU" when CUDA is active.
echo ==================================================
echo.
pause
