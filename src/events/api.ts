import { Player, Vector3, world } from "@minecraft/server";
import { t } from "../kernel/i18n";
import { log } from "../kernel/logger";
import { distance3d } from "../kernel/util";
import { effectivePlaySeconds, getProfile } from "../meta/profiles";
import { audit } from "../security/audit";
import { recordEvent } from "../meta/progress";
import { EVENT_SCHEDULE } from "./config";
import { giveStacks, rollTable } from "./loot";
import type { ActiveEvent, LootTable } from "./types";

export const announce = (key: string, params?: Record<string, string | number>): void => {
  for (const player of world.getAllPlayers()) {
    try {
      player.sendMessage(t(player, key, params));
    } catch {
      continue;
    }
  }
};

export const announceTo = (player: Player, key: string, params?: Record<string, string | number>): void => {
  try {
    player.sendMessage(t(player, key, params));
  } catch {
    return;
  }
};

export const titleAll = (key: string, params?: Record<string, string | number>, subtitleKey?: string): void => {
  for (const player of world.getAllPlayers()) {
    try {
      player.onScreenDisplay.setTitle(t(player, key, params), {
        subtitle: subtitleKey ? t(player, subtitleKey, params) : undefined,
        fadeInDuration: 10,
        stayDuration: 50,
        fadeOutDuration: 15,
      });
    } catch {
      continue;
    }
  }
};

export const titleAllNamed = (titleKey: string, nameKey: string): void => {
  for (const player of world.getAllPlayers()) {
    try {
      player.onScreenDisplay.setTitle(t(player, titleKey, { name: t(player, nameKey) }), {
        subtitle: t(player, nameKey),
        fadeInDuration: 10,
        stayDuration: 60,
        fadeOutDuration: 15,
      });
    } catch {
      continue;
    }
  }
};

export const soundAll = (soundId: string, pitch = 1): void => {
  for (const player of world.getAllPlayers()) {
    try {
      player.playSound(soundId, { pitch });
    } catch {
      continue;
    }
  }
};

export const actionBarAll = (key: string, params?: Record<string, string | number>): void => {
  for (const player of world.getAllPlayers()) {
    try {
      player.onScreenDisplay.setActionBar(t(player, key, params));
    } catch {
      continue;
    }
  }
};

export const eligibleForReward = (player: Player): boolean => {
  const profile = getProfile(player);
  if (profile.banned) return false;
  if (Date.now() - profile.joinedAt < EVENT_SCHEDULE.minAccountAgeMs) return false;
  return effectivePlaySeconds(player) >= EVENT_SCHEDULE.minPlaySecondsForRewards;
};

export const markAwarded = (active: ActiveEvent, playerId: string): boolean => {
  const map = (active.data.awarded as Record<string, boolean> | undefined) ?? {};
  if (map[playerId]) return true;
  map[playerId] = true;
  active.data.awarded = map;
  return false;
};

export const grantLoot = (
  active: ActiveEvent,
  player: Player,
  table: LootTable,
  reason: string,
): boolean => {
  if (markAwarded(active, player.id)) return false;
  if (!eligibleForReward(player)) {
    announceTo(player, "ev.reward.ineligible", { minutes: Math.floor(EVENT_SCHEDULE.minPlaySecondsForRewards / 60) });
    audit("events", "reward-denied", player.name, `${active.id}: ${reason}, мало времени в мире`);
    return false;
  }
  const stacks = rollTable(table);
  giveStacks(player, stacks);
  recordEvent(player);
  audit("events", "reward", player.name, `${active.id}: ${reason}, ${stacks.length} предметов`);
  return true;
};

export const playersInRadius = (center: Vector3, radius: number, dimensionId: string): Player[] =>
  world
    .getAllPlayers()
    .filter((player) => {
      if (player.dimension.id !== dimensionId) return false;
      return distance3d(player.location, center) <= radius;
    });

export const pickRandom = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];

export const randomPlayer = (): Player | undefined => {
  const players = world.getAllPlayers();
  if (players.length === 0) return undefined;
  return players[Math.floor(Math.random() * players.length)];
};

export const numData = (active: ActiveEvent, key: string, fallback = 0): number => {
  const value = active.data[key];
  return typeof value === "number" ? value : fallback;
};

export const strData = (active: ActiveEvent, key: string): string => {
  const value = active.data[key];
  return typeof value === "string" ? value : "";
};

export const mapData = <T>(active: ActiveEvent, key: string): Record<string, T> => {
  const value = active.data[key];
  if (value && typeof value === "object") return value as Record<string, T>;
  const created: Record<string, T> = {};
  active.data[key] = created;
  return created;
};

export const safe = (scope: string, fn: () => void): void => {
  try {
    fn();
  } catch (error) {
    log.error(`events:${scope}`, String(error));
  }
};

export const removeEventTag = (tag: string): void => {
  for (const player of world.getAllPlayers()) {
    try {
      const entities = player.dimension.getEntities({ tags: [tag] });
      for (const entity of entities) entity.removeTag(tag);
    } catch {
      continue;
    }
  }
};
