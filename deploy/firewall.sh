#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${ROOT:-/srv/swipecraft}"
PROPS="$ROOT/server/server.properties"
SSH_PORT="${SSH_PORT:-22}"
ENGINE="${ENGINE:-auto}"
DRY_RUN="${DRY_RUN:-0}"

log() { printf '[firewall] %s\n' "$*"; }
die() { printf '[firewall][error] %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 || "$DRY_RUN" == "1" ]] || die "запусти от root"
[[ -f "$PROPS" ]] || die "нет $PROPS"

TCP_PORT="$(grep -E '^server-port=' "$PROPS" | head -1 | cut -d= -f2 | tr -d '[:space:]')"
UDP_SPEC="$(grep -E '^server-udp-ports=' "$PROPS" | head -1 | cut -d= -f2- | tr -d '[:space:]')"
TRANSPORT="$(grep -E '^transport=' "$PROPS" | head -1 | cut -d= -f2 | tr -d '[:space:]')"

[[ -n "$TCP_PORT" ]] || die "не смог прочитать server-port"
[[ -n "$UDP_SPEC" ]] || die "не смог прочитать server-udp-ports"
[[ "$TRANSPORT" == "nethernet" ]] || log "ВНИМАНИЕ: transport=$TRANSPORT, порты открываю как для nethernet"

public_spec="$UDP_SPEC"
if [[ "$public_spec" == \[*\]* ]]; then
  public_spec="$(printf '%s' "$public_spec" | sed -E 's/^\[[^]]*\]:([0-9-]+):([0-9-]+)$/\1/')"
elif [[ "$public_spec" == *:*:* ]]; then
  public_spec="$(printf '%s' "$public_spec" | awk -F: '{print $(NF-1)}')"
elif [[ "$public_spec" == *:* ]]; then
  public_spec="${public_spec%%:*}"
fi

if [[ "$public_spec" =~ ^([0-9]+)-([0-9]+)$ ]]; then
  UDP_LOW="${BASH_REMATCH[1]}"
  UDP_HIGH="${BASH_REMATCH[2]}"
  UFW_UDP="$UDP_LOW:$UDP_HIGH/udp"
else
  UDP_LOW="$public_spec"
  UDP_HIGH="$public_spec"
  UFW_UDP="$public_spec/udp"
fi

(( UDP_LOW >= 1 && UDP_HIGH <= 65535 && UDP_LOW <= UDP_HIGH )) || die "некорректный UDP-диапазон: $UDP_SPEC"

log "TCP-сигналинг: $TCP_PORT/tcp, UDP-игровой: $UDP_LOW-$UDP_HIGH/udp, SSH: $SSH_PORT/tcp"

if [[ "$ENGINE" == "auto" ]]; then
  if command -v ufw >/dev/null 2>&1; then ENGINE="ufw"; else ENGINE="nft"; fi
fi

if [[ "$DRY_RUN" == "1" ]]; then
  log "DRY_RUN: правила, которые были бы применены"
  printf 'ufw allow %s/tcp # nethernet-signaling\nufw allow %s # nethernet-gameplay\nufw allow %s/tcp # ssh\n' "$TCP_PORT" "$UFW_UDP" "$SSH_PORT"
  log "проверка конфигурации пройдена"
  exit 0
fi

if [[ "$ENGINE" == "ufw" ]]; then
  ufw --force reset >/dev/null
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow "$SSH_PORT/tcp" comment 'ssh' >/dev/null
  ufw allow "$TCP_PORT/tcp" comment 'nethernet-signaling' >/dev/null
  ufw allow "$UFW_UDP" comment 'nethernet-gameplay' >/dev/null
  ufw --force enable >/dev/null
  log "ufw применён"
  ufw status numbered
else
  nft -f - <<EOF
table inet swipecraft {
  chain input {
    type filter hook input priority filter; policy drop;
    iif lo accept
    ct state established,related accept
    ip protocol icmp accept
    ip6 nexthdr icmpv6 accept
    tcp dport $SSH_PORT accept
    tcp dport $TCP_PORT accept
    udp dport $UDP_LOW-$UDP_HIGH accept
  }
  chain forward {
    type filter hook forward priority filter; policy drop;
  }
  chain output {
    type filter hook output priority filter; policy accept;
  }
}
EOF
  log "nftables применён"
  nft list table inet swipecraft
fi

log "слушающие сокеты"
ss -lntu | grep -E ":(${TCP_PORT}|${UDP_LOW})$|:(${UDP_LOW}-${UDP_HIGH})" || true
