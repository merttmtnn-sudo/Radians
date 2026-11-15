@echo off
rem Starts Radians from this folder: makes the Python environment on the first run, then serves the
rem site at http://127.0.0.1:8765 and opens it in the browser. Close this window to stop it.
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Install Python 3.12 or newer from https://www.python.org/downloads/
  echo and tick "Add python.exe to PATH" in the installer. Then run this file again.
  pause
  exit /b 1
)

rem an environment copied from another computer does not work here: build it again
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "import fastapi, astropy, uvicorn" >nul 2>nul
  if errorlevel 1 rmdir /s /q .venv
)

if not exist ".venv\Scripts\python.exe" (
  echo First run: setting up the Python environment. This takes a few minutes and needs the internet.
  python -m venv .venv
  if errorlevel 1 goto :failed
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r backend\requirements.txt
  if errorlevel 1 goto :failed
)

echo.
echo Radians is starting at http://127.0.0.1:8765/?lang=tr
echo The five challenge targets open at once. Any other spot shows its first pictures after about 10 seconds; all six bands take a few minutes.
echo Close this window, or press Ctrl+C, to stop.
echo.
start "" cmd /c "timeout /t 8 /nobreak >nul & start "" http://127.0.0.1:8765/?lang=tr"
".venv\Scripts\python.exe" -m uvicorn app.main:app --port 8765 --app-dir backend --timeout-keep-alive 75
goto :eof

:failed
echo.
echo The set-up did not finish. Check the internet connection and run this file again.
pause
exit /b 1
