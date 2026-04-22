@echo off
setlocal EnableExtensions

cd /d "%~dp0"

set "DRY_RUN=0"
set "AUTO_LAUNCH=0"
set "NO_PAUSE=0"
set "SHOW_HELP=0"
set "EXIT_CODE=0"
set "BOOTSTRAP_PYTHON="
set "VENV_PYTHON=%~dp0.venv\Scripts\python.exe"

:parse_args
if "%~1"=="" goto :after_args
if /I "%~1"=="--dry-run" (
  set "DRY_RUN=1"
  shift
  goto :parse_args
)
if /I "%~1"=="--launch" (
  set "AUTO_LAUNCH=1"
  shift
  goto :parse_args
)
if /I "%~1"=="--no-pause" (
  set "NO_PAUSE=1"
  shift
  goto :parse_args
)
if /I "%~1"=="--help" (
  set "SHOW_HELP=1"
  shift
  goto :parse_args
)
if /I "%~1"=="-h" (
  set "SHOW_HELP=1"
  shift
  goto :parse_args
)

echo [install] Unknown argument: %~1
set "EXIT_CODE=1"
goto :finish

:after_args
if "%SHOW_HELP%"=="1" goto :help

echo [install] Working directory: %CD%

call :find_bootstrap_python
if errorlevel 1 (
  echo [install] Python 3.10+ was not found. Install Python and add it to PATH.
  set "EXIT_CODE=1"
  goto :finish
)

call :require_command node "Node.js"
if errorlevel 1 (
  set "EXIT_CODE=1"
  goto :finish
)

call :require_command npm "npm"
if errorlevel 1 (
  set "EXIT_CODE=1"
  goto :finish
)

if exist "%VENV_PYTHON%" (
  echo [install] Reusing existing virtual environment: .venv
) else (
  echo.
  echo [install] Creating local virtual environment .venv
  if "%DRY_RUN%"=="1" (
    echo [dry-run] %BOOTSTRAP_PYTHON% -m venv .venv
  ) else (
    call %BOOTSTRAP_PYTHON% -m venv .venv
    if errorlevel 1 (
      echo [install] Failed to create the virtual environment.
      set "EXIT_CODE=1"
      goto :finish
    )
  )
)

echo.
echo [install] Upgrading pip
if "%DRY_RUN%"=="1" (
  echo [dry-run] "%VENV_PYTHON%" -m pip install --upgrade pip
) else (
  call "%VENV_PYTHON%" -m pip install --upgrade pip
  if errorlevel 1 (
    echo [install] Failed to upgrade pip.
    set "EXIT_CODE=1"
    goto :finish
  )
)

echo.
echo [install] Installing Python dependencies
if "%DRY_RUN%"=="1" (
  echo [dry-run] "%VENV_PYTHON%" -m pip install -e ".[gui]"
) else (
  call "%VENV_PYTHON%" -m pip install -e ".[gui]"
  if errorlevel 1 (
    echo [install] Failed to install Python dependencies.
    set "EXIT_CODE=1"
    goto :finish
  )
)

echo.
echo [install] Installing and building TS agent
if "%DRY_RUN%"=="1" (
  echo [dry-run] pushd src\ts
  echo [dry-run] npm install
  echo [dry-run] npm run build
  echo [dry-run] popd
) else (
  pushd src\ts
  call npm install
  if errorlevel 1 (
    popd
    echo [install] Failed to install TS agent dependencies.
    set "EXIT_CODE=1"
    goto :finish
  )
  call npm run build
  set "STEP_EXIT=%ERRORLEVEL%"
  popd
  if not "%STEP_EXIT%"=="0" (
    echo [install] Failed to build the TS agent.
    set "EXIT_CODE=1"
    goto :finish
  )
)

echo.
echo [install] Installing and building desktop frontend
if "%DRY_RUN%"=="1" (
  echo [dry-run] pushd src\frontend
  echo [dry-run] npm install
  echo [dry-run] npm run build
  echo [dry-run] popd
) else (
  pushd src\frontend
  call npm install
  if errorlevel 1 (
    popd
    echo [install] Failed to install frontend dependencies.
    set "EXIT_CODE=1"
    goto :finish
  )
  call npm run build
  set "STEP_EXIT=%ERRORLEVEL%"
  popd
  if not "%STEP_EXIT%"=="0" (
    echo [install] Failed to build the desktop frontend.
    set "EXIT_CODE=1"
    goto :finish
  )
)

echo.
if exist "config.json" (
  echo [install] Keeping the existing config.json file.
) else (
  echo [install] Copying config.example.json to config.json
  if "%DRY_RUN%"=="1" (
    echo [dry-run] copy /Y config.example.json config.json
  ) else (
    copy /Y config.example.json config.json >nul
    if errorlevel 1 (
      echo [install] Failed to copy the config template.
      set "EXIT_CODE=1"
      goto :finish
    )
  )
)

echo.
echo [install] Installation completed.
echo [install] Update config.json with a valid base URL, API key, and model name.
echo [install] After that, you can launch the app with launch_gui.bat.

if "%AUTO_LAUNCH%"=="1" (
  echo.
  echo [install] Launching the desktop app
  if "%DRY_RUN%"=="1" (
    echo [dry-run] launch_gui.bat
  ) else (
    call launch_gui.bat
    set "EXIT_CODE=%ERRORLEVEL%"
  )
)

goto :finish

:help
echo Usage: install_windows.bat [--launch] [--dry-run] [--no-pause]
echo.
echo   --launch    Start the desktop app after installation finishes
echo   --dry-run   Print the steps without running them
echo   --no-pause  Exit immediately without waiting for a key press
goto :finish

:find_bootstrap_python
where py >nul 2>nul
if not errorlevel 1 (
  py -3.10 -V >nul 2>nul
  if not errorlevel 1 (
    set "BOOTSTRAP_PYTHON=py -3.10"
    exit /b 0
  )
  py -3 -V >nul 2>nul
  if not errorlevel 1 (
    set "BOOTSTRAP_PYTHON=py -3"
    exit /b 0
  )
)

where python >nul 2>nul
if not errorlevel 1 (
  set "BOOTSTRAP_PYTHON=python"
  exit /b 0
)

exit /b 1

:require_command
where %~1 >nul 2>nul
if errorlevel 1 (
  echo [install] %~2 was not found. Install it and add it to PATH.
  exit /b 1
)

exit /b 0

:finish
if not "%NO_PAUSE%"=="1" pause
exit /b %EXIT_CODE%
