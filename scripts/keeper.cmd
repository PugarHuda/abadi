@echo off
rem One bot cycle, for Windows Task Scheduler. GitHub's cron never fired for this
rem repository in its first nine hours, so the keeper also runs from this machine.
cd /d "%~dp0.."
set CYCLES=1
set SHORTEST=1
set ACTIVE=3
node scripts\bot.ts >> docs\evidence\keeper-local.log 2>&1
