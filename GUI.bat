@echo off
chcp 65001 >nul
title WhatsApp Poster - Control Panel
cd /d "%~dp0"

echo ==========================================================
echo    WHATSAPP QUESTION POSTER - CONTROL PANEL
echo ==========================================================
echo.
echo   Your browser will open automatically.
echo   Keep THIS window open while you use the panel.
echo   Close this window when you are done.
echo.

node src\gui\server.js

echo.
echo   Server stopped.
pause >nul
