@echo off
REM Cybercruise — enemy car editor.
REM
REM Starts the local editor server (server.js, in this folder) and opens the
REM editor UI once it is actually accepting connections. Requires Node.js;
REM the "Create Pull Request" step additionally needs Git and push access to
REM the repo's origin remote. See play.bat for the same wait-then-open
REM pattern, used here for the same reason: opening the browser before the
REM server is listening races it.
REM
REM Usage:  edit.bat [port]        (default port 5174)

setlocal
cd /d "%~dp0"

if /i "%~1"=="--open" goto wait_and_open

set PORT=%~1
REM 5174 is duplicated in server.js's own no-arg default -- keep both in sync.
if "%PORT%"=="" set PORT=5174

where node >nul 2>nul
if not %errorlevel%==0 (
  echo.
  echo   Node.js was not found on PATH.
  echo   Install Node.js ^(https://nodejs.org^) and run this again.
  echo.
  pause
  exit /b 1
)

echo Starting the car editor on http://localhost:%PORT%/  ^(Ctrl+C to stop^)
start "" /b "%~f0" --open %PORT%
call node server.js
exit /b %errorlevel%

:wait_and_open
set PORT=%~2

where powershell >nul 2>nul
if not %errorlevel%==0 goto blind_open

powershell -NoProfile -Command "$end=(Get-Date).AddSeconds(30); while((Get-Date) -lt $end){ $c=New-Object Net.Sockets.TcpClient; try{ $c.Connect('127.0.0.1',%PORT%); $c.Close(); exit 0 } catch { Start-Sleep -Milliseconds 200 } finally { $c.Dispose() } }; exit 1"
if errorlevel 1 (
  echo.
  echo   The server never started listening on port %PORT%.
  echo   Check the messages above; the browser was not opened.
  exit /b 1
)
echo Server is up — opening the editor.
start "" "http://localhost:%PORT%/"
exit /b 0

:blind_open
ping -n 4 127.0.0.1 >nul
start "" "http://localhost:%PORT%/"
exit /b 0
