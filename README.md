# Swipecraft

PvP-анархия для Minecraft Bedrock **26.60+** (iPhone / Android, без модов на клиенте).
Стек: Bedrock Dedicated Server 1.26.60 + TypeScript Script API (`@minecraft/server` 2.11.0, `@minecraft/server-ui` 2.3.0), поведенческий и ресурсный паки раздаются сервером.

## Статус

| Этап | Тема | Статус |
|---|---|---|
| 1 | Архитектура, выбор технологий, хостинг | готово → `docs/ARCHITECTURE.md`, `docs/HOSTING.md` |
| 2 | Установка, запуск, systemd, бэкапы, firewall, анти-лаг | готово → `docs/DEPLOY.md`, `docs/SERVER-PROPERTIES.md`, `deploy/` |
| 3 | Ядро анархии: лобби, rtp, граница, сезон, античит | готово → `docs/ANTICHEAT.md`, `docs/ANTIDUPE.md`, `src/` |
| 4 | Планировщик ивентов и 7 механик | готово → `docs/EVENTS.md`, `src/events/` |
| 5 | Экономика, рынок, кейсы, кланы, квесты, донат, UI | готово → `docs/META.md`, `src/meta/`, `src/ui/` |
| 6 | Монетизация и рост | ожидает |

## Установка

```bash
cd /opt/swipecraft-src
BDS_VERSION=1.26.60.6 bash deploy/install-bds.sh
bash deploy/check-ports.sh --remote <ПУБЛИЧНЫЙ_IP>
```

## Сборка и деплой паков

```bash
npm ci
npm run check      # tsc --noEmit по @minecraft/server 2.11.0
npm run stability  # 44 headless-проверок мета-слоя на моке Script API
npm run build      # esbuild -> packs/behavior_pack/scripts/main.js
npm run pack       # .mcpack + .mcaddon для ручной проверки на клиенте
bash deploy/deploy-packs.sh   # разложить паки на сервере, включить их в мире, перезапустить
```

## Команды в игре

```
/sw:menu                    меню (RTP, правила, статистика, язык, админ-панель)
/sw:rtp                     случайная телепортация
/sw:admin                   админ-панель (нужен тег admin)
/sw:ac show|set|reset       конфиг античита без перезапуска
/sw:event status|next|list  состояние планировщика ивентов
/sw:event start <id>        ручной запуск ивента (airdrop, bloodmoon, koth, bossraid, doubleloot, bountyhunt, lifesteal)
/sw:event stop              остановить активный ивент
/sw:eco                     кошелёк, перевод, продажа предмета, топы, квесты
/sw:market                  рынок игроков: купить / выставить / мои лоты / поиск
/sw:case                    кейсы: честные шансы, вскрытие за ₡ и за ключи
/sw:clan                    клан: состав, права, доска, дом, казна, войны, топ
/sw:quest                   ежедневная награда и квесты
/sw:don                     донат: каталог и заявка
/sw:meta status|info|tx|flush|set <параметр> <число>|reset   мета-слой из консоли
```

Тег админа выдаётся в консоли сервера: `tag <ник> add admin`.

## Ключевые особенности версии 26.60

- Транспорт — только **NetherNet**: TCP `server-port` (сигналинг) + UDP-диапазон `server-udp-ports` (по порту на игрока).
- Проверка живости сервера: `curl http://IP:19132/v1/join`.
- Первый вход с телефона: Servers → Add Server → IP/19132 → «Доверять» (один раз, пока не сменится ключ `server/keys`).
- Паки подключаются к миру, клиент получает их автоматически при входе.

## Документация

- `docs/ARCHITECTURE.md` — сравнение технологий, дерево модулей, бюджеты производительности.
- `docs/HOSTING.md` — расчёт ресурсов, варианты хостинга, сетевые требования NetherNet.
- `docs/DEPLOY.md` — установка, проверка портов, бэкапы, мониторинг, диагностика входа.
- `docs/SERVER-PROPERTIES.md` — каждый ключ конфигурации с обоснованием.
- `docs/ANTICHEAT.md` — детекты, окна допуска, надёжность, горячая правка конфига.
- `docs/ANTIDUPE.md` — таблица векторов дюпа и что из них закрывается скриптом.
- `docs/EVENTS.md` — расписание, 7 ивентов, таблицы лута, восстановление после падения, нагрузка на тики.
- `docs/META.md` — мета-слой: как включается, где хранится, UI и команды, бюджеты задач.
- `docs/ECONOMY.md` — монеты: анти-инфляция, эмиссия, переводы, рынок, кейсы, тюнинги.
- `docs/CLANS.md` — кланы: роли, дом, казна, войны, лимиты хранилища.
- `docs/DONATE.md` — донат: тарифы, заявки, месячные ключи, приоритетный вход.

## Эксплуатация

```bash
systemctl status swipecraft            # состояние
systemctl restart swipecraft           # перезапуск
bash deploy/healthcheck.sh             # проверка здоровья
bash deploy/backup.sh                  # бэкап вручную
bash deploy/restore.sh <архив>         # восстановление
bash deploy/check-ports.sh --local     # локальная проверка портов
```
