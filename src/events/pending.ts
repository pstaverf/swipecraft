import { Player } from "@minecraft/server";
import { audit } from "../security/audit";
import { announceTo, eligibleForReward } from "./api";
import { EVENTS } from "./config";
import { giveStacks, rollTable } from "./loot";
import type { EventId, LootTable, PendingReward } from "./types";

export type { PendingReward };

const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const queue: PendingReward[] = [];

const TABLES: Partial<Record<EventId, LootTable>> = {
  koth: EVENTS.koth.loot,
  bossraid: EVENTS.bossraid.loot,
  bountyhunt: EVENTS.bountyhunt.loot,
};

export const pendingQueue = (): PendingReward[] => queue;

export const loadPending = (items: PendingReward[]): void => {
  queue.length = 0;
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const item of items) {
    if (!item || typeof item.playerId !== "string") continue;
    if (!TABLES[item.event]) continue;
    if (typeof item.at !== "number" || item.at < cutoff) continue;
    queue.push(item);
  }
};

export const queuePending = (player: Player, event: EventId, reason: string): void => {
  if (!TABLES[event]) return;
  if (queue.some((item) => item.playerId === player.id && item.event === event)) return;
  queue.push({ playerId: player.id, playerName: player.name, event, reason, at: Date.now() });
  audit("events", "reward-pending", player.name, `${event}: ${reason}`);
};

export const queuePendingById = (playerId: string, playerName: string, event: EventId, reason: string): void => {
  if (!TABLES[event]) return;
  if (queue.some((item) => item.playerId === playerId && item.event === event)) return;
  queue.push({ playerId, playerName, event, reason, at: Date.now() });
  audit("events", "reward-pending", playerName, `${event}: ${reason}`);
};

export const flushPendingFor = (player: Player): number => {
  const due = queue.filter((item) => item.playerId === player.id);
  if (due.length === 0) return 0;
  if (!eligibleForReward(player)) return -due.length;
  let granted = 0;
  for (const item of due) {
    const table = TABLES[item.event];
    if (!table) continue;
    const stacks = rollTable(table);
    giveStacks(player, stacks);
    const index = queue.indexOf(item);
    if (index >= 0) queue.splice(index, 1);
    granted += 1;
    announceTo(player, "ev.pending", { count: stacks.length });
    audit("events", "reward-pending-paid", player.name, `${item.event}: ${item.reason}`);
  }
  return granted;
};

export const pendingCount = (): number => queue.length;
