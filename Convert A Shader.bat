@echo off
title Inoscula Convert
cd /d "%~dp0"
call "%~dp0runtime\find-node.bat" || goto end
set "FILE=%~1"
if defined FILE goto run
echo Drag a shader file onto this window (or type its path), then press Enter.
set /p "FILE=Shader file: "
if not defined FILE goto end
set "FILE=%FILE:"=%"
:run
echo.
"%NODE%" bin\inoscula.ts "%FILE%" --out "%~dp0out"
if errorlevel 1 goto end
echo.
echo Done. The converted files are in the out folder, which opens now.
start "" explorer "%~dp0out"
:end
pause
