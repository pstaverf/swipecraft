import { Player, world } from "@minecraft/server";
import { log } from "../../kernel/logger";
import { announce, announceTo, mapData, numData, soundAll, titleAll } from "../api";
import { EVENTS } from "../config";
import type { ActiveEvent, EventHandler, FinishReason } from "../types";

const CONFIG = EVENTS.lifesteal;

const applyHearts = (player: Player, level: number, seconds: number): void => {
  try {
    player.removeEffect("health_boost");
    if (level > 0) {
      player.addEffect("health_boost", Math.max(20, seconds), { amplifier: level - 1, showParticles: true });
    }
  } catch (error) {
    log.error("events:lifesteal", `эффект: ${String(error)}`);
  }
};

export const lifestealEvent: EventHandler = {
  id: "lifesteal",
  minPlayers: CONFIG.minPlayers,
  defaultDurationMs: CONFIG.durationMs,

  start(active: ActiveEvent): void {
    active.data.hearts = {};
    titleAll("ev.lifesteal.title", undefined, "ev.lifesteal.subtitle");
    soundAll("random.orb", 0.8);
    announce("ev.lifesteal.announce", { minutes: Math.round(CONFIG.durationMs / 60_000), max: CONFIG.maxLevel });
  },

  tick(active: ActiveEvent, now: number): void {
    const hearts = mapData<number>(active, "hearts");
    const remaining = Math.max(30, Math.round((active.endsAt - now) / 1000) + 10);
    if (now - numData(active, "lastRefreshAt") < 20_000) return;
    active.data.lastRefreshAt = now;
    for (const player of world.getAllPlayers()) {
      const level = hearts[player.id] ?? 0;
      if (level <= 0) continue;
      applyHearts(player, level, remaining);
    }
  },

  onPlayerKill(active: ActiveEvent, killer: Player, victim: Player): void {
    const hearts = mapData<number>(active, "hearts");
    const remaining = Math.max(30, Math.round((active.endsAt - Date.now()) / 1000) + 10);
    const killerLevel = Math.min(CONFIG.maxLevel, (hearts[killer.id] ?? 0) + 1);
    const victimLevel = Math.max(0, (hearts[victim.id] ?? 0) - 1);
    hearts[killer.id] = killerLevel;
    hearts[victim.id] = victimLevel;
    applyHearts(killer, killerLevel, remaining);
    applyHearts(victim, victimLevel, remaining);
    announce("ev.lifesteal.steal", { killer: killer.name, victim: victim.name, level: killerLevel, max: CONFIG.maxLevel });
    announceTo(killer, "ev.lifesteal.gain", { level: killerLevel });
    announceTo(victim, "ev.lifesteal.lose", { level: victimLevel });
    soundAll("random.orb", 1.3);
  },

  finish(active: ActiveEvent, reason: FinishReason): void {
    const hearts = mapData<number>(active, "hearts");
    for (const player of world.getAllPlayers()) {
      try {
        player.removeEffect("health_boost");
      } catch {
        continue;
      }
      hearts[player.id] = 0;
    }
    if (reason === "timeout" || reason === "completed" || reason === "manual") {
      titleAll("ev.lifesteal.end", undefined);
    }
  },
};
