#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Общие мелочи скриптов деплоя: куда кладём, от чьего имени, что можно менять.
#
# Почему это в одном месте. Раньше каждый скрипт сам писал `chown -R
# bedrock:bedrock`, и это ломалось на любой установке, где BDS заведён не
# install-bds.sh (Amazon Linux, ручная распаковка, контейнер): `chown: invalid
# user: «bedrock:bedrock»`. Хуже всего было то, что вместе с `set -e`
# deploy-packs.sh умирал ПОСЕРЕДИНЕ: паки уже скопированы в $ROOT, а
# world_behavior_packs.json не записан — мир живёт со старыми паками, и по логу
# не понять, что деплой вообще не дошёл.
# ---------------------------------------------------------------------------

TAG="${TAG:-deploy}"
DRY_RUN="${DRY_RUN:-0}"

log() { printf '[%s] %s\n' "$TAG" "$*"; }
warn() { printf '[%s][warn] %s\n' "$TAG" "$*" >&2; }
die() { printf '[%s][error] %s\n' "$TAG" "$*" >&2; exit 1; }

# Не используется: только чтобы lint не спотыкался о комментарии выше.

# Выполнить команду (или показать, что бы выполнил, при DRY_RUN=1).
run() {
  printf '[%s]$ %s\n' "$TAG" "$*"
  [[ "$DRY_RUN" == "1" ]] && return 0
  "$@"
}

# Есть ли systemd-юнит службы (на ручной установке его может не быть).
has_service() {
  command -v systemctl >/dev/null 2>&1 || return 1
  if [[ -n "$(command -v systemctl)" ]]; then
    systemctl list-unit-files 2>/dev/null | grep -q '^swipecraft\.service' && return 0
  fi
  [[ -f /etc/systemd/system/swipecraft.service ]] || [[ -f /lib/systemd/system/swipecraft.service ]]
}

# Требовать службу там, где без неё скрипт бессмысленен (restore/update/wipe).
require_service() {
  has_service && return 0
  die "нет службы swipecraft.service — этот скрипт рассчитан на systemd-установку. Если запускаешь bedrock_server вручную (deploy/run-bds.sh), останови и запусти его сам, а этот скрипт пропусти"
}

# * Каталог установки. $ROOT если задан руками — верим; иначе пробуем найти
# * работающий bedrock_server (его рабочий каталог по юниту — $ROOT/server);
# * иначе объясняем, как указать путь. Делается ДО любых записей: молча
# * создать /srv/swipecraft на машине, где сервер живёт в ~/bds, — значит
# * «успешно задеплоить» паки в несуществующий мир.
resolve_root() {
  local guess=""
  if [[ -f "${ROOT:-}/server/server.properties" ]]; then
    printf '%s' "$ROOT"
    return 0
  fi
  if command -v pgrep >/dev/null 2>&1; then
    local pid
    pid="$(pgrep -f '[b]edrock_server' | head -1 || true)"
    if [[ -n "$pid" && -r "/proc/$pid/cwd" ]]; then
      local cwd
      cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
      [[ -n "$cwd" ]] && guess="$(dirname "$cwd")"
    fi
  fi
  if [[ -z "$guess" && -f "$HOME/swipecraft/server/server.properties" ]]; then
    guess="$HOME/swipecraft"
  fi
  if [[ -n "$guess" && -f "$guess/server/server.properties" ]]; then
    if [[ -n "${ROOT:-}" && "$ROOT" != "$guess" ]]; then
      warn "ROOT=$ROOT не похож на установку (нет $ROOT/server/server.properties), беру каталог запущенного bedrock_server: $guess"
    fi
    printf '%s' "$guess"
    return 0
  fi
  die "не нашёл установку сервера: ни в ROOT=$ROOT, ни у запущенного bedrock_server нет server/server.properties. Укажи явно: ROOT=/путь/до/установки $0 (посмотри, где лежит bedrock_server: pgrep -af bedrock_server)"
}

# Владелец файлов сервера — «кому chownить», если мы вообще можем chownить.
resolve_owner() {
  local owner=""
  if [[ -n "${BDS_OWNER:-}" ]]; then
    local user="${BDS_OWNER%%:*}"
    if ! id -u "$user" >/dev/null 2>&1; then
      die "BDS_OWNER=$BDS_OWNER: пользователя '$user' нет в системе. Посмотри фактического владельца: stat -c '%U' '${ROOT:-.}/server' — либо заведи пользователя: useradd --system --home-dir '${ROOT:-/srv/swipecraft}' --shell /usr/sbin/nologin $user"
    fi
    printf '%s' "$BDS_OWNER"
    return 0
  fi
  local probe=""
  for probe in "${ROOT:-}/server/bedrock_server" "${ROOT:-}/server" "${ROOT:-}"; do
    [[ -e "$probe" ]] || continue
    owner="$(stat -c '%U:%G' "$probe" 2>/dev/null || true)"
    [[ -n "$owner" ]] && break
  done
  if [[ -z "$owner" ]]; then
    local fallback="${SUDO_USER:-$(id -un)}"
    owner="$fallback:$(id -gn "$fallback" 2>/dev/null || echo "$fallback")"
    warn "не смог вычислить владельца установки, беру $owner (переопредели явно: BDS_OWNER=user:group)"
  fi
  local user="${owner%%:*}"
  if ! id -u "$user" >/dev/null 2>&1; then
    die "владелец '$user' из stat не найден в passwd (удалённый пользователь?). Передай BDS_OWNER=user:group"
  fi
  printf '%s' "$owner"
}

# * chown, который не роняет деплой. Не root — пропускаем и говорим, что сделать
# * руками; chown упал — предупреждаем, но копирование уже состоялось, и
# * обрывать его из-за прав владения значит оставить мир с половиной деплоя.
chown_or_warn() {
  local target="$1"; shift
  [[ "$EUID" -eq 0 ]] || { warn "я не root — права на $target не меняю; если сервер работает от другого пользователя: chown -R $OWNER $target"; return 0; }
  if ! run chown -R "$OWNER" "$target"; then
    warn "chown -R $OWNER $target не удался — права остались как были, серверу должно хватить 0644/0755"
  fi
}

# * Файл из манифеста пака: python3 → jq → node → запасной sed-разбор.
# * Раньше требовался только python3; на минимальных образах его нет, и деплой
# * падал уже ПОСЛЕ копирования паков.
manifest_field() {
  local file="$1" field="$2"
  [[ -f "$file" ]] || die "нет $file"
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "import json,sys;m=json.load(open(sys.argv[1]));print(m['header'][sys.argv[2]])" "$file" "$field"
    return $?
  fi
  if command -v jq >/dev/null 2>&1; then
    jq -r ".header.$field | if type==\"array\" then join(\",\") else tostring end" "$file"
    return $?
  fi
  if command -v node >/dev/null 2>&1; then
    node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const v=m.header[process.argv[2]];console.log(Array.isArray(v)?v.join(","):String(v));' "$file" "$field"
    return $?
  fi
  # последний вариант — вынуть одно поле из «header» без JSON-парсера: только для
  # uuid/version, которые у нас всегда записаны в одну строку
  local value
  value="$(sed -n '/"header"[[:space:]]*:/,/[[:space:]]*}/p' "$file" | tr -d '[:space:]' | sed -n "s/.*\"$field\":\[\\?\([^],\"]*\\)\].*/\1/p" | head -1)"
  [[ -n "$value" ]] || die "не смог прочитать '$field' из $file — нет python3, jq или node"
  printf '%s\n' "$value"
}

# * Проверка, что файл не просто лежит на диске, а читается тем, кто его будет
# * открывать: UMask 0027 у systemd-службы и файлы, созданные root, дают ровно
# * ту картину, когда сервер «молча не видит» новый пак.
readable_by() {
  local user="$1" file="$2"
  [[ "$EUID" -eq 0 ]] || return 0
  [[ "$DRY_RUN" == "1" ]] && return 0
  [[ "$user" == "root" ]] && return 0
  command -v su >/dev/null 2>&1 || return 0
  su -s /bin/sh "$user" -c "test -r '$file'" 2>/dev/null
}
