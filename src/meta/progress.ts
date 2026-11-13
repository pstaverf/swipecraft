import { Player, world } from "@minecraft/server";
import { t } from "../kernel/i18n";
import { log } from "../kernel/logger";
import { loadWorldJson, saveWorldJson } from "../kernel/store";
import { clamp } from "../kernel/util";
import { audit } from "../security/audit";
import { DAILY, LEADERBOARD, META_KEYS, ORE_BLOCKS, QUESTS, STREAKS } from "./config";
import { getMeta, markDirty } from "./balances";
import { grantKeys, metaOf, mint } from "./economy";
import type { QuestKind } from "./config";
import "./messages";
import type { TopRow } from "../types/domain";

const DAY_MS = 86_400_000;

export interface ProgressResult {
  ok: boolean;
  key: string;
  params?: Record<string, string | number>;
}

let top: Record<string, TopRow> = {};
let oreSet: Set<string> = new Set(ORE_BLOCKS);
let dirty = false;

const dayIndex = (): number => Math.floor(Date.now() / DAY_MS);

export const loadProgress = (): void => {
  const stored = loadWorldJson<Record<string, TopRow> | undefined>(META_KEYS.top, undefined);
  if (stored && typeof stored === "object") top = stored;
  oreSet = new Set(ORE_BLOCKS);
};

const persistTop = (): void => {
  if (!dirty) return;
  saveWorldJson(META_KEYS.top, top);
  dirty = false;
};

const scoreOf = (row: TopRow): number => row.kills * 3 + row.points + Math.floor(row.coins / 1000);

export const updateTopRow = (player: Player): void => {
  const meta = metaOf(player);
  const previous = top[player.id];
  const row: TopRow = {
    id: player.id,
    name: player.name,
    kills: meta.pvpKills,
    deaths: meta.pvpDeaths,
    coins: meta.coins,
    points: meta.streakBest,
    streak: meta.streak,
    clan: previous?.clan ?? "",
  };
  top[player.id] = row;
  const entries = Object.values(top);
  if (entries.length > LEADERBOARD.keepRows) {
    const keep = new Set(
      entries
        .slice()
        .sort((left, right) => scoreOf(right) - scoreOf(left))
        .slice(0, LEADERBOARD.keepRows)
        .map((item) => item.id),
    );
    for (const id of Object.keys(top)) {
      if (!keep.has(id)) delete top[id];
    }
  }
  dirty = true;
};

export const setClanTag = (playerId: string, clanName: string): void => {
  const row = top[playerId];
  if (!row) return;
  if (row.clan === clanName) return;
  row.clan = clanName;
  dirty = true;
};

export const recordKill = (killer: Player, victim: Player): void => {
  const killerMeta = metaOf(killer);
  const victimMeta = getMeta(victim.id, victim.name);
  killerMeta.streak += 1;
  killerMeta.streakAt = Date.now();
  killerMeta.streakBest = Math.max(killerMeta.streakBest, killerMeta.streak);
  killerMeta.quests.pvp = (killerMeta.quests.pvp ?? 0) + 1;
  killerMeta.pvpKills += 1;
  killerMeta.updatedAt = Date.now();
  markDirty(killer.id);
  victimMeta.streak = 0;
  victimMeta.pvpDeaths += 1;
  victimMeta.updatedAt = Date.now();
  markDirty(victim.id);
  const reward = STREAKS.find((row) => row.kills === killerMeta.streak);
  if (reward) {
    mint(killer, reward.coins, `streak ${reward.kills}`);
    if ("keys" in reward && reward.keys) grantKeys(killer, reward.keys, `streak ${reward.kills}`);
    try {
      killer.sendMessage(
        t(killer, "streak.award", {
          kills: reward.kills,
          coins: reward.coins,
          keys: "keys" in reward && reward.keys ? t(killer, "daily.keys", { keys: reward.keys }) : "",
        }),
      );
      for (const player of world.getAllPlayers()) {
        if (player.id === killer.id) continue;
        try {
          player.sendMessage(t(player, "streak.broadcast", { player: killer.name, kills: reward.kills }));
        } catch {
          continue;
        }
      }
    } catch (error) {
      log.debug("meta", `streak msg: ${String(error)}`);
    }
    audit("meta", "streak", killer.name, `${reward.kills} убийств подряд`);
  }
  updateTopRow(killer);
};

export const recordDeath = (player: Player): void => {
  const meta = metaOf(player);
  if (meta.streak > 0) {
    meta.streak = 0;
    markDirty(player.id);
  }
  updateTopRow(player);
};

export const isOre = (typeId: string): boolean => oreSet.has(typeId);

export const bumpQuest = (player: Player, kind: QuestKind, amount: number): void => {
  const meta = metaOf(player);
  let announced = 0;
  for (const quest of QUESTS) {
    if (quest.kind !== kind) continue;
    if (meta.claimedQuests[quest.id] !== undefined) continue;
    const before = meta.quests[quest.id] ?? 0;
    if (before >= quest.target) continue;
    const after = Math.min(quest.target, before + amount);
    if (after === before) continue;
    meta.quests[quest.id] = after;
    meta.updatedAt = Date.now();
    markDirty(player.id);
    if (before < quest.target && after >= quest.target) announced += 1;
  }
  if (announced > 0) {
    try {
      player.sendMessage(t(player, "quest.done.short"));
    } catch {
      return;
    }
  }
};

export const recordOre = (player: Player, typeId: string, amount: number): void => {
  if (!isOre(typeId)) return;
  bumpQuest(player, "mine", amount);
};

export const recordMobKill = (player: Player): void => {
  bumpQuest(player, "mob", 1);
};

export const recordTrade = (player: Player): void => {
  bumpQuest(player, "trade", 1);
};

export const recordEvent = (player: Player): void => {
  bumpQuest(player, "event", 1);
};

export const dailyState = (player: Player): { ready: boolean; index: number; streak: number } => {
  const meta = metaOf(player);
  const day = dayIndex();
  const gap = day - meta.dailyDay;
  const nextIndex = meta.dailyDay === 0 ? 0 : gap <= 1 ? (meta.dailyStreak + 1) % DAILY.rewards.length : 0;
  return { ready: gap >= 1 || meta.dailyDay === 0, index: nextIndex, streak: meta.dailyStreak };
};

export const claimDaily = (player: Player): ProgressResult => {
  const meta = metaOf(player);
  const day = dayIndex();
  if (meta.dailyDay === day) {
    return { ok: false, key: "daily.already", params: { hoursLeft: Math.max(0, 24 - new Date().getHours()) } };
  }
  const gap = meta.dailyDay === 0 ? 1 : day - meta.dailyDay;
  const streak = gap <= 1 ? meta.dailyStreak + 1 : 0;
  const index = streak % DAILY.rewards.length;
  const reward = DAILY.rewards[index];
  const bonus = Math.min(streak, DAILY.streakMax) * DAILY.streakBonus;
  const total = reward.coins + bonus;
  const result = mint(player, total, `daily ${index + 1}`);
  if (!result.ok) return { ok: false, key: result.key, params: result.params };
  if (reward.keys > 0) grantKeys(player, reward.keys, "daily keys");
  meta.dailyDay = day;
  meta.dailyStreak = streak;
  meta.updatedAt = Date.now();
  markDirty(player.id);
  audit("meta", "daily", player.name, `день ${streak + 1}: ${total}${reward.keys > 0 ? ` +${reward.keys} ключей` : ""}`);
  return {
    ok: true,
    key: "daily.claimed",
    params: { day: streak + 1, coins: total, bonus, keysText: reward.keys > 0 ? t(player, "daily.keys", { keys: reward.keys }) : "" },
  };
};

export const questLines = (player: Player): string[] => {
  const meta = metaOf(player);
  const lines: string[] = [];
  for (const quest of QUESTS) {
    const progress = clamp(meta.quests[quest.id] ?? 0, 0, quest.target);
    const claimed = meta.claimedQuests[quest.id] !== undefined;
    lines.push(
      t(player, "quest.line", {
        mark: claimed ? "✓" : progress >= quest.target ? "→" : "•",
        label: quest.label,
        progress,
        target: quest.target,
        coins: quest.coins,
        keys: quest.keys > 0 ? `+${quest.keys}` : "",
      }),
    );
  }
  return lines;
};

export const claimQuest = (player: Player, questId: string): ProgressResult => {
  const quest = QUESTS.find((row) => row.id === questId);
  if (!quest) return { ok: false, key: "quest.unknown" };
  const meta = metaOf(player);
  if (meta.claimedQuests[quest.id] !== undefined) return { ok: false, key: "quest.claimed" };
  if ((meta.quests[quest.id] ?? 0) < quest.target) {
    return { ok: false, key: "quest.progress", params: { have: meta.quests[quest.id] ?? 0, need: quest.target } };
  }
  const result = mint(player, quest.coins, `quest ${quest.id}`);
  if (!result.ok) return { ok: false, key: result.key, params: result.params };
  if (quest.keys > 0) grantKeys(player, quest.keys, `quest ${quest.id}`);
  meta.claimedQuests[quest.id] = Date.now();
  meta.updatedAt = Date.now();
  markDirty(player.id);
  audit("meta", "quest", player.name, `${quest.id}: ${quest.coins}${quest.keys > 0 ? ` +${quest.keys}` : ""}`);
  return {
    ok: true,
    key: "quest.done",
    params: { label: quest.label, coins: quest.coins, keysText: quest.keys > 0 ? t(player, "daily.keys", { keys: quest.keys }) : "" },
  };
};

export const streakDecay = (): void => {
  const now = Date.now();
  let changed = false;
  for (const player of world.getAllPlayers()) {
    const meta = metaOf(player);
    if (meta.streak <= 0) continue;
    if (now - meta.streakAt < 30 * 60 * 1000) continue;
    meta.streak = 0;
    meta.updatedAt = now;
    markDirty(player.id);
    updateTopRow(player);
    changed = true;
  }
  if (changed) persistTop();
};

export const leaderboardLines = (player: Player, kind: "kills" | "coins" | "points"): string[] => {
  const rows = Object.values(top);
  for (const online of world.getAllPlayers()) {
    const meta = metaOf(online);
    const existing = rows.find((row) => row.id === online.id);
    if (existing) {
      existing.coins = meta.coins;
      existing.name = online.name;
    } else {
      rows.push({ id: online.id, name: online.name, kills: meta.pvpKills, deaths: meta.pvpDeaths, coins: meta.coins, points: meta.streakBest, streak: meta.streak, clan: "" });
    }
  }
  const sorted = rows
    .slice()
    .filter((row) => (kind === "coins" ? row.coins > 0 : true))
    .sort((left, right) => (kind === "coins" ? right.coins - left.coins : kind === "points" ? right.points - left.points : right.kills - left.kills))
    .slice(0, LEADERBOARD.rows);
  if (sorted.length === 0) return ["пусто"];
  const self = player ? player.id : "";
  return sorted.map((row, position) => {
    const value = kind === "coins" ? row.coins : kind === "points" ? row.points : row.kills;
    const clan = row.clan.length > 0 ? ` [${row.clan}]` : "";
    return `${position + 1}. ${row.name === self ? "§e" : "§f"}${row.name}${clan}: ${value}${row.name === self ? " §7(ты)" : ""}`;
  });
};

export const progressSummary = (player: Player): string[] => {
  const meta = metaOf(player);
  const state = dailyState(player);
  const lines = [
    t(player, "prog.summary", { pulls: meta.casePulls, streak: meta.streak, best: meta.streakBest, kills: meta.pvpKills }),
    t(player, "daily.line", {
      state: t(player, state.ready ? "daily.ready" : "daily.done"),
      streak: meta.dailyStreak,
      bonus: Math.min(state.streak, DAILY.streakMax) * DAILY.streakBonus,
    }),
  ];
  lines.push(...questLines(player));
  return lines;
};

export const flushProgress = (): void => {
  for (const player of world.getAllPlayers()) updateTopRow(player);
  persistTop();
};
