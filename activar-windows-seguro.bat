@echo off
chcp 65001 >nul
title O'Reilly Pulse - Activador de Modo Seguro (127.0.0.1:3050)
net session >nul 2>&1
if %errorLevel% neq 0 (
  echo Solicitando permiso de Administrador para activar el enlace seguro http://127.0.0.1:3050 ...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
echo ====================================================================
echo   O'Reilly Pulse - Configurando Enlace Seguro en Windows (WebGPU)
echo   Tunel Permanente: http://127.0.0.1:3050  --^>  Mac (192.168.1.225:3050)
echo ====================================================================
netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=3050 >nul 2>&1
netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=3050 connectaddress=192.168.1.225 connectport=3050
echo.
echo Tuneles portproxy activos en este PC con Windows:
netsh interface portproxy show v4tov4
echo.
echo Listo! Abriendo http://127.0.0.1:3050 sin aviso "No es seguro"...
start "" "http://127.0.0.1:3050"
timeout /t 2 >nul
