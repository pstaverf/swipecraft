# Установка и эксплуатация Swipecraft (Ubuntu 22.04/24.04, BDS 1.26.60, NetherNet)

## 1. Требования

- Ubuntu 22.04 LTS или 24.04 LTS, x86_64, root/sudo.
- 4 vCPU, 8 ГБ RAM, 80+ ГБ NVMe (под 50–70 онлайн; см. `docs/HOSTING.md`).
- Открываемые порты: **TCP 19132** (сигналинг) и **UDP 19132–19250** (игровые сессии, по порту на игрока).
- Репозиторий с проектом на сервере (git clone или rsync).

## 2. Быстрый старт

```bash
apt-get update && apt-get install -y git
git clone https://github.com/pstaverf/swipecraft.git /opt/swipecraft-src
cd /opt/swipecraft-src

BDS_VERSION=1.26.60.6 bash deploy/install-bds.sh
```

Версию брать с официальной страницы загрузки (`https://www.minecraft.net/download/server/bedrock`): имя архива — `bedrock-server-<версия>.zip`. Если билд другой, установщик упадёт на скачивании с понятным сообщением, ничего не сломав.

Установщик делает по порядку:

1. Ставит пакеты (`curl`, `unzip`, `ufw`/`nftables`, `logrotate`, библиотеки `libcurl`, `libssl`).
2. Создаёт системного пользователя `bedrock` и каталоги `/srv/swipecraft/{server,logs,backups,packs,keys,deploy}`.
3. Скачивает и распаковывает BDS, проверяет зависимости через `ldd`.
4. Кладёт `config/server.properties` (с бэкапом старого).
5. Копирует скрипты управления, линкует `packs/` в рабочий каталог сервера.
6. Применяет `sysctl` (`deploy/sysctl-nethernet.conf`).
7. Ставит systemd-юниты и таймер бэкапа, `logrotate`.
8. Открывает порты (ufw; альтернатива — `deploy/nftables-swipecraft.nft`).
9. Запускает сервер, ждёт `Server started.`, выполняет `serveridentity save` и выставляет геймрулы.
10. Прогоняет локальную проверку портов.

## 2b. Если ставишь не установщиком (Amazon Linux, контейнер, ручная распаковка)

`deploy/install-bds.sh` — под Ubuntu: он ставит пакеты через `apt-get`, создаёт
пользователя `bedrock` и systemd-юнит. На Amazon Linux/AMI (или когда BDS распакован
руками в домашний каталог) ничего из этого не работает, и раньше это выглядело так:

```
$ sudo bash deploy/deploy-packs.sh
chown: invalid user: ‘bedrock:bedrock’
```

Скрипт умирал **посередине**: паки уже скопированы в `$ROOT/packs`, а
`world_behavior_packs.json` не записан — мир продолжает жить со старыми паками, и в логе
BDS по этому поводу тишина. Сейчас так не делает: владелец берётся из самой установки,
`chown` не роняет деплой, а в конце скрипт сам читает то, что записал.

Что нужно знать:

- **Где лежит установка.** Скрипты ищут каталог по `server/server.properties`: сначала
  `$ROOT` (по умолчанию `/srv/swipecraft`), потом рабочий каталог запущенного
  `bedrock_server`. Если не нашли — падают с объяснением, **ничего не создавая**. Указать
  явно: `ROOT=/home/ec2-user/bds sudo -E bash deploy/deploy-packs.sh`.
- **`sudo -E` обязательно для переменных.** Обычный `sudo` выбрасывает `ROOT`,
  `BDS_OWNER` и `DRY_RUN` из окружения (или настрой `env_keep`), и тогда скрипт работает с
  дефолтами. Проверить, что переменная дожила: `sudo -E env | grep ROOT`.
- **Владелец файлов.** По умолчанию — тот, кому реально принадлежит `$ROOT/server` (его
  читает `stat`). Переопределить: `BDS_OWNER=ec2-user:ec2-user`. Если скрипт запущен не от
  root, `chown` просто пропускается с подсказкой — копирование и привязка к миру при этом
  выполняются.
- **Службы может не быть.** `RESTART=1` перезапускает `swipecraft.service` только если
  юнит установлен; иначе печатает, как перезапустить вручную. `restore.sh`,
  `update-bds.sh` и `season-wipe.sh` без systemd не работают по замыслу (остановка/запуск
  должны быть атомарными) и говорят об этом прямо, а не падают на `systemctl`.
- **Системд-юнит под другую установку.** В `deploy/systemd/swipecraft.service` Пути
  зашиты в `/srv/swipecraft`, стоят `User=bedrock` и `ProtectHome=yes`. Для установки в
  домашний каталог `ProtectHome=yes` нужно убрать (иначе сервис просто не увидит `/home/…`),
  а `User=`/`Group=` — заменить на своего пользователя либо удалить обе строки (тогда юнит
  наследует пользователя запускатора).
- **Превью без записи.** `DRY_RUN=1 bash deploy/deploy-packs.sh` показывает команды и
  ничего не трогает на диске — удобно на чужой машине перед боевым прогоном.
- **Сверка после деплоя.** `bash deploy/healthcheck.sh` теперь проверяет не только процессы:
  уложен ли пак, привязан ли его uuid к миру и не остались ли файлы в руках у пользователя,
  от которого служба не работает.

Сборка на сервере обязательна: `packs/behavior_pack/scripts/main.js` — артефакт, в git он
не лежит. `npm ci && npm run build` перед укладкой. Предупреждение npm про заблокированный
postinstall у `esbuild` на результат не влияет (платформенный бинарник `@esbuild/linux-x64`
ставится обычным пакетом); если `npm run build` всё же упадёт — `npm install-scripts approve
esbuild && npm rebuild esbuild`.

### BDS ещё не распакован: установка вручную (Amazon Linux 2023, контейнер)

`install-bds.sh` умеет только Ubuntu (`apt-get`, `useradd`, systemd). На остальном — то же
самое руками. Пока `pgrep -af bedrock_server` пуст, а `server/server.properties` нет,
деплоить некуда — и скрипты правильно останавливаются на preflight, ничего не создавая.

```bash
SRC=$HOME/swipecraft        # копия репозитория (в ней же и собираем)
export ROOT=$HOME/bds       # каталог установки — его передаём всем скриптам

# 0. сборки BDS требуют glibc 2.34+: на Amazon Linux 2 (glibc 2.26) не запустится,
#    на AL2023 — да. Проверить: ldd --version | head -1
sudo dnf install -y curl unzip tar rsync procps-ng iproute logrotate libcurl nftables

# 1. каталоги, которые ждут скрипты: ROOT/{server,logs,packs,backups,keys}
mkdir -p "$ROOT"/{server,logs,packs,backups,keys}
cd /tmp && curl -fLO https://www.minecraft.net/bedrockdedicatedserver/bin-linux/bedrock-server-1.26.60.6.zip
unzip -o bedrock-server-1.26.60.6.zip -d "$ROOT/server" && rm bedrock-server-1.26.60.6.zip
ldd "$ROOT/server/bedrock_server" | grep 'not found'   # пусто = библиотек хватает

# 2. конфиг и линки: BDS видит паки только в server/behavior_packs
cp "$SRC/config/server.properties" "$ROOT/server/server.properties"
ln -sfn "$ROOT/packs/behavior_packs" "$ROOT/server/behavior_packs"
ln -sfn "$ROOT/packs/resource_packs" "$ROOT/server/resource_packs"

# 3. паки: собирать и укладывать из копии репозитория, не из $ROOT/deploy
cd "$SRC" && npm ci && npm run build
DRY_RUN=1 bash "$SRC/deploy/deploy-packs.sh"   # посмотрит на ROOT, ничего не тронет
bash "$SRC/deploy/deploy-packs.sh"             # мир появится после первого старта —
                                               # скрипт сам скажет «выполни повторно»

# 4. первый запуск (создаёт мир) — в tmux/screen; run-bds.sh ждёт cwd = каталог сервера
cd "$ROOT/server" && CONSOLE_FIFO="$ROOT/.console.fifo" \
  bash "$SRC/deploy/run-bds.sh" 2>&1 | tee -a "$ROOT/logs/console.log"

# 5. идентичность и геймрулы, повторная укладка (теперь worlds/swipecraft есть), рестарт
ROOT="$ROOT" CONSOLE_FIFO="$ROOT/.console.fifo" bash "$SRC/deploy/init-server.sh"
ROOT="$ROOT" bash "$SRC/deploy/deploy-packs.sh"
ROOT="$ROOT" CONSOLE_FIFO="$ROOT/.console.fifo" bash "$SRC/deploy/stop-bds.sh"
```

Дальше — то, чего ни один скрипт за тебя на EC2 не сделает:

- **Security group.** `deploy/firewall.sh` открывает порты внутри машины; снаружи их ещё
  нужно впустить в группе безопасности: **TCP 19132** (сигналинг NetherNet) и **UDP
  19132–19250** (по порту на игрока). Проверять с другой машины: `bash
  deploy/check-ports.sh --remote <публичный_IP>`, не с самой себя.
- **sysctl** для NetherNet: `sudo cp deploy/sysctl-nethernet.conf
  /etc/sysctl.d/99-swipecraft.conf && sudo sysctl --system`. Без него сервер поднимется и
  даже поедет, но на сотнях UDP-портов упрётся в дефолтные очереди.
- **systemd по желанию.** Юнит из `deploy/systemd/` требует правки `User=`/`Group=` и
  путей, а для установки внутри `/home` — ещё и удаления `ProtectHome=yes`. Без юнита
  `restore.sh`, `update-bds.sh` и `season-wipe.sh` отказываются работать по замыслу
  (остановка и запуск должны быть атомарными); `deploy-packs.sh` и `healthcheck.sh`
  работают и так.
- **Права.** Если сервер запускается от твоего пользователя, `sudo` для деплоя не нужен
  вовсе: `chown` просто пропустится с подсказкой, а файлы и так твои. `sudo` понадобится,
  только если BDS работает от отдельного пользователя — и тогда не забудь `-E`.

Сами скрипты деплоя проверяются без сервера и без root: `npm run check:deploy` (временная
«установка» в `/tmp`, 15 проверок: идемпотентность, dry-run, привязка uuid, поведение при
кривом `ROOT`, несуществующем пользователе и покрытие `install-bds.sh`).

## 3. Проверка, что порты реально открыты снаружи

С самого сервера внешнюю доступность проверить нельзя (NAT, провайдерский фильтр). Запусти проверку **с другой машины**:

```bash
bash deploy/check-ports.sh --remote 203.0.113.10
```

Что проверяется:

- TCP-соединение на 19132;
- HTTP-ответ сигналинга `http://IP:19132/v1/join` — главный признак, что NetherNet жив;
- UDP: проба через `nmap` (если установлен) даёт только «open|filtered», потому что NetherNet не отвечает на посторонние пакеты. **Достоверное подтверждение UDP — реальный вход игрока** и строка в `logs/console.log`.

Ручная проверка с телефона (30 секунд, без клиента Minecraft):

```
браузер на телефоне -> http://IP:19132/v1/join
```

Должна прийти строка с именем и версией сервера.

Локально (на сервере):

```bash
bash /srv/swipecraft/deploy/check-ports.sh --local
```

## 4. Первый вход и онбординг мобильных игроков

1. Игрок: **Play → Servers → Add Server**, адрес `IP`, порт `19132`.
2. Первый вход: клиент спрашивает **«Trust this server?»** → «Доверять». Это разовое действие на устройство (TOFU, сигналинг по HTTP).
3. Повторный запрос появляется **только если сменился ключ сервера**. Поэтому:
   - `serveridentity save` уже выполнен установщиком;
   - каталог `/srv/swipecraft/server/keys` обязан попадать в бэкап (он включён в `backup.sh`) и храниться вне сервера.
4. Готовый текст для Discord/Telegram:

> Заходим: Play → Серверы → Добавить сервер → адрес `IP`, порт `19132`.
> При первом входе игра спросит «Доверять серверу?» — жмём «Доверять». Это один раз.
> Дальше сервер появится в списке и будет запускаться одним тапом.

Если запрос доверия неприемлем — единственный чистый путь — HTTPS-сигналинг по домену; на BDS это **ТРЕБУЕТ ПРОВЕРКИ** (документировано для Geyser, не для BDS). В текущей конфигурации схема — HTTP + сохранённый ключ.

## 5. Бэкапы

- Таймер: `swipecraft-backup.timer`, ежедневно 05:00 UTC + через 30 минут после загрузки, случайный разброс 5 минут.
- Метод: **горячий** — `save hold` → `tar` каталогов `server/worlds`, `server/keys`, `server/server.properties`, `packs` → `save resume`. Запись мира приостановлена, игровые сессии не рвутся.
- Куда: `/srv/swipecraft/backups/daily/` (7 последних) и `weekly/` (4, по воскресеньям).
- Целостность: проверка `tar -tzf` + файл `.sha256` рядом с архивом.

Проверить вручную:

```bash
systemctl start swipecraft-backup.service
ls -lh /srv/swipecraft/backups/daily | tail -3
journalctl -u swipecraft-backup -n 30 --no-pager
```

Восстановление (с подтверждением, sha256 проверяется автоматически):

```bash
systemctl list-timers swipecraft-backup.timer
bash /srv/swipecraft/deploy/restore.sh /srv/swipecraft/backups/daily/swipecraft-XXXX.tar.gz
```

Перед распаковкой скрипт делает `pre-restore` бэкап текущего мира.

Offsite (обязательно для продакшена): в юните `swipecraft-backup.service` задать

```
Environment=BACKUP_REMOTE=backup@storage:/srv/backups/swipecraft
```

или `rclone`-ремоут вида `Environment=BACKUP_REMOTE=r2:swipecraft/backups` (если `rclone` установлен, используется он).

**Тест восстановления — раз в месяц.** Бэкап, который никогда не восстанавливали, бэкапом не считается.

## 6. Логи и ротация

- `logs/console.log` — stdout всего сервера (systemd `append:`), ротация ежедневно, 14 файлов, сжатие, `copytruncate`.
- `server/logs/*.log` — собственные логи BDS, 7 файлов.
- `logs/deploy.log` — вывод бэкапов и деплоя, 6 месяцев.
- Конфиг: `/etc/logrotate.d/swipecraft` (шаблон в `deploy/logrotate-swipecraft`).

Проверка: `logrotate --debug /etc/logrotate.d/swipecraft`.

Живой просмотр: `tail -f /srv/swipecraft/logs/console.log`.

## 7. Мониторинг

```bash
bash /srv/swipecraft/deploy/healthcheck.sh
```

Проверяет: активность юнита, RSS и uptime процесса, ответ `/v1/join`, TCP-сессии, UDP-сокеты, свежесть лога, ошибки в логе, диск, load1 против числа ядер, свежесть бэкапа. Возвращает код 1 при любой ошибке.

Ставим в cron с уведомлением:

```bash
cat >/etc/cron.d/swipecraft-health <<'EOF'
*/5 * * * * root /srv/swipecraft/deploy/healthcheck.sh --quiet || logger -t swipecraft "healthcheck FAILED"
EOF
chmod 0644 /etc/cron.d/swipecraft-health
```

## 8. Обновление BDS

```bash
BDS_VERSION=1.26.61.1 bash /srv/swipecraft/deploy/update-bds.sh
```

Скрипт: бэкап мира → бэкап бинарников → остановка → скачивание → распаковка (с сохранением `server.properties`) → запуск → ожидание `Server started.`. При неудачном скачивании возвращает сервер в работу на старой версии.

## 9. Firewall: важные детали

- `TCP 19132` — сигналинг; `UDP 19132-19250` — игровые сессии.
- **Не ставь `ufw limit` на игровой TCP-порт.** Мобильные операторы сидят за CGNAT: десятки игроков приходят с одного IP, и лимит «6 новых соединений за 30 секунд» отрежет половину онлайна. Лимит уместен только для SSH.
- Защита от SYN-флуда — на уровне ядра: `tcp_syncookies`, `tcp_max_syn_backlog`, `somaxconn` (уже в `sysctl-nethernet.conf`).
- Провайдерский L3/L4-фильтр важнее любого `nft`-правила: сигналинг — обычный HTTP, его флудят чаще всего.
- Альтернатива ufw: `nft -f deploy/nftables-swipecraft.nft` (порты и SSH поправить под себя).

## 10. Анти-лаг и лимиты под мобильных

Что уже сделано на этом этапе (конфигурация BDS):

| Механизм | Значение |
|---|---|
| Дистанция прорисовки | `view-distance=10` |
| Зона тика | `tick-distance=4` |
| Потоки | `max-threads=4` |
| Постоянные тикающие зоны | максимум 8 зон × 64 чанка |
| Временные тикающие зоны | максимум 200 чанков на пак |
| Vibrant Visuals | отключён сервером |
| Сжатие трафика | `compression-threshold=128` |
| Watchdog скриптов | память 350/700 МБ, зависание 10 с |
| Геймрулы | `randomtickspeed=1`, `maxcommandchainlength=10000`, `commandblockoutput=false` |

Что добавляется на этапе 3 (скриптовый слой, без возможности отключить админам):

- лимит сущностей на чанк и глобальный, автоочистка «мусорных» сущностей по возрасту;
- лимит хопперов и наблюдателей на чанк (превышение → блок не активируется, игроку сообщение);
- лимит ТНТ и криперов в зоне;
- рейт-лимит на взрывы и на `playerBreakBlock` для anti-nuker;
- сэмплированный тикер с бюджетом 8 мс.

## 11. Диагностика проблем входа

| Симптом у игрока | Причина | Что делать |
|---|---|---|
| «Unsupported Transport», код 149 | клиент 26.60+ попал на RakNet-сервер | `transport=nethernet` в `server.properties`, перезапуск |
| Server shows up but join hangs | UDP-диапазон закрыт/не проброшен | открыть `19132-19250/udp`, проверить `server-udp-ports` |
| «Door» / «Terracotta» | TCP не доходит, либо сервер анонсирует недоступный адрес | `check-ports.sh --remote`, при NAT указать публичный IP в `server-udp-ports=IP:pub:local` |
| «Trust this server?» каждый вход | ключ не сохранён/меняется | `serveridentity save`, бэкап `server/keys`, не удалять каталог |
| «You're not invited to play on this server» | включён allow-list | `allow-list=false` (у нас выключен) или `allowlist add <ник>` |
| Пусто в `http://IP:19132/v1/join` | процесс не поднялся или порт занят | `systemctl status swipecraft`, `ss -lntp | grep 19132` |
| `load1` выше числа ядер | мир раздут, редстоун-фермы, много сущностей | снизить `view-distance` до 8, включить модули лимитов (этап 3) |

## 12. Чек-лист приёмки этапа 2

- [ ] `systemctl status swipecraft` — active (running), автоперезапуск работает (`systemctl kill -s KILL swipecraft` → вернулся).
- [ ] `curl http://IP:19132/v1/join` с внешней машины отвечает.
- [ ] Вход с iPhone и с Android: сервер добавлен, «Доверять» нажат, игрок в мире.
- [ ] `bash deploy/check-ports.sh --remote IP` — без FAIL.
- [ ] `systemctl start swipecraft-backup.service` создал архив, `.sha256` совпадает.
- [ ] `restore.sh` на тестовом архиве поднял мир.
- [ ] `logrotate --debug /etc/logrotate.d/swipecraft` без ошибок.
- [ ] `healthcheck.sh` — все PASS.
- [ ] `keys/` скопирован на внешнее хранилище.
