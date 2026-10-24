@echo off
chcp 65001 >nul
cd /d "%~dp0"
title USTC xueshu baogao - login
echo ============================================
echo   Login / renew session
echo   1) silent try with existing cookie (no action needed)
echo   2) if failed, Chrome window opens for you to log in
echo ============================================
echo.
node "%~dp0browser-session.js"
echo.
echo [done] exit code=%ERRORLEVEL%
echo log: setup-login.log
pause
