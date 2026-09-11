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
rem The 60-second tier, LAST in the preference order on purpose.
rem
rem It is 67% of every market the venue creates and this vault had never quoted it, because
rem two absolute numbers in quoting.ts refused it outright (42acda1). Measured 2026-09-10:
rem 30 of the last 40 cycles ended `resting 0.00` — the bot is idle three quarters of the
rem time waiting for a 900s or 14400s window to open.
rem
rem Last in TIERS means a 60s window is taken only when nothing better is quotable, so this
rem fills the idle gap rather than competing with the tiers that have a record. CYCLES=1 and
rem ACTIVE=3 bound it to three slots per fifteen minutes either way — the earlier fear of a
rem fourteen-fold gas jump assumed a bot running continuously, which this one does not.
rem
rem PROFITABILITY ON 60s WINDOWS IS UNMEASURED. Armed 2026-09-11; read it back with
rem `node scripts/ledger.ts` before claiming anything about it.
set MIN_TIER=60
set TIERS=14400,900,60
node scripts\bot.ts >> docs\evidence\keeper-local.log 2>&1
if errorlevel 1 echo keeper exited %ERRORLEVEL% -- see the ALERT lines above >> docs\evidence\keeper-local.log
