#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${ROOT:-/srv/swipecraft}"
PROPS="$ROOT/server/server.properties"
ARCHIVE_DIR="$ROOT/backups/world-archive"

log() { printf '[wipe] %s\n' "$*"; }
die() { printf '[wipe][error] %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "запусти от root"
[[ "${1:-}" == "--confirm" ]] || die "запуск: $0 --confirm (и переменная CONFIRM=WIPE)"
[[ "${CONFIRM:-}" == "WIPE" ]] || die "нет подтверждения: CONFIRM=WIPE $0 --confirm"
[[ -f "$PROPS" ]] || die "нет $PROPS"

LEVEL_NAME="$(grep -E '^level-name=' "$PROPS" | head -1 | cut -d= -f2- | tr -d '[:space:]')"
[[ -n "$LEVEL_NAME" ]] || die "не смог прочитать level-name"
WORLD_DIR="$ROOT/server/worlds/$LEVEL_NAME"
[[ -d "$WORLD_DIR" ]] || die "мир не найден: $WORLD_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SEED="$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)"

log "остановка сервера"
systemctl stop swipecraft.service

log "бэкап перед вайпом"
ROOT="$ROOT" bash "$ROOT/deploy/backup.sh"

log "архивация мира $LEVEL_NAME"
mkdir -p "$ARCHIVE_DIR"
mv "$WORLD_DIR" "$ARCHIVE_DIR/${LEVEL_NAME}-${STAMP}"
chown -R root:root "$ARCHIVE_DIR/${LEVEL_NAME}-${STAMP}"

log "ротация сида: $SEED"
if grep -qE '^level-seed=' "$PROPS"; then
  sed -i "s/^level-seed=.*/level-seed=$SEED/" "$PROPS"
else
  printf 'level-seed=%s\n' "$SEED" >> "$PROPS"
fi
chown bedrock:bedrock "$PROPS"

log "запуск с новым миром"
systemctl start swipecraft.service
ready=0
for _ in $(seq 1 90); do
  if tail -n 300 "$ROOT/logs/console.log" | grep -qE 'Server started\.'; then ready=1; break; fi
  systemctl is-active --quiet swipecraft.service || break
  sleep 2
done

if [[ $ready -eq 1 ]]; then
  log "сезон сброшен, новый сид $SEED, старый мир в $ARCHIVE_DIR/${LEVEL_NAME}-${STAMP}"
  log "не забудь: пересоздать лобби и проверить границу (/sw:admin -> border)"
else
  die "сервер не поднялся после вайпа, лог: $ROOT/logs/console.log"
fi
