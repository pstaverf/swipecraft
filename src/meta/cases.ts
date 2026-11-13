import { ItemStack, Player, world } from "@minecraft/server";
import { t } from "../kernel/i18n";
import { log } from "../kernel/logger";
import { loadWorldJson, saveWorldJson } from "../kernel/store";
import { clamp } from "../kernel/util";
import { audit } from "../security/audit";
import { CASE_ECONOMY, CASES, META_KEYS, RARITY_COLOR, RARITY_LABEL } from "./config";
import { burn, getTunables, metaOf, payKeys } from "./economy";
import { markDirty } from "./balances";
import { deserializeItem } from "./market";
import "./messages";
import type { CaseEntry, CaseId, CaseLogEntry, Rarity, SerializedItem } from "../types/domain";

export interface CaseStats {
  pulls: number;
  byCase: Record<string, number>;
  byRarity: Record<string, number>;
  byItem: Record<string, number>;
}

export interface OpenResult {
  ok: boolean;
  key: string;
  params?: Record<string, string | number>;
  lines?: string[];
}

let caseLog: CaseLogEntry[] = [];
let stats: CaseStats = { pulls: 0, byCase: {}, byRarity: {}, byItem: {} };
let dirty = false;

const RANDOM_LIMIT = 5;

const weightOf = (entry: CaseEntry): number => Math.max(0, entry.weight);

export const poolWeight = (pool: CaseEntry[]): number => pool.reduce((sum, entry) => sum + weightOf(entry), 0);

export const oddsOf = (caseId: CaseId): { entry: CaseEntry; percent: number }[] => {
  const def = CASES[caseId];
  const total = poolWeight(def.pool);
  if (total <= 0) return [];
  return def.pool.map((entry) => ({ entry, percent: (weightOf(entry) / total) * 100 }));
};

export const rarityOdds = (caseId: CaseId): { rarity: Rarity; percent: number }[] => {
  const total = poolWeight(CASES[caseId].pool);
  const merged = new Map<Rarity, number>();
  if (total <= 0) return [];
  for (const entry of CASES[caseId].pool) {
    merged.set(entry.rarity, (merged.get(entry.rarity) ?? 0) + weightOf(entry));
  }
  return [...merged.entries()]
    .map(([rarity, weight]) => ({ rarity, percent: (weight / total) * 100 }))
    .sort((left, right) => right.percent - left.percent);
};

export const casePrice = (caseId: CaseId): { coins: number; keys: number } => {
  const percent = getTunables().casePricePercent;
  return {
    coins: Math.round((CASES[caseId].priceCoins * clamp(percent, 10, 400)) / 100),
    keys: CASES[caseId].priceKeys,
  };
};

export const oddsLines = (viewer: Player, caseId: CaseId): string[] => {
  const lines = [t(viewer, "case.odds.header", { case: CASES[caseId].label, rolls: CASES[caseId].rolls })];
  for (const row of rarityOdds(caseId)) {
    lines.push(t(viewer, "case.odds.rarity", { color: RARITY_COLOR[row.rarity], rarity: RARITY_LABEL[row.rarity], percent: row.percent.toFixed(2) }));
  }
  for (const row of oddsOf(caseId)) {
    lines.push(
      t(viewer, "case.odds.entry", {
        color: RARITY_COLOR[row.entry.rarity],
        item: row.entry.item.replace("minecraft:", ""),
        min: row.entry.min,
        max: row.entry.max > row.entry.min ? `-${row.entry.max}` : "",
        percent: row.percent.toFixed(2),
        enchant: row.entry.enchant && row.entry.enchant.length > 0 ? t(viewer, "case.odds.enchant") : "",
      }),
    );
  }
  return lines;
};

const roll = (pool: CaseEntry[]): CaseEntry | undefined => {
  const total = poolWeight(pool);
  if (total <= 0) return undefined;
  let ticket = Math.random() * total;
  for (const entry of pool) {
    ticket -= weightOf(entry);
    if (ticket > 0) continue;
    return entry;
  }
  return pool[pool.length - 1];
};

const buildItem = (entry: CaseEntry): ItemStack | undefined => {
  const amount = entry.max > entry.min ? entry.min + Math.floor(Math.random() * (entry.max - entry.min + 1)) : entry.min;
  const data: SerializedItem = { typeId: entry.item, amount };
  if (entry.enchant && entry.enchant.length > 0) data.enchant = entry.enchant;
  return deserializeItem(data);
};

const give = (player: Player, stack: ItemStack): void => {
  try {
    const container = player.getComponent("minecraft:inventory")?.container;
    if (!container) {
      player.dimension.spawnItem(stack, player.location);
      return;
    }
    const leftover = container.addItem(stack);
    if (leftover) player.dimension.spawnItem(leftover, player.location);
  } catch (error) {
    log.error("cases", `выдача ${stack.typeId}: ${String(error)}`);
    try {
      player.dimension.spawnItem(stack, player.location);
    } catch {
      return;
    }
  }
};

const pushLog = (entry: CaseLogEntry): void => {
  caseLog.push(entry);
  if (caseLog.length > CASE_ECONOMY.maxLogEntries) caseLog = caseLog.slice(-CASE_ECONOMY.maxLogEntries);
  dirty = true;
};

const bump = (table: Record<string, number>, key: string): void => {
  table[key] = (table[key] ?? 0) + 1;
};

const persist = (force = false): void => {
  if (!dirty && !force) return;
  saveWorldJson(META_KEYS.caseLog, caseLog);
  saveWorldJson(META_KEYS.caseStats, stats);
  dirty = false;
};

export const loadCases = (): void => {
  const storedLog = loadWorldJson<CaseLogEntry[] | undefined>(META_KEYS.caseLog, undefined);
  if (Array.isArray(storedLog)) {
    caseLog = storedLog.filter((row): row is CaseLogEntry => !!row && typeof row.item === "string" && typeof row.t === "number");
  }
  const storedStats = loadWorldJson<CaseStats | undefined>(META_KEYS.caseStats, undefined);
  if (storedStats && typeof storedStats === "object") {
    stats = {
      pulls: Number(storedStats.pulls) || 0,
      byCase: storedStats.byCase ?? {},
      byRarity: storedStats.byRarity ?? {},
      byItem: storedStats.byItem ?? {},
    };
  }
};

export const canOpen = (player: Player, caseId: CaseId, count: number, useKeys: boolean): OpenResult => {
  const pulls = clamp(Math.floor(count), 1, RANDOM_LIMIT);
  if (!(caseId in CASES)) return { ok: false, key: "case.unknown" };
  const price = casePrice(caseId);
  const meta = metaOf(player);
  if (useKeys) {
    const need = price.keys * pulls;
    if (need <= 0) return { ok: false, key: "case.keys.notNeeded" };
    if (meta.caseKeys < need) return { ok: false, key: "case.keys.missing", params: { need, have: meta.caseKeys } };
    return { ok: true, key: "case.ready", params: { count: pulls, price: 0, keys: need } };
  }
  const discount = pulls >= 5 ? (100 - CASE_ECONOMY.fivePullDiscountPercent) / 100 : 1;
  const total = Math.round(price.coins * pulls * discount);
  if (total <= 0) return { ok: false, key: "case.free.only" };
  if (meta.coins < total) return { ok: false, key: "eco.balance.low", params: { need: total, have: meta.coins } };
  return { ok: true, key: "case.ready", params: { count: pulls, price: total, keys: 0 } };
};

export const openCase = (player: Player, caseId: CaseId, count: number, useKeys: boolean): OpenResult => {
  const pulls = clamp(Math.floor(count), 1, RANDOM_LIMIT);
  const check = canOpen(player, caseId, pulls, useKeys);
  if (!check.ok) return check;
  const meta = metaOf(player);
  const price = casePrice(caseId);
  let paid = 0;
  if (useKeys) {
    const need = price.keys * pulls;
    if (need > 0 && !payKeys(player, need)) return { ok: false, key: "case.keys.missing", params: { need, have: meta.caseKeys } };
  } else {
    const discount = pulls >= 5 ? (100 - CASE_ECONOMY.fivePullDiscountPercent) / 100 : 1;
    paid = Math.round(price.coins * pulls * discount);
    if (paid > 0) {
      const burned = burn(player, paid, `case ${caseId} x${pulls}`);
      if (!burned.ok) return { ok: false, key: burned.key, params: burned.params };
    }
  }
  const lines: string[] = [];
  for (let index = 0; index < pulls; index += 1) {
    const pityActive = meta.pity + 1 >= CASE_ECONOMY.pityPulls;
    const pool = CASES[caseId].pool;
    const filtered = pityActive ? pool.filter((entry) => entry.rarity === "legendary") : pool;
    const entry = roll(filtered.length > 0 ? filtered : pool);
    if (!entry) continue;
    meta.pity = entry.rarity === "legendary" ? 0 : meta.pity + 1;
    const stack = buildItem(entry);
    if (!stack) continue;
    for (let roll2 = 0; roll2 < Math.max(1, CASES[caseId].rolls); roll2 += 1) {
      give(player, roll2 === 0 ? stack : stack.clone());
    }
    meta.casePulls += 1;
    stats.pulls += 1;
    bump(stats.byCase, caseId);
    bump(stats.byRarity, entry.rarity);
    bump(stats.byItem, entry.item);
    pushLog({
      t: Date.now(),
      player: player.name,
      caseId,
      item: entry.item,
      amount: stack.amount,
      rarity: entry.rarity,
      paid: Math.round(paid / pulls),
      pity: pityActive,
    });
    lines.push(`${pityActive ? "§6[гарант] " : ""}${RARITY_COLOR[entry.rarity]}${entry.item.replace("minecraft:", "")} x${stack.amount}`);
    if (entry.rarity === "legendary") {
      broadcast(t(player, "case.legendary", { player: player.name, item: entry.item.replace("minecraft:", ""), case: CASES[caseId].label }));
    }
  }
  meta.updatedAt = Date.now();
  markDirty(player.id);
  persist(true);
  audit("cases", "open", player.name, `${caseId} x${pulls} за ${useKeys ? `${price.keys * pulls} ключей` : `${paid} монет`}`);
  return { ok: true, key: "case.result", params: { count: pulls, paid: paid > 0 ? paid : price.keys * pulls }, lines };
};

export const caseLogFor = (playerName: string, count: number): string[] => {
  const rows = caseLog.filter((row) => row.player === playerName).slice(-count);
  if (rows.length === 0) return ["выпадений нет"];
  return rows.map((row) => {
    const time = new Date(row.t).toISOString().slice(0, 16).replace("T", " ");
    return `${time} ${row.caseId}: ${RARITY_COLOR[row.rarity]}${row.item.replace("minecraft:", "")} x${row.amount}${row.pity ? " [гарант]" : ""} — ${row.paid}`;
  });
};

export const recentCaseLog = (count: number): string[] => {
  const rows = caseLog.slice(-count);
  if (rows.length === 0) return ["журнал кейсов пуст"];
  return rows.map((row) => {
    const time = new Date(row.t).toISOString().slice(11, 19);
    return `${time} ${row.player}: ${row.caseId} → ${row.item.replace("minecraft:", "")} x${row.amount} (${row.rarity}${row.pity ? ", гарант" : ""})`;
  });
};

export const caseStatsLines = (): string[] => {
  const lines = [`всего вскрытий: ${stats.pulls}`];
  for (const [rarity, value] of Object.entries(stats.byRarity)) {
    const percent = stats.pulls > 0 ? (value / stats.pulls) * 100 : 0;
    lines.push(`${rarity}: ${value} (${percent.toFixed(2)}%)`);
  }
  const top = Object.entries(stats.byItem)
    .sort((left, right) => right[1] - left[1])
    .slice(0, CASE_ECONOMY.maxStatsEntries);
  if (top.length > 0) {
    lines.push("топ предметов:");
    for (const [item, value] of top.slice(0, 10)) lines.push(`  ${item.replace("minecraft:", "")}: ${value}`);
  }
  return lines;
};

export const pityOf = (player: Player): { value: number; need: number } => ({
  value: metaOf(player).pity,
  need: CASE_ECONOMY.pityPulls,
});

export const flushCases = (): void => {
  persist();
};

const broadcast = (text: string): void => {
  for (const player of world.getAllPlayers()) {
    try {
      player.sendMessage(text);
    } catch {
      continue;
    }
  }
};
