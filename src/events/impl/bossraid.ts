import { Entity, Player, world } from "@minecraft/server";
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
      log.error("events:boss", `minion: ${String(error)}`);
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
      y: base.y + 2,
      z: base.z + Math.sin(angle) * CONFIG.spawnRadius,
    };
    let boss: Entity | undefined;
    try {
      boss = dimension.spawnEntity(CONFIG.entityId, spot);
      boss.nameTag = "§4Swipecraft Boss";
      boss.addTag(TAG);
      boss.addEffect("health_boost", Math.round(CONFIG.durationMs / 1000), {
        amplifier: 15,
        showParticles: false,
      });
      boss.addEffect("resistance", Math.round(CONFIG.durationMs / 1000), { amplifier: 2, showParticles: false });
      boss.addEffect("speed", Math.round(CONFIG.durationMs / 1000), { amplifier: 0, showParticles: false });
    } catch (error) {
      log.error("events:boss", `спавн босса: ${String(error)}`);
    }
    active.data.bossId = boss?.id ?? "";
    active.data.damage = {};
    active.data.participation = {};
    active.data.phase = 0;
    active.data.x = spot.x;
    active.data.y = spot.y;
    active.data.z = spot.z;

    titleAll("ev.boss.title", undefined, "ev.boss.subtitle");
    soundAll("mob.wither.spawn", 0.6);
    announce("ev.boss.coords", { x: Math.round(spot.x), y: Math.round(spot.y), z: Math.round(spot.z), hp: "320" });
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
      if (distance3d(player.location, boss.location) <= 40) {
        participation[player.id] = (participation[player.id] ?? 0) + 1;
      }
    }

    const ratio = healthRatio(boss);
    const phase = numData(active, "phase");
    if (phase === 0 && ratio <= CONFIG.phaseThresholds[0]) {
      active.data.phase = 1;
      spawnMinions(boss);
      boss.addEffect("strength", 900, { amplifier: 1, showParticles: false });
      announce("ev.boss.phase", { phase: 2, percent: Math.round(ratio * 100) });
      soundAll("random.explode", 0.7);
      return;
    }
    if (phase === 1 && ratio <= CONFIG.phaseThresholds[1]) {
      active.data.phase = 2;
      spawnMinions(boss);
      boss.addEffect("strength", 900, { amplifier: 2, showParticles: false });
      boss.addEffect("speed", 900, { amplifier: 1, showParticles: false });
      announce("ev.boss.phase", { phase: 3, percent: Math.round(ratio * 100) });
      soundAll("mob.enderdragon.growl", 1);
    }

    if (now - numData(active, "lastPulseAt") > 15_000) {
      active.data.lastPulseAt = now;
      try {
        boss.dimension.spawnParticle("minecraft:endrod", {
          x: boss.location.x,
          y: boss.location.y + 1.5,
          z: boss.location.z,
        });
      } catch {
        return;
      }
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
    soundAll("random.levelup", 0.9);
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
