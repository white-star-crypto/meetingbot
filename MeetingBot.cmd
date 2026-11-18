@echo off
setlocal
set "DIR=%~dp0"
rem Clear variables an agent/terminal host may inject. ELECTRON_RUN_AS_NODE
rem makes Electron run as plain Node; a NODE_OPTIONS --require shim crashes
rem Electron's bundled Node during preload, so the window dies with no error.
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%DIR%launch-app.ps1"
if errorlevel 1 (
  echo.
  echo MeetingBot failed to start. Recent log:
  echo ----------------------------------------
  type "%DIR%launch.log"
  echo ----------------------------------------
  echo Full log: %DIR%launch.log
  echo.
  pause
)
