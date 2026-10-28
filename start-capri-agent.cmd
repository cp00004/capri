@echo off
title Capri hands agent
cd /d "%~dp0"
echo.
echo   Capri hands agent - keeps this window open while she has hands.
echo.
node agent.js
echo.
echo   Agent stopped. Press any key to close.
pause >nul
