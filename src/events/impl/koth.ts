import { Player, Vector3, world } from "@minecraft/server";
import { t } from "../../kernel/i18n";
import { log } from "../../kernel/logger";
import { distance3d, randomPointInRing } from "../../kernel/util";
import { borderRadius } from "../../world/border";
import { announce, grantLoot, mapData, markAwarded, numData, playersInRadius, soundAll, strData, titleAll } from "../api";
import { queuePendingById } from "../pending";
import { EVENTS } from "../config";
import type { ActiveEvent, EventHandler, FinishReason } from "../types";

const CONFIG = EVENTS.koth;

const centerOf = (active: ActiveEvent): Vector3 => ({
  x: numData(active, "x"),
  y: numData(active, "y"),
  z: numData(active, "z"),
});

const rewardWinner = (active: ActiveEvent, player: Player, share: number, reason: string): void => {
  if (!grantLoot(active, player, CONFIG.loot, reason)) return;
  titleAll("ev.koth.won", { player: player.name });
  soundAll("random.levelup", 1);
  announce("ev.koth.wonAnnounce", { player: player.name, progress: Math.round(share * 100) });
};

export const kothEvent: EventHandler = {
  id: "koth",
  minPlayers: CONFIG.minPlayers,
  defaultDurationMs: CONFIG.durationMs,

  start(active: ActiveEvent): void {
    const border = Math.max(CONFIG.minRadius + 60, borderRadius() - 100);
    const maxRadius = Math.min(CONFIG.maxRadius, border);
    const point = randomPointInRing(CONFIG.minRadius, Math.max(CONFIG.minRadius + 20, maxRadius));
    let y = 80;
    try {
      const top = world.getDimension("overworld").getTopmostBlock({ x: point.x, z: point.z });
      if (top) y = Math.floor(top.location.y) + 1;
    } catch {
      y = 80;
    }
    active.data.x = point.x;
    active.data.y = y;
    active.data.z = point.z;
    active.data.radius = CONFIG.radius;
    active.data.progress = 0;
    active.data.holder = "";
    active.data.timeInside = {};
    active.data.contested = false;

    titleAll("ev.koth.title", undefined, "ev.koth.subtitle");
    soundAll("random.orb", 0.9);
    announce("ev.koth.coords", { x: point.x, y, z: point.z, r: CONFIG.radius, seconds: CONFIG.requiredSeconds });
  },

  tick(active: ActiveEvent, now: number): void {
    const center = centerOf(active);
    const radius = numData(active, "radius", CONFIG.radius);
    const inside = playersInRadius(center, radius, "minecraft:overworld");
    const progress = numData(active, "progress");
    const timeInside = mapData<number>(active, "timeInside");

    for (const player of inside) {
      timeInside[player.id] = (timeInside[player.id] ?? 0) + 1;
    }

    if (inside.length === 1) {
      const player = inside[0];
      active.data.holder = player.id;
      active.data.holderName = player.name;
      active.data.contested = false;
      const next = Math.min(1, progress + 1 / CONFIG.requiredSeconds);
      active.data.progress = next;
      try {
        player.onScreenDisplay.setActionBar(
          t(player, "ev.koth.progress", { percent: Math.round(next * 100), radius: Math.round(radius) }),
        );
      } catch {
        log.error("events:koth", "actionbar");
      }
      if (next >= 1) {
        const insideSeconds = timeInside[player.id] ?? 0;
        if (insideSeconds >= CONFIG.minInsideSeconds) {
          rewardWinner(active, player, next, "hold");
        } else {
          announce("ev.koth.tooFast", { player: player.name });
          active.data.progress = 0;
        }
        return;
      }
    } else if (inside.length > 1) {
      active.data.contested = true;
      for (const player of inside) {
        try {
          player.onScreenDisplay.setActionBar(t(player, "ev.koth.contested", { count: inside.length }));
        } catch {
          continue;
        }
      }
    } else {
      active.data.contested = false;
      active.data.holder = "";
      active.data.progress = Math.max(0, progress - CONFIG.decayPerSecond / CONFIG.requiredSeconds);
    }

    if (now % 5000 < 1000 && inside.length === 0) {
      const remaining = active.endsAt - now;
      if (remaining > 0) announce("ev.koth.idle", { minutes: Math.ceil(remaining / 60_000) });
    }
  },

  finish(active: ActiveEvent, reason: FinishReason): void {
    const holderId = strData(active, "holder");
    const progress = numData(active, "progress");
    if (reason === "recover" && holderId && progress >= 0.5) {
      const holder = world.getAllPlayers().find((player) => player.id === holderId);
      const percent = Math.round(progress * 100);
      if (holder) {
        if (!markAwarded(active, holder.id)) {
          announce("ev.koth.recover", { player: holder.name, percent });
          grantLoot(active, holder, CONFIG.loot, "recover");
        }
      } else if (!markAwarded(active, holderId)) {
        queuePendingById(holderId, strData(active, "holderName") || holderId, "koth", `recover ${percent}%`);
      }
    }
    if (reason === "manual") announce("ev.koth.cancelled", {});
  },
};
