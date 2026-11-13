#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${ROOT:-/srv/swipecraft}"
FIFO="${CONSOLE_FIFO:-/run/swipecraft/console.fifo}"
TIMEOUT="${TIMEOUT:-90}"
PIDFILE_PATTERN="$ROOT/server/bedrock_server"

console_send() {
  [[ -p "$FIFO" ]] || return 1
  timeout 5 bash -c "printf '%s\n' '$1' > '$FIFO'" || return 1
  return 0
}

alive() { pgrep -f "$PIDFILE_PATTERN" >/dev/null 2>&1; }

if ! alive; then
  exit 0
fi

if console_send 'save hold'; then
  sleep 2
  console_send 'save resume' || true
  console_send 'stop' || true
else
  echo "[stop] консольный канал недоступен, отправляю SIGTERM"
  pkill -TERM -f "$PIDFILE_PATTERN" || true
fi

for _ in $(seq 1 "$TIMEOUT"); do
  alive || exit 0
  sleep 1
done

echo "[stop] процесс не завершился за ${TIMEOUT}s, SIGKILL"
pkill -KILL -f "$PIDFILE_PATTERN" || true
exit 0
