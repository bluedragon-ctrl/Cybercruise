@echo off
REM Cybercruise — visual asset gallery.
REM
REM The gallery (gallery.html + gallery.js, this folder) is plain HTML/JS
REM reaching into src/game and src/engine to draw catalogue entries in
REM isolation — it needs no API of its own, unlike the tuning editor, so it is
REM served by the same zero-dependency static server play.bat uses rather than
REM a dedicated one. See play.bat for the wait-then-open pattern this copies
REM (opening the browser before the server is listening races it).
REM
REM Usage:  gallery.bat [port]        (default port 5175)

setlocal
cd /d "%~dp0..\.."

REM Internal re-entry: this script relaunches itself with --open so the
REM waiting and browser launch happen alongside the server, which holds the
REM console.
if /i "%~1"=="--open" goto wait_and_open

set PORT=%~1
if "%PORT%"=="" set PORT=5175

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
node tools\serve.js %PORT%
exit /b %errorlevel%

:serve_python
echo Starting Cybercruise server on http://localhost:%PORT%/  ^(Ctrl+C to stop^)
start "" /b "%~f0" --open %PORT%
python -m http.server %PORT%
exit /b %errorlevel%

:wait_and_open
REM Poll the port until the server answers, then launch the browser.
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
echo Server is up — opening the gallery.
start "" "http://localhost:%PORT%/tools/gallery/gallery.html"
exit /b 0

:blind_open
REM No PowerShell to poll with: give the server a moment and open anyway.
ping -n 4 127.0.0.1 >nul
start "" "http://localhost:%PORT%/tools/gallery/gallery.html"
exit /b 0
