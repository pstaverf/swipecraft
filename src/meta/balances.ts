import { log } from "../kernel/logger";
import { loadWorldJson, saveWorldJson } from "../kernel/store";
import { notifyAdmins } from "../security/audit";
import { META_KEYS } from "./config";
import { createPlayerMeta } from "./defaults";
import type { PlayerMeta } from "../types/domain";

const MAX_BYTES = 2_000_000;
const PRUNE_AFTER_MS = 60 * 24 * 60 * 60 * 1000;

const cache = new Map<string, PlayerMeta>();
const dirty = new Set<string>();

let loaded = false;
let blocked = false;
let lastBytes = 0;

const snapshot = (): Record<string, PlayerMeta> => {
  const data: Record<string, PlayerMeta> = {};
  for (const [id, record] of cache) data[id] = record;
  return data;
};

export const loadBalances = (): number => {
  const stored = loadWorldJson<Record<string, PlayerMeta> | undefined>(META_KEYS.balances, undefined);
  if (stored) {
    for (const [id, record] of Object.entries(stored)) {
      if (!record || typeof record !== "object") continue;
      cache.set(id, { ...createPlayerMeta(record.name ?? id), ...record });
    }
  }
  loaded = true;
  return cache.size;
};

export const isLoaded = (): boolean => loaded;

export const getMeta = (playerId: string, name: string): PlayerMeta => {
  const existing = cache.get(playerId);
  if (existing) {
    if (name.length > 0 && existing.name !== name) {
      existing.name = name;
      dirty.add(playerId);
    }
    return existing;
  }
  const created = createPlayerMeta(name);
  cache.set(playerId, created);
  dirty.add(playerId);
  return created;
};

export const peekMeta = (playerId: string): PlayerMeta | undefined => cache.get(playerId);

export const markDirty = (playerId: string): void => {
  dirty.add(playerId);
};

export const flushBalances = (): number => {
  if (dirty.size === 0) return 0;
  const data = snapshot();
  const bytes = JSON.stringify(data).length;
  lastBytes = bytes;
  if (bytes > MAX_BYTES) {
    if (!blocked) {
      blocked = true;
      log.error("balances", `хранилище переполнено: ${bytes} > ${MAX_BYTES}, запись приостановлена`);
      notifyAdmins(`[eco] Хранилище балансов переполнено (${bytes} байт). Данные в памяти, на диск не пишемся: сократи архив через админ-меню.`);
    }
    return -1;
  }
  blocked = false;
  saveWorldJson(META_KEYS.balances, data);
  dirty.clear();
  return Object.keys(data).length;
};

export const pruneBalances = (inactiveDays: number): number => {
  const cutoff = Date.now() - Math.max(1, inactiveDays) * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [id, record] of cache) {
    if (record.updatedAt >= cutoff) continue;
    if (record.coins > 0 || record.lockedCoins > 0 || record.caseKeys > 0) continue;
    cache.delete(id);
    dirty.delete(id);
    removed += 1;
  }
  if (removed > 0) {
    for (const id of cache.keys()) dirty.add(id);
    log.warn("balances", `удалено записей: ${removed}`);
  }
  return removed;
};

export const balancesReport = (): string[] => {
  let withCoins = 0;
  let total = 0;
  let stale = 0;
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  for (const record of cache.values()) {
    total += record.coins + record.lockedCoins;
    if (record.coins + record.lockedCoins > 0) withCoins += 1;
    if (record.updatedAt < cutoff) stale += 1;
  }
  return [
    `записей: ${cache.size}, не записано на диск: ${dirty.size}`,
    `сумма на руках: ${total}, байт: ${lastBytes}/${MAX_BYTES}`,
    `недавно не активны (>60 дней): ${stale}`,
    `запись на диск: ${blocked ? "заблокирована (переполнение)" : "нормально"}`,
    `игроков с балансом: ${withCoins}`,
  ];
};

export const allMeta = (): PlayerMeta[] => [...cache.values()];

export const metaCount = (): number => cache.size;
