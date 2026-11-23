#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/deploy-common.sh
. "$SCRIPT_DIR/lib/deploy-common.sh"
TAG="health"

ROOT="${ROOT:-/srv/swipecraft}"
# установка может лежать не в /srv (ручная установка, контейнер): берём каталог
# запущенного bedrock_server, если он есть. Молча проверять несуществующий путь —
# значит показывать «FAIL» там, где просто неверно указан ROOT
if [[ ! -f "$ROOT/server/server.properties" ]]; then
  pid_hc="$(pgrep -f '[b]edrock_server' 2>/dev/null | head -1 || true)"
  if [[ -n "$pid_hc" ]]; then
    guess="$(dirname "$(readlink "/proc/$pid_hc/cwd" 2>/dev/null || echo '')")"
    [[ -f "$guess/server/server.properties" ]] && ROOT="$guess"
  fi
fi
PROPS="$ROOT/server/server.properties"
LOG="$ROOT/logs/console.log"
QUIET=0
# Диагностика, которая умерла на первом же отсутствующем файле, бесполезна: ниже каждая внешняя
# команда обёрнута так, чтобы отсутствие файла не роняло скрипт, а попадало в FAIL
hard_stop() {
  printf '%s' "$OUT"
  echo "итог: PASS=$PASS FAIL=$FAIL"
  exit 1
}

[[ "${1:-}" == "--quiet" ]] && QUIET=1

PASS=0
FAIL=0
OUT=""

ok() { PASS=$((PASS + 1)); [[ $QUIET -eq 1 ]] || OUT+="$(printf '  PASS  %s\n' "$*")"$'\n'; }
bad() { FAIL=$((FAIL + 1)); OUT+="$(printf '  FAIL  %s\n' "$*")"$'\n'; }

if [[ ! -f "$PROPS" ]]; then
  bad "нет $PROPS: это не установка (или ROOT указан неверно). Запусти так: ROOT=/путь/до/установки $0; где лежит сервер — подскажет pgrep -af bedrock_server"
  hard_stop
fi

TCP_PORT="$( { grep -E '^server-port=' "$PROPS" || true; } 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')"

if systemctl is-active --quiet swipecraft.service; then ok "служба swipecraft активна"; else bad "служба swipecraft не активна"; fi

pid="$(systemctl show -p MainPID --value swipecraft.service 2>/dev/null || echo 0)"
if [[ "$pid" != "0" ]] && [[ -d "/proc/$pid" ]]; then
  rss_mb=$(( $(awk '/VmRSS/{print $2}' "/proc/$pid/status" 2>/dev/null || echo 0) / 1024 ))
  etime="$(ps -o etime= -p "$pid" | tr -d ' ')"
  ok "процесс pid=$pid, RSS=${rss_mb}MB, uptime=$etime"
  (( rss_mb < 6144 )) || bad "RSS ${rss_mb}MB близко к MemoryMax=7G"
else
  bad "процесс bedrock_server не найден"
fi

if curl -fsS --max-time 5 "http://127.0.0.1:${TCP_PORT}/v1/join" >/dev/null 2>&1; then
  ok "NetherNet-сигналинг отвечает локально"
else
  bad "NetherNet-сигналинг не отвечает на 127.0.0.1:${TCP_PORT}"
fi

conns="$( { ss -ntH state established "( sport = :$TCP_PORT )" || true; } 2>/dev/null | wc -l)"
ok "активных TCP-сессий сигналинга: $conns"

udp_conns="$( { ss -nuH || true; } 2>/dev/null | wc -l)"
ok "UDP-сокетов в системе: $udp_conns"

if [[ -f "$LOG" ]]; then
  age=$(( $(date +%s) - $(stat -c %Y "$LOG" 2>/dev/null || echo 0) ))
  if (( age < 3600 )); then ok "лог обновлялся $age сек назад"; else bad "лог не обновлялся $age сек"; fi
  errors="$( { tail -n 2000 "$LOG" || true; } | grep -ciE '\[error\]|crash|assert' || true)"
  (( errors == 0 )) && ok "в последних 2000 строках лога нет ошибок" || bad "в логе найдено $errors строк с ошибками"
else
  bad "лог $LOG отсутствует"
fi

disk_use="$( { df --output=pcent "$ROOT" || true; } | tail -1 | tr -dc '0-9')"
(( disk_use < 85 )) && ok "диск занят на ${disk_use}%" || bad "диск занят на ${disk_use}%"

cores="$(nproc)"
load1="$(cut -d' ' -f1 /proc/loadavg)"
awk -v l="$load1" -v c="$cores" 'BEGIN{exit !(l < c * 1.2)}' \
  && ok "load1=$load1 при ${cores} vCPU" \
  || bad "load1=$load1 при ${cores} vCPU — сервер перегружен"

latest_backup="$(ls -1t "$ROOT"/backups/daily/swipecraft-*.tar.gz 2>/dev/null | head -1 || true)"
if [[ -n "$latest_backup" ]]; then
  bage=$(( ( $(date +%s) - $(stat -c %Y "$latest_backup") ) / 3600 ))
  (( bage < 36 )) && ok "свежий бэкап: $(basename "$latest_backup"), ${bage}ч назад" || bad "последний бэкап старше 36 часов"
else
  bad "бэкапов не найдено"
fi

# ── паки: уложены и привязаны к миру ─────────────────────────────────────────
# Именно этот узел «деплой прошёл, а сервер старое» остаётся невидимым для лога BDS:
# мир стартует с тем, что было в world_behavior_packs.json, и молча.
BP_DIR="$ROOT/packs/behavior_packs/swipecraft_bp"
LEVEL_NAME="$( { grep -E '^level-name=' "$PROPS" || true; } 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]')"
WORLD_DIR="$ROOT/server/worlds/$LEVEL_NAME"
if [[ ! -f "$BP_DIR/manifest.json" ]]; then
  bad "пака нет в $BP_DIR — выполни deploy/deploy-packs.sh"
elif [[ -f "$WORLD_DIR/world_behavior_packs.json" ]]; then
  pack_uuid="$(manifest_field "$BP_DIR/manifest.json" uuid 2>/dev/null || true)"
  if [[ -z "$pack_uuid" ]]; then
    ok "пак уложен (uuid не прочитал: нет python3/jq/node — сверку пропускаю)"
  elif grep -q "$pack_uuid" "$WORLD_DIR/world_behavior_packs.json"; then
    ok "пак $pack_uuid привязан к миру $LEVEL_NAME"
  else
    bad "мир $LEVEL_NAME не знает про пак $pack_uuid — выполни deploy/deploy-packs.sh"
  fi
else
  bad "нет $WORLD_DIR/world_behavior_packs.json: паки лежат на диске, но в мир не подключены"
fi

# владелец файлов против пользователя сервиса: «sudo bash deploy.sh» оставляет root-файлы,
# а служба с UMask 0027 и User=other их не читает
if [[ -d "$ROOT/packs" ]]; then
  files_owner="$(stat -c '%U' "$ROOT/packs" 2>/dev/null || echo '?')"
  service_user="$(systemctl show -p User --value swipecraft.service 2>/dev/null || true)"
  if [[ -z "$service_user" || "$service_user" == "$files_owner" ]]; then
    ok "файлы паков принадлежат $files_owner (службы с другим пользователем нет или совпадает)"
  else
    bad "файлы в $ROOT/packs принадлежат $files_owner, а служба работает от $service_user — проверь права (0644/0755) или chown -R $service_user $ROOT/packs"
  fi
fi

printf '%s' "$OUT"
echo "итог: PASS=$PASS FAIL=$FAIL"
[[ $FAIL -eq 0 ]] || exit 1
