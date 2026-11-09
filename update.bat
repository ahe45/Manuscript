@echo off
setlocal
pushd "%~dp0" || exit /b 1

if not exist "log" mkdir "log"
set "UPDATE_LOG=log\update-server.log"
echo Manuscript update: %DATE% %TIME%>"%UPDATE_LOG%"
if errorlevel 1 goto FAILED

where git.exe >nul 2>&1
if errorlevel 1 (
  echo Install Git for Windows before running this script.
  goto FAILED
)
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 24 with npm before running this script.
  goto FAILED
)
if not exist ".env" (
  echo Run start.bat and configure .env before applying updates.
  goto FAILED
)
if not exist ".git" (
  echo Run update.bat from a Manuscript Git clone.
  goto FAILED
)

node --env-file=.env tools/windows-server.mjs check >>"%UPDATE_LOG%" 2>&1
if errorlevel 1 goto FAILED
git diff --quiet --
if errorlevel 1 goto DIRTY
git diff --cached --quiet --
if errorlevel 1 goto DIRTY
git symbolic-ref --quiet HEAD >>"%UPDATE_LOG%" 2>&1
if errorlevel 1 goto FAILED
git rev-parse --verify "@{upstream}" >>"%UPDATE_LOG%" 2>&1
if errorlevel 1 goto FAILED
for /f "delims=" %%H in ('git rev-parse HEAD') do set "PREVIOUS_HEAD=%%H"
if not defined PREVIOUS_HEAD goto FAILED

echo Pulling the latest changes from the tracking branch...
git pull --ff-only >>"%UPDATE_LOG%" 2>&1
if errorlevel 1 goto FAILED
echo Preparing dependencies...
node --env-file=.env tools/windows-server.mjs prepare >>"%UPDATE_LOG%" 2>&1
if errorlevel 1 goto FAILED

git diff --quiet "%PREVIOUS_HEAD%" HEAD -- db/schema.sql
if errorlevel 1 (
  echo Database schema changed. Back up the database and apply db\schema.sql before starting.
  echo Database schema changed. Back up the database and apply db\schema.sql before starting.>>"%UPDATE_LOG%"
)
echo Update completed. Run start.bat to start Manuscript.
echo Log: %UPDATE_LOG%
popd
if /i not "%~1"=="--no-pause" pause
exit /b 0

:DIRTY
echo Tracked files have local changes. Update stopped to preserve them.
git status --short --untracked-files=no

:FAILED
if exist "%UPDATE_LOG%" type "%UPDATE_LOG%"
echo Manuscript update stopped. Log: %UPDATE_LOG%
popd
if /i not "%~1"=="--no-pause" pause
exit /b 1
