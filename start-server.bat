@echo off
rem Start the messenger server (Windows). Double-click this file to run.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Install the LTS version from https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing libraries. This runs only the first time...
  call npm install --omit=dev
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo Messenger server is starting. Keep this window open.
echo Open http://localhost:3000 in your browser. Press Ctrl+C to stop.
echo.
call npm start
pause
