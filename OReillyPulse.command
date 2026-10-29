#!/bin/zsh
# Lanzador rápido y gestor de autoinicio de O'Reilly Pulse (http://localhost:3050)

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
PROJECT_DIR="/Volumes/MisAppsV/oreilly_pulse"
PLIST_NAME="com.jesusconde.oreillypulse.plist"
PLIST_SRC="$PROJECT_DIR/$PLIST_NAME"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"
APP_URL="http://localhost:3050"

cd "$PROJECT_DIR" || exit 1

# 1. Instalar y activar el servicio de autoinicio en macOS (LaunchAgent) si aún no está activo
if [ -f "$PLIST_SRC" ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  if [ ! -f "$PLIST_DEST" ] || ! cmp -s "$PLIST_SRC" "$PLIST_DEST"; then
    cp "$PLIST_SRC" "$PLIST_DEST"
    launchctl unload "$PLIST_DEST" >/dev/null 2>&1
    launchctl load -w "$PLIST_DEST" >/dev/null 2>&1
  fi
fi

# 2. Comprobar si el servidor ya está respondiendo en el puerto 3050
if ! lsof -i :3050 -sTCP:LISTEN -t >/dev/null 2>&1; then
  if [ -f "$PLIST_DEST" ]; then
    launchctl start com.jesusconde.oreillypulse >/dev/null 2>&1
  fi
  sleep 0.6
  if ! lsof -i :3050 -sTCP:LISTEN -t >/dev/null 2>&1; then
    mkdir -p "$PROJECT_DIR/data"
    nohup /opt/homebrew/bin/node --no-warnings "$PROJECT_DIR/server.js" >> "$PROJECT_DIR/data/server.log" 2>&1 &
  fi

  for i in {1..15}; do
    if lsof -i :3050 -sTCP:LISTEN -t >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
fi

# 3. Abrir directamente O'Reilly Pulse en el navegador predeterminado
open "$APP_URL"
exit 0
