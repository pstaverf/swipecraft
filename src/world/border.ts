import { Player, Vector3, world } from "@minecraft/server";
import { CONFIG, STORE_KEYS } from "../config";
import { t } from "../kernel/i18n";
import { log } from "../kernel/logger";
import { loadWorldJson, saveWorldJson } from "../kernel/store";
import { registerTask } from "../kernel/ticker";
import { clamp, distance2d } from "../kernel/util";
import { grantGrace } from "../security/anticheat";
import { audit } from "../security/audit";
import { revertPlacement } from "./blocks";
import type { BorderState } from "../types/domain";
import { seasonStartedAt } from "./season";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

let state: BorderState = {
  radius: CONFIG.border.startRadius,
  updatedAt: 0,
  week: 0,
};

const warned = new Map<string, number>();
const placementWarn = new Map<string, number>();

export const borderRadius = (): number => state.radius;

export const borderInfo = (): BorderState => state;

const computeWeek = (): number => {
  const elapsed = Math.max(0, Date.now() - seasonStartedAt());
  return Math.floor(elapsed / WEEK_MS);
};

const computeRadius = (week: number): number =>
  clamp(CONFIG.border.startRadius - week * CONFIG.border.weeklyShrink, CONFIG.border.minRadius, CONFIG.border.startRadius);

const persist = (): void => {
  try {
    saveWorldJson(STORE_KEYS.border, state);
  } catch (error) {
    log.error("border", `не удалось сохранить состояние: ${String(error)}`);
  }
};

const pushInside = (player: Player): void => {
  const center = { x: 0, z: 0 };
  const location = player.location;
  const dx = location.x - center.x;
  const dz = location.z - center.z;
  const length = Math.hypot(dx, dz) || 1;
  const target: Vector3 = {
    x: center.x + (dx / length) * (state.radius - 12),
    y: location.y,
    z: center.z + (dz / length) * (state.radius - 12),
  };
  try {
    player.teleport(target, { dimension: player.dimension });
    grantGrace(player.id, 2500);
    player.sendMessage(t(player, "border.push"));
  } catch {
    return;
  }
};

export const isOutsideBorder = (location: Vector3): boolean => distance2d(location, { x: 0, y: 0, z: 0 }) > state.radius;

let initialized = false;

export const initBorder = (): void => {
  if (initialized) return;
  initialized = true;

  const stored = loadWorldJson<BorderState | undefined>(STORE_KEYS.border, undefined);
  if (stored) {
    state = stored;
  } else {
    state = { radius: CONFIG.border.startRadius, updatedAt: Date.now(), week: computeWeek() };
    persist();
  }

  world.afterEvents.playerPlaceBlock.subscribe((event) => {
    if (!isOutsideBorder(event.block.location)) return;
    revertPlacement(event.player, event.block);
    const now = Date.now();
    const last = placementWarn.get(event.player.id) ?? 0;
    if (now - last > 10_000) {
      placementWarn.set(event.player.id, now);
      try {
        event.player.onScreenDisplay.setActionBar(t(event.player, "border.blocked"));
      } catch {
        return;
      }
    }
  });

  registerTask("border-watch", CONFIG.border.checkEveryTicks, 6, () => {
    const week = computeWeek();
    if (week !== state.week) {
      state.week = week;
      state.radius = computeRadius(week);
      state.updatedAt = Date.now();
      persist();
      audit("border", "shrink", "world", `неделя ${week}, радиус ${state.radius}`);
      for (const player of world.getAllPlayers()) {
        try {
          player.sendMessage(t(player, "border.info", { radius: state.radius, week }));
        } catch {
          continue;
        }
      }
    }

    const players = world.getAllPlayers();
    if (players.length === 0) return;
    const divisor = Math.max(1, CONFIG.border.sampleDivisor);
    const start = (Date.now() / 1000) % divisor;
    const index = Math.floor(start) % divisor;
    for (let offset = index; offset < players.length; offset += divisor) {
      const player = players[offset];
      const distance = distance2d(player.location, { x: 0, y: 0, z: 0 });
      if (distance > state.radius) {
        pushInside(player);
        continue;
      }
      const remaining = state.radius - distance;
      if (remaining < CONFIG.border.warnDistance) {
        const now = Date.now();
        const last = warned.get(player.id) ?? 0;
        if (now - last > 15_000) {
          warned.set(player.id, now);
          try {
            player.onScreenDisplay.setActionBar(t(player, "border.warn", { blocks: Math.round(remaining) }));
          } catch {
            continue;
          }
        }
      }
    }
  });
};
