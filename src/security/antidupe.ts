import { Player, world } from "@minecraft/server";
import { getAcConfig } from "./anticheat/config";
import { registerTask } from "../kernel/ticker";
import { audit } from "./audit";

const containerOps = new Map<string, number[]>();
const pickupOps = new Map<string, number[]>();
const lastDeath = new Map<string, number>();

const prune = (times: number[], windowMs: number): void => {
  const limit = Date.now() - windowMs;
  while (times.length > 0 && times[0] < limit) times.shift();
};

const track = (store: Map<string, number[]>, playerId: string, windowMs: number): number => {
  const list = store.get(playerId) ?? [];
  list.push(Date.now());
  prune(list, windowMs);
  store.set(playerId, list);
  return list.length;
};

const isContainer = (typeId: string): boolean =>
  typeId.includes("chest") ||
  typeId.includes("barrel") ||
  typeId.includes("shulker") ||
  typeId.includes("hopper") ||
  typeId.includes("furnace") ||
  typeId.includes("dispenser") ||
  typeId.includes("dropper") ||
  typeId.includes("brewing");

let initialized = false;

export const initAntiDupe = (): void => {
  if (initialized) return;
  initialized = true;

  world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    const player = event.player;
    if (!player) return;
    if (!isContainer(event.block.typeId)) return;
    const config = getAcConfig();
    const count = track(containerOps, player.id, config.limits.containerWindowMs);
    if (count > config.limits.containerOpsPerWindow) {
      event.cancel = true;
      audit("antidupe", "container-throttle", player.name, `${event.block.typeId} ${count} операций`);
    }
  });

  world.afterEvents.entityItemPickup.subscribe((event) => {
    const player = event.entity;
    if (!(player instanceof Player)) return;
    const config = getAcConfig();
    const count = track(pickupOps, player.id, config.limits.entityWindowMs);
    if (count > config.limits.entityOpsPerWindow * 3) {
      pickupOps.set(player.id, []);
      audit("antidupe", "pickup-flood", player.name, `${count} подборов за ${config.limits.entityWindowMs}мс`);
    }
  });

  world.afterEvents.entityDie.subscribe((event) => {
    if (event.deadEntity instanceof Player) lastDeath.set(event.deadEntity.id, Date.now());
  });

  world.afterEvents.playerSpawn.subscribe((event) => {
    const player = event.player;
    const died = lastDeath.get(player.id);
    if (died && Date.now() - died < 2500) {
      audit("antidupe", "fast-respawn", player.name, `респавн через ${Date.now() - died}мс после смерти`);
    }
  });

  world.beforeEvents.playerLeave.subscribe((event) => {
    containerOps.delete(event.player.id);
    pickupOps.delete(event.player.id);
  });

  registerTask("antidupe-cleanup", 1200, 2, () => {
    const now = Date.now();
    for (const [playerId, times] of containerOps.entries()) {
      const fresh = times.filter((time) => now - time < 10_000);
      if (fresh.length === 0) containerOps.delete(playerId);
      else containerOps.set(playerId, fresh);
    }
    for (const [playerId, times] of pickupOps.entries()) {
      const fresh = times.filter((time) => now - time < 10_000);
      if (fresh.length === 0) pickupOps.delete(playerId);
      else pickupOps.set(playerId, fresh);
    }
    for (const [playerId, time] of lastDeath.entries()) {
      if (now - time > 60_000) lastDeath.delete(playerId);
    }
  });
};
