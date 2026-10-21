@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Harden state/ ACLs (Windows needs WRITE_DAC; the directory owner normally has it,
rem so no UAC prompt in the usual case). This NEVER blocks startup: if it cannot get
rem permission it prints a copy-pasteable command and exits 0.
rem See docs/guides/SECURITY_BASELINE.md ("secrets at rest").
node scripts\harden-state-acl.mjs --quiet
:loop
rem DSH 桌面端每次启动会换一个空闲端口，而桥接的 dsh.baseUrl 写在 config.json 里。
rem 这一行在每次拉起桥接前先发现当前 DSH 并改写 baseUrl（找不到就保留原值，不阻塞启动）。
rem 见 scripts/dsh-endpoint.mjs。
node scripts\dsh-endpoint.mjs
node src/bridge.js
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] bridge already running in another window. Exiting.
    pause
    exit /b 2
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
