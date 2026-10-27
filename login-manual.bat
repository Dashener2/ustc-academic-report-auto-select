@echo off
chcp 65001 >nul
cd /d "%~dp0"
title USTC - manual login
echo ============================================
echo   Manual login
echo   1. a normal Chrome window opens
echo   2. log in there
echo   3. DO NOT close it! come back and press Enter
echo   4. script exports cookies and verifies the API
echo ============================================
echo.
node "%~dp0browser-session.js" --reset --manual
echo.
echo [done] exit code=%ERRORLEVEL%
pause
