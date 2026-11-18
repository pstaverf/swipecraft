import { Block, Dimension, Entity, Player, Vector3, world } from "@minecraft/server";
import { log } from "../../kernel/logger";
import { distance3d } from "../../kernel/util";
import { announce, numData, pickRandom, randomPlayer, removeEventTag, soundAll, titleAll } from "../api";
import { EVENTS } from "../config";
import { giveStacks, rollTable } from "../loot";
import type { ActiveEvent, EventHandler, FinishReason } from "../types";

const CONFIG = EVENTS.bloodmoon;
const TAG = "sw:bloodmoon";

const HAZARD_BLOCKS = ["lava", "water", "powder_snow", "fire", "cactus", "vine", "cobweb", "sculk_vein"];

const isAirLike = (block: Block | undefined): boolean => {
  if (!block) return false;
  try {
    return block.isAir;
  } catch {
    return false;
  }
};

const isHazard = (block: Block | undefined): boolean => {
  if (!block) return true;
  try {
    if (block.isLiquid) return true;
    const id = block.typeId;
    return HAZARD_BLOCKS.some((part) => id.includes(part));
  } catch {
    return true;
  }
};

const topGround = (dimension: Dimension, x: number, z: number, nearY: number): Block | undefined => {
  try {
    const top = dimension.getTopmostBlock({ x, z }, Math.max(-60, nearY - 16));
    if (top) return top;
  } catch (error) {
    log.debug("events:bloodmoon", `getTopmostBlock: ${String(error)}`);
  }
  for (let depth = 0; depth <= 10; depth += 1) {
    let block: Block | undefined;
    try {
      block = dimension.getBlock({ x, y: nearY - depth, z });
    } catch {
      return undefined;
    }
    if (!block) continue;
    if (isAirLike(block) || isHazard(block)) continue;
    return block;
  }
  return undefined;
};

export const safeSpawnSpot = (dimension: Dimension, origin: Vector3): Vector3 | undefined => {
  for (let attempt = 0; attempt < CONFIG.spawnAttempts; attempt += 1) {
    const angle = Math.random() * Math.PI * 2;
    const distance = CONFIG.spawnMinRadius + Math.random() * (CONFIG.spawnMaxRadius - CONFIG.spawnMinRadius);
    const x = Math.round(origin.x + Math.cos(angle) * distance);
    const z = Math.round(origin.z + Math.sin(angle) * distance);
    const ground = topGround(dimension, x, z, Math.round(origin.y));
    if (!ground) continue;
    const feet = { x, y: ground.y + 1, z };
    let blocked = false;
    for (let step = 0; step < CONFIG.headroom; step += 1) {
      let air: Block | undefined;
      try {
        air = dimension.getBlock({ x: feet.x, y: feet.y + step, z: feet.z });
      } catch {
        blocked = true;
        break;
      }
      if (!isAirLike(air) || isHazard(air)) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    const below = dimension.getBlock({ x, y: ground.y, z });
    if (!below || isAirLike(below) || isHazard(below)) continue;
    return { x: x + 0.5, y: feet.y, z: z + 0.5 };
  }
  return undefined;
};

const countAlive = (anchor: Player): number => {
  try {
    return anchor.dimension.getEntities({ tags: [TAG], location: anchor.location, maxDistance: 64 }).length;
  } catch {
    return 0;
  }
};

const damageStuck = (mob: Entity): void => {
  try {
    const block = mob.dimension.getBlock(mob.location);
    if (block && !isAirLike(block)) mob.applyDamage(1);
  } catch {
    return;
  }
};

const spawnWave = (active: ActiveEvent): void => {
  const players = world.getAllPlayers().filter((player) => player.dimension.id === "overworld");
  if (players.length === 0) return;
  let spawned = 0;
  let skipped = 0;
  for (let index = 0; index < CONFIG.waveSize; index += 1) {
    const anchor = pickRandom(players);
    if (countAlive(anchor) >= CONFIG.maxMobsAlive) {
      skipped += 1;
      continue;
    }
    const spot = safeSpawnSpot(anchor.dimension, anchor.location);
    if (!spot) {
      skipped += 1;
      continue;
    }
    try {
      const mob = anchor.dimension.spawnEntity(pickRandom(CONFIG.mobs), spot);
      mob.addTag(TAG);
      mob.addEffect("strength", CONFIG.effectDurationSec, { amplifier: 1, showParticles: false });
      mob.addEffect("speed", CONFIG.effectDurationSec, { amplifier: 0, showParticles: false });
      mob.addEffect("resistance", CONFIG.effectDurationSec, { amplifier: 0, showParticles: false });
      spawned += 1;
    } catch (error) {
      log.error("events:bloodmoon", `спавн: ${String(error)}`);
      skipped += 1;
    }
  }
  active.data.lastWaveAt = Date.now();
  active.data.spawned = numData(active, "spawned") + spawned;
  active.data.skipped = numData(active, "skipped") + skipped;
  if (spawned === 0 && skipped > 0) {
    announce("ev.bloodmoon.noPlace", {});
  }
};

const removeUnstuckable = (player: Player): number => {
  let removed = 0;
  try {
    const nearby = player.dimension.getEntities({ tags: [TAG], location: player.location, maxDistance: 48 });
    for (const entity of nearby) {
      if (distance3d(entity.location, player.location) > 48) continue;
      const block = player.dimension.getBlock(entity.location);
      if (block && !isAirLike(block)) {
        entity.remove();
        removed += 1;
      } else {
        damageStuck(entity);
      }
    }
  } catch {
    return removed;
  }
  return removed;
};

export const bloodmoonEvent: EventHandler = {
  id: "bloodmoon",
  minPlayers: CONFIG.minPlayers,
  defaultDurationMs: CONFIG.durationMs,

  start(active: ActiveEvent): void {
    try {
      world.setTimeOfDay(18000);
    } catch (error) {
      log.error("events:bloodmoon", `время: ${String(error)}`);
    }
    active.data.lastWaveAt = Date.now();
    active.data.waves = 0;
    active.data.spawned = 0;
    active.data.skipped = 0;
    active.data.bonus = 0;
    titleAll("ev.bloodmoon.title", undefined, "ev.bloodmoon.subtitle");
    soundAll("mob.wither.spawn", 0.7);
    announce("ev.bloodmoon.announce", { minutes: Math.round(CONFIG.durationMs / 60_000) });
    spawnWave(active);
  },

  resume(): void {
    try {
      world.setTimeOfDay(18000);
    } catch (error) {
      log.error("events:bloodmoon", `время: ${String(error)}`);
    }
  },

  tick(active: ActiveEvent, now: number): void {
    const last = numData(active, "lastWaveAt", now);
    if (now - last < CONFIG.waveEveryMs) return;
    active.data.waves = numData(active, "waves") + 1;
    spawnWave(active);
    for (const player of world.getAllPlayers()) removeUnstuckable(player);
    if (Math.random() < 0.2) {
      soundAll("ambient.cave", 0.6);
    }
  },

  onEntityDie(active: ActiveEvent, entity: Entity, killer: Player | undefined): void {
    if (!entity.hasTag(TAG)) return;
    if (!killer) return;
    if (Math.random() > CONFIG.bonusChance) return;
    const stacks = rollTable(CONFIG.bonusLoot);
    giveStacks(killer, stacks);
    active.data.bonus = numData(active, "bonus") + stacks.length;
    announce("ev.bloodmoon.bonus", { player: killer.name, item: stacks.map((stack) => stack.typeId.replace("minecraft:", "")).join(", ") });
  },

  finish(active: ActiveEvent, reason: FinishReason): void {
    removeEventTag(TAG);
    if (reason === "timeout" || reason === "completed") {
      titleAll("ev.bloodmoon.end", undefined);
      soundAll("random.levelup", 0.8);
      announce("ev.bloodmoon.summary", {
        waves: numData(active, "waves"),
        spawned: numData(active, "spawned"),
        skipped: numData(active, "skipped"),
        bonus: numData(active, "bonus"),
      });
    }
    active.data.lastWaveAt = 0;
    for (const player of world.getAllPlayers()) {
      try {
        const nearby = player.dimension
          .getEntities({ tags: [TAG], location: player.location, maxDistance: 48 })
          .filter((entity) => distance3d(entity.location, player.location) < 48);
        for (const entity of nearby) entity.remove();
      } catch {
        continue;
      }
    }
  },
};
