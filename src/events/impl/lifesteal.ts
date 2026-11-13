import { Entity, Player, world } from "@minecraft/server";
import { log } from "../../kernel/logger";
import { registerTask } from "../../kernel/ticker";
import { getMeta, markDirty } from "../../meta/balances";
import { metaOf } from "../../meta/economy";
import { announce, announceTo, soundAll, titleAll } from "../api";
import { EVENTS } from "../config";
import type { ActiveEvent, EventHandler, FinishReason } from "../types";

const CONFIG = EVENTS.lifesteal;

export const lifestealCapHp = (hearts: number): number =>
  Math.max(CONFIG.floorHp, CONFIG.baseHp + hearts * CONFIG.heartsToHp);

export const lifestealMaxHp = (hearts: number): number =>
  hearts > 0 ? CONFIG.baseHp + hearts * CONFIG.heartsToHp : CONFIG.baseHp;

const heartsOf = (player: Player): number => metaOf(player).hearts;

const heartsOfId = (playerId: string): number => getMeta(playerId, "").hearts;

const effectSeconds = (active?: ActiveEvent): number => {
  if (!active) return CONFIG.effectRefreshMs / 1000 + 30;
  return Math.max(30, Math.round((active.endsAt - Date.now()) / 1000) + 15);
};

const applyTo = (player: Player, active?: ActiveEvent): void => {
  const hearts = heartsOf(player);
  try {
    player.removeEffect("health_boost");
    if (hearts > 0) {
      player.addEffect("health_boost", effectSeconds(active), {
        amplifier: Math.min(CONFIG.maxLevel, hearts) - 1,
        showParticles: false,
      });
    }
    const health = player.getComponent("minecraft:health");
    if (!health) return;
    const cap = lifestealCapHp(hearts);
    if (hearts < 0 && health.currentValue > cap) {
      const excess = health.currentValue - cap;
      if (excess > 0) player.applyDamage(excess);
    }
  } catch (error) {
    log.debug("events:lifesteal", `применение: ${String(error)}`);
  }
};

const setHearts = (player: Player, value: number): number => {
  const meta = metaOf(player);
  const clamped = Math.max(CONFIG.minLevel, Math.min(CONFIG.maxLevel, value));
  meta.hearts = clamped;
  meta.updatedAt = Date.now();
  markDirty(player.id);
  return clamped;
};

const heal = (player: Player, amount: number): void => {
  try {
    player.addEffect("instant_health", 1, { amplifier: Math.max(0, Math.ceil(amount / 4) - 1), showParticles: false });
  } catch (error) {
    log.debug("events:lifesteal", `лечение: ${String(error)}`);
  }
};

const steal = (killer: Player, victim: Player, active: ActiveEvent): void => {
  const killerLevel = setHearts(killer, heartsOf(killer) + 1);
  const victimLevel = setHearts(victim, heartsOf(victim) - 1);
  applyTo(killer, active);
  heal(killer, CONFIG.heartsToHp);
  announce("ev.lifesteal.steal", {
    killer: killer.name,
    victim: victim.name,
    level: killerLevel,
    max: CONFIG.maxLevel,
    hp: lifestealCapHp(killerLevel),
  });
  announceTo(killer, "ev.lifesteal.gain", { level: killerLevel, max: CONFIG.maxLevel });
  announceTo(victim, "ev.lifesteal.lose", { level: victimLevel, hp: lifestealCapHp(victimLevel) });
  soundAll(CONFIG.soundSteal, 1.3);
};

const diePenalty = (victim: Player, active: ActiveEvent): void => {
  const level = setHearts(victim, heartsOf(victim) - 1);
  applyTo(victim, active);
  announceTo(victim, "ev.lifesteal.death", { level, hp: lifestealCapHp(level) });
};

let guardRegistered = false;

export const initLifestealGuard = (): void => {
  if (guardRegistered) return;
  guardRegistered = true;
  registerTask("lifesteal-guard", CONFIG.guardTicks, 4, () => {
    for (const player of world.getAllPlayers()) {
      if (heartsOfId(player.id) === 0) continue;
      applyTo(player, undefined);
    }
  });
  log.info("events:lifesteal", `страж сердец: каждые ${CONFIG.guardTicks} тиков`);
};

export const lifestealEvent: EventHandler = {
  id: "lifesteal",
  minPlayers: CONFIG.minPlayers,
  defaultDurationMs: CONFIG.durationMs,

  start(active: ActiveEvent): void {
    for (const player of world.getAllPlayers()) {
      setHearts(player, 0);
      applyTo(player, active);
    }
    active.data.lastRefreshAt = Date.now();
    titleAll("ev.lifesteal.title", undefined, "ev.lifesteal.subtitle");
    announce("ev.lifesteal.announce", {
      minutes: Math.round(CONFIG.durationMs / 60_000),
      max: CONFIG.maxLevel,
      min: CONFIG.minLevel,
      hpPlus: lifestealCapHp(CONFIG.maxLevel),
      floor: CONFIG.floorHp,
    });
  },

  resume(active: ActiveEvent): void {
    for (const player of world.getAllPlayers()) applyTo(player, active);
    active.data.lastRefreshAt = Date.now();
    announce("ev.lifesteal.resume", { max: CONFIG.maxLevel });
  },

  tick(active: ActiveEvent, now: number): void {
    if (now - numRefresh(active) < CONFIG.effectRefreshMs) return;
    active.data.lastRefreshAt = now;
    for (const player of world.getAllPlayers()) applyTo(player, active);
  },

  onEntityDie(active: ActiveEvent, entity: Entity, killer: Player | undefined): void {
    if (!(entity instanceof Player)) return;
    const victim = entity;
    if (killer && killer.id !== victim.id) {
      steal(killer, victim, active);
      return;
    }
    diePenalty(victim, active);
  },

  finish(active: ActiveEvent, reason: FinishReason): void {
    for (const player of world.getAllPlayers()) {
      try {
        player.removeEffect("health_boost");
      } catch {
        continue;
      }
      if (!CONFIG.keepBetweenEvents) setHearts(player, 0);
      if (heartsOf(player) < 0) {
        try {
          const health = player.getComponent("minecraft:health");
          const cap = lifestealCapHp(heartsOf(player));
          if (health && health.currentValue > cap) player.applyDamage(health.currentValue - cap);
        } catch {
          continue;
        }
      }
      if (heartsOf(player) !== 0) {
        announceTo(player, "ev.lifesteal.kept", { level: heartsOf(player), hp: lifestealCapHp(heartsOf(player)) });
      }
    }
    if (reason === "timeout" || reason === "completed" || reason === "manual") {
      titleAll("ev.lifesteal.end", undefined);
    }
  },
};

const numRefresh = (active: ActiveEvent): number => {
  const value = active.data.lastRefreshAt;
  return typeof value === "number" ? value : 0;
};
