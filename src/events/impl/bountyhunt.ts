import { Player, world } from "@minecraft/server";
import { log } from "../../kernel/logger";
import { getProfile } from "../../meta/profiles";
import { announce, announceTo, grantLoot, numData, pickRandom, soundAll, strData, titleAll } from "../api";
import { EVENTS } from "../config";
import type { ActiveEvent, EventHandler, FinishReason } from "../types";

const CONFIG = EVENTS.bountyhunt;

const pickTarget = (active: ActiveEvent, excludeIds: string[] = []): Player | undefined => {
  const candidates = world
    .getAllPlayers()
    .filter((player) => !excludeIds.includes(player.id))
    .map((player) => ({ player, kills: getProfile(player).kills }))
    .sort((left, right) => right.kills - left.kills);
  const qualified = candidates.filter((row) => row.kills >= CONFIG.minKills);
  const chosen = qualified.length > 0 ? qualified[0].player : candidates.length > 0 ? pickRandom(candidates).player : undefined;
  if (!chosen) return undefined;
  active.data.targetId = chosen.id;
  active.data.targetName = chosen.name;
  return chosen;
};

const markTarget = (target: Player, active: ActiveEvent): void => {
  try {
    target.addEffect("glowing", Math.round(CONFIG.glowingRefreshMs / 1000) + 5, { showParticles: false });
  } catch (error) {
    log.error("events:bounty", `glowing: ${String(error)}`);
  }
  announce("ev.bounty.target", { player: target.name, kills: getProfile(target).kills });
  announceTo(target, "ev.bounty.youAreTarget", {});
};

export const bountyhuntEvent: EventHandler = {
  id: "bountyhunt",
  minPlayers: CONFIG.minPlayers,
  defaultDurationMs: CONFIG.durationMs,

  start(active: ActiveEvent): void {
    const target = pickTarget(active);
    titleAll("ev.bounty.title", undefined, "ev.bounty.subtitle");
    soundAll("random.orb", 1.2);
    if (!target) {
      announce("ev.bounty.noTarget", {});
      return;
    }
    markTarget(target, active);
  },

  tick(active: ActiveEvent, now: number): void {
    const targetId = strData(active, "targetId");
    if (!targetId) {
      const replacement = pickTarget(active);
      if (replacement) markTarget(replacement, active);
      return;
    }
    const target = world.getAllPlayers().find((player) => player.id === targetId);
    if (!target) {
      const replacement = pickTarget(active, [targetId]);
      if (replacement) {
        active.data.targetId = replacement.id;
        active.data.targetName = replacement.name;
        markTarget(replacement, active);
      }
      return;
    }
    if (now - numData(active, "lastMarkAt") > CONFIG.glowingRefreshMs) {
      active.data.lastMarkAt = now;
      markTarget(target, active);
    }
  },

  onPlayerKill(active: ActiveEvent, killer: Player, victim: Player): void {
    const targetId = strData(active, "targetId");
    if (victim.id !== targetId) {
      if (killer.id === targetId) {
        announce("ev.bounty.defended", { player: killer.name });
        const next = pickTarget(active, [killer.id]);
        if (next) markTarget(next, active);
      }
      return;
    }
    const granted = grantLoot(active, killer, CONFIG.loot, "bounty");
    titleAll("ev.bounty.killed", { player: killer.name, victim: victim.name });
    soundAll("random.levelup", 1);
    announce("ev.bounty.reward", { player: killer.name, victim: victim.name, granted: granted ? "да" : "нет" });
    active.data.targetId = "";
    const next = pickTarget(active, [killer.id, victim.id]);
    if (next) {
      markTarget(next, active);
      active.data.targetId = next.id;
    }
  },

  finish(active: ActiveEvent, reason: FinishReason): void {
    const targetId = strData(active, "targetId");
    if (targetId) {
      const target = world.getAllPlayers().find((player) => player.id === targetId);
      if (target) {
        try {
          target.removeEffect("glowing");
        } catch {
          log.error("events:bounty", "снятие glowing");
        }
      }
    }
    if (reason === "timeout") announce("ev.bounty.expired", {});
    active.data.targetId = "";
  },
};
