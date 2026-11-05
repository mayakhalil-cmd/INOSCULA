@echo off
title Inoscula Live Link (shared)
cd /d "%~dp0"
call "%~dp0runtime\find-node.bat" || goto end
echo This lets other computers on the same network join the live link.
echo Pick a pass word. Everyone who joins types the same word into their Studio.
echo.
:ask
set "KEY="
set /p "KEY=Pass word: "
if not defined KEY goto ask
echo.
echo If Windows asks whether Node may use the network, allow it on private networks.
echo Leave this window open while you work; close it to stop.
echo.
"%NODE%" bin\inoscula-live.ts --share --key "%KEY%"
:end
pause
