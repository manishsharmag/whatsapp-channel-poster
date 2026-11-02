@echo off
chcp 65001 >nul
title Find My WhatsApp Channel ID
cd /d "%~dp0"

echo ==========================================================
echo    FIND YOUR WHATSAPP CHANNEL ID
echo ==========================================================
echo.
echo   Step 1: Open your channel in WhatsApp
echo   Step 2: Tap the channel name -^> Share -^> Copy link
echo   Step 3: Paste that link below and press Enter
echo.
echo   Example:
echo   https://whatsapp.com/channel/0029VbE6hzE17EmwS4HvnF15
echo.

set /p LINK=  Paste link here: 

if "%LINK%"=="" (
  echo.
  echo   Nothing entered. Closing.
  pause >nul
  exit /b 1
)

echo.
echo   Connecting to WhatsApp... (scan QR in this window if asked)
echo.
node src\index.js jid "%LINK%"

echo.
echo ==========================================================
echo    Copy the channelJid value above into config.json
echo    (the line that says: "channelJid": "...@newsletter")
echo ==========================================================
pause >nul
