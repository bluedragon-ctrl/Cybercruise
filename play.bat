@echo off
REM Cybercruise — start the game.
REM
REM The game uses native ES modules, so it CANNOT be opened as a file:// path —
REM the browser blocks module loads from the filesystem. This starts the local
REM server first, waits until it is actually accepting connections, and only
REM then opens the game in the browser. Opening the browser first (as this
REM script used to) raced the server and could land on a connection error.
REM
REM Usage:  play.bat [port]        (default port 5173)

setlocal
cd /d "%~dp0"

REM Internal re-entry: this script relaunches itself with --open so the waiting
REM and browser launch happen alongside the server, which holds the console.
if /i "%~1"=="--open" goto wait_and_open

set PORT=%~1
if "%PORT%"=="" set PORT=5173

where node >nul 2>nul
if %errorlevel%==0 goto serve_node

where python >nul 2>nul
if %errorlevel%==0 goto serve_python

echo.
echo   Neither Node.js nor Python was found on PATH.
echo   Install Node.js ^(https://nodejs.org^) and run this again.
echo.
pause
exit /b 1

:serve_node
echo Starting Cybercruise server on http://localhost:%PORT%/  ^(Ctrl+C to stop^)
start "" /b "%~f0" --open %PORT%
REM tools/serve.js is a zero-dependency static server built on Node built-ins.
REM It replaces `npx http-server`, which made starting the game depend on a
REM working npm install — a missing %%APPDATA%%\npm made npx fail outright.
node tools\serve.js %PORT%
exit /b %errorlevel%

:serve_python
echo Starting Cybercruise server on http://localhost:%PORT%/  ^(Ctrl+C to stop^)
start "" /b "%~f0" --open %PORT%
python -m http.server %PORT%
exit /b %errorlevel%

:wait_and_open
REM Poll the port until the server answers, then launch the browser. Node's
REM first run may shell out to npx and take a few seconds, hence the long-ish
REM 30 second budget.
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
echo Server is up — opening the game.
start "" "http://localhost:%PORT%/"
exit /b 0

:blind_open
REM No PowerShell to poll with: give the server a moment and open anyway.
REM If the page fails to load, just reload it once the server prints its banner.
ping -n 4 127.0.0.1 >nul
start "" "http://localhost:%PORT%/"
exit /b 0
