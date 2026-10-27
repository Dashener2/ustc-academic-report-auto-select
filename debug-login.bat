@echo off
chcp 65001 >nul
cd /d "%~dp0"
title USTC - debug login
echo ============================================
echo   DEBUG MODE
echo   Chrome internal errors will be recorded
echo ============================================
echo.
set BS_DEBUG=1
node "%~dp0browser-session.js" --reset --login
echo.
echo [done] exit code=%ERRORLEVEL%
pause
