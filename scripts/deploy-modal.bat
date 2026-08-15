@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0\.."

echo.
echo  Modly — one-time Modal deploy (Windows + uv)
echo  ============================================
echo  Registers the CPU/GPU app shell on your Modal account.
echo  Idle = 0 CPU, 0 GPU. Closing npm run dev does not undeploy.
echo  No browser. token-id + token-secret are enough
echo  (same pair you paste into Connect this session).
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

if not "%~1"=="" set "MODAL_TOKEN_LINE=%*"

if defined MODAL_TOKEN_ID if defined MODAL_TOKEN_SECRET goto :deploy

if not defined MODAL_TOKEN_LINE (
    echo [3/4] Paste the CLI line you already have, then press Enter.
    echo       modal token set --token-id ak-... --token-secret as-...
    echo       ^(or set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET before running^)
    set /p MODAL_TOKEN_LINE=
)
if not defined MODAL_TOKEN_LINE (
    echo [ERROR] No token line. The pair is required; this script does not open a browser.
    goto :fail
)

for /f "usebackq tokens=1,* delims==" %%A in (`".venv-modal\Scripts\python.exe" "scripts\parse_modal_token_line.py"`) do (
    set "%%A=%%B"
)
set "MODAL_TOKEN_LINE="

if not defined MODAL_TOKEN_ID goto :badpair
if not defined MODAL_TOKEN_SECRET goto :badpair
goto :deploy

:badpair
echo [ERROR] Could not parse token-id / token-secret from that line.
echo         Paste: modal token set --token-id ak-... --token-secret as-...
goto :fail

:deploy
echo [4/4] python -m modal deploy modal/app.py
echo       (registers the shell; containers stay at 0)
".venv-modal\Scripts\python.exe" -m modal deploy modal\app.py
if errorlevel 1 goto :fail

echo.
echo Done. The empty shell is on Modal.
echo Next: npm run dev  →  Settings → Connect this session
echo        ^(paste the same token pair; no second login^)
echo Closing the Electron window does not undeploy. GPU drops in ~2s on quit;
echo leftover CPU scales to 0 in a few seconds.
echo.
pause
exit /b 0

:fail
echo.
echo Deploy failed. Fix the error above and run this script again.
echo This script never opens a browser. Use the token pair only.
pause
exit /b 1
