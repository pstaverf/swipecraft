#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${ROOT:-/srv/swipecraft}"
PROPS="$ROOT/server/server.properties"
MODE="local"
HOST=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) MODE="local"; shift ;;
    --remote) MODE="remote"; HOST="${2:-}"; shift 2 ;;
    -h|--help)
      printf 'usage: %s [--local] [--remote HOST]\n' "$0"
      exit 0 ;;
    *) printf 'неизвестный аргумент: %s\n' "$1" >&2; exit 2 ;;
  esac
done

PASS=0
FAIL=0
UNKNOWN=0

ok() { printf '  \033[1;32mPASS\033[0m  %s\n' "$*"; PASS=$((PASS + 1)); }
bad() { printf '  \033[1;31mFAIL\033[0m  %s\n' "$*"; FAIL=$((FAIL + 1)); }
unk() { printf '  \033[1;33m?  \033[0m   %s\n' "$*"; UNKNOWN=$((UNKNOWN + 1)); }

[[ -f "$PROPS" ]] || { echo "нет $PROPS" >&2; exit 2; }

TCP_PORT="$(grep -E '^server-port=' "$PROPS" | head -1 | cut -d= -f2 | tr -d '[:space:]')"
UDP_SPEC="$(grep -E '^server-udp-ports=' "$PROPS" | head -1 | cut -d= -f2- | tr -d '[:space:]')"
TRANSPORT="$(grep -E '^transport=' "$PROPS" | head -1 | cut -d= -f2 | tr -d '[:space:]')"

udp_public="$UDP_SPEC"
if [[ "$udp_public" == \[*\]* ]]; then
  udp_public="$(printf '%s' "$udp_public" | sed -E 's/^\[[^]]*\]:([0-9-]+):([0-9-]+)$/\1/')"
elif [[ "$udp_public" == *:*:* ]]; then
  udp_public="$(printf '%s' "$udp_public" | awk -F: '{print $(NF-1)}')"
elif [[ "$udp_public" == *:* ]]; then
  udp_public="${udp_public%%:*}"
fi

if [[ "$udp_public" =~ ^([0-9]+)-([0-9]+)$ ]]; then
  UDP_LOW="${BASH_REMATCH[1]}"; UDP_HIGH="${BASH_REMATCH[2]}"
else
  UDP_LOW="$udp_public"; UDP_HIGH="$udp_public"
fi

echo "конфигурация: transport=$TRANSPORT tcp=$TCP_PORT udp=$UDP_LOW-$UDP_HIGH"

if [[ "$MODE" == "local" ]]; then
  echo "режим: локальный"

  tcp_listen="$(ss -lntH "sport = :$TCP_PORT" 2>/dev/null | wc -l)"
  (( tcp_listen > 0 )) && ok "TCP-сигналинг слушает порт $TCP_PORT" || bad "нет слушателя на TCP $TCP_PORT"

  udp_listen="$(ss -lnuH "sport >= :$UDP_LOW and sport <= :$UDP_HIGH" 2>/dev/null | wc -l)"
  if (( udp_listen > 0 )); then
    ok "UDP-сокеты в диапазоне: $udp_listen (нужно минимум 1, по одному на активного игрока)"
  else
    bad "нет UDP-сокетов в диапазоне $UDP_LOW-$UDP_HIGH"
  fi

  if curl -fsS --max-time 5 "http://127.0.0.1:$TCP_PORT/v1/join" >/dev/null 2>&1; then
    ok "HTTP /v1/join отвечает локально"
  else
    bad "HTTP /v1/join не отвечает на 127.0.0.1:$TCP_PORT"
  fi

  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
    ufw status 2>/dev/null | grep -qE "^$TCP_PORT/tcp" && ok "ufw разрешает TCP $TCP_PORT" || bad "ufw не разрешает TCP $TCP_PORT"
    if [[ "$UDP_LOW" == "$UDP_HIGH" ]]; then
      ufw status 2>/dev/null | grep -qE "^$UDP_LOW/udp" && ok "ufw разрешает UDP $UDP_LOW" || bad "ufw не разрешает UDP $UDP_LOW"
    else
      ufw status 2>/dev/null | grep -qE "^$UDP_LOW:$UDP_HIGH/udp" && ok "ufw разрешает UDP $UDP_LOW:$UDP_HIGH" || bad "ufw не разрешает UDP $UDP_LOW:$UDP_HIGH"
    fi
  elif command -v nft >/dev/null 2>&1 && nft list table inet swipecraft >/dev/null 2>&1; then
    nft list table inet swipecraft | grep -q "tcp dport $TCP_PORT" && ok "nftables разрешает TCP $TCP_PORT" || bad "nftables не разрешает TCP $TCP_PORT"
    ok "правила nftables содержат UDP-диапазон, проверь глазами: nft list table inet swipecraft"
  else
    unk "активный firewall не обнаружен (ufw/nftables) — проверь правила провайдера"
  fi

  public_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)"
  [[ -n "$public_ip" ]] && unk "внешний адрес локально виден как $public_ip, но за NAT он может отличаться — запусти с другого хоста: $0 --remote <IP>"

  echo
  echo "локально: PASS=$PASS FAIL=$FAIL UNKNOWN=$UNKNOWN"
  [[ $FAIL -eq 0 ]] || exit 1
  exit 0
fi

echo "режим: внешний, цель $HOST"
[[ -n "$HOST" ]] || { echo "укажи адрес: --remote <IP или домен>" >&2; exit 2; }

if timeout 5 bash -c "exec 3<>/dev/tcp/$HOST/$TCP_PORT" 2>/dev/null; then
  ok "TCP $HOST:$TCP_PORT принимает соединения"
else
  bad "TCP $HOST:$TCP_PORT недоступен снаружи (firewall, NAT или сервер не запущен)"
fi

join_body="$(curl -fsS --max-time 8 "http://$HOST:$TCP_PORT/v1/join" 2>/dev/null || true)"
if [[ -n "$join_body" ]]; then
  ok "NetherNet-сигналинг отвечает: $(printf '%s' "$join_body" | head -c 160)"
else
  bad "NetherNet-сигналинг не ответил по http://$HOST:$TCP_PORT/v1/join"
fi

if command -v nmap >/dev/null 2>&1; then
  scan_ports="$UDP_LOW"
  if [[ "$UDP_LOW" != "$UDP_HIGH" ]]; then
    mid=$((UDP_LOW + (UDP_HIGH - UDP_LOW) / 2))
    scan_ports="$UDP_LOW-$((UDP_LOW + 4)),$mid-$((mid + 4)),$((UDP_HIGH - 4))-$UDP_HIGH"
  fi
  nmap_out="$(nmap -sU -Pn -T4 --max-retries 1 --max-rtt-timeout 400ms --host-timeout 90s -p "$scan_ports" "$HOST" 2>/dev/null || true)"
  if printf '%s' "$nmap_out" | grep -qE 'open\|filtered|open '; then
    unk "UDP-порты отвечают как open|filtered — это норма для NetherNet, достоверно подтверждается только входом игрока"
  else
    unk "UDP-проба не дала однозначного результата"
  fi
else
  unk "nmap не установлен, UDP снаружи не проверяю (apt-get install -y nmap)"
fi

echo
echo "точный тест UDP: зайди с телефона на $HOST:$TCP_PORT и проверь строку входа в $ROOT/logs/console.log"
echo "ожидаемая строка: Player connected ... или запись с портом из диапазона $UDP_LOW-$UDP_HIGH"
echo
echo "итог: PASS=$PASS FAIL=$FAIL UNKNOWN=$UNKNOWN"
[[ $FAIL -eq 0 ]] || exit 1
