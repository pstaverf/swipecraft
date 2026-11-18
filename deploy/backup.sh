#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${ROOT:-/srv/swipecraft}"
FIFO="${CONSOLE_FIFO:-/run/swipecraft/console.fifo}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
REMOTE="${BACKUP_REMOTE:-}"
DEST="$ROOT/backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TMP="$DEST/.partial-$STAMP.tar.gz"
TARGET="$DEST/daily/swipecraft-$STAMP.tar.gz"

mkdir -p "$DEST/daily" "$DEST/weekly" "$DEST/weekly"
exec 9>"$DEST/.backup.lock"
flock -n 9 || { echo "[backup] уже выполняется другой бэкап"; exit 0; }

save_started=0

console_send() {
  [[ -p "$FIFO" ]] || return 1
  timeout 5 bash -c "printf '%s\n' '$1' > '$FIFO'" || return 1
  return 0
}

finish() {
  local rc=$?
  if [[ $save_started -eq 1 ]]; then
    console_send 'save resume' || true
  fi
  rm -f "$TMP"
  exit $rc
}
trap finish EXIT

archive() {
  tar -czf "$TMP" \
    --warning=no-file-changed \
    --ignore-failed-read \
    -C "$ROOT" \
    server/worlds \
    server/server.properties \
    server/keys \
    packs \
    2>>"$ROOT/logs/deploy.log"
}

if systemctl is-active --quiet swipecraft.service 2>/dev/null && [[ -p "$FIFO" ]]; then
  if console_send 'save hold'; then
    save_started=1
    sleep 3
    echo "[backup] горячий бэкап (save hold)"
  else
    echo "[backup] консольный канал не отвечает, бэкап без hold"
  fi
else
  echo "[backup] сервер не запущен, бэкап файлов как есть"
fi

archive

if ! tar -tzf "$TMP" >/dev/null 2>&1; then
  echo "[backup][error] архив повреждён, бэкап отменён" >&2
  exit 1
fi

mv -f "$TMP" "$TARGET"
sha256sum "$TARGET" | awk '{print $1}' > "$TARGET.sha256"
chmod 0640 "$TARGET" "$TARGET.sha256"

if [[ "$(date -u +%u)" == "7" ]]; then
  cp -f "$TARGET" "$DEST/weekly/"
  cp -f "$TARGET.sha256" "$DEST/weekly/"
fi

ls -1t "$DEST/daily"/swipecraft-*.tar.gz 2>/dev/null | tail -n +"$((KEEP_DAILY + 1))" | while read -r old; do
  rm -f "$old" "$old.sha256"
done
ls -1t "$DEST/weekly"/swipecraft-*.tar.gz 2>/dev/null | tail -n +"$((KEEP_WEEKLY + 1))" | while read -r old; do
  rm -f "$old" "$old.sha256"
done

if [[ -n "$REMOTE" ]]; then
  if command -v rclone >/dev/null 2>&1; then
    rclone copy "$TARGET" "$REMOTE" >>"$ROOT/logs/deploy.log" 2>&1 || echo "[backup][warn] rclone не смог отправить архив"
  else
    rsync -a -e 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' "$TARGET" "$REMOTE/" >>"$ROOT/logs/deploy.log" 2>&1 || echo "[backup][warn] rsync не смог отправить архив"
  fi
fi

echo "[backup] готово: $TARGET ($(du -h "$TARGET" | awk '{print $1}'))"
