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
rem The model landed in 16cd74d and every scheduled run since had it switched off.
rem On now: refuse a window the book and N(d2) disagree about by more than FV_MAX_EDGE,
rem and lean the mid up to FV_SKEW_TICKS toward fair. Unset it to go back to book-only.
set FAIR_VALUE=1
node scripts\bot.ts >> docs\evidence\keeper-local.log 2>&1
if errorlevel 1 echo keeper exited %ERRORLEVEL% -- see the ALERT lines above >> docs\evidence\keeper-local.log
