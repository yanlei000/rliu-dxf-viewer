@echo off
setlocal
rem Drag a .dxf file onto this batch file to build a standalone HTML drawing.
set "NODE_EXE=C:\Users\29089\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
if "%~1"=="" (
  echo Drag and drop a .dxf file onto this batch file.
  echo Or run: node dxf2html.js your_file.dxf
  echo.
  pause
  exit /b 1
)
"%NODE_EXE%" "%~dp0dxf2html.js" "%~1"
echo.
pause
