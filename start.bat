@echo off
setlocal
title mariowOS
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22.12 or newer and try again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js with npm included and try again.
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo Dependencies are not installed. Run npm install first.
  pause
  exit /b 1
)

echo booting mariowOS gui...
call npm run start-os
set "exitCode=%errorlevel%"
if not "%exitCode%"=="0" (
  echo mariowOS exited with code %exitCode%.
  pause
)
exit /b %exitCode%
