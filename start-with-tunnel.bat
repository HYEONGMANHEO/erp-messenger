@echo off
rem Start the messenger server and a Cloudflare Quick Tunnel (Windows).
rem Double-click this file to run. Two windows will open: keep both open.
cd /d "%~dp0"

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo [ERROR] cloudflared is not installed.
  echo Run this command first, then open a new window:
  echo   winget install --id Cloudflare.cloudflared
  pause
  exit /b 1
)

start "Messenger Server" cmd /k call "%~dp0start-server.bat"

echo Waiting for the server to start...
timeout /t 5 /nobreak >nul

echo.
echo Starting the tunnel. Look for the https://....trycloudflare.com address below.
echo The address changes every time. Do NOT press Ctrl+C to copy it:
echo select it with the mouse and right-click instead.
echo.
cloudflared tunnel --url http://localhost:3000
pause
