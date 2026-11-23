#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Проверка скриптов деплоя. НЕ требует root и живого сервера: собирает временную
# «установку» в /tmp, прогоняет по ней deploy/deploy-packs.sh и смотрит, что
# получилось на диске.
#
#   npm run check:deploy
#
# Смысл проверок — не «скрипт запустился», а те три способа, которыми деплой паков
# врал: (1) жёсткий chown на пользователя, которого нет (обрукал деплой посередине:
# паки скопированы, мир не привязан), (2) «успех» без проверки, что uuid реально
# записан в world_*_packs.json, (3) молчаливое создание установки в ROOT по
# умолчанию, когда сервер живёт совсем в другом каталоге.
# ---------------------------------------------------------------------------
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
PASS=0
FAIL=0
FAILED_NAMES=()

ok() { PASS=$((PASS + 1)); printf '  OK   %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); FAILED_NAMES+=("$1"); printf '  FAIL %s — %s\n' "$1" "${2:-}"; }

TMP="$(mktemp -d)"
trap 'chmod -R u+rwX "$TMP" 2>/dev/null || true; rm -rf "$TMP"' EXIT

# ── фиктивная сборка: паки с манифестами и main.js, установка с миром ─────────
FAKE_REPO="$TMP/repo"
FAKE_ROOT="$TMP/root"
mkdir -p "$FAKE_REPO/packs/behavior_pack/scripts" "$FAKE_REPO/packs/resource_pack/textures"
mkdir -p "$FAKE_ROOT/server/bedrock_server_dir" "$FAKE_ROOT/packs/behavior_packs" "$FAKE_ROOT/packs/resource_packs"
uuid_bp="11111111-1111-1111-1111-111111111111"
uuid_rp="22222222-2222-2222-2222-222222222222"
printf '{"header":{"uuid":"%s","version":[1,0,0],"min_engine_version":[1,20,0]},"modules":[{"type":"scripts","uuid":"33333333-3333-3333-3333-333333333333","version":[1,0,0]}]}\n' "$uuid_bp" > "$FAKE_REPO/packs/behavior_pack/manifest.json"
printf '{"header":{"uuid":"%s","version":[1,0,0],"min_engine_version":[1,20,0]},"modules":[{"type":"resources","uuid":"44444444-4444-4444-4444-444444444444","version":[1,0,0]}]}\n' "$uuid_rp" > "$FAKE_REPO/packs/resource_pack/manifest.json"
printf '// собранный бандл\n' > "$FAKE_REPO/packs/behavior_pack/scripts/main.js"
printf 'stub\n' > "$FAKE_REPO/packs/resource_pack/textures/x.txt"
WORLD="$FAKE_ROOT/server/worlds/swipecraft"
mkdir -p "$WORLD"
printf 'level-name=swipecraft\nserver-port=19132\n' > "$FAKE_ROOT/server/server.properties"
touch "$FAKE_ROOT/server/bedrock_server"
chmod 0755 "$FAKE_ROOT/server/bedrock_server"

PACKS="$REPO/deploy/deploy-packs.sh"
# переменные передаём через env: как «REPO_DIR=… bash …», а не позиционными аргументами —
# иначе «run_packs DRY_RUN=1» превращался в запуск с аргументом DRY_RUN=1, и dry-run
# молча работал по-настоящему (тест на «не трогает диск» при этом врал)
run_packs() {
  (cd "$FAKE_REPO" && env REPO_DIR="$FAKE_REPO" ROOT="$FAKE_ROOT" ${1+"$@"} bash "$PACKS" 2>&1)
}

# ── 1. no hard-coded users anywhere in deploy/ ────────────────────────────────
name="ни одного жёсткого chown на bedrock в deploy/"
# Код возврата grep проверяется отдельно от содержимого: с битым шаблоном grep отдаёт 2,
# и «if grep …; then bad; else ok» превращает сломанную проверку в зелёную (так и было).
# Комментарии-объяснения слово «bedrock» упоминают намеренно — их отсекаем, но после rc.
set +e
grep -rnE 'chown[[:space:]].*bedrock' "$REPO/deploy" --include='*.sh' >"$TMP/chown.raw" 2>/dev/null
grep_rc=$?
set -e
grep -vE ':[0-9]+:[[:space:]]*#' "$TMP/chown.raw" >"$TMP/chown.hits" 2>/dev/null || true
if [[ $grep_rc -gt 1 ]]; then
  bad "$name" "grep вернул $grep_rc — шаблон сломан, проверка ничего не видела"
elif [[ -s "$TMP/chown.hits" ]]; then
  bad "$name" "найдено: $(head -1 "$TMP/chown.hits")"
else
  ok "$name"
fi

# ── 2. dry-run ничего не пишет ────────────────────────────────────────────────
name="DRY_RUN=1 не трогает диск"
out="$(run_packs DRY_RUN=1 || true)"
name="$name"
if [[ -f "$WORLD/world_behavior_packs.json" || -f "$FAKE_ROOT/packs/behavior_packs/swipecraft_bp/scripts/main.js" ]]; then
  bad "$name" "в dry-run появились файлы в установке"
else
  ok "$name"
fi

# ── 3. dry-run показывает РЕАЛЬНОГО владельца, а не bedrock ───────────────────
name="владелец берётся из установки (не из головы)"
want_owner="$(stat -c '%U:%G' "$FAKE_ROOT/server")"
if printf '%s' "$out" | grep -q "владелец файлов: $want_owner"; then
  ok "$name — $want_owner"
else
  bad "$name" "ожидал «владелец файлов: $want_owner», получил: $(printf '%s' "$out" | grep 'владелец' | head -1)"
fi

# ── 4. обычный прогон раскладывает паки и привязывает их к миру ───────────────
name="укладка паков и привязка к миру"
out="$(run_packs || true)"
if [[ -s "$FAKE_ROOT/packs/behavior_packs/swipecraft_bp/scripts/main.js" \
  && -s "$FAKE_ROOT/packs/resource_packs/swipecraft_rp/textures/x.txt" ]]; then
  ok "$name"
else
  bad "$name" "паков нет на месте: $(printf '%s' "$out" | tail -2)"
fi

name="world_*_packs.json содержат нужные uuid"
bp="$( { grep -o "\"pack_id\":\"[^\"]*\"" "$WORLD/world_behavior_packs.json" || true; } | head -1 | cut -d'"' -f4)"
rp="$( { grep -o "\"pack_id\":\"[^\"]*\"" "$WORLD/world_resource_packs.json" || true; } | head -1 | cut -d'"' -f4)"
if [[ "$bp" == "$uuid_bp" && "$rp" == "$uuid_rp" ]]; then
  ok "$name"
else
  bad "$name" "behavior=$bp resource=$rp"
fi

name="права на паки читаемые (0644/0755)"
mode="$( { stat -c '%a' "$FAKE_ROOT/packs/behavior_packs/swipecraft_bp/scripts/main.js" || true; } )"
dirmode="$( { stat -c '%a' "$FAKE_ROOT/packs/behavior_packs/swipecraft_bp" || true; } )"
if [[ "$mode" == "644" && "$dirmode" == "755" ]]; then
  ok "$name"
else
  bad "$name" "файл $mode, каталог $dirmode"
fi

# ── 4b. healthcheck видит и уложенный пак, и отсутствующий ────────────────────
name="healthcheck подтверждает привязку паков"
hc_out="$(ROOT="$FAKE_ROOT" bash "$REPO/deploy/healthcheck.sh" 2>&1 || true)"
if printf '%s' "$hc_out" | grep -q "привязан к миру swipecraft"; then
  ok "$name"
else
  bad "$name" "$(printf '%s' "$hc_out" | grep -E 'пак|FAIL' | head -2 | tr '\n' ' ')"
fi

name="healthcheck ругается на неположенный пак"
EMPTY_ROOT="$TMP/empty"
mkdir -p "$EMPTY_ROOT/server/worlds/swipecraft"
printf 'level-name=swipecraft\nserver-port=19132\n' > "$EMPTY_ROOT/server/server.properties"
hc_out="$(ROOT="$EMPTY_ROOT" bash "$REPO/deploy/healthcheck.sh" 2>&1 || true)"
if printf '%s' "$hc_out" | grep -q "пака нет в"; then
  ok "$name"
else
  bad "$name" "вывод: $(printf '%s' "$hc_out" | tail -2 | tr '\n' ' ')"
fi

name="healthcheck не умирает молча на несуществующем ROOT"
if ROOT="$TMP/does-not-exist" bash "$REPO/deploy/healthcheck.sh" >"$TMP/hc.txt" 2>&1; then hc_rc=0; else hc_rc=$?; fi
hc_out="$(cat "$TMP/hc.txt")"
if printf '%s' "$hc_out" | grep -q "это не установка" && [[ "$hc_rc" -eq 1 ]]; then
  ok "$name"
else
  bad "$name" "exit=$hc_rc, вывод: $(printf '%s' "$hc_out" | tail -1)"
fi

# ── 5. повторный запуск идемпотентен ──────────────────────────────────────────
name="повторный запуск ничего не ломает"
out="$(run_packs || true)"
if [[ -s "$FAKE_ROOT/packs/behavior_packs/swipecraft_bp/scripts/main.js" && "$out" != *"[error]"* ]]; then
  ok "$name"
else
  bad "$name" "$(printf '%s' "$out" | tail -1)"
fi

# ── 6. не-существующий ROOT: внятный отказ, а не тихое mkdir ─────────────────
name="кривой ROOT — отказ с инструкцией"
out="$( (cd "$FAKE_REPO" && REPO_DIR="$FAKE_REPO" ROOT="$TMP/nope" bash "$PACKS" 2>&1) || true)"
if printf '%s' "$out" | grep -q "не нашёл установку" && [[ ! -d "$TMP/nope" ]]; then
  ok "$name"
else
  bad "$name" "either не отказал или создал $TMP/nope: $(printf '%s' "$out" | tail -1)"
fi

# ── 7. BDS_OWNER на несуществующего пользователя — объяснение, а не «invalid user» ──
name="BDS_OWNER с несуществующим пользователем"
out="$( (cd "$FAKE_REPO" && REPO_DIR="$FAKE_REPO" ROOT="$FAKE_ROOT" BDS_OWNER="ghost-user-42:ghost-user-42" bash "$PACKS" 2>&1) || true)"
if printf '%s' "$out" | grep -q "ghost-user-42" && printf '%s' "$out" | grep -q "пользователя"; then
  ok "$name"
else
  bad "$name" "$(printf '%s' "$out" | tail -1)"
fi

# ── 8. нет собранного main.js — подсказка про npm run build ──────────────────
name="без сборки — подсказка npm run build"
rm -f "$FAKE_REPO/packs/behavior_pack/scripts/main.js"
out="$(run_packs || true)"
if printf '%s' "$out" | grep -q "npm run build"; then
  ok "$name"
else
  bad "$name" "$(printf '%s' "$out" | tail -1)"
fi

# ── 9. restore/update/wipe не падают из-за отсутствующего bedrock ─────────────
name="restore/update/wipe используют общий резолв владельца"
missing=""
for f in restore.sh update-bds.sh season-wipe.sh; do
  grep -q 'lib/deploy-common.sh' "$REPO/deploy/$f" || missing="$missing $f"
done
if [[ -z "$missing" ]]; then
  ok "$name"
else
  bad "$name" "не подключили библиотеку:$missing"
fi

# ── 10. установщик укладывает всё, что потом source'ится с сервера ────────────
name="install-bds.sh укладывает lib и все скрипты"
missing=""
for f in "$REPO"/deploy/*.sh; do
  base="$(basename "$f")"
  # install-bds.sh и firewall.sh запускаются из репозитория, на сервере их не должно быть
  [[ "$base" == "install-bds.sh" || "$base" == "firewall.sh" ]] && continue
  grep -qF "\"$base\"" "$REPO/deploy/install-bds.sh" || missing="$missing $base"
done
for f in "$REPO"/deploy/lib/*; do
  [[ -e "$f" ]] || continue
  grep -qF "\"lib/$(basename "$f")\"" "$REPO/deploy/install-bds.sh" || missing="$missing lib/$(basename "$f")"
done
if [[ -z "$missing" ]]; then
  ok "$name"
else
  bad "$name" "на сервере не окажется:$missing"
fi

echo
echo "всего проверок: $((PASS + FAIL)), провалов: $FAIL"
if [[ $FAIL -gt 0 ]]; then
  printf 'провалено: %s\n' "${FAILED_NAMES[*]}"
  exit 1
fi
