#!/usr/bin/env bash
set -Eeuo pipefail

FIFO="${CONSOLE_FIFO:-/run/swipecraft/console.fifo}"
FIFO_DIR="$(dirname "$FIFO")"

# BDS берёт server.properties, worlds/ и behavior_packs из текущего каталога, поэтому
# запускать надо из каталога сервера. Раньше проверки не было, и скрипт умирал на
# «line 15: ./bedrock_server: No such file or directory» — это читается как сломанный
# скрипт, а на деле означает нераспакованный BDS (например скачивание отвалилось молча).
if [[ ! -x ./bedrock_server ]]; then
  if [[ -f ./bedrock_server ]]; then
    echo "[run] ./bedrock_server есть, но не исполняемый: chmod 0755 $PWD/bedrock_server" >&2
  else
    echo "[run] в $PWD нет bedrock_server — BDS не распакован (или запущено не из каталога сервера)." >&2
    echo "[run] распаковка и укладка описаны в docs/DEPLOY.md, раздел 2b." >&2
  fi
  exit 1
fi

# /run/swipecraft создаёт systemd (RuntimeDirectory); при ручном запуске от обычного
# пользователя его не создать, и тогда fifo кладут рядом с установкой
if ! mkdir -p "$FIFO_DIR" 2>/dev/null; then
  echo "[run] не могу создать каталог консоли $FIFO_DIR — задай CONSOLE_FIFO в доступное место," >&2
  echo "[run] например: CONSOLE_FIFO=\"$PWD/../.console.fifo\" bash $0" >&2
  exit 1
fi
if [[ ! -p "$FIFO" ]]; then
  rm -f "$FIFO"
  mkfifo "$FIFO"
  chmod 0660 "$FIFO"
fi

exec 3<>"$FIFO"
tail -f "$FIFO" | ./bedrock_server
