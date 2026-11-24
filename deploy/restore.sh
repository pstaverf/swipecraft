#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-common.sh
. "$SCRIPT_DIR/lib/deploy-common.sh"
TAG="restore"

ROOT="${ROOT:-/srv/swipecraft}"
ARCHIVE="${1:-}"
ASSUME_YES="${ASSUME_YES:-0}"

[[ $EUID -eq 0 ]] || die "запусти от root"
[[ -n "$ARCHIVE" ]] || die "использование: restore.sh /srv/swipecraft/backups/daily/swipecraft-XXXX.tar.gz"
[[ -f "$ARCHIVE" ]] || die "нет файла $ARCHIVE"

if [[ -f "$ARCHIVE.sha256" ]]; then
  expected="$(cat "$ARCHIVE.sha256")"
  actual="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
  [[ "$expected" == "$actual" ]] || die "контрольная сумма не совпадает: $ARCHIVE повреждён"
  echo "[restore] контрольная сумма ок"
fi

tar -tzf "$ARCHIVE" >/dev/null || die "архив не читается"

if [[ "$ASSUME_YES" != "1" ]]; then
  printf 'Восстановить %s в %s? Текущий мир будет перезаписан [yes/N]: ' "$ARCHIVE" "$ROOT"
  read -r answer
  [[ "$answer" == "yes" ]] || die "отменено"
fi

echo "[restore] остановка сервера"
require_service
systemctl stop swipecraft.service

mkdir -p "$ROOT/backups/pre-restore"
tar -czf "$ROOT/backups/pre-restore/pre-restore-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" \
  -C "$ROOT" server/worlds server/keys packs 2>/dev/null || true

echo "[restore] распаковка"
rm -rf "$ROOT/server/worlds"
tar -xzf "$ARCHIVE" -C "$ROOT"
# chown здесь всегда был «мягким» и это правильно: после распаковки архива права могут быть
# какие угодно, а падать из-за этого — значит оставить сервер в полуразобранном состоянии.
# Владелец при этом берётся из установки, а не из имени «bedrock»: на машине без такого
# пользователя chown падал с «invalid user»
for target in "$ROOT/server/worlds" "$ROOT/packs" "$ROOT/server/keys"; do
  chown_or_warn "$target" || true
done

echo "[restore] запуск"
systemctl start swipecraft.service
sleep 5
systemctl is-active --quiet swipecraft.service || die "сервер не поднялся, смотри $ROOT/logs/console.log"
echo "[restore] готово"
