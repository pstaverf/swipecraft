# `server.properties` для Swipecraft (BDS 1.26.60, NetherNet, 100 игроков, мобильные)

Файл: `/srv/swipecraft/server/server.properties` (эталон — `config/server.properties` в репозитории).
Комментариев в файле нет намеренно; пояснения — здесь. Значения ключей сверены с дефолтным файлом BDS 1.26.63.1 из официальной поставки.

## Транспорт и сеть

| Ключ | Значение | Зачем |
|---|---|---|
| `transport` | `nethernet` | Единственный рабочий транспорт с 26.60. `raknet` даёт клиентам ошибку 149 «Unsupported Transport». |
| `server-port` | `19132` | TCP-порт **сигналинга**: клиент делает `GET /v1/join`, получает адрес и UDP-порт сессии. |
| `server-udp-ports` | `19132-19250` | UDP-диапазон игровых сессий: по порту на игрока, при исчерпании переиспользуется. 119 портов под `max-players=100`. Если не задать — BDS возьмёт эфемерные порты, и firewall/роутер их не пропустит. |
| `server-portv6` | `19133` | Игнорируется при `transport=nethernet` (открывается dual-stack сокет на `server-port`). Оставлен для совместимости с тулингом. |
| `enable-lan-visibility` | `false` | На публичном сервере LAN-обнаружение не нужно: экономит сокеты и убирает конфликты портов на нескольких инстансах. |

## Игровые правила

| Ключ | Значение | Зачем |
|---|---|---|
| `max-players` | `100` | Целевой онлайн. Больше 100 на 4 vCPU не тянем. |
| `gamemode` | `survival` | Анархия. |
| `force-gamemode` | `true` | Иначе смена `gamemode` после создания мира игнорируется клиентом. |
| `difficulty` | `hard` | Мобы и голод как на анархии. |
| `allow-cheats` | `false` | Игроки не получают доступ к командам; консольные команды администратора работают. |
| `online-mode` | `true` | Только лицензионные Xbox Live аккаунты: без этого невозможны ни NetherNet, ни защита от рейдов ботов. |
| `allow-list` | `false` | Вайтлиста нет (с 26.30 BDS по умолчанию ставит `true` — ключ обязателен явно). |
| `default-player-permission-level` | `member` | Не `operator`: игроки не должны иметь доступ к серверным командам. |
| `player-idle-timeout` | `0` | AFK-фарм разрешён (анархия). Если начнёт жрать RAM — ставить 20–30. |

## Производительность под мобильные

| Ключ | Значение | Зачем |
|---|---|---|
| `view-distance` | `10` | Дефолт BDS — 32; мобильный клиент всё равно не рендерит больше ~12 чанков, а сервер обязан их держать. 10 — баланс: видно достаточно, RAM/CPU не улетают. |
| `tick-distance` | `4` | Минимум: тикуется только ближняя зона. Редстоун/фермы за её пределами не нагружают CPU. |
| `max-threads` | `4` | По числу vCPU хостера (4). `0` = «сколько есть» → драка за ядра с GC и сетью. |
| `compression-threshold` | `128` | Сжимать почти всё: у мобильных канал узкий, CPU дешевле трафика. |
| `compression-algorithm` | `zlib` | Совместимость гарантирована. `snappy` даёт меньше CPU, но больше трафика — менять только после теста на iOS/Android (ТРЕБУЕТ ПРОВЕРКИ). |
| `client-side-chunk-generation-enabled` | `true` | Клиент достраивает дальние чанки сам — сервер не генерирует то, что никто не тикает. |
| `server-build-radius-ratio` | `Disabled` | BDS сам решает, сколько генерировать под конкретный телефон. |
| `persistent-ticking-area-max-count` | `8` | Ограничение постоянных тикающих зон (спавн, арены). Без лимита паки плодят зоны и сервер не спит никогда. |
| `persistent-ticking-area-max-chunks` | `64` | Максимум чанков в одной постоянной зоне. |
| `transient-ticking-area-max-chunks` | `200` | Максимум чанков во временных зонах на пак — защита от «зоны на весь мир». |
| `disable-client-vibrant-visuals` | `true` | Vibrant Visuals (RT-подобная графика) на телефонах режет FPS и требует тяжёлых данных — отключаем на серверном уровне. |
| `block-network-ids-are-hashes` | `true` | Стабильные ID блоков: клиент не пересобирает палитру после смены паков. |

## Серверная валидация (встроенный анти-чит BDS)

| Ключ | Значение | Зачем |
|---|---|---|
| `server-authoritative-entity-attack-range-validation` | `enforce` | Сервер сам отклоняет удары вне игровой дистанции — режет reach-хаки без скриптов. |
| `server-authoritative-entity-attack-range-tolerance` | `1.0` | +1 блок допуска под мобильный пинг 150–250 мс. Меньше 0.5 — начнутся «не проходит удар» у игроков на 3G. |
| `server-authoritative-entity-attack-request-validation` | `enforce` | Проверка соответствия типа атаки предмету в руке (анти-«удар киркой на 8 блоков», анти-скриптовые атаки). |
| `player-position-acceptance-threshold` | `0.7` | Допуск расхождения позиции клиент/сервер. 0.5 — частые рывки на мобильном, >1.0 — послабление читерам. |
| `player-movement-action-direction-threshold` | `0.85` | Удар должен совпадать с направлением взгляда — дешёвый детект killaura на уровне движка. |
| `server-authoritative-block-breaking-pick-range-scalar` | `1.5` | Множитель дистанции ломания блоков: анти-nuker, но с запасом под лаг. |
| `server-authoritative-movement-strict` | `false` | Строгий режим даёт телепорт-коррекции на плохой сети — для мобильных вреден. |
| `server-authoritative-dismount-strict` | `false` | То же для спешивания. |
| `server-authoritative-entity-interactions-strict` | `false` | Взаимодействия с сущностями на лаге иначе «не срабатывают». |

## Чат, скины, модерация

| Ключ | Значение | Зачем |
|---|---|---|
| `chat-restriction` | `None` | Чат открыт; фильтрация — на уровне скриптов (мьюты, анти-спам). |
| `disable-player-interaction` | `false` | Игроки должны взаимодействовать друг с другом. |
| `disable-custom-skins` | `false` | Кастомные скины разрешены. |
| `disable-persona` | `false` | Внутренний флаг, не трогаем. |
| `texturepack-required` | `false` | Обязательный RP ломает вход при рассинхроне версии пака; лучше `false` + версионирование. |

## Логи, отладка, watchdog

| Ключ | Значение | Зачем |
|---|---|---|
| `content-log-file-enabled` | `true` | Ошибки паков и скриптов пишутся в файл — без этого диагностика слепая. |
| `content-log-console-output-enabled` | `false` | Не засоряем `console.log` (он и так ротируется). |
| `content-log-level` | `error` | Только ошибки: `info`/`verbose` на 100 онлайн дают гигабайты. |
| `allow-outbound-script-debugging` | `false` | Отладчик скриптов в проде — дыра. |
| `allow-inbound-script-debugging` | `false` | То же. |
| `script-debugger-auto-attach` | `disabled` | То же. |
| `script-watchdog-enable` | `true` | Сторож зависаний скриптов включён. |
| `script-watchdog-enable-shutdown` | `true` | Лучше аварийно сохраниться и упасть, чем стоять мёртвым с открытым портом. |
| `script-watchdog-hang-threshold` | `10000` | 10 с зависания = критическая ошибка. |
| `script-watchdog-spike-threshold` | `150` | Предупреждение при спайке 150 мс — маркер тяжёлого тика. |
| `script-watchdog-slow-threshold` | `20` | Предупреждение о медленных скриптах (суммарно по тикам). |
| `script-watchdog-memory-warning` | `350` | Предупреждение при 350 МБ памяти скриптов. |
| `script-watchdog-memory-limit` | `700` | Аварийное сохранение и выход при 700 МБ — не даём скриптам уронить весь сервер в OOM. |

## Что меняется после первого месяца

- Онлайн стабильно 90+ и `load1 > 4` → 6–8 vCPU, `max-threads` по числу ядер, `view-distance` можно вернуть к 12.
- Жалобы на «удары не проходят» на 3G → `server-authoritative-entity-attack-range-tolerance=1.25`, `player-position-acceptance-threshold=0.9`.
- Мир вырос > 20 ГБ → бэкап только `worlds` + вынести старые миры в архив (см. `docs/DEPLOY.md`).
