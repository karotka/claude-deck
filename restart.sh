#!/usr/bin/env bash
set -euo pipefail

# Restart (or start) the claude-deck app.
#
# Usage:
#   ./restart.sh          # dev mode (server :3456 + ui :5173)
#   ./restart.sh prod     # production mode (built server only :3456)
#   ./restart.sh stop     # stop without restarting

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

MODE="${1:-dev}"
LOG_DIR="$SCRIPT_DIR/.run"
PID_FILE="$LOG_DIR/app.pid"
LOG_FILE="$LOG_DIR/app.log"
SERVER_PORT=3456
UI_PORT=5173

mkdir -p "$LOG_DIR"

# Configuration lives in .env at the repo root (see .env.example); the server
# loads it itself, and anything already exported here wins over the file. No
# environment setup is needed in this script.

kill_port() {
  local port=$1
  local pids
  pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "  killing PIDs on :$port -> $pids"
    kill $pids 2>/dev/null || true
    sleep 1
    pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
    if [ -n "$pids" ]; then
      kill -9 $pids 2>/dev/null || true
    fi
  fi
}

stop_app() {
  echo "Stopping claude-deck..."
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      echo "  killing tracked PID $pid (and group)"
      kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 -- -"$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  kill_port "$SERVER_PORT"
  kill_port "$UI_PORT"
}

case "$MODE" in
  stop)
    stop_app
    echo "Stopped."
    exit 0
    ;;
  dev|prod) ;;
  *)
    echo "Unknown mode: $MODE (expected: dev | prod | stop)" >&2
    exit 1
    ;;
esac

stop_app

echo "Starting claude-deck in $MODE mode..."
if [ "$MODE" = "prod" ]; then
  if [ ! -d "$SCRIPT_DIR/packages/server/dist" ] || [ ! -d "$SCRIPT_DIR/packages/ui/dist" ]; then
    echo "  building first..."
    npm run build >>"$LOG_FILE" 2>&1
  fi
  CMD=(npm start)
else
  CMD=(npm run dev)
fi

# Enable job control so the backgrounded process becomes its own process group
# leader — letting us kill the whole tree later via `kill -- -PID`.
set -m
nohup "${CMD[@]}" >>"$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
set +m

sleep 2
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Started (PID $(cat "$PID_FILE")). Logs: $LOG_FILE"
  if [ "$MODE" = "dev" ]; then
    echo "  server: http://localhost:$SERVER_PORT"
    echo "  ui:     http://localhost:$UI_PORT"
  else
    echo "  app:    http://localhost:$SERVER_PORT"
  fi
else
  echo "Failed to start. Check $LOG_FILE" >&2
  exit 1
fi
