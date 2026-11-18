#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${ROOT:-/srv/swipecraft}"
FIFO="${CONSOLE_FIFO:-/run/swipecraft/console.fifo}"
LOG="$ROOT/logs/console.log"

send() {
  [[ -p "$FIFO" ]] || return 1
  printf '%s\n' "$1" > "$FIFO"
  sleep 1
}

for _ in $(seq 1 60); do
  grep -qE 'Server started\.' "$LOG" 2>/dev/null && break
  sleep 2
done

grep -qE 'Server started\.' "$LOG" 2>/dev/null || {
  echo "[init] сервер не запущен, инициализация отменена" >&2
  exit 1
}

send "serveridentity save"

send "gamerule keepinventory false"
send "gamerule pvp true"
send "gamerule showcoordinates true"
send "gamerule naturalregeneration true"
send "gamerule mobgriefing true"
send "gamerule tntexplodes true"
send "gamerule dodaylightcycle true"
send "gamerule doweathercycle true"
send "gamerule dofiretick true"
send "gamerule doentitydrops true"
send "gamerule drowningdamage true"
send "gamerule falldamage true"
send "gamerule firedamage true"
send "gamerule showdeathmessages true"
send "gamerule sendcommandfeedback false"
send "gamerule commandblockoutput false"
send "gamerule maxcommandchainlength 10000"
send "gamerule randomtickspeed 1"

if [[ -d "$ROOT/server/keys" ]] && compgen -G "$ROOT/server/keys/*" >/dev/null; then
  echo "[init] идентичность сервера сохранена в $ROOT/server/keys"
else
  echo "[init] ВНИМАНИЕ: каталог keys пуст, игроки будут подтверждать доверие после каждого рестарта" >&2
fi
