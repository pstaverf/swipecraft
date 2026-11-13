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

log "не забудь, что паки должны быть включены в мире: worlds/swipecraft/world_behavior_packs.json и world_resource_packs.json"
