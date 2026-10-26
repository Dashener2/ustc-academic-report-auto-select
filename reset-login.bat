@echo off
chcp 65001 >nul
cd /d "%~dp0"
title USTC xueshu baogao - reset login
echo ============================================
echo   Reset login (use when redirect loop occurs)
echo   1. delete .chrome-profile
echo   2. open Chrome for CAS login
echo ============================================
echo.
echo Press Ctrl+C to cancel, or
pause
node "%~dp0browser-session.js" --reset --login
echo.
echo [done] exit code=%ERRORLEVEL%
pause
