@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem DSH desktop picks a new port on every launch; this watcher rewrites
rem config.json's dsh.baseUrl and asks the bridge to restart when it moves.
rem Kept in a loop so a crash does not silently kill the safety net.
rem Log: state\watch.log
if not exist "state" mkdir "state"
:loop
node scripts\dsh-endpoint.mjs --watch >> "state\watch.log" 2>&1
echo [%date% %time%] watcher exited, restarting in 5s >> "state\watch.log"
timeout /t 5 /nobreak >nul
goto loop
