import { Entity, Player, world } from "@minecraft/server";
import { log } from "../../kernel/logger";
import { distance3d } from "../../kernel/util";
import { announce, numData, pickRandom, randomPlayer, removeEventTag, soundAll, titleAll } from "../api";
import { EVENTS } from "../config";
import { giveStacks, rollTable } from "../loot";
import type { ActiveEvent, EventHandler, FinishReason } from "../types";

const CONFIG = EVENTS.bloodmoon;
const TAG = "sw:bloodmoon";

const spawnWave = (active: ActiveEvent): void => {
  const players = world.getAllPlayers();
  if (players.length === 0) return;
  for (let index = 0; index < CONFIG.waveSize; index += 1) {
    const anchor = pickRandom(players);
    const angle = Math.random() * Math.PI * 2;
    const distance = 6 + Math.random() * CONFIG.waveRadius;
    const spot = {
      x: anchor.location.x + Math.cos(angle) * distance,
      y: anchor.location.y + 2,
      z: anchor.location.z + Math.sin(angle) * distance,
    };
    try {
      const mob = anchor.dimension.spawnEntity(pickRandom(CONFIG.mobs), spot);
      mob.addTag(TAG);
      mob.addEffect("strength", CONFIG.effectDurationSec, { amplifier: 1, showParticles: false });
      mob.addEffect("speed", CONFIG.effectDurationSec, { amplifier: 0, showParticles: false });
      mob.addEffect("resistance", CONFIG.effectDurationSec, { amplifier: 0, showParticles: false });
      if (Math.random() < 0.25) mob.nameTag = "§4Кровавый моб";
    } catch (error) {
      log.error("events:bloodmoon", `спавн: ${String(error)}`);
    }
  }
  active.data.lastWaveAt = Date.now();
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
    announce("ev.bloodmoon.bonus", { player: killer.name, item: stacks.map((stack) => stack.typeId.replace("minecraft:", "")).join(", ") });
  },

  finish(active: ActiveEvent, reason: FinishReason): void {
    removeEventTag(TAG);
    if (reason === "timeout" || reason === "completed") {
      titleAll("ev.bloodmoon.end", undefined);
      soundAll("random.levelup", 0.8);
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
