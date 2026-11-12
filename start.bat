@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="
if exist "%~dp0AlbumDeck.exe" (
  start "" "%~dp0AlbumDeck.exe"
  exit /b 0
)
if not exist "%~dp0node_modules\electron\dist\electron.exe" goto missing_dependencies
if not exist "%~dp0node_modules\ws\package.json" goto missing_dependencies
start "" "%~dp0node_modules\electron\dist\electron.exe" .
exit /b 0

:missing_dependencies
echo.
echo [AlbumDeck] Missing Electron runtime or application dependencies.
echo.
echo This is a source package, not a ready-to-run Windows package.
echo.
echo Recommended: download the Windows portable ZIP from Releases,
echo extract the ENTIRE ZIP, then run AlbumDeck.exe or start.bat.
echo https://github.com/kenaziuuu/AlbumDeck/releases/latest
echo.
echo To run this source package: install Node.js LTS, then run:
echo   npm install
echo   start.bat
echo.
pause
exit /b 1
