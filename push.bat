@echo off
chcp 65001 >nul
title Gemini Clean - Push to GitHub
cd /d "%~dp0"
setlocal enabledelayedexpansion

echo ==================================================
echo    GEMINI CLEAN  -  Push to GitHub
echo ==================================================
echo.

REM --- 0. Check prerequisites -----------------------------------------
where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Git not found. Install it from https://git-scm.com then run again.
  echo.
  pause
  exit /b 1
)
git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 (
  echo [ERROR] This folder is not a Git repository.
  echo.
  pause
  exit /b 1
)

REM --- 1. Show current changes ----------------------------------------
echo Current changes:
git status --short
echo.

REM --- 2. Stage everything -------------------------------------------
git add -A

REM --- 3. Commit only if something is staged --------------------------
git diff --cached --quiet
if not errorlevel 1 (
  echo No new changes to commit. Will still push any local commits...
  goto push
)

set "MSG="
set /p "MSG=Commit message (press Enter for default): "
if "!MSG!"=="" set "MSG=Update !DATE! !TIME!"

git commit -m "!MSG!"
if errorlevel 1 (
  echo.
  echo [ERROR] Commit failed. See messages above.
  echo.
  pause
  exit /b 1
)

:push
echo.
echo Pushing to GitHub...
git push
if errorlevel 1 (
  echo.
  echo [ERROR] Push failed.
  echo If the remote has newer commits, run:   git pull --rebase
  echo then run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo [DONE] Pushed to GitHub successfully.
echo.
pause
