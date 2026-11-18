export const CONFIG = {
  brand: "Swipecraft",
  lobby: {
    x: 0,
    y: 80,
    z: 0,
    radius: 24,
    safeRadius: 16,
    dimension: "overworld",
  },
  rtp: {
    minRadius: 120,
    maxRadius: 1800,
    cooldownMs: 90_000,
    attempts: 28,
    minY: 40,
    maxY: 200,
    marginFromBorder: 40,
  },
  border: {
    startRadius: 4000,
    weeklyShrink: 500,
    minRadius: 800,
    checkEveryTicks: 40,
    warnDistance: 30,
    sampleDivisor: 4,
  },
  season: {
    lengthMs: 56 * 24 * 60 * 60 * 1000,
    warnBeforeMs: 24 * 60 * 60 * 1000,
    announceEveryMs: 60 * 60 * 1000,
  },
  limits: {
    tntCheckTicks: 100,
    inventoryScanTicks: 60,
  },
  quarry: {
    /** как часто делать проход по карьерам (такт = 50 мс) */
    everyTicks: 20,
    /** гарантированный минимум на карьер за проход и общий «бонус» на все карьеры */
    cellsPerClaim: 1,
    extraCells: 6,
    /** сколько пропусков подряд можно проскочить, прежде чем такт закончится */
    maxSkipPerCell: 40,
    maxClaims: 40,
    /** карьер = квадрат (2r+1)² на depth ярусов вниз от точки запуска */
    radius: 5,
    depth: 8,
    /** глубже этого не копаем (и не выше maxY: у спавна и на поверхности карьер бесполезен) */
    maxY: 62,
    minY: -56,
    minDistance: 20,
    setupCost: 1200,
    /** буфер в стопках: полный — копать стопорится, пока игрок не заберёт добычу */
    bufferStacks: 8,
  },
  totems: {
    /** предмет-носитель: ванический тотем, который обряд превращает в зачарованный */
    carrier: "minecraft:totem_of_undying",
    /** сколько секунд после спасения удары по игроку гасятся (как ванильный тотем, иначе «спасли и добили») */
    immunityMs: 2500,
    /** пауза между спасениями у одного игрока */
    saveCooldownMs: 90_000,
    /** потолок спасений на игрока в сутки */
    savesPerDay: 3,
    /** потолок обрядов на игрока в сутки */
    forgesPerDay: 2,
    /** размер реестра: разряженные записи живут spentTtlDays и потом вычищаются */
    maxActive: 400,
    spentTtlDays: 7,
    pruneEveryTicks: 600,
    tiers: {
      whisper: {
        coinCost: 2500,
        emeralds: 6,
        charges: 1,
        effects: [
          { id: "regeneration", seconds: 8, amplifier: 0 },
          { id: "resistance", seconds: 3, amplifier: 0 },
        ],
      },
      oath: {
        coinCost: 7000,
        emeralds: 18,
        charges: 1,
        effects: [
          { id: "regeneration", seconds: 12, amplifier: 1 },
          { id: "resistance", seconds: 6, amplifier: 1 },
          { id: "speed", seconds: 6, amplifier: 0 },
        ],
      },
      ash: {
        coinCost: 20000,
        emeralds: 48,
        charges: 2,
        effects: [
          { id: "regeneration", seconds: 20, amplifier: 1 },
          { id: "resistance", seconds: 10, amplifier: 1 },
          { id: "strength", seconds: 10, amplifier: 0 },
        ],
      },
    },
  },
  spawnProtect: {
    /** как часто напоминать игроку, почему блок не трогается: спам в чате хуже тишины */
    noticeEveryMs: 8_000,
    /** откатывать установку блоков в лобби (beforeEvents.playerPlaceBlock в 2.11 нет) */
    denyPlace: true,
    /** вёдра: точной цели у события нет, поэтому судим по позиции игрока */
    denyBuckets: true,
    /** вырезать клетки спавна из impactedBlocks взрыва */
    denyExplosions: true,
    /** сколько клеток взрыва вообще смотреть: хвост длинного списка остаётся как есть */
    explosionScanCap: 512,
  },
  spawn: {
    /** сторона площади спавна (нечётная), центр — CONFIG.lobby.x/z */
    size: 25,
    pillarHeight: 5,
    pathLength: 8,
    blocksPerRun: 120,
    everyTicks: 5,
    checkEveryTicks: 600,
    sampleCells: 24,
    repairAfterMissing: 4,
  },
  hud: {
    /** период action bar'а: 40 тиков = 2 с; чаще смысла нет — числа меняются раз в минуту */
    everyTicks: 40,
    /** сайдбар — мировой ресурс, его перерисовываем реже */
    sidebarEveryTicks: 100,
    /** сколько игроков обслуживается за один проход бара (бюджет тика) */
    budget: 8,
    /** строк топа по монетам в сайдбаре */
    sidebarRows: 5,
    /** id объектива: чужой объектив ломать нельзя, поэтому у нас свой */
    sidebarObjective: "sw_hud",
    /** заголовок ставится один раз при создании объектива: displayName у него readonly */
    sidebarTitle: "§6Swipecraft",
  },
  profiles: {
    flushTicks: 20 * 60,
    maxAuditEntries: 250,
  },
  store: {
    chunkSize: 7000,
  },
} as const;

export const STORE_KEYS = {
  season: "sw:season",
  border: "sw:border",
  acConfig: "sw:ac:cfg",
  audit: "sw:audit",
  events: "sw:events",
  quarry: "sw:quarry",
  totems: "sw:totems",
  spawnBuild: "sw:spawn:build",
  profilePrefix: "sw:p:",
} as const;
