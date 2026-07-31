@echo off
REM Cybercruise — start the game.
REM
REM The game uses native ES modules, so it CANNOT be opened as a file:// path —
REM the browser blocks module loads from the filesystem. This serves the project
REM folder over HTTP and opens it.
REM
REM Usage:  play.bat [port]        (default port 5173)

setlocal
cd /d "%~dp0"

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
echo Serving Cybercruise on http://localhost:%PORT%/  ^(Ctrl+C to stop^)
start "" "http://localhost:%PORT%/"
REM -c-1 disables caching, so a reload always picks up edited source.
call npx --yes http-server . -p %PORT% -c-1
exit /b %errorlevel%

:serve_python
echo Serving Cybercruise on http://localhost:%PORT%/  ^(Ctrl+C to stop^)
start "" "http://localhost:%PORT%/"
python -m http.server %PORT%
exit /b %errorlevel%
