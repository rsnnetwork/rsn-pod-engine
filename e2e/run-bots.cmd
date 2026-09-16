@echo off
cd /d "C:\Users\ARFA TECH\Desktop\RSN-fixloc\e2e"
echo launcher starting > bots-log.txt
for /f "usebackq delims=" %%a in (".jwt_secret") do set JWT_SECRET=%%a
set EVENT_TITLE=z1
call npx playwright test tests/bots-8.spec.ts --workers=1 >> bots-log.txt 2>&1
echo launcher exited %ERRORLEVEL% >> bots-log.txt
