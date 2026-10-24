@echo off
chcp 65001 >nul
cd /d "%~dp0"
node "%~dp0monitor.js" --test
echo.
pause
