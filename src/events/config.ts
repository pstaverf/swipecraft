import type { EventId, LootTable } from "./types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const EVENT_SCHEDULE = {
  intervalMs: 6 * HOUR,
  minPlayers: 3,
  postponeMs: 15 * MINUTE,
  maxPostpones: 8,
  announceLead5Ms: 5 * MINUTE,
  announceLead1Ms: MINUTE,
  countdownStepMs: 1000,
  minPlaySecondsForRewards: 300,
  minAccountAgeMs: 10 * MINUTE,
  rotationMemory: 3,
} as const;

export const EVENT_ORDER: EventId[] = [
  "airdrop",
  "bloodmoon",
  "koth",
  "bossraid",
  "doubleloot",
  "bountyhunt",
  "lifesteal",
];

export const AIRDROP_LOOT: LootTable = {
  guaranteed: [
    { item: "minecraft:netherite_ingot", amount: 1 },
    { item: "minecraft:diamond_block", amount: 2 },
  ],
  rolls: 4,
  pool: [
    { item: "minecraft:enchanted_golden_apple", min: 1, max: 2, weight: 18 },
    { item: "minecraft:totem_of_undying", min: 1, max: 1, weight: 14 },
    { item: "minecraft:elytra", min: 1, max: 1, weight: 8 },
    { item: "minecraft:netherite_scrap", min: 1, max: 3, weight: 16 },
    { item: "minecraft:diamond_block", min: 1, max: 3, weight: 20 },
    { item: "minecraft:golden_apple", min: 2, max: 4, weight: 22 },
    { item: "minecraft:experience_bottle", min: 4, max: 12, weight: 18 },
    { item: "minecraft:end_crystal", min: 1, max: 2, weight: 10 },
    { item: "minecraft:shulker_shell", min: 1, max: 2, weight: 12 },
    { item: "minecraft:netherite_upgrade_smithing_template", min: 1, max: 1, weight: 6 },
  ],
};

export const BOSS_LOOT: LootTable = {
  guaranteed: [
    { item: "minecraft:netherite_ingot", amount: 2 },
    { item: "minecraft:diamond_block", amount: 3 },
  ],
  rolls: 5,
  pool: [
    { item: "minecraft:elytra", min: 1, max: 1, weight: 10 },
    { item: "minecraft:totem_of_undying", min: 1, max: 1, weight: 16 },
    { item: "minecraft:enchanted_golden_apple", min: 1, max: 2, weight: 20 },
    { item: "minecraft:netherite_scrap", min: 2, max: 4, weight: 18 },
    { item: "minecraft:netherite_upgrade_smithing_template", min: 1, max: 1, weight: 8 },
    { item: "minecraft:experience_bottle", min: 8, max: 16, weight: 20 },
    { item: "minecraft:shulker_shell", min: 2, max: 4, weight: 14 },
  ],
};

export const KOTH_LOOT: LootTable = {
  guaranteed: [{ item: "minecraft:diamond_block", amount: 2 }],
  rolls: 3,
  pool: [
    { item: "minecraft:golden_apple", min: 3, max: 6, weight: 25 },
    { item: "minecraft:enchanted_golden_apple", min: 1, max: 1, weight: 15 },
    { item: "minecraft:experience_bottle", min: 6, max: 12, weight: 25 },
    { item: "minecraft:netherite_scrap", min: 1, max: 3, weight: 12 },
    { item: "minecraft:totem_of_undying", min: 1, max: 1, weight: 8 },
  ],
};

export const BOUNTY_LOOT: LootTable = {
  guaranteed: [{ item: "minecraft:golden_apple", amount: 3 }],
  rolls: 3,
  pool: [
    { item: "minecraft:diamond_block", min: 1, max: 2, weight: 25 },
    { item: "minecraft:netherite_scrap", min: 1, max: 2, weight: 20 },
    { item: "minecraft:experience_bottle", min: 4, max: 10, weight: 25 },
    { item: "minecraft:totem_of_undying", min: 1, max: 1, weight: 10 },
    { item: "minecraft:elytra", min: 1, max: 1, weight: 5 },
  ],
};

export const BLOODMOON_BONUS_LOOT: LootTable = {
  guaranteed: [],
  rolls: 1,
  pool: [
    { item: "minecraft:iron_ingot", min: 1, max: 3, weight: 25 },
    { item: "minecraft:gold_ingot", min: 1, max: 2, weight: 20 },
    { item: "minecraft:emerald", min: 1, max: 3, weight: 20 },
    { item: "minecraft:experience_bottle", min: 1, max: 4, weight: 25 },
    { item: "minecraft:diamond", min: 1, max: 1, weight: 10 },
  ],
};

export const EVENTS = {
  airdrop: {
    minPlayers: EVENT_SCHEDULE.minPlayers,
    durationMs: 15 * MINUTE,
    fallMs: 8000,
    minRadius: 150,
    maxRadius: 1400,
    loot: AIRDROP_LOOT,
  },
  bloodmoon: {
    minPlayers: EVENT_SCHEDULE.minPlayers,
    durationMs: 20 * MINUTE,
    waveEveryMs: 25_000,
    waveSize: 3,
    waveRadius: 24,
    mobs: ["minecraft:zombie", "minecraft:skeleton", "minecraft:spider", "minecraft:husk"],
    effectDurationSec: 300,
    bonusLoot: BLOODMOON_BONUS_LOOT,
    bonusChance: 0.55,
  },
  koth: {
    minPlayers: EVENT_SCHEDULE.minPlayers,
    durationMs: 12 * MINUTE,
    radius: 7,
    requiredSeconds: 60,
    minInsideSeconds: 20,
    decayPerSecond: 0.6,
    contestedFreeze: true,
    loot: KOTH_LOOT,
    minRadius: 200,
    maxRadius: 900,
  },
  bossraid: {
    minPlayers: EVENT_SCHEDULE.minPlayers,
    durationMs: 20 * MINUTE,
    entityId: "minecraft:ravager",
    healthBoostAmplifier: 6,
    phaseThresholds: [0.66, 0.33],
    minions: ["minecraft:pillager", "minecraft:vindicator"],
    minionCount: 3,
    minDamageShare: 0.05,
    minParticipationSeconds: 20,
    loot: BOSS_LOOT,
    spawnRadius: 40,
  },
  doubleloot: {
    minPlayers: EVENT_SCHEDULE.minPlayers,
    durationMs: 60 * MINUTE,
    breakChance: 0.45,
    mobChance: 0.4,
    xpMultiplier: 2,
    blockBonus: {
      "minecraft:diamond_ore": "minecraft:diamond",
      "minecraft:deepslate_diamond_ore": "minecraft:diamond",
      "minecraft:emerald_ore": "minecraft:emerald",
      "minecraft:deepslate_emerald_ore": "minecraft:emerald",
      "minecraft:gold_ore": "minecraft:raw_gold",
      "minecraft:deepslate_gold_ore": "minecraft:raw_gold",
      "minecraft:iron_ore": "minecraft:raw_iron",
      "minecraft:deepslate_iron_ore": "minecraft:raw_iron",
      "minecraft:ancient_debris": "minecraft:netherite_scrap",
      "minecraft:lapis_ore": "minecraft:lapis_lazuli",
      "minecraft:deepslate_lapis_ore": "minecraft:lapis_lazuli",
      "minecraft:redstone_ore": "minecraft:redstone",
      "minecraft:deepslate_redstone_ore": "minecraft:redstone",
      "minecraft:coal_ore": "minecraft:coal",
      "minecraft:deepslate_coal_ore": "minecraft:coal",
      "minecraft:copper_ore": "minecraft:raw_copper",
    } as Record<string, string>,
    mobBonusItem: "minecraft:experience_bottle",
  },
  bountyhunt: {
    minPlayers: EVENT_SCHEDULE.minPlayers,
    durationMs: 30 * MINUTE,
    minKills: 1,
    glowingRefreshMs: 20_000,
    loot: BOUNTY_LOOT,
  },
  lifesteal: {
    minPlayers: EVENT_SCHEDULE.minPlayers,
    durationMs: 60 * MINUTE,
    maxLevel: 6,
    baseAmplifier: 0,
  },
} as const;

export const EVENT_LABELS: Record<EventId, { ru: string; en: string }> = {
  airdrop: { ru: "Аирдроп", en: "Airdrop" },
  bloodmoon: { ru: "Кровавая луна", en: "Blood moon" },
  koth: { ru: "Царь горы", en: "King of the hill" },
  bossraid: { ru: "Босс-рейд", en: "Boss raid" },
  doubleloot: { ru: "Двойной лут", en: "Double loot" },
  bountyhunt: { ru: "Охота за головами", en: "Bounty hunt" },
  lifesteal: { ru: "Lifesteal-час", en: "Lifesteal hour" },
};
