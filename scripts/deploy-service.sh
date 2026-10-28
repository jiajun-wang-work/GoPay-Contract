#!/usr/bin/env bash
# Run the local 1AM deployment page for one network in the background.
#
# Usage:
#   scripts/deploy-service.sh <preprod|preview> start     # start in the background, wait until the page answers
#   scripts/deploy-service.sh <preprod|preview> stop      # stop the background service
#   scripts/deploy-service.sh <preprod|preview> restart   # stop, then start
#   scripts/deploy-service.sh <preprod|preview> status    # running or stopped, with page URL
#   scripts/deploy-service.sh <preprod|preview> logs      # follow the service log (Ctrl+C to leave)
#
# The PID and log live in .deployment-<network>/ next to that network's record and secrets (Git-ignored,
# directory mode 0700). The log never contains secrets or Blockfrost tokens. Ports and endpoints come
# from scripts/networks.mjs. For a foreground run use: npm run deploy:<network>
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

NETWORK="${1:-}"
MODE="${2:-}"
usage() { echo "Usage: $0 <preprod|preview> <start|stop|restart|status|logs>" >&2; exit 1; }
[[ -n "$NETWORK" && -n "$MODE" ]] || usage

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found. Install Node.js >= 22." >&2
  exit 1
fi
# Validates the network name and reads its port from the shared network table.
PORT="$(node --input-type=module -e "const { networkConfig } = await import('./scripts/networks.mjs'); console.log(networkConfig(process.argv[1]).port);" "$NETWORK" 2>/dev/null)" \
  || { echo "ERROR: unknown network '$NETWORK'." >&2; usage; }

STATE_DIR=".deployment-$NETWORK"
PID_FILE="$STATE_DIR/server.pid"
LOG_FILE="$STATE_DIR/server.log"
URL="http://127.0.0.1:$PORT"
COMMAND_PATTERN="scripts/deploy-server.mjs $NETWORK"

# A PID only counts if it is still this network's deployment server (PIDs can be reused).
running_pid() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE")"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  ps -o command= -p "$pid" 2>/dev/null | grep -Fq "$COMMAND_PATTERN" || return 1
  echo "$pid"
}

start() {
  if pid="$(running_pid)"; then
    echo ">> $NETWORK deployment service already running (PID $pid): $URL"
    return 0
  fi
  rm -f "$PID_FILE"
  if command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "ERROR: port $PORT is already in use by a process this script did not start:" >&2
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
    exit 1
  fi
  if [[ ! -f src/managed/gopay/compiler/contract-info.json ]]; then
    echo "ERROR: compiled contract not found. Run: npm run compact:zk" >&2
    exit 1
  fi
  if [[ ! -d node_modules ]]; then
    echo "ERROR: dependencies not installed. Run: npm ci" >&2
    exit 1
  fi
  if ! curl -s -m 3 -o /dev/null http://127.0.0.1:6301/version; then
    echo "WARNING: proof server is not answering on 127.0.0.1:6301; preparing transactions will fail until it runs." >&2
  fi

  mkdir -p -m 700 "$STATE_DIR"
  echo ">> Starting $NETWORK deployment service..."
  nohup node scripts/deploy-server.mjs "$NETWORK" >>"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" >"$PID_FILE"
  chmod 600 "$PID_FILE" "$LOG_FILE"

  # Startup bundles the page and contacts the indexer; wait until the page answers or the process exits.
  for _ in $(seq 1 60); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "ERROR: $NETWORK deployment service exited during startup. Last log lines:" >&2
      tail -n 20 "$LOG_FILE" >&2
      exit 1
    fi
    if curl -s -m 2 -o /dev/null "$URL/config"; then
      echo ">> $NETWORK deployment service running (PID $pid): $URL"
      return 0
    fi
    sleep 1
  done
  echo "WARNING: $NETWORK deployment service (PID $pid) has not answered yet; see: $0 $NETWORK logs" >&2
}

stop() {
  local pid
  if ! pid="$(running_pid)"; then
    rm -f "$PID_FILE"
    echo ">> $NETWORK deployment service is not running."
    return 0
  fi
  echo ">> Stopping $NETWORK deployment service (PID $pid)..."
  kill "$pid"
  # Records are written atomically, so a forced stop after the grace period cannot corrupt them.
  for _ in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo ">> Still running after 10 s; forcing stop."
    kill -9 "$pid"
  fi
  rm -f "$PID_FILE"
  echo ">> Stopped."
}

case "$MODE" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status)
    if pid="$(running_pid)"; then echo "$NETWORK: running (PID $pid) $URL"; else echo "$NETWORK: stopped"; fi
    ;;
  logs)
    [[ -f "$LOG_FILE" ]] || { echo "No log yet: $LOG_FILE" >&2; exit 1; }
    exec tail -n 50 -f "$LOG_FILE"
    ;;
  *) usage ;;
esac
