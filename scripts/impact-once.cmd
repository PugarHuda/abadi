@echo off
REM Run the venue-impact measurement once, outside the agent session.
REM
REM `scripts/impact.ts` rebuilds every quoted window's order book twice from the venue's own
REM `Order` rows — with this vault's orders and without — and takes an hour or two: one
REM indexer query per window, sequential, 146 windows. Two attempts inside the session were
REM killed by memory pressure at windows 68 and 86, and the script buffers its markdown until
REM the end, so both lost everything.
REM
REM Task Scheduler runs outside that, the same way the keeper and the deploy retry do. It
REM writes the evidence file, then removes its own task.
REM
REM   schtasks /Delete /TN "Abadi impact" /F      to stop it by hand

cd /d "C:\Hackathons\Event Contracts Hackathon"

node scripts/impact.ts > "docs\evidence\impact-2026-09-07.md" 2> "docs\evidence\impact-2026-09-07.progress.txt"
if %ERRORLEVEL% NEQ 0 (
  echo impact.ts exited %ERRORLEVEL%>> "docs\evidence\impact-2026-09-07.progress.txt"
  exit /b %ERRORLEVEL%
)

schtasks /Delete /TN "Abadi impact" /F >nul 2>&1
