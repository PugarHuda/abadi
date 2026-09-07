@echo off
REM Retry the production deploy until Vercel's free-plan daily cap releases a slot.
REM
REM The framework build is committed, CI-green and verified; the only thing between it and
REM production is `api-deployments-free-per-day`, which refuses politely and costs nothing.
REM Two background retry loops were killed by memory pressure before this became a scheduled
REM task, which is the same mechanism the keeper already uses on this machine.
REM
REM It removes its own task on the first success, so it is not a thing that runs forever.
REM Remove it by hand with:  schtasks /Delete /TN "Abadi deploy retry" /F

cd /d "C:\Hackathons\Event Contracts Hackathon"
set LOG=docs\evidence\deploy-retry.log

for /f "tokens=*" %%t in ('powershell -NoProfile -Command "(Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')"') do set NOW=%%t

REM `call`, and it matters: the CLI on this machine is vercel.cmd, and one batch file
REM invoking another without `call` hands control over and never comes back. Everything
REM below this line -- the log, the route check, the task removing itself -- was dead
REM code, which is why no log ever appeared while the task ran every 30 minutes.
call vercel deploy --prebuilt --prod --yes > "%TEMP%\abadi-deploy.txt" 2>&1
findstr /C:"api-deployments-free-per-day" "%TEMP%\abadi-deploy.txt" >nul
if %ERRORLEVEL%==0 (
  echo %NOW% still capped>> "%LOG%"
  exit /b 0
)

echo %NOW% deploy attempted, output follows>> "%LOG%"
type "%TEMP%\abadi-deploy.txt" >> "%LOG%"
for %%p in (/ /app /dashboard /deck) do (
  for /f %%c in ('curl -s -o NUL -w "%%{http_code}" --max-time 20 https://abadi-wheat.vercel.app%%p') do echo %NOW%   %%p = %%c>> "%LOG%"
)
schtasks /Delete /TN "Abadi deploy retry" /F >nul 2>&1
echo %NOW% task removed>> "%LOG%"
