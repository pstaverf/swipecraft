#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${ROOT:-/srv/swipecraft}"
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
RESTART="${RESTART:-0}"

SRC_BP="$REPO_DIR/packs/behavior_pack"
SRC_RP="$REPO_DIR/packs/resource_pack"
DST_BP="$ROOT/packs/behavior_packs/swipecraft_bp"
DST_RP="$ROOT/packs/resource_packs/swipecraft_rp"

die() { printf '[packs][error] %s\n' "$*" >&2; exit 1; }
log() { printf '[packs] %s\n' "$*"; }

[[ $EUID -eq 0 ]] || die "запусти от root"
[[ -f "$SRC_BP/manifest.json" ]] || die "нет $SRC_BP/manifest.json"
[[ -f "$SRC_RP/manifest.json" ]] || die "нет $SRC_RP/manifest.json"
[[ -f "$SRC_BP/scripts/main.js" ]] || die "нет собранного $SRC_BP/scripts/main.js — выполни npm run build"

mkdir -p "$DST_BP" "$DST_RP"
rsync -a --delete --exclude 'scripts/main.js.map' "$SRC_BP/" "$DST_BP/"
rsync -a --delete "$SRC_RP/" "$DST_RP/"
chown -R bedrock:bedrock "$ROOT/packs"
find "$ROOT/packs" -type d -exec chmod 0755 {} +
find "$ROOT/packs" -type f -exec chmod 0644 {} +

uuid_bp="$(python3 -c "import json;print(json.load(open('$DST_BP/manifest.json'))['header']['uuid'])")"
uuid_rp="$(python3 -c "import json;print(json.load(open('$DST_RP/manifest.json'))['header']['uuid'])")"
ver_bp="$(python3 -c "import json;m=json.load(open('$DST_BP/manifest.json'))['header'];print(m['version'])")"
ver_rp="$(python3 -c "import json;m=json.load(open('$DST_RP/manifest.json'))['header'];print(m['version'])")"

log "behavior pack:  $uuid_bp $ver_bp"
log "resource pack:  $uuid_rp $ver_rp"

if [[ "$RESTART" == "1" ]]; then
  log "перезапуск службы"
  systemctl restart swipecraft.service
fi

PROPS="$ROOT/server/server.properties"
LEVEL_NAME="$(grep -E '^level-name=' "$PROPS" | head -1 | cut -d= -f2- | tr -d '[:space:]')"
WORLD_DIR="$ROOT/server/worlds/$LEVEL_NAME"

if [[ -n "$LEVEL_NAME" && -d "$WORLD_DIR" ]]; then
  printf '[{"pack_id":"%s","version":[1,0,0]}]' "$uuid_bp" > "$WORLD_DIR/world_behavior_packs.json"
  printf '[{"pack_id":"%s","version":[1,0,0]}]' "$uuid_rp" > "$WORLD_DIR/world_resource_packs.json"
  chown bedrock:bedrock "$WORLD_DIR/world_behavior_packs.json" "$WORLD_DIR/world_resource_packs.json"
  log "паки подключены к миру $LEVEL_NAME"
else
  log "мир $LEVEL_NAME ещё не создан: после первого запуска выполни $0 повторно"
fi

if [[ "$RESTART" == "1" ]]; then
  log "перезапуск службы"
  systemctl restart swipecraft.service
fi
