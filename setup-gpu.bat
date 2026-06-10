@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title Gemini Clean - Setup tang toc AI inpaint (nhieu loai card)
cd /d "%~dp0"

echo ==================================================
echo   Cai dat tang toc AI inpaint - ho tro nhieu card
echo ==================================================
echo   [1] NVIDIA  (CUDA)         - tang toc THAT SU cho AI inpaint
echo   [2] AMD / Intel (DirectML) - AI inpaint van chay CPU *
echo   [3] CPU / khong co GPU     - AI inpaint chay CPU
echo.
echo   * Mo hinh AI inpaint (LaMa) KHONG chay duoc tren DirectML,
echo     nen AMD/Intel se tu lui ve CPU. Chi NVIDIA CUDA tang toc that.
echo     (Che do xoa watermark thuong cho video KHONG can GPU.)
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Khong tim thay Python. Cai tu https://python.org roi chay lai.
  pause & exit /b 1
)

REM ---------- Phat hien card man hinh ----------
set "HASNV="
set "HASAMD="
set "HASINTEL="
set "GPUFILE=%TEMP%\gcd_gpu_list.txt"
where nvidia-smi >nul 2>nul && set "HASNV=1"
powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController).Name -join ';'" > "%GPUFILE%" 2>nul
if not exist "%GPUFILE%" type nul > "%GPUFILE%"
find /i "NVIDIA" "%GPUFILE%" >nul 2>nul && set "HASNV=1"
find /i "AMD"    "%GPUFILE%" >nul 2>nul && set "HASAMD=1"
find /i "Radeon" "%GPUFILE%" >nul 2>nul && set "HASAMD=1"
find /i "Intel"  "%GPUFILE%" >nul 2>nul && set "HASINTEL=1"

echo Card phat hien:
type "%GPUFILE%"
echo.
del "%GPUFILE%" >nul 2>nul

REM ---------- Goi y mac dinh theo card ----------
set "DEF=3"
if defined HASINTEL set "DEF=2"
if defined HASAMD set "DEF=2"
if defined HASNV set "DEF=1"
if "%DEF%"=="1" set "DEFTXT=NVIDIA CUDA"
if "%DEF%"=="2" set "DEFTXT=AMD/Intel DirectML"
if "%DEF%"=="3" set "DEFTXT=CPU"

set "CHOICE="
set /p "CHOICE=Chon 1/2/3 (Enter = goi y: %DEF% - %DEFTXT%, 0 = thoat): "
if not defined CHOICE set "CHOICE=%DEF%"
if "%CHOICE%"=="0" exit /b 0

echo.
echo [1/2] Go cac ban onnxruntime dang co (tranh xung dot giua cac ban)...
python -m pip uninstall -y onnxruntime onnxruntime-directml onnxruntime-gpu

echo.
if "%CHOICE%"=="1" goto :cuda
if "%CHOICE%"=="2" goto :dml
if "%CHOICE%"=="3" goto :cpu
echo [ERROR] Lua chon khong hop le: %CHOICE%
pause & exit /b 1

:cuda
echo [2/2] Cai ban CUDA (NVIDIA) + thu vien CUDA 12 (vai tram MB)...
python -m pip install -r backend\requirements-ai-cuda.txt
if errorlevel 1 goto :fail
set "MSG=Da cai NVIDIA CUDA. Settings se hien 'GPU' khi CUDA hoat dong; neu CUDA khong khoi dong duoc, app tu lui ve CPU."
goto :done

:dml
echo [2/2] Cai ban DirectML (AMD / Intel) + numpy + Pillow...
python -m pip install -r backend\requirements-ai.txt
if errorlevel 1 goto :fail
set "MSG=Da cai DirectML cho AMD/Intel. LUU Y: AI inpaint (LaMa) van chay bang CPU. Voi card AMD/Intel nen dung che do xoa watermark thuong cho video (khong can GPU)."
goto :done

:cpu
echo [2/2] Cai ban CPU (onnxruntime thuan) + numpy + Pillow...
python -m pip install "onnxruntime>=1.20.0" "numpy>=1.24.0" "Pillow>=10.0.0"
if errorlevel 1 goto :fail
set "MSG=Da cai ban CPU. AI inpaint chay bang CPU (cham hon nhung van sach nhat)."
goto :done

:fail
echo.
echo [ERROR] Cai dat that bai. Co the do Python ^< 3.10 (chua co wheel onnxruntime)
echo         hoac mang loi. Ban van dung duoc che do xoa watermark thuong qua update.bat.
pause & exit /b 1

:done
echo.
echo ==================================================
echo  XONG. %MSG%
echo  Mo app bang update.bat roi bat "AI inpaint" trong Cai dat.
echo ==================================================
echo.
pause
exit /b 0
