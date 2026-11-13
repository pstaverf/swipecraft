import { Player, Vector3, world } from "@minecraft/server";
import { CONFIG } from "../config";
import { t } from "../kernel/i18n";
import { formatDuration, randomPointInRing } from "../kernel/util";
import { getProfile, saveProfile } from "../meta/profiles";
import { grantGrace } from "../security/anticheat";
import { borderRadius } from "./border";
import { lobbySpawnPoint } from "./spawn";

const liquidBlocks = new Set([
  "minecraft:water",
  "minecraft:flowing_water",
  "minecraft:lava",
  "minecraft:flowing_lava",
]);

const dangerBlocks = new Set([
  "minecraft:cactus",
  "minecraft:magma",
  "minecraft:campfire",
  "minecraft:fire",
  "minecraft:soul_fire",
  "minecraft:powder_snow",
]);

const isSafeSpot = (player: Player, x: number, z: number): Vector3 | undefined => {
  const dimension = player.dimension;
  for (let y = CONFIG.rtp.maxY; y >= CONFIG.rtp.minY; y -= 4) {
    try {
      const block = dimension.getBlock({ x, y, z });
      if (!block) continue;
      if (block.typeId === "minecraft:air") continue;
      if (liquidBlocks.has(block.typeId) || dangerBlocks.has(block.typeId)) return undefined;
      const above = dimension.getBlock({ x, y: y + 1, z });
      const above2 = dimension.getBlock({ x, y: y + 2, z });
      if (!above || !above2) return undefined;
      if (above.typeId !== "minecraft:air" || above2.typeId !== "minecraft:air") return undefined;
      return { x: x + 0.5, y: y + 1, z: z + 0.5 };
    } catch {
      continue;
    }
  }
  return undefined;
};

export const randomTeleport = (player: Player): { ok: boolean; message: string } => {
  const profile = getProfile(player);
  const now = Date.now();
  if (profile.rtpReadyAt > now) {
    return { ok: false, message: t(player, "rtp.cooldown", { time: formatDuration(profile.rtpReadyAt - now) }) };
  }

  const border = borderRadius() - CONFIG.rtp.marginFromBorder;
  const maxRadius = Math.min(CONFIG.rtp.maxRadius, Math.max(CONFIG.rtp.minRadius + 50, border));
  if (maxRadius <= CONFIG.rtp.minRadius) {
    return { ok: false, message: t(player, "rtp.outside") };
  }

  try {
    player.onScreenDisplay.setActionBar(t(player, "rtp.ready"));
  } catch {
    return { ok: false, message: t(player, "rtp.failed") };
  }

  for (let attempt = 0; attempt < CONFIG.rtp.attempts; attempt += 1) {
    const point = randomPointInRing(CONFIG.rtp.minRadius, maxRadius);
    const location = isSafeSpot(player, point.x, point.z);
    if (!location) continue;
    try {
      player.teleport(location, { dimension: world.getDimension(CONFIG.lobby.dimension) });
      grantGrace(player.id, 4000);
      profile.rtpReadyAt = now + CONFIG.rtp.cooldownMs;
      saveProfile(player);
      const distance = Math.hypot(location.x, location.z);
      return {
        ok: true,
        message: t(player, "rtp.done", {
          x: Math.round(location.x),
          y: Math.round(location.y),
          z: Math.round(location.z),
          border: Math.round(borderRadius() - distance),
        }),
      };
    } catch {
      continue;
    }
  }

  try {
    player.teleport(lobbySpawnPoint(), { dimension: world.getDimension(CONFIG.lobby.dimension) });
  } catch {
    return { ok: false, message: t(player, "rtp.failed") };
  }
  return { ok: false, message: t(player, "rtp.failed") };
};
