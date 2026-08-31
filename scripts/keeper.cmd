@echo off
rem One bot cycle, for Windows Task Scheduler. GitHub's cron never fired for this
rem repository in its first nine hours, so the keeper also runs from this machine.
rem
rem Every line the bot logs now carries its date, so appending run after run to one file
rem stays readable. The exit code is 1 when the cycle alerted, which is what Task
rem Scheduler shows as Last Run Result - and it is written into the log too, because a
rem run that dies before node starts leaves nothing else behind.
cd /d "%~dp0.."
set CYCLES=1
set SHORTEST=1
set ACTIVE=3
node scripts\bot.ts >> docs\evidence\keeper-local.log 2>&1
if errorlevel 1 echo keeper exited %ERRORLEVEL% -- see the ALERT lines above >> docs\evidence\keeper-local.log
