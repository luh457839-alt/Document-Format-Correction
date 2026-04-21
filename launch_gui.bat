@echo off
setlocal

cd /d "%~dp0"
set "CONDA_ENV_NAME=Agent"
set "CONDA_BASE="

for /f "usebackq delims=" %%I in (`conda info --base 2^>nul`) do set "CONDA_BASE=%%I"

if defined CONDA_BASE if exist "%CONDA_BASE%\condabin\conda.bat" (
  call "%CONDA_BASE%\condabin\conda.bat" activate %CONDA_ENV_NAME% >nul 2>nul
  if errorlevel 1 (
    call "%CONDA_BASE%\condabin\conda.bat" run -n %CONDA_ENV_NAME% python scripts\launch_gui.py
    set "EXIT_CODE=%ERRORLEVEL%"
    goto :finish
  )
)

python scripts\launch_gui.py

set "EXIT_CODE=%ERRORLEVEL%"

:finish
if not "%EXIT_CODE%"=="0" (
  echo.
  echo launch_gui.bat failed with exit code %EXIT_CODE%.
)

exit /b %EXIT_CODE%
