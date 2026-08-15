@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."

echo.
echo  Modly — one-time Modal deploy (Windows + uv)
echo  ============================================
echo  This REGISTERS the CPU/GPU app shell on your Modal account.
echo  It does NOT keep containers running. Idle = 0 CPU, 0 GPU.
echo  Closing npm run dev does not delete the deploy.
echo.

where uv >nul 2>&1
if errorlevel 1 (
    echo [ERROR] uv is not in PATH.
    echo         Install: https://docs.astral.sh/uv/getting-started/installation/
    echo         PowerShell: irm https://astral.sh/uv/install.ps1 ^| iex
    echo         Then close this window and double-click this script again.
    pause
    exit /b 1
)

if not exist "modal\app.py" (
    echo [ERROR] Run this from the Modly repo. Missing modal\app.py
    pause
    exit /b 1
)

if not exist ".venv-modal\Scripts\python.exe" (
    echo [1/4] Creating .venv-modal with uv...
    uv venv .venv-modal
    if errorlevel 1 goto :fail
) else (
    echo [1/4] Reusing .venv-modal
)

echo [2/4] Installing modal[api-proxy-support] into .venv-modal...
uv pip install --python ".venv-modal\Scripts\python.exe" -r "modal\requirements.txt"
if errorlevel 1 goto :fail

echo [3/4] Log in to Modal (browser window). Already logged in? This is a no-op.
".venv-modal\Scripts\python.exe" -m modal setup
if errorlevel 1 (
    echo setup returned an error. You can also run:
    echo   .venv-modal\Scripts\python.exe -m modal token new
    pause
)

echo [4/4] modal deploy modal/app.py  ^(registers the shell; containers stay at 0^)
".venv-modal\Scripts\python.exe" -m modal deploy modal\app.py
if errorlevel 1 goto :fail

echo.
echo Done. The empty shell is on Modal.
echo Next: npm run dev  →  Settings → Connect this session
echo        ^(same Modal account / tokens^)
echo Closing the Electron window does not undeploy. GPU drops in ~2s on quit;
echo leftover CPU scales to 0 in a few seconds.
echo.
pause
exit /b 0

:fail
echo.
echo Deploy failed. Fix the error above and run this script again.
pause
exit /b 1
