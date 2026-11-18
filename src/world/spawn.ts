import { Player, Vector3, world } from "@minecraft/server";
import { CONFIG } from "../config";
import { t } from "../kernel/i18n";
import { registerTask } from "../kernel/ticker";
import { distance2d } from "../kernel/util";
import { grantGrace } from "../security/anticheat";
import { revertPlacement } from "./blocks";

const lobby = CONFIG.lobby;
const safeTag = "sw:safe";
const inside = new Set<string>();

export const lobbySpawnPoint = (): Vector3 => ({ x: lobby.x + 0.5, y: lobby.y, z: lobby.z + 0.5 });

export const isInsideLobby = (location: Vector3): boolean => distance2d(location, lobbySpawnPoint()) <= lobby.radius;

export const isInsideSafeZone = (location: Vector3): boolean =>
  distance2d(location, lobbySpawnPoint()) <= lobby.safeRadius;

export const teleportToLobby = (player: Player): void => {
  try {
    player.teleport(lobbySpawnPoint(), { dimension: world.getDimension(lobby.dimension) });
    grantGrace(player.id, 3000);
  } catch {
    return;
  }
};

let initialized = false;

export const initSpawn = (): void => {
  if (initialized) return;
  initialized = true;

  world.afterEvents.playerSpawn.subscribe((event) => {
    if (!event.initialSpawn) return;
    teleportToLobby(event.player);
    try {
      event.player.sendMessage(t(event.player, "lobby.safe"));
    } catch {
      return;
    }
  });

  world.beforeEvents.entityHurt.subscribe((event) => {
    const hurt = event.hurtEntity;
    const attacker = event.damageSource.damagingEntity;
    if (hurt instanceof Player && isInsideLobby(hurt.location)) {
      event.cancel = true;
      return;
    }
    if (attacker instanceof Player && isInsideLobby(attacker.location)) {
      event.cancel = true;
    }
  });

  world.beforeEvents.playerBreakBlock.subscribe((event) => {
    if (isInsideLobby(event.block.location)) event.cancel = true;
  });

  world.afterEvents.playerPlaceBlock.subscribe((event) => {
    if (!isInsideLobby(event.block.location)) return;
    revertPlacement(event.player, event.block);
    try {
      event.player.onScreenDisplay.setActionBar(t(event.player, "border.blocked"));
    } catch {
      return;
    }
  });

  world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    if (inside.has(event.player.id)) grantGrace(event.player.id, 1500);
  });

  registerTask("lobby-watch", 20, 3, () => {
    for (const player of world.getAllPlayers()) {
      const inLobby = isInsideLobby(player.location);
      const was = inside.has(player.id);
      if (inLobby) {
        inside.add(player.id);
        grantGrace(player.id, 2000);
        if (!was) {
          try {
            player.sendMessage(t(player, "lobby.safe"));
            if (!player.hasTag(safeTag)) player.addTag(safeTag);
          } catch {
            continue;
          }
        }
      } else if (was) {
        inside.delete(player.id);
        try {
          player.removeTag(safeTag);
          player.sendMessage(t(player, "lobby.leave"));
        } catch {
          continue;
        }
      }
    }
  });
};
