@echo off
chcp 65001 >nul
title Gemini Clean
cd /d "%~dp0"

REM --- Quick launcher: opens the already-built app (no rebuild). ---
REM --- After changing/updating code, run update.bat instead.      ---

where node >nul 2>nul
if errorlevel 1 ( echo [ERROR] Node.js not found. Install from https://nodejs.org & echo. & pause & exit /b 1 )
where python >nul 2>nul
if errorlevel 1 ( echo [ERROR] Python not found. Install from https://python.org & echo. & pause & exit /b 1 )

if not exist "node_modules" ( echo First time here - run update.bat once to set up. & echo. & pause & exit /b 1 )
if not exist "dist" ( echo No build found - run update.bat once to build the app. & echo. & pause & exit /b 1 )

echo Starting Gemini Clean...
echo (Keep this window open while using the app. Closing it stops the app.)
echo.
call npm start

echo.
echo App closed. You can close this window.
