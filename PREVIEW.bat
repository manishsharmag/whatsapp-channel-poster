@echo off
chcp 65001 >nul
title WhatsApp Poster - PREVIEW (nothing is sent)
cd /d "%~dp0"

echo ==========================================================
echo    PREVIEW ONLY - nothing will be posted
echo ==========================================================
echo.
node src\index.js preview

echo.
echo ==========================================================
pause >nul
