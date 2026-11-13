import { Entity, Dimension, Player, Vector3, world } from "@minecraft/server";
import { log } from "../../kernel/logger";
import { distance3d } from "../../kernel/util";
import {
  announce,
  grantLoot,
  mapData,
  markAwarded,
  numData,
  pickRandom,
  randomPlayer,
  soundAll,
  strData,
  titleAll,
} from "../api";
import { EVENTS } from "../config";
import { queuePendingById } from "../pending";
import type { ActiveEvent, EventHandler, FinishReason } from "../types";

const CONFIG = EVENTS.bossraid;
const TAG = "sw:boss";

type BossKind = "custom" | "fallback" | "none";

const findBoss = (dimensionId: string, center: Vector3): Entity | undefined => {
  try {
    const dimension = world.getDimension(dimensionId);
    const entities = dimension.getEntities({ tags: [TAG], location: center, maxDistance: CONFIG.searchRadius });
    if (entities.length === 0) return undefined;
    let best = entities[0];
    let bestDistance = distance3d(best.location, center);
    for (const entity of entities) {
      const current = distance3d(entity.location, center);
      if (current < bestDistance) {
        best = entity;
        bestDistance = current;
      }
    }
    return best;
  } catch (error) {
    log.debug("events:boss", `поиск: ${String(error)}`);
    return undefined;
  }
};

const fireBossEvent = (dimension: Dimension, event: string): boolean => {
  try {
    return dimension.runCommand(`event entity @e[tag=${TAG},limit=4] ${event}`).successCount > 0;
  } catch (error) {
    log.warn("events:boss", `событие ${event}: ${String(error)}`);
    return false;
  }
};

const spawnBoss = (dimension: Dimension, spot: Vector3): { entity: Entity; kind: BossKind } | undefined => {
  try {
    const entity = dimension.spawnEntity(CONFIG.entityId, spot);
    entity.addTag(TAG);
    return { entity, kind: "custom" };
  } catch (error) {
    log.warn("events:boss", `кастомный босс недоступен: ${String(error)}`);
  }
  try {
    const entity = dimension.spawnEntity(CONFIG.fallbackEntityId, spot);
    entity.addTag(TAG);
    const seconds = Math.round(CONFIG.durationMs / 1000);
    entity.addEffect("health_boost", seconds, { amplifier: CONFIG.healthBoostAmplifier, showParticles: false });
    entity.addEffect("resistance", seconds, { amplifier: 2, showParticles: false });
    return { entity, kind: "fallback" };
  } catch (error) {
    log.error("events:boss", `спавн босса: ${String(error)}`);
    return undefined;
  }
};

const applyBossName = (entity: Entity, kind: BossKind): void => {
  try {
    entity.nameTag = kind === "custom" ? CONFIG.nameTag : `${CONFIG.nameTag} (§8${kind}§r)`;
  } catch (error) {
    log.debug("events:boss", `имя: ${String(error)}`);
  }
};

const spawnMinions = (boss: Entity): void => {
  for (let index = 0; index < CONFIG.minionCount; index += 1) {
    const angle = (Math.PI * 2 * index) / CONFIG.minionCount;
    try {
      const minion = boss.dimension.spawnEntity(pickRandom(CONFIG.minions), {
        x: boss.location.x + Math.cos(angle) * 4,
        y: boss.location.y + 1,
        z: boss.location.z + Math.sin(angle) * 4,
      });
      minion.addEffect("speed", 600, { amplifier: 1, showParticles: false });
    } catch (error) {
      log.error("events:boss", `миньон: ${String(error)}`);
    }
  }
};

const healthRatio = (boss: Entity): number => {
  try {
    const health = boss.getComponent("minecraft:health");
    if (!health || health.effectiveMax <= 0) return 0;
    return Math.max(0, Math.min(1, health.currentValue / health.effectiveMax));
  } catch {
    return 0;
  }
};

const bossParticle = (boss: Entity): void => {
  const spot = { x: boss.location.x, y: boss.location.y + 1.2, z: boss.location.z };
  try {
    boss.dimension.spawnParticle(CONFIG.particle, spot);
  } catch {
    try {
      boss.dimension.spawnParticle("minecraft:endrod", spot);
    } catch {
      return;
    }
  }
};

const rewardByDamage = (active: ActiveEvent, reason: string): void => {
  const damage = mapData<number>(active, "damage");
  const participation = mapData<number>(active, "participation");
  const names = mapData<string>(active, "names");
  const total = Object.values(damage).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return;
  const rows = Object.entries(damage)
    .map(([playerId, value]) => ({ playerId, share: value / total }))
    .filter((row) => row.share >= CONFIG.minDamageShare)
    .sort((left, right) => right.share - left.share);

  for (const row of rows) {
    if ((participation[row.playerId] ?? 0) < CONFIG.minParticipationSeconds) continue;
    const player = world.getAllPlayers().find((candidate) => candidate.id === row.playerId);
    if (!player) {
      if (!markAwarded(active, row.playerId)) {
        queuePendingById(row.playerId, names[row.playerId] ?? row.playerId, "bossraid", `${reason} share=${Math.round(row.share * 100)}%`);
      }
      continue;
    }
    const granted = grantLoot(active, player, CONFIG.loot, `${reason} share=${(row.share * 100).toFixed(0)}%`);
    if (granted) announce("ev.boss.reward", { player: player.name, share: Math.round(row.share * 100) });
  }
};

const locateBossSpot = (active: ActiveEvent): Vector3 => ({
  x: numData(active, "x"),
  y: numData(active, "y"),
  z: numData(active, "z"),
});

export const bossraidEvent: EventHandler = {
  id: "bossraid",
  minPlayers: CONFIG.minPlayers,
  defaultDurationMs: CONFIG.durationMs,

  start(active: ActiveEvent): void {
    const anchor = randomPlayer();
    const base = anchor?.location ?? { x: 0, y: 80, z: 0 };
    const dimension = anchor?.dimension ?? world.getDimension("overworld");
    const angle = Math.random() * Math.PI * 2;
    const spot = {
      x: base.x + Math.cos(angle) * CONFIG.spawnRadius,
      y: base.y + 1,
      z: base.z + Math.sin(angle) * CONFIG.spawnRadius,
    };
    const spawned = spawnBoss(dimension, spot);
    active.data.bossId = spawned?.entity.id ?? "";
        active.data.dimensionId = dimension.id;
    active.data.damage = {};
    active.data.participation = {};
    active.data.names = {};
    active.data.phase = 0;
    active.data.x = spot.x;
    active.data.y = spot.y;
    active.data.z = spot.z;
    if (spawned) {
      applyBossName(spawned.entity, spawned.kind);
      const health = spawned.entity.getComponent("minecraft:health");
      announce("ev.boss.coords", {
        x: Math.round(spot.x),
        y: Math.round(spot.y),
        z: Math.round(spot.z),
        hp: health ? Math.round(health.effectiveMax) : "320",
        kind: spawned.kind,
      });
    } else {
      announce("ev.boss.failed", {});
    }
    titleAll("ev.boss.title", undefined, "ev.boss.subtitle");
    soundAll(CONFIG.soundSpawn, 0.6);
  },

  resume(active: ActiveEvent): void {
    const dimensionId = strData(active, "dimensionId") || "overworld";
    const bossId = strData(active, "bossId");
    const known = bossId ? world.getEntity(bossId) : undefined;
    if (known) return;
    const found = findBoss(dimensionId, locateBossSpot(active));
    if (!found) return;
    active.data.bossId = found.id;
    applyBossName(found, "custom");
    announce("ev.boss.resume", {});
  },

  tick(active: ActiveEvent, now: number): void {
    const bossId = strData(active, "bossId");
    if (!bossId) return;
    const boss = world.getEntity(bossId);
    if (!boss) {
      if (numData(active, "reported", 0) === 0) {
        active.data.reported = 1;
        announce("ev.boss.lost", {});
        rewardByDamage(active, "lost");
      }
      return;
    }

    const participation = mapData<number>(active, "participation");
    const names = mapData<string>(active, "names");
    for (const player of world.getAllPlayers()) {
      names[player.id] = player.name;
      if (player.dimension.id !== boss.dimension.id) continue;
      if (distance3d(player.location, boss.location) <= CONFIG.nearRadius) {
        participation[player.id] = (participation[player.id] ?? 0) + 1;
      }
    }

    const ratio = healthRatio(boss);
    const phase = numData(active, "phase");
    const thresholds = CONFIG.phaseThresholds;
    if (phase < thresholds.length && ratio <= thresholds[phase]) {
      active.data.phase = phase + 1;
      const event = CONFIG.phaseEvents[phase];
      const applied = event ? fireBossEvent(boss.dimension, event) : false;
      spawnMinions(boss);
      boss.addEffect("strength", 900, { amplifier: phase + 1, showParticles: false });
      boss.addEffect("speed", 900, { amplifier: phase, showParticles: false });
      announce("ev.boss.phase", { phase: phase + 2, percent: Math.round(ratio * 100), mode: applied ? "entity" : "effects" });
      soundAll(CONFIG.soundPhase, 1);
      return;
    }

    if (now - numData(active, "lastPulseAt") > CONFIG.particleEveryMs) {
      active.data.lastPulseAt = now;
      bossParticle(boss);
    }

    if (now - numData(active, "lastAnnounceAt") > CONFIG.announceEveryMs) {
      active.data.lastAnnounceAt = now;
      announce("ev.boss.live", { percent: Math.round(ratio * 100), x: Math.round(boss.location.x), z: Math.round(boss.location.z) });
    }
  },

  onEntityHurt(active: ActiveEvent, entity: Entity, attacker: Player, damage: number): void {
    if (entity.id !== strData(active, "bossId")) return;
    const damageMap = mapData<number>(active, "damage");
    damageMap[attacker.id] = (damageMap[attacker.id] ?? 0) + Math.max(0, damage);
  },

  onEntityDie(active: ActiveEvent, entity: Entity, killer: Player | undefined): void {
    if (entity.id !== strData(active, "bossId")) return;
    titleAll("ev.boss.defeated", undefined);
    soundAll(CONFIG.soundKill, 0.9);
    if (killer) announce("ev.boss.killer", { player: killer.name });
    rewardByDamage(active, "defeated");
    active.data.bossId = "";
  },

  finish(active: ActiveEvent, reason: FinishReason): void {
    const bossId = strData(active, "bossId");
    if (bossId) {
      const boss = world.getEntity(bossId);
      if (boss) {
        try {
          boss.remove();
        } catch (error) {
          log.error("events:boss", `удаление: ${String(error)}`);
        }
      }
      rewardByDamage(active, reason === "manual" ? "cancelled" : "timeout");
    }
    active.data.bossId = "";
    if (reason === "manual" || reason === "timeout") announce("ev.boss.end", {});
  },
};
