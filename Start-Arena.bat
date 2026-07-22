@echo off
setlocal EnableExtensions
title Agentic Architectures Arena (port 8035)
cd /d "%~dp0"
set PORT=8035
if not "%ARENA_PORT%"=="" set PORT=%ARENA_PORT%

if not exist ".venv\Scripts\python.exe" (
    echo [arena] No .venv found - run setup first:   python setup.py
    pause
    exit /b 1
)

REM free the port (kill any stale listener)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
    echo [arena] freeing port %PORT% (pid %%p^)
    taskkill /f /pid %%p >nul 2>&1
)

codex login status 2>nul | findstr /i "Logged in" >nul
if errorlevel 1 echo [arena] WARNING: Codex CLI not logged in. Run:  codex login

start "" /min cmd /c "timeout /t 3 >nul & start "" http://127.0.0.1:%PORT%/"
echo [arena] starting server on http://127.0.0.1:%PORT%/  (Ctrl+C to stop)
".venv\Scripts\python.exe" "dashboard\server.py"
