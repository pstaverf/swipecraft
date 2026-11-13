import { BlockPermutation, world } from "@minecraft/server";
import { log } from "../../kernel/logger";
import { distance2d, randomPointInRing } from "../../kernel/util";
import { borderRadius } from "../../world/border";
import { announce, numData, soundAll, titleAll } from "../api";
import { EVENTS } from "../config";
import { fillContainer, rollTable } from "../loot";
import type { ActiveEvent, EventHandler, FinishReason } from "../types";

const CONFIG = EVENTS.airdrop;

const findSurface = (x: number, z: number): number | undefined => {
  try {
    const dimension = world.getDimension("overworld");
    const top = dimension.getTopmostBlock({ x, z });
    if (!top) return undefined;
    return Math.floor(top.location.y) + 1;
  } catch {
    return undefined;
  }
};

const spawnChest = (active: ActiveEvent): boolean => {
  const x = numData(active, "x");
  const y = numData(active, "y");
  const z = numData(active, "z");
  try {
    const dimension = world.getDimension("overworld");
    const block = dimension.getBlock({ x, y, z });
    if (!block) return false;
    block.setPermutation(BlockPermutation.resolve("minecraft:chest"));
    const container = block.getComponent("minecraft:inventory")?.container;
    if (container) {
      fillContainer(container, CONFIG.loot);
    } else {
      for (const stack of rollTable(CONFIG.loot)) {
        dimension.spawnItem(stack, { x: x + 0.5, y: y + 0.5, z: z + 0.5 });
      }
    }
    active.data.spawned = true;
    return true;
  } catch (error) {
    log.error("events:airdrop", `сундук: ${String(error)}`);
    return false;
  }
};

const beam = (active: ActiveEvent, progress: number): void => {
  const x = numData(active, "x");
  const y = numData(active, "y");
  const z = numData(active, "z");
  try {
    const dimension = world.getDimension("overworld");
    const height = 40 - Math.floor(40 * progress);
    for (let offset = 0; offset < height; offset += 4) {
      dimension.spawnParticle("minecraft:endrod", { x: x + 0.5, y: y + offset, z: z + 0.5 });
    }
  } catch {
    return;
  }
};

export const airdropEvent: EventHandler = {
  id: "airdrop",
  minPlayers: CONFIG.minPlayers,
  defaultDurationMs: CONFIG.durationMs,

  start(active: ActiveEvent): void {
    const border = Math.max(CONFIG.minRadius + 60, borderRadius() - 80);
    const maxRadius = Math.min(CONFIG.maxRadius, border);
    let point: { x: number; z: number } = randomPointInRing(CONFIG.minRadius, Math.max(CONFIG.minRadius + 20, maxRadius));
    let y = findSurface(point.x, point.z);
    for (let attempt = 0; attempt < 12 && y === undefined; attempt += 1) {
      point = randomPointInRing(CONFIG.minRadius, Math.max(CONFIG.minRadius + 20, maxRadius));
      y = findSurface(point.x, point.z);
    }
    if (y === undefined) {
      const fallback = world.getDimension("overworld").getTopmostBlock({ x: 0, z: 0 });
      y = fallback ? Math.floor(fallback.location.y) + 1 : 80;
      point = { x: 0, z: 0 };
    }
    active.data.x = point.x;
    active.data.y = y;
    active.data.z = point.z;
    active.data.spawned = false;
    active.data.landedAt = 0;

    titleAll("ev.airdrop.title", undefined, "ev.airdrop.subtitle");
    soundAll("mob.enderdragon.growl", 1.2);
    announce("ev.airdrop.coords", { x: point.x, y, z: point.z, dist: Math.round(distance2d({ x: point.x, y, z: point.z }, { x: 0, y: 0, z: 0 })) });
  },

  tick(active: ActiveEvent, now: number): void {
    const elapsed = now - active.startedAt;
    const progress = Math.min(1, elapsed / CONFIG.fallMs);
    if (progress < 1) {
      beam(active, progress);
      return;
    }
    if (active.data.spawned === true) return;
    const ok = spawnChest(active);
    active.data.landedAt = now;
    if (!ok) return;
    titleAll("ev.airdrop.landed", undefined);
    soundAll("random.anvil_land", 0.8);
    announce("ev.airdrop.open", {
      x: Math.round(numData(active, "x")),
      y: Math.round(numData(active, "y")),
      z: Math.round(numData(active, "z")),
    });
  },

  finish(active: ActiveEvent, reason: FinishReason): void {
    if (active.data.spawned !== true && reason !== "manual") {
      spawnChest(active);
    }
    if (active.data.spawned === true && reason === "timeout") {
      announce("ev.airdrop.timeout", {});
    }
  },
};
