@echo off
setlocal EnableDelayedExpansion
rem Packman Python launcher for Windows cmd.exe.
rem Resolve a Python 3.11+ interpreter in order:
rem   1. PACKMAN_PYTHON
rem   2. <repo>/.venv\Scripts\python.exe
rem   3. python
rem   4. py -3
rem The interpreter is invoked with %* and exits with exit /b %ERRORLEVEL%.
if defined PACKMAN_PYTHON (
  "%PACKMAN_PYTHON%" -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
  if not errorlevel 1 (
    "%PACKMAN_PYTHON%" %*
    exit /b !ERRORLEVEL!
  )
)
if exist "%~dp0..\..\.venv\Scripts\python.exe" (
  "%~dp0..\..\.venv\Scripts\python.exe" -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
  if not errorlevel 1 (
    "%~dp0..\..\.venv\Scripts\python.exe" %*
    exit /b !ERRORLEVEL!
  )
)
where python >nul 2>&1
if not errorlevel 1 (
  python -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
  if not errorlevel 1 (
    python %*
    exit /b !ERRORLEVEL!
  )
)
where py >nul 2>&1
if not errorlevel 1 (
  py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
  if not errorlevel 1 (
    py -3 %*
    exit /b !ERRORLEVEL!
  )
)
echo packman python: no Python 3.11+ interpreter found 1>&2
exit /b 1
