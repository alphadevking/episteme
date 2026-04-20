@echo off
echo ==========================================
echo Setting up Episteme Environment
echo ==========================================

echo [episteme-core] Installing dependencies...
cd /d "%~dp0episteme-core"
call pnpm install
if %ERRORLEVEL% NEQ 0 (
    echo [episteme-core] pnpm install failed!
    pause
    exit /b %ERRORLEVEL%
)
echo [episteme-core] Starting server (new window)...
start "Episteme Core" cmd /k "pnpm run dev"

echo [episteme-chat] Installing dependencies...
cd /d "%~dp0episteme-chat"
call pnpm install
if %ERRORLEVEL% NEQ 0 (
    echo [episteme-chat] pnpm install failed!
    pause
    exit /b %ERRORLEVEL%
)
echo [episteme-chat] Starting client (new window)...
start "Episteme Chat" cmd /k "pnpm run dev"

echo ==========================================
echo Setup initiated successfully.
echo Core and Web processes are running in separate windows.
echo Closing this terminal...
echo ==========================================
timeout /t 2 >nul

:: If running in PowerShell, this will attempt to close the parent shell window
powershell -Command "$p = Get-Process -Id $PID; if ($p.Parent.ProcessName -match 'powershell|pwsh') { Stop-Process -Id $p.Parent.Id }" >nul 2>&1

exit

