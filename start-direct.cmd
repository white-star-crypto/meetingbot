@echo off
rem Start the MeetingBot Electron window directly, without PowerShell.
rem Keep this file ASCII-only: cmd.exe on a Chinese Windows uses GBK.
setlocal
set "NODE_OPTIONS="
set "ELECTRON_RUN_AS_NODE="
pushd "%~dp0" || (echo Cannot enter the MeetingBot folder. & pause & exit /b 1)
set "ELECTRON=%CD%\node_modules\electron\dist\electron.exe"
set "MAIN=%CD%\electron\main.cjs"
if not exist "%ELECTRON%" (echo Missing: %ELECTRON% & pause & exit /b 1)
if not exist "%MAIN%" (echo Missing: %MAIN% & pause & exit /b 1)
start "" "%ELECTRON%" --no-sandbox "%MAIN%"
popd
exit /b 0
