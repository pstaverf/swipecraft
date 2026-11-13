import { Entity, ItemStack, Player, Vector3 } from "@minecraft/server";
import { log } from "../../kernel/logger";
import { announce, soundAll, titleAll } from "../api";
import { EVENTS } from "../config";
import { giveStacks } from "../loot";
import type { ActiveEvent, EventHandler, FinishReason } from "../types";

const CONFIG = EVENTS.doubleloot;

export const doublelootEvent: EventHandler = {
  id: "doubleloot",
  minPlayers: CONFIG.minPlayers,
  defaultDurationMs: CONFIG.durationMs,

  start(active: ActiveEvent): void {
    active.data.bonusItems = 0;
    titleAll("ev.double.title", undefined, "ev.double.subtitle");
    soundAll("random.orb", 1.1);
    announce("ev.double.announce", { minutes: Math.round(CONFIG.durationMs / 60_000) });
  },

  tick(): void {
    return;
  },

  onPlayerBreakBlock(active: ActiveEvent, player: Player, blockTypeId: string, location: Vector3): void {
    const item = CONFIG.blockBonus[blockTypeId];
    if (!item) return;
    if (Math.random() > CONFIG.breakChance) return;
    try {
      giveStacks(player, [new ItemStack(item, 1)]);
      player.dimension.spawnXp(location, 2 * CONFIG.xpMultiplier);
      active.data.bonusItems = Number(active.data.bonusItems ?? 0) + 1;
    } catch (error) {
      log.error("events:double", `бонус ${item}: ${String(error)}`);
    }
  },

  onEntityDie(active: ActiveEvent, entity: Entity, killer: Player | undefined): void {
    if (!killer) return;
    if (entity instanceof Player) return;
    if (Math.random() > CONFIG.mobChance) return;
    try {
      giveStacks(killer, [new ItemStack(CONFIG.mobBonusItem, 1)]);
      killer.dimension.spawnXp(entity.location, 3 * CONFIG.xpMultiplier);
    } catch (error) {
      log.error("events:double", `моб-бонус: ${String(error)}`);
    }
  },

  finish(active: ActiveEvent, reason: FinishReason): void {
    if (reason === "timeout" || reason === "completed" || reason === "recover") {
      titleAll("ev.double.end", undefined);
      announce("ev.double.total", { count: Number(active.data.bonusItems ?? 0) });
    }
    soundAll("random.orb", 0.7);
  },
};
