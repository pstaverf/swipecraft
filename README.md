# Swipecraft

PvP-анархия для Minecraft Bedrock **26.60+** (iPhone / Android, без модов на клиенте).
Стек: Bedrock Dedicated Server 1.26.60 + TypeScript Script API (`@minecraft/server` 2.11.0, `@minecraft/server-ui` 2.3.0), поведенческий и ресурсный паки раздаются сервером.

## Статус

| Этап | Тема | Статус |
|---|---|---|
| 1 | Архитектура, выбор технологий, хостинг | готово → `docs/ARCHITECTURE.md`, `docs/HOSTING.md` |
| 2 | Установка, запуск, systemd, бэкапы, firewall, анти-лаг | готово → `docs/DEPLOY.md`, `docs/SERVER-PROPERTIES.md`, `deploy/` |
| 3 | Ядро анархии: лобби, rtp, граница, сезон, античит | ожидает |
| 4 | Ивенты каждые 6 часов (7 механик) | ожидает |
| 5 | Кланы, экономика, кейсы, квесты, UI | ожидает |
| 6 | Монетизация и рост | ожидает |

## Установка

```bash
cd /opt/swipecraft-src
BDS_VERSION=1.26.60.6 bash deploy/install-bds.sh
bash deploy/check-ports.sh --remote <ПУБЛИЧНЫЙ_IP>
```

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

## Эксплуатация

```bash
systemctl status swipecraft            # состояние
systemctl restart swipecraft           # перезапуск
bash deploy/healthcheck.sh             # проверка здоровья
bash deploy/backup.sh                  # бэкап вручную
bash deploy/restore.sh <архив>         # восстановление
bash deploy/check-ports.sh --local     # локальная проверка портов
```
