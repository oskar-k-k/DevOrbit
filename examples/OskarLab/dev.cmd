@echo off
setlocal
cd /d "%~dp0"
set "DEV_PROJECT_ROOT=%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js fehlt. Bitte Node.js installieren.
  pause
  exit /b 1
)
if not "%~1"=="" (
  node "%~dp0scripts\dev-runner.cjs" %*
  exit /b
)
:menu
echo.
echo OskarLab - Entwicklungsumgebung
echo [1] Alles starten
echo [2] Status
echo [3] Alles stoppen
echo [4] Dienst-Logs ansehen
echo [5] Schliessen - Dienste laufen weiter
choice /c 12345 /n /m "Auswahl: "
if errorlevel 5 exit /b
if errorlevel 4 goto logs
if errorlevel 3 goto stop
if errorlevel 2 goto status
node "%~dp0scripts\dev-runner.cjs" start
goto menu
:stop
node "%~dp0scripts\dev-runner.cjs" stop
goto menu
:status
node "%~dp0scripts\dev-runner.cjs" status
goto menu
:logs
set /p "DEV_SERVICE_NAME=Dienstname aus dev.yaml: "
node "%~dp0scripts\dev-runner.cjs" logs "%DEV_SERVICE_NAME%"
goto menu
