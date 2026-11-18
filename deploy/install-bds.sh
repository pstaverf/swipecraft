#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${ROOT:-/srv/swipecraft}"
USER_NAME="${USER_NAME:-bedrock}"
BDS_VERSION="${BDS_VERSION:-1.26.60.6}"
BDS_URL="${BDS_URL:-https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-${BDS_VERSION}.zip}"
SSH_PORT="${SSH_PORT:-22}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

log() { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "запусти от root"
[[ "$(uname -m)" == "x86_64" ]] || die "BDS Linux требует x86_64, текущая архитектура: $(uname -m)"
[[ -f "$REPO_DIR/config/server.properties" ]] || die "не найден $REPO_DIR/config/server.properties"

export DEBIAN_FRONTEND=noninteractive
log "пакеты"
apt-get update -y
apt-get install -y --no-install-recommends \
  curl ca-certificates unzip tar rsync logrotate ufw nftables jq procps iproute2

if ! ldconfig -p | grep -q 'libcurl\.so\.4'; then
  apt-get install -y --no-install-recommends libcurl4t64 || apt-get install -y --no-install-recommends libcurl4
fi
if ! ldconfig -p | grep -q 'libssl\.so\.3'; then
  apt-get install -y --no-install-recommends libssl3t64 || apt-get install -y --no-install-recommends libssl3
fi

if ! id -u "$USER_NAME" >/dev/null 2>&1; then
  log "пользователь $USER_NAME"
  useradd --system --home-dir "$ROOT" --shell /usr/sbin/nologin "$USER_NAME"
fi

log "каталоги"
install -d -m 0755 -o "$USER_NAME" -g "$USER_NAME" "$ROOT"
install -d -m 0755 -o "$USER_NAME" -g "$USER_NAME" "$ROOT/server" "$ROOT/logs" "$ROOT/backups"
install -d -m 0755 -o "$USER_NAME" -g "$USER_NAME" "$ROOT/packs/behavior_packs" "$ROOT/packs/resource_packs"
install -d -m 0755 -o root -g root "$ROOT/deploy"

if [[ ! -x "$ROOT/server/bedrock_server" ]]; then
  log "загрузка BDS $BDS_VERSION"
  curl -fL --retry 3 --retry-delay 2 -o /tmp/bds.zip "$BDS_URL" || die "не удалось скачать $BDS_URL — проверь актуальный билд на https://www.minecraft.net/download/server/bedrock и передай BDS_VERSION"
  unzip -q -o /tmp/bds.zip -d "$ROOT/server"
  rm -f /tmp/bds.zip
  chown -R "$USER_NAME:$USER_NAME" "$ROOT/server"
else
  log "BDS уже установлен, бинарник не трогаю"
fi

if ldd "$ROOT/server/bedrock_server" | grep -q 'not found'; then
  ldd "$ROOT/server/bedrock_server" | grep 'not found' >&2
  die "не хватает библиотек для bedrock_server"
fi

log "конфигурация"
if [[ -f "$ROOT/server/server.properties" ]] && ! cmp -s "$ROOT/server/server.properties" "$REPO_DIR/config/server.properties"; then
  cp -a "$ROOT/server/server.properties" "$ROOT/server/server.properties.bak.$(date -u +%Y%m%dT%H%M%SZ)"
fi
install -m 0644 -o "$USER_NAME" -g "$USER_NAME" "$REPO_DIR/config/server.properties" "$ROOT/server/server.properties"

log "скрипты управления"
for f in run-bds.sh stop-bds.sh backup.sh restore.sh healthcheck.sh check-ports.sh deploy-packs.sh init-server.sh; do
  [[ -f "$REPO_DIR/deploy/$f" ]] || die "нет файла deploy/$f"
  install -m 0750 -o root -g "$USER_NAME" "$REPO_DIR/deploy/$f" "$ROOT/deploy/$f"
done

if [[ ! -e "$ROOT/server/behavior_packs" ]]; then
  ln -sfn "$ROOT/packs/behavior_packs" "$ROOT/server/behavior_packs"
fi
if [[ ! -e "$ROOT/server/resource_packs" ]]; then
  ln -sfn "$ROOT/packs/resource_packs" "$ROOT/server/resource_packs"
fi

log "sysctl"
install -m 0644 "$REPO_DIR/deploy/sysctl-nethernet.conf" /etc/sysctl.d/99-swipecraft.conf
sysctl --system >/dev/null

log "systemd"
install -m 0644 "$REPO_DIR/deploy/systemd/swipecraft.service" /etc/systemd/system/swipecraft.service
install -m 0644 "$REPO_DIR/deploy/systemd/swipecraft-backup.service" /etc/systemd/system/swipecraft-backup.service
install -m 0644 "$REPO_DIR/deploy/systemd/swipecraft-backup.timer" /etc/systemd/system/swipecraft-backup.timer
systemctl daemon-reload

log "logrotate"
sed "s#__ROOT__#$ROOT#g" "$REPO_DIR/deploy/logrotate-swipecraft" > /etc/logrotate.d/swipecraft
chmod 0644 /etc/logrotate.d/swipecraft
logrotate --debug /etc/logrotate.d/swipecraft >/dev/null

log "firewall"
SSH_PORT="$SSH_PORT" ROOT="$ROOT" bash "$REPO_DIR/deploy/firewall.sh"

log "автозапуск"
systemctl enable --now swipecraft.service
systemctl enable --now swipecraft-backup.timer

log "ожидание готовности"
ready=0
for _ in $(seq 1 60); do
  if grep -qE 'Server started\.' "$ROOT/logs/console.log" 2>/dev/null; then ready=1; break; fi
  sleep 2
done
if [[ $ready -eq 0 ]]; then
  systemctl status swipecraft.service --no-pager -l | tail -30
  die "сервер не поднялся за 120 секунд, смотри $ROOT/logs/console.log"
fi

log "инициализация идентичности и геймрулов"
ROOT="$ROOT" bash "$ROOT/deploy/init-server.sh"

log "проверка портов"
ROOT="$ROOT" bash "$ROOT/deploy/check-ports.sh" --local || warn "локальная проверка портов вернула ошибку"

TCP_PORT="$(grep -E '^server-port=' "$ROOT/server/server.properties" | cut -d= -f2)"
cat <<EOF

Готово. Установлено в $ROOT
  порт сигналинга (TCP): $TCP_PORT
  UDP-диапазон:          $(grep -E '^server-udp-ports=' "$ROOT/server/server.properties" | cut -d= -f2)
  лог:                   $ROOT/logs/console.log
  бэкапы:                $ROOT/backups (таймер swipecraft-backup.timer)
  управление:            systemctl {status|restart|stop} swipecraft

Дальше обязательно:
  1. Проверить снаружи: $ROOT/deploy/check-ports.sh --remote <ПУБЛИЧНЫЙ_IP>
  2. Сохранить копию каталога $ROOT/server/keys вне сервера (иначе игроки заново подтверждают доверие)
  3. Зайти с телефона: Play -> Servers -> Add Server -> <IP> / $TCP_PORT

EOF
