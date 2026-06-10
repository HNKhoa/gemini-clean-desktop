@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title Gemini Clean - Setup tang toc AI inpaint (nhieu loai card)
cd /d "%~dp0"

REM ============================================================
REM  Cach dung:
REM    setup-gpu.bat              -> menu tuong tac (chon tay)
REM    setup-gpu.bat auto         -> tu chon theo card phat hien (cho nhieu may)
REM    setup-gpu.bat nvidia|cuda  -> ep cai ban NVIDIA CUDA
REM    setup-gpu.bat amd|intel|dml-> ep cai ban DirectML
REM    setup-gpu.bat cpu          -> ep cai ban CPU
REM  Co tham so = che do TU DONG (khong hoi, khong pause) -> tien deploy hang loat.
REM ============================================================

set "ARG=%~1"
set "NONINTERACTIVE="
if defined ARG set "NONINTERACTIVE=1"
if /i "%ARG%"=="help"   goto :usage
if /i "%ARG%"=="/?"     goto :usage
if /i "%ARG%"=="-h"     goto :usage
if /i "%ARG%"=="--help" goto :usage

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

REM ---------- Tim Python THAT (tranh alias Microsoft Store) ----------
REM `where python` se thay alias Store va bao nham la "co Python"; ta chay thu
REM mot lenh that su (alias Store tra ma loi khac 0 nen bi loai).
set "PY="
for %%I in ("py -3" "python" "py" "python3") do (
  if not defined PY (
    %%~I -c "import sys" >nul 2>nul && set "PY=%%~I"
  )
)
if not defined PY (
  echo [ERROR] Khong tim thay Python THAT su ^(co the may chi co alias Microsoft Store^).
  echo   - Cai Python tu https://python.org  -- NHO tick "Add Python to PATH".
  echo   - Hoac tat alias: Settings ^> Apps ^> Advanced app settings ^> App execution aliases
  echo     ^> tat "python.exe" va "python3.exe", roi chay lai.
  if not defined NONINTERACTIVE pause
  exit /b 1
)
echo Dung Python: %PY%

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

REM ---------- Khong co tham so -> menu tuong tac ----------
if not defined ARG goto :menu

REM ---------- Co tham so -> che do tu dong ----------
set "CHOICE="
if /i "%ARG%"=="auto"     set "CHOICE=%DEF%"
if /i "%ARG%"=="nvidia"   set "CHOICE=1"
if /i "%ARG%"=="cuda"     set "CHOICE=1"
if /i "%ARG%"=="1"        set "CHOICE=1"
if /i "%ARG%"=="amd"      set "CHOICE=2"
if /i "%ARG%"=="intel"    set "CHOICE=2"
if /i "%ARG%"=="dml"      set "CHOICE=2"
if /i "%ARG%"=="directml" set "CHOICE=2"
if /i "%ARG%"=="2"        set "CHOICE=2"
if /i "%ARG%"=="cpu"      set "CHOICE=3"
if /i "%ARG%"=="3"        set "CHOICE=3"
if not defined CHOICE (
  echo [ERROR] Tham so khong hop le: "%ARG%". Dung: auto ^| nvidia ^| amd ^| intel ^| cpu
  exit /b 1
)
echo Che do tu dong [%ARG%] -^> cai dat lua chon %CHOICE% ^(goi y theo card: %DEF% - %DEFTXT%^).
goto :dispatch

:menu
set "CHOICE="
set /p "CHOICE=Chon 1/2/3 (Enter = goi y: %DEF% - %DEFTXT%, 0 = thoat): "
if not defined CHOICE set "CHOICE=%DEF%"
if "%CHOICE%"=="0" exit /b 0

:dispatch
echo.
echo [1/2] Go cac ban onnxruntime dang co (tranh xung dot giua cac ban)...
%PY% -m pip uninstall -y onnxruntime onnxruntime-directml onnxruntime-gpu

echo.
if "%CHOICE%"=="1" goto :cuda
if "%CHOICE%"=="2" goto :dml
if "%CHOICE%"=="3" goto :cpu
echo [ERROR] Lua chon khong hop le: %CHOICE%
if not defined NONINTERACTIVE pause
exit /b 1

:cuda
echo [2/2] Cai ban CUDA (NVIDIA) + thu vien CUDA 12 (vai tram MB)...
%PY% -m pip install -r backend\requirements-ai-cuda.txt
if errorlevel 1 goto :fail
set "MSG=Da cai NVIDIA CUDA. Settings se hien 'GPU' khi CUDA hoat dong; neu CUDA khong khoi dong duoc, app tu lui ve CPU."
goto :done

:dml
echo [2/2] Cai ban DirectML (AMD / Intel) + numpy + Pillow...
%PY% -m pip install -r backend\requirements-ai.txt
if errorlevel 1 goto :fail
set "MSG=Da cai DirectML cho AMD/Intel. LUU Y: AI inpaint (LaMa) van chay bang CPU. Voi card AMD/Intel nen dung che do xoa watermark thuong cho video (khong can GPU)."
goto :done

:cpu
echo [2/2] Cai ban CPU (onnxruntime thuan) + numpy + Pillow...
%PY% -m pip install "onnxruntime>=1.20.0" "numpy>=1.24.0" "Pillow>=10.0.0"
if errorlevel 1 goto :fail
set "MSG=Da cai ban CPU. AI inpaint chay bang CPU (cham hon nhung van sach nhat)."
goto :done

:fail
echo.
echo [ERROR] Cai dat that bai. Co the do Python ^< 3.10 (chua co wheel onnxruntime)
echo         hoac mang loi. Ban van dung duoc che do xoa watermark thuong qua update.bat.
if not defined NONINTERACTIVE pause
exit /b 1

:done
echo.
echo ==================================================
echo  XONG. %MSG%
echo  Mo app bang update.bat roi bat "AI inpaint" trong Cai dat.
echo ==================================================
echo.
if not defined NONINTERACTIVE pause
exit /b 0

:usage
echo Cach dung setup-gpu.bat:
echo   setup-gpu.bat               - menu tuong tac (chon tay)
echo   setup-gpu.bat auto          - tu chon theo card phat hien (cho nhieu may)
echo   setup-gpu.bat nvidia ^| cuda - ep cai ban NVIDIA CUDA
echo   setup-gpu.bat amd ^| intel ^| dml - ep cai ban DirectML (AMD/Intel)
echo   setup-gpu.bat cpu           - ep cai ban CPU
echo.
echo Co tham so = che do tu dong: khong hoi, khong pause (tien chay hang loat).
exit /b 0
