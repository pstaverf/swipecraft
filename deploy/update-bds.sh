#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${ROOT:-/srv/swipecraft}"
USER_NAME="${USER_NAME:-bedrock}"
BDS_VERSION="${BDS_VERSION:-}"
BDS_URL="${BDS_URL:-}"

log() { printf '[update] %s\n' "$*"; }
die() { printf '[update][error] %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "запусти от root"
[[ -n "$BDS_VERSION" ]] || die "укажи версию: BDS_VERSION=1.26.61.1 $0"
[[ -n "$BDS_URL" ]] || BDS_URL="https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-${BDS_VERSION}.zip"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

log "бэкап мира перед обновлением"
ROOT="$ROOT" bash "$ROOT/deploy/backup.sh"

log "бэкап бинарников"
mkdir -p "$ROOT/backups/binaries"
tar -czf "$ROOT/backups/binaries/bds-$STAMP.tar.gz" \
  -C "$ROOT/server" . --exclude 'worlds' --exclude 'keys' --exclude 'behavior_packs' --exclude 'resource_packs' \
  2>/dev/null || true
cp -a "$ROOT/server/server.properties" "/tmp/server.properties.keep"

log "остановка"
systemctl stop swipecraft.service

log "загрузка $BDS_VERSION"
if ! curl -fL --retry 3 -o /tmp/bds-update.zip "$BDS_URL"; then
  cp -a "/tmp/server.properties.keep" "$ROOT/server/server.properties"
  systemctl start swipecraft.service
  die "не удалось скачать $BDS_URL, сервер возвращён в работу на старой версии"
fi

log "распаковка"
unzip -q -o /tmp/bds-update.zip -d "$ROOT/server"
rm -f /tmp/bds-update.zip
cp -a "/tmp/server.properties.keep" "$ROOT/server/server.properties"
chown -R "$USER_NAME:$USER_NAME" "$ROOT/server"
chmod 0755 "$ROOT/server/bedrock_server"

log "запуск"
systemctl start swipecraft.service
ready=0
for _ in $(seq 1 60); do
  if tail -n 200 "$ROOT/logs/console.log" | grep -qE 'Server started\.'; then ready=1; break; fi
  systemctl is-active --quiet swipecraft.service || break
  sleep 2
done

if [[ $ready -eq 1 ]]; then
  log "обновление до $BDS_VERSION завершено"
  log "проверь снаружи: $ROOT/deploy/check-ports.sh --remote <IP>"
else
  systemctl status swipecraft.service --no-pager -l | tail -30
  die "сервер не поднялся после обновления, лог: $ROOT/logs/console.log"
fi
