#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${ROOT:-/srv/swipecraft}"
PROPS="$ROOT/server/server.properties"
LOG="$ROOT/logs/console.log"
QUIET=0

[[ "${1:-}" == "--quiet" ]] && QUIET=1

PASS=0
FAIL=0
OUT=""

ok() { PASS=$((PASS + 1)); [[ $QUIET -eq 1 ]] || OUT+="$(printf '  PASS  %s\n' "$*")"$'\n'; }
bad() { FAIL=$((FAIL + 1)); OUT+="$(printf '  FAIL  %s\n' "$*")"$'\n'; }

TCP_PORT="$(grep -E '^server-port=' "$PROPS" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '[:space:]')"

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

conns="$(ss -ntH state established "( sport = :$TCP_PORT )" 2>/dev/null | wc -l)"
ok "активных TCP-сессий сигналинга: $conns"

udp_conns="$(ss -nuH 2>/dev/null | wc -l)"
ok "UDP-сокетов в системе: $udp_conns"

if [[ -f "$LOG" ]]; then
  age=$(( $(date +%s) - $(stat -c %Y "$LOG") ))
  if (( age < 3600 )); then ok "лог обновлялся $age сек назад"; else bad "лог не обновлялся $age сек"; fi
  errors="$(tail -n 2000 "$LOG" | grep -ciE '\[error\]|crash|assert' || true)"
  (( errors == 0 )) && ok "в последних 2000 строках лога нет ошибок" || bad "в логе найдено $errors строк с ошибками"
else
  bad "лог $LOG отсутствует"
fi

disk_use="$(df --output=pcent "$ROOT" | tail -1 | tr -dc '0-9')"
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

printf '%s' "$OUT"
echo "итог: PASS=$PASS FAIL=$FAIL"
[[ $FAIL -eq 0 ]] || exit 1
