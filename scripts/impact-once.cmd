@echo off
REM Run the venue-impact measurement once, outside the agent session.
REM
REM `scripts/impact.ts` rebuilds every quoted window's order book twice from the venue's own
REM `Order` rows -- with this vault's orders and without -- and takes an hour or two: one
REM indexer query per window, sequential, 148 windows.
REM
REM Three runs died before publishing anything: two to memory pressure inside a session (at
REM windows 68 and 86) and one overnight under this very task, at window 121 of 146. Task
REM Scheduler was the fix for the first two and was not enough, because the script held its
REM whole report until the last window. It now writes each window's verdict to
REM docs/evidence/impact.cache.json as that window lands, so a run that dies resumes where
REM it stopped -- which is why the progress file is appended to here and not overwritten.
REM
REM   schtasks /Delete /TN "Abadi impact" /F      to stop it by hand
REM   del docs\evidence\impact.cache.json         to force a measurement from scratch

cd /d "C:\Hackathons\Event Contracts Hackathon"

echo === run started %DATE% %TIME% >> "docs\evidence\impact-2026-09-07.progress.txt"
node scripts/impact.ts > "docs\evidence\impact-2026-09-07.md" 2>> "docs\evidence\impact-2026-09-07.progress.txt"
if %ERRORLEVEL% NEQ 0 (
  echo impact.ts exited %ERRORLEVEL%>> "docs\evidence\impact-2026-09-07.progress.txt"
  exit /b %ERRORLEVEL%
)

schtasks /Delete /TN "Abadi impact" /F >nul 2>&1
