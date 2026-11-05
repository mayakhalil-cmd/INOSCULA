@echo off
title Inoscula Live Link
cd /d "%~dp0"
call "%~dp0runtime\find-node.bat" || goto end
echo Starting the Inoscula live link. Leave this window open while you work; close it to stop.
echo In Inoscula Studio, press the connection button at the top right (it says Offline).
echo.
"%NODE%" bin\inoscula-live.ts %*
:end
pause
