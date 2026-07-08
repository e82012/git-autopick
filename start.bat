@echo off
title Git AutoPick - Web UI

echo.
echo  ====================================
echo    Git AutoPick - Web UI Launcher
echo  ====================================
echo.

:: Change to the directory where this bat file is located
cd /d "%~dp0"

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo  [ERROR] Node.js not found. Please install Node.js v18+
  echo  Download: https://nodejs.org/
  pause
  exit /b 1
)

:: Install dependencies if node_modules is missing
if not exist "node_modules\" (
  echo  Installing dependencies, please wait...
  npm install
  if %errorlevel% neq 0 (
    echo  [ERROR] npm install failed. Please check your network connection.
    pause
    exit /b 1
  )
)

:: Start the server in a minimized background window
echo  Starting web server...
start "Git AutoPick Server" /min cmd /c "node server.js"

:: Wait for server to start
timeout /t 2 /nobreak > nul

:: Open browser
echo  Opening browser at http://localhost:3131
start "" http://localhost:3131

echo.
echo  Server is running in the background (port 3131)
echo  To stop the server, close the window titled "Git AutoPick Server"
echo.
pause
