@echo off
title CAPRI // Project Capricorn
cd /d "%~dp0"
if not exist node_modules echo No dependencies to install - starting straight up.

rem opens the app window as soon as the server answers (detached, waits ~20s max)
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-capri.ps1"

node server.js
pause
