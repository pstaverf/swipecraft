#!/usr/bin/env bash
# Кладёт собранные паки в установку и привязывает их к миру.
#
# Полезные переменные:
#   ROOT=/путь/до/установки   каталог сервера (по умолчанию /srv/swipecraft, иначе —
#                             каталог запущенного bedrock_server)
#   BDS_OWNER=user:group      кому chownить (по умолчанию — фактический владелец $ROOT/server)
#   RESTART=1                 перезапустить службу после укладки (только если юнит есть)
#   DRY_RUN=1                 показать, что будет сделано, ничего не меняя
#
# Раньше скрипт требовал root и жёстко писал chown -R bedrock:bedrock: на установке без
# такого пользователя деплой обрывался посередине (паки скопированы, мир не привязан).
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-common.sh
. "$SCRIPT_DIR/lib/deploy-common.sh"
TAG="packs"

REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ROOT="${ROOT:-/srv/swipecraft}"
RESTART="${RESTART:-0}"

SRC_BP="$REPO_DIR/packs/behavior_pack"
SRC_RP="$REPO_DIR/packs/resource_pack"
DST_BP="$ROOT/packs/behavior_packs/swipecraft_bp"
DST_RP="$ROOT/packs/resource_packs/swipecraft_rp"

# ── 1. preflight: всё проверяем ДО первой записи ──────────────────────────────
[[ -f "$SRC_BP/manifest.json" ]] || die "нет $SRC_BP/manifest.json — репозиторий выглядит неполным"
[[ -f "$SRC_RP/manifest.json" ]] || die "нет $SRC_RP/manifest.json — репозиторий выглядит неполным"
# main.js в git намеренно не лежит — это артефакт сборки, и собирать его надо в копии
# репозитория (отсюда REPO_DIR), а не в $ROOT: паки скрипт берёт именно оттуда
[[ -s "$SRC_BP/scripts/main.js" ]] || die "нет собранного $SRC_BP/scripts/main.js — выполни npm ci && npm run build (main.js в git нет, это норма)"

ROOT="$(resolve_root)"
DST_BP="$ROOT/packs/behavior_packs/swipecraft_bp"
DST_RP="$ROOT/packs/resource_packs/swipecraft_rp"
PROPS="$ROOT/server/server.properties"
[[ -f "$PROPS" ]] || die "нет $PROPS"

OWNER="$(resolve_owner)"
owner_user="${OWNER%%:*}"
log "установка: $ROOT, владелец файлов: $OWNER$([[ $EUID -eq 0 ]] || echo ' (я не root — chown пропущу)')"
[[ "$DRY_RUN" == "1" ]] && log "DRY_RUN=1: команды только показываются"

# ── 2. укладка паков ──────────────────────────────────────────────────────────
run mkdir -p "$ROOT/packs/behavior_packs" "$ROOT/packs/resource_packs" "$DST_BP" "$DST_RP"
# rsync есть не везде (на минимальных Amazon Linux его нет); cp -a + очистка — тот же
# результат для нашего случая: каталоги паков полностью принадлежат этому скрипту
if command -v rsync >/dev/null 2>&1; then
  run rsync -a --delete --exclude 'scripts/main.js.map' "$SRC_BP/" "$DST_BP/"
  run rsync -a --delete "$SRC_RP/" "$DST_RP/"
else
  warn "rsync не найден — заменяю очисткой каталога и cp -a"
  run rm -rf "$DST_BP" "$DST_RP"
  run mkdir -p "$DST_BP" "$DST_RP"
  run cp -a "$SRC_BP/." "$DST_BP/"
  run cp -a "$SRC_RP/." "$DST_RP/"
  run rm -f "$DST_BP/scripts/main.js.map"
fi
chown_or_warn "$ROOT/packs"
run find "$ROOT/packs" -type d -exec chmod 0755 {} +
run find "$ROOT/packs" -type f -exec chmod 0644 {} +

# ── 3. uuid/версии из манифестов ──────────────────────────────────────────────
# в DRY_RUN копирования не было, поэтому читаем исходные манифесты: они с уложенными
# совпадают посимвольно (это ровно тот же файл), а на отсутствующем назначении dry-run
# падал бы с «нет …/manifest.json»
man_bp="$DST_BP/manifest.json"; man_rp="$DST_RP/manifest.json"
if [[ "$DRY_RUN" == "1" ]]; then
  man_bp="$SRC_BP/manifest.json"; man_rp="$SRC_RP/manifest.json"
fi
uuid_bp="$(manifest_field "$man_bp" uuid)"
uuid_rp="$(manifest_field "$man_rp" uuid)"
ver_bp="$(manifest_field "$man_bp" version)"
ver_rp="$(manifest_field "$man_rp" version)"
log "behavior pack:  $uuid_bp $ver_bp"
log "resource pack:  $uuid_rp $ver_rp"

# ── 4. привязка к миру ────────────────────────────────────────────────────────
LEVEL_NAME="$(grep -E '^level-name=' "$PROPS" | head -1 | cut -d= -f2- | tr -d '[:space:]')"
WORLD_DIR="$ROOT/server/worlds/$LEVEL_NAME"
if [[ -z "$LEVEL_NAME" ]]; then
  warn "в $PROPS нет level-name — привязку паков пропускаю"
elif [[ ! -d "$WORLD_DIR" ]]; then
  log "мир $LEVEL_NAME ещё не создан (первый запускает его сам): после старта выполни $0 повторно"
else
  # проверка до записи: без неё «>/path» от не-root'а упал бы молча, и деплой оборвался бы
  # на середине (именно этот сценарий и выглядел как «скрипт отработал, а паки не подключились»)
  [[ -w "$WORLD_DIR" ]] || die "нет прав на запись в $WORLD_DIR — запусти через sudo -E (обычный sudo выбрасывает ROOT/BDS_OWNER из окружения)"
  if [[ "$DRY_RUN" == "1" ]]; then
    #dry-run ничего не пишет на диск — перенаправление «> file» мимо run() это ломало
    log "dry-run: записал бы $WORLD_DIR/world_behavior_packs.json ($uuid_bp) и world_resource_packs.json ($uuid_rp)"
    exit 0
  fi
  for pair in "world_behavior_packs.json:$uuid_bp" "world_resource_packs.json:$uuid_rp"; do
    file="$WORLD_DIR/${pair%%:*}"
    want="${pair##*:}"
    printf '[{"pack_id":"%s","version":[1,0,0]}]' "$want" > "$file"
    chown_or_warn "$file"
    # читаем обратно: файл, в который не записан uuid, — это «деплой прошёл», а паки нет
    grep -q "$want" "$file" || die "записал $file, а uuid в нём не вижу"
  done
  log "паки подключены к миру $LEVEL_NAME"
fi

# ── 5. самопроверка результата ────────────────────────────────────────────────
if [[ "$DRY_RUN" == "1" ]]; then
  log "DRY_RUN=1 — проверка результата пропускаю"
  exit 0
fi
[[ -s "$DST_BP/scripts/main.js" ]] || die "после копирования $DST_BP/scripts/main.js пуст"
for file in "$DST_BP/manifest.json" "$DST_RP/manifest.json"; do
  readable_by "$owner_user" "$file" || die "$file не читается пользователем $owner_user — сервер его не увидит (права 0644, владелец $OWNER)"
done
log "файлы на месте: $(du -sh "$DST_BP" "$DST_RP" 2>/dev/null | awk '{printf "%s ", $1}'; echo)"

# ── 6. перезапуск — один раз и в самом конце ──────────────────────────────────
# Порядок важен: раньше служба перезапускалась ДО записи world_*_packs.json, поэтому
# привязка паков уезжала в следующий рестарт.
if [[ "$RESTART" == "1" ]]; then
  if has_service; then
    log "перезапуск службы"
    run systemctl restart swipecraft.service
  else
    warn "службы swipecraft.service нет — перезапусти bedrock_server вручную (deploy/stop-bds.sh && deploy/run-bds.sh)"
  fi
fi
