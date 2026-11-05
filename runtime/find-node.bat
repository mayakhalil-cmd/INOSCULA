@echo off
rem Sets NODE to the Node that comes with Inoscula (runtime\node.exe), or to an installed Node if that is missing.
rem Used by the .bat files in the inoscula folder.
set "NODE=%~dp0node.exe"
if exist "%NODE%" goto check
set "NODE="
for %%I in (node.exe) do set "NODE=%%~$PATH:I"
if not defined NODE goto none
:check
"%NODE%" -e "const [a, b] = process.versions.node.split('.').map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)"
if errorlevel 1 goto old
exit /b 0
:none
echo.
echo Inoscula could not find Node, the program that runs its tools.
echo The Windows download on the Inoscula Releases page has it built in (runtime\node.exe).
echo Or install Node 22.18 or newer from https://nodejs.org and try again.
echo.
exit /b 1
:old
echo.
echo The Node installed on this computer is too old for Inoscula (it needs 22.18 or newer).
echo Use the Windows download on the Inoscula Releases page, which has Node built in,
echo or install a newer Node from https://nodejs.org and try again.
echo.
exit /b 1
