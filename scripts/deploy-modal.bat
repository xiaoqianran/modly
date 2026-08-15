@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."

set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8

echo.
echo  Modly — deploy with YOUR Modal CLI
echo  ==================================
echo  This script does not install Modal and does not open a browser.
echo  Install once yourself, then token set once:
echo    uv pip install "modal[api-proxy-support]"
echo    python -m modal token set --token-id ak-... --token-secret as-...
echo  That writes %%USERPROFILE%%\.modal.toml. Connect / this script read it.
echo.

if not exist "modal\app.py" (
    echo [ERROR] Run this from the Modly repo. Missing modal\app.py
    pause
    exit /b 1
)

if exist ".venv-modal\Scripts\python.exe" (
    echo Using .venv-modal\Scripts\python.exe -m modal deploy
    ".venv-modal\Scripts\python.exe" -m modal deploy modal\app.py
    goto :after
)

if exist ".venv\Scripts\python.exe" (
    echo Using .venv\Scripts\python.exe -m modal deploy
    ".venv\Scripts\python.exe" -m modal deploy modal\app.py
    goto :after
)

echo Using python -m modal deploy
python -m modal deploy modal\app.py

:after
if errorlevel 1 goto :fail

echo.
echo Done. Empty shell is on Modal. Idle = 0 CPU / 0 GPU.
echo Next: npm run dev → Connect this session (reads .modal.toml).
pause
exit /b 0

:fail
echo.
echo Deploy failed. Need a python that already has modal, and
echo python -m modal token set already run once.
pause
exit /b 1
