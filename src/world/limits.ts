import { Player, world } from "@minecraft/server";
import { CONFIG } from "../config";
import { log } from "../kernel/logger";
import { registerTask } from "../kernel/ticker";
import { chunkKey } from "../kernel/util";
import { getAcConfig } from "../security/anticheat/config";
import { audit } from "../security/audit";
import { revertPlacement } from "./blocks";

const chunkCounters = new Map<string, number>();

const counterKey = (dimensionId: string, x: number, z: number, typeId: string): string =>
  `${dimensionId}|${chunkKey(x, z)}|${typeId}`;

const limitFor = (typeId: string): number => {
  const limits = getAcConfig().limits;
  if (typeId === "minecraft:hopper") return limits.hopperPerChunk;
  if (typeId === "minecraft:observer") return limits.observerPerChunk;
  if (typeId === "minecraft:piston" || typeId === "minecraft:sticky_piston") return limits.pistonPerChunk;
  return Number.MAX_SAFE_INTEGER;
};

const bump = (key: string, delta: number): number => {
  const current = chunkCounters.get(key) ?? 0;
  const next = Math.max(0, current + delta);
  chunkCounters.set(key, next);
  return next;
};

export const chunkCounterReport = (): string[] =>
  [...chunkCounters.entries()]
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 20)
    .map(([key, value]) => `${key}=${value}`);

let initialized = false;

export const initLimits = (): void => {
  if (initialized) return;
  initialized = true;

  world.afterEvents.playerPlaceBlock.subscribe((event) => {
    const typeId = event.block.typeId;
    const limit = limitFor(typeId);
    if (limit === Number.MAX_SAFE_INTEGER) return;
    const key = counterKey(event.block.dimension.id, event.block.location.x, event.block.location.z, typeId);
    const next = bump(key, 1);
    if (next > limit) {
      bump(key, -1);
      revertPlacement(event.player, event.block);
      try {
        event.player.onScreenDisplay.setActionBar(
          `Лимит ${typeId.replace("minecraft:", "")}: ${limit} на чанк`,
        );
      } catch {
        return;
      }
      audit("limits", "block-cap", event.player.name, `${typeId} в ${key}`);
    }
  });

  world.afterEvents.playerBreakBlock.subscribe((event) => {
    const typeId = event.brokenBlockPermutation.type.id;
    if (limitFor(typeId) === Number.MAX_SAFE_INTEGER) return;
    const key = counterKey(event.block.dimension.id, event.block.location.x, event.block.location.z, typeId);
    bump(key, -1);
  });

  registerTask("limits-tnt", CONFIG.limits.tntCheckTicks, 8, () => {
    const limits = getAcConfig().limits;
    for (const player of world.getAllPlayers()) {
      try {
        const tnt = player.dimension.getEntities({
          type: "minecraft:tnt",
          location: player.location,
          maxDistance: limits.tntAreaRadius,
        });
        if (tnt.length <= limits.maxTntPerArea) continue;
        const excess = tnt.length - limits.maxTntPerArea;
        for (let index = 0; index < excess; index += 1) {
          const entity = tnt[index];
          try {
            entity.remove();
          } catch {
            continue;
          }
        }
        audit("limits", "tnt-cap", player.name, `удалено ${excess} TNT в радиусе ${limits.tntAreaRadius}`);
        log.warn("limits", `TNT-кап: ${excess} сущностей убрано рядом с ${player.name}`);
      } catch {
        continue;
      }
    }
  });
};

export const entityCapFor = (player: Player): number => {
  const base = 60;
  try {
    const renderDistance = player.clientSystemInfo.maxRenderDistance;
    return Math.min(120, base + Math.floor(renderDistance / 2));
  } catch {
    return base;
  }
};
