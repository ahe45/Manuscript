@echo off
setlocal
pushd "%~dp0" || exit /b 1

if not exist ".env" (
  copy "deploy\manuscript.windows.env.example" ".env" >nul
  if errorlevel 1 goto FAILED
  echo Created .env. Set the database and access values, then run start.bat again.
  echo See deploy\README.md for the first-time setup.
  goto FAILED
)

where node.exe >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 24 with npm before running this script.
  goto FAILED
)

node --env-file=.env tools/windows-server.mjs prepare
if errorlevel 1 goto FAILED

echo Starting Manuscript. Press Ctrl+C to stop the server.
node --env-file=.env server.mjs
if errorlevel 1 goto FAILED

popd
exit /b 0

:FAILED
echo Manuscript did not start or exited with an error.
popd
if /i not "%~1"=="--no-pause" pause
exit /b 1
