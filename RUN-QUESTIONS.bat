@echo off
chcp 65001 >nul
title WhatsApp Question Poster
cd /d "%~dp0"

echo ==========================================================
echo    WHATSAPP QUESTION POSTER
echo ==========================================================
echo.
echo   Posts 50 questions to your WhatsApp channel.
echo   Gap between each post: 5 seconds.
echo.
echo   Starting in 10 seconds.
echo   Press Ctrl+C now to cancel.
echo.
timeout /t 10 /nobreak >nul

node src\index.js batch

echo.
echo ==========================================================
echo    FINISHED - you can close this window.
echo ==========================================================
pause >nul
