#!/usr/bin/env bash
# Lanzador de O'Reilly Pulse WebGPU para Linux
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-3050}"
URL="http://localhost:${PORT}"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: No se encontró Node.js. Instala Node.js v22.5 o superior desde https://nodejs.org/"
  read -r -p "Pulsa Intro para salir..."
  exit 1
fi

if command -v lsof >/dev/null 2>&1 && lsof -iTCP:"${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "O'Reilly Pulse ya está en ejecución en ${URL}"
  xdg-open "${URL}" >/dev/null 2>&1 || true
  exit 0
fi

echo "Iniciando O'Reilly Pulse WebGPU en ${URL} ..."
(sleep 1.2 && xdg-open "${URL}" >/dev/null 2>&1) &
node --no-warnings server.js
