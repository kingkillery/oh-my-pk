:; exec "$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)/tools/packman/python.sh" "$@"
@echo off
goto :PACKMAN_WIN
:PACKMAN_WIN
call "%~dp0..\..\tools\packman\python.bat" %*
exit /b %ERRORLEVEL%
