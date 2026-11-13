import type { CaseDef, CaseId, ClanRole, DonorTier, EcoTunables, Rarity } from "../types/domain";

export const META_KEYS = {
  tunables: "sw:eco:cfg",
  balances: "sw:eco:meta",
  ledger: "sw:eco:ledger",
  tx: "sw:eco:tx",
  market: "sw:market",
  caseLog: "sw:cases:log",
  caseStats: "sw:cases:stats",
  clans: "sw:clans:index",
  clanPrefix: "sw:clan:",
  top: "sw:meta:top",
  donRequests: "sw:don:requests",
  donGrants: "sw:don:grants",
  donUsage: "sw:don:usage",
} as const;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

export const CURRENCY = {
  symbol: "₡",
  name: { ru: "монеты", en: "coins" },
  maxBalance: 20_000_000,
  sellPrices: {
    "minecraft:coal": 6,
    "minecraft:copper_ingot": 8,
    "minecraft:raw_iron": 20,
    "minecraft:iron_ingot": 26,
    "minecraft:raw_gold": 32,
    "minecraft:gold_ingot": 42,
    "minecraft:redstone": 9,
    "minecraft:lapis_lazuli": 11,
    "minecraft:quartz": 12,
    "minecraft:glowstone_dust": 14,
    "minecraft:string": 5,
    "minecraft:bone": 6,
    "minecraft:rotten_flesh": 2,
    "minecraft:spider_eye": 7,
    "minecraft:gunpowder": 15,
    "minecraft:slime_ball": 14,
    "minecraft:ender_pearl": 60,
    "minecraft:blaze_rod": 70,
    "minecraft:ghast_tear": 180,
    "minecraft:phantom_membrane": 90,
    "minecraft:emerald": 95,
    "minecraft:diamond": 130,
    "minecraft:diamond_block": 1150,
    "minecraft:ancient_debris": 900,
    "minecraft:netherite_scrap": 720,
    "minecraft:netherite_ingot": 3000,
    "minecraft:experience_bottle": 15,
    "minecraft:golden_apple": 190,
    "minecraft:enchanted_golden_apple": 1500,
    "minecraft:totem_of_undying": 1250,
    "minecraft:shulker_shell": 360,
    "minecraft:elytra": 4200,
    "minecraft:netherite_upgrade_smithing_template": 520,
    "minecraft:book": 30,
    "minecraft:amethyst_shard": 20,
  } as Record<string, number>,
  targetCirculation: 4_000_000,
  multiplierFloor: 0.5,
  multiplierCap: 1.25,
} as const;

export const TRANSFERS = {
  minAmount: 50,
  cooldownMs: 90 * 1000,
  holdHours: 12,
} as const;

export const MARKET = {
  minPrice: 10,
  maxPrice: 5_000_000,
  maxListings: 200,
  maxPerSeller: 12,
  maxStacks: 9,
  refreshTicks: 200,
} as const;

export const FORBIDDEN_LISTINGS = [
  "minecraft:shulker_box",
  "minecraft:bundle",
  "minecraft:written_book",
  "minecraft:writable_book",
  "minecraft:knowledge_book",
  "minecraft:command_block",
  "minecraft:structure_block",
  "minecraft:barrier",
  "minecraft:bedrock",
] as const;

export const CLANS = {
  tag: { min: 3, max: 6 },
  name: { min: 3, max: 20 },
  createCost: 8000,
  renameCost: 4000,
  boardChars: 260,
  inviteTtlMs: 24 * HOUR,
  maxInvites: 20,
  joinCost: 0,
  homeCost: 1500,
  homeTeleportCost: 250,
  homeCooldownMs: 5 * MINUTE,
  bankMax: 2_000_000,
  withdrawMaxPerDay: 100_000,
  rolePermissions: {
    leader: ["board", "kick", "invite", "promote", "demote", "bank", "war", "home", "disband", "rename"],
    officer: ["board", "kick", "invite", "bank", "home"],
    member: [],
  } as Record<ClanRole, string[]>,
  war: {
    stakeMin: 5000,
    stakeMax: 200_000,
    durationMs: 7 * DAY,
    cooldownMs: 3 * DAY,
    pointPerKill: 1,
    pointBonusForWin: 5,
    feePercent: 10,
    minMembers: 3,
  },
  inactivityDays: 21,
  storage: {
    perClanBudgetBytes: 6000,
    indexBudgetBytes: 200_000,
    totalBudgetBytes: 2_000_000,
    maxClans: 150,
    warnPercent: 70,
  },
} as const;

export const CASES: Record<CaseId, CaseDef> = {
  basic: {
    label: "Базовый",
    priceCoins: 5000,
    priceKeys: 1,
    rolls: 1,
    pool: [
      { item: "minecraft:iron_ingot", min: 8, max: 16, weight: 320, rarity: "common" },
      { item: "minecraft:gold_ingot", min: 6, max: 12, weight: 260, rarity: "common" },
      { item: "minecraft:diamond", min: 1, max: 3, weight: 200, rarity: "common" },
      { item: "minecraft:experience_bottle", min: 8, max: 24, weight: 160, rarity: "common" },
      { item: "minecraft:golden_apple", min: 2, max: 4, weight: 90, rarity: "rare" },
      { item: "minecraft:ender_pearl", min: 2, max: 6, weight: 80, rarity: "rare" },
      { item: "minecraft:diamond_sword", min: 1, max: 1, weight: 46, rarity: "rare", enchant: [{ id: "minecraft:sharpness", level: 3 }] },
      { item: "minecraft:diamond_pickaxe", min: 1, max: 1, weight: 44, rarity: "rare", enchant: [{ id: "minecraft:efficiency", level: 3 }] },
      { item: "minecraft:totem_of_undying", min: 1, max: 1, weight: 26, rarity: "epic" },
      { item: "minecraft:netherite_scrap", min: 1, max: 3, weight: 24, rarity: "epic" },
      { item: "minecraft:enchanted_golden_apple", min: 1, max: 2, weight: 18, rarity: "epic" },
      { item: "minecraft:elytra", min: 1, max: 1, weight: 8, rarity: "legendary" },
      { item: "minecraft:netherite_ingot", min: 1, max: 2, weight: 12, rarity: "legendary" },
      { item: "minecraft:diamond_chestplate", min: 1, max: 1, weight: 10, rarity: "legendary", enchant: [{ id: "minecraft:protection", level: 4 }, { id: "minecraft:mending", level: 1 }] },
    ],
  },
  elite: {
    label: "Элитный",
    priceCoins: 18000,
    priceKeys: 3,
    rolls: 1,
    pool: [
      { item: "minecraft:diamond", min: 5, max: 9, weight: 240, rarity: "common" },
      { item: "minecraft:experience_bottle", min: 16, max: 32, weight: 200, rarity: "common" },
      { item: "minecraft:netherite_scrap", min: 1, max: 2, weight: 180, rarity: "common" },
      { item: "minecraft:enchanted_golden_apple", min: 1, max: 2, weight: 120, rarity: "rare" },
      { item: "minecraft:shulker_shell", min: 1, max: 2, weight: 110, rarity: "rare" },
      { item: "minecraft:diamond_chestplate", min: 1, max: 1, weight: 74, rarity: "rare", enchant: [{ id: "minecraft:protection", level: 3 }] },
      { item: "minecraft:totem_of_undying", min: 1, max: 2, weight: 62, rarity: "epic" },
      { item: "minecraft:netherite_ingot", min: 1, max: 1, weight: 50, rarity: "epic" },
      { item: "minecraft:diamond_sword", min: 1, max: 1, weight: 40, rarity: "epic", enchant: [{ id: "minecraft:sharpness", level: 5 }, { id: "minecraft:unbreaking", level: 3 }] },
      { item: "minecraft:elytra", min: 1, max: 1, weight: 22, rarity: "legendary" },
      { item: "minecraft:netherite_sword", min: 1, max: 1, weight: 16, rarity: "legendary", enchant: [{ id: "minecraft:sharpness", level: 5 }, { id: "minecraft:mending", level: 1 }] },
      { item: "minecraft:netherite_pickaxe", min: 1, max: 1, weight: 14, rarity: "legendary", enchant: [{ id: "minecraft:efficiency", level: 5 }, { id: "minecraft:mending", level: 1 }] },
    ],
  },

};

export const CASE_ECONOMY = {
  pityPulls: 24,
  keyPriceCoins: 5000,
  maxLogEntries: 400,
  maxStatsEntries: 40,
  logFlushTicks: 600,
  fivePullDiscountPercent: 5,
} as const;

export const RARITY_LABEL: Record<Rarity, string> = {
  common: "Обычный",
  rare: "Редкий",
  epic: "Эпический",
  legendary: "Легендарный",
};

export const RARITY_COLOR: Record<Rarity, string> = {
  common: "§7",
  rare: "§b",
  epic: "§5",
  legendary: "§6",
};

export const DONATIONS = {
  currency: "₽",
  tiers: {
    none: { price: 0, days: 0, queuePriority: false, prefix: "", particles: false },
    bronze: {
      price: 199,
      days: 30,
      queuePriority: true,
      prefix: "§7[§8бронза§7]§r ",
      particles: false,
    },
    silver: {
      price: 399,
      days: 30,
      queuePriority: true,
      prefix: "§f[§7серебро§f]§r ",
      particles: true,
    },
    gold: {
      price: 799,
      days: 30,
      queuePriority: true,
      prefix: "§6[§eзолото§6]§r ",
      particles: true,
    },
  } as Record<DonorTier, { price: number; days: number; queuePriority: boolean; prefix: string; particles: boolean }>,
  trailParticle: "swipecraft:donor_trail",
  trailFallbackParticle: "minecraft:basic_smoke_particle",
  trailEveryTicks: 10,
  requestsMax: 80,
  grantsMax: 300,
  minDays: 7,
  maxDays: 120,
  refundAllowed: false,
  keysPerMonth: { none: 0, bronze: 2, silver: 5, gold: 10 } as Record<DonorTier, number>,
  priceMultiplierRub: 1,
} as const;

export const QUEUE = {
  waitSpot: { x: 6, y: 81, z: 6 },
  dimensionId: "overworld",
  noticeEveryTicks: 40,
} as const;

export const DAILY = {
  streakBonus: 250,
  streakMax: 7,
  rewards: [
    { coins: 800, keys: 0 },
    { coins: 1000, keys: 0 },
    { coins: 1200, keys: 1 },
    { coins: 1500, keys: 0 },
    { coins: 1800, keys: 0 },
    { coins: 2200, keys: 1 },
    { coins: 3000, keys: 2 },
  ],
} as const;

export type QuestKind = "mine" | "mob" | "pvp" | "trade" | "event";

export const QUESTS: { id: string; label: string; kind: QuestKind; target: number; coins: number; keys: number }[] = [
  { id: "miner", label: "Добудь 200 руды", kind: "mine", target: 200, coins: 2500, keys: 0 },
  { id: "hunter", label: "Убей 120 мобов", kind: "mob", target: 120, coins: 2000, keys: 0 },
  { id: "warrior", label: "Убей 10 игроков", kind: "pvp", target: 10, coins: 3500, keys: 1 },
  { id: "trader", label: "Соверши 3 сделки на рынке", kind: "trade", target: 3, coins: 1800, keys: 0 },
  { id: "raider", label: "Участвуй в 2 ивентах", kind: "event", target: 2, coins: 2200, keys: 1 },
];

export const ORE_BLOCKS = [
  "minecraft:diamond_ore",
  "minecraft:deepslate_diamond_ore",
  "minecraft:emerald_ore",
  "minecraft:deepslate_emerald_ore",
  "minecraft:gold_ore",
  "minecraft:deepslate_gold_ore",
  "minecraft:iron_ore",
  "minecraft:deepslate_iron_ore",
  "minecraft:ancient_debris",
  "minecraft:lapis_ore",
  "minecraft:deepslate_lapis_ore",
  "minecraft:redstone_ore",
  "minecraft:deepslate_redstone_ore",
  "minecraft:coal_ore",
  "minecraft:deepslate_coal_ore",
  "minecraft:copper_ore",
  "minecraft:deepslate_copper_ore",
  "minecraft:nether_quartz_ore",
];

export const STREAKS = [
  { kills: 3, coins: 600 },
  { kills: 5, coins: 1400 },
  { kills: 8, coins: 3000, keys: 1 },
  { kills: 12, coins: 6000, keys: 2 },
] as const;

export const LEADERBOARD = {
  rows: 12,
  flushTicks: 1200,
  keepRows: 60,
} as const;

export const META_TASKS = {
  economyFlushTicks: 600,
  warSettleTicks: 1200,
  queueTicks: 20,
  heartsEnforceTicks: 20,
} as const;

export const DEFAULT_ECO_TUNABLES: EcoTunables = {
  transferFeePercent: 4,
  marketCommissionPercent: 7,
  mintCapPerDay: 9000,
  maxTransferPerTx: 150_000,
  maxReceivePerDay: 400_000,
  maxPerPairPerDay: 250_000,
  minPlaySecondsForTransfers: 1800,
  minAccountAgeHours: 24,
  clanMaxMembers: 24,
  marketTtlDays: 14,
  casePricePercent: 100,
  queueEnabled: true,
  queueSoftCap: 82,
  queueReleaseAt: 74,
};

export const CASE_IDS: CaseId[] = ["basic", "elite"];
