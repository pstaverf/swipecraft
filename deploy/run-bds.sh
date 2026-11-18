#!/usr/bin/env bash
set -Eeuo pipefail

FIFO="${CONSOLE_FIFO:-/run/swipecraft/console.fifo}"
FIFO_DIR="$(dirname "$FIFO")"

mkdir -p "$FIFO_DIR"
if [[ ! -p "$FIFO" ]]; then
  rm -f "$FIFO"
  mkfifo "$FIFO"
  chmod 0660 "$FIFO"
fi

exec 3<>"$FIFO"
tail -f "$FIFO" | ./bedrock_server
