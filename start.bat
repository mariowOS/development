echo off
title mariowOS start.bat
cls
cd boot
type ver
cd ..
timeout 3 >nul
echo starting mariowOS server...
cd system
node server.js