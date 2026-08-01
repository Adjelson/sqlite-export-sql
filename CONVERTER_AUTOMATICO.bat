@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist node_modules\better-sqlite3 (
  echo A instalar dependencias...
  call npm install
  if errorlevel 1 goto :error
)

set "INPUT=%~1"
if "%INPUT%"=="" (
  echo.
  set /p "INPUT=Arraste uma base/pasta para esta janela ou escreva o caminho: "
)

if "%INPUT%"=="" goto :error
node .\bin\sqlite-to-sql.js "%INPUT%" --recursive
if errorlevel 1 goto :error

echo.
echo Conversao concluida. Consulte o .sql e o .report.json criados junto da base.
pause
exit /b 0

:error
echo.
echo Nao foi possivel concluir a conversao.
pause
exit /b 1
