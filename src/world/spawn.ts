import { Block, BlockPermutation, ExplosionBeforeEvent, ItemStack, Player, Vector3, world } from "@minecraft/server";
import { CONFIG } from "../config";
import { t } from "../kernel/i18n";
import { log } from "../kernel/logger";
import { registerTask } from "../kernel/ticker";
import { distance2d } from "../kernel/util";
import { getTunables } from "../meta/economy";
import { grantGrace } from "../security/anticheat";
import { revertPlacement } from "./blocks";
import { spawnBlueprintCellAt } from "./spawnbuild";

/**
 * Правила лобби: точка возрождения, «здесь не бьют и не копают», освещение античит-grace'ом и
 * защита площади спавна от изменений.
 *
 * Защита спавна — одна на весь мир и без исключений для админов: «никому» означает, что у
 * блокировки нет обхода по правам. Ключевые решения:
 *
 * 1. Область — та же `isInsideLobby` (круг `CONFIG.lobby.radius` вокруг точки лобби, по X/Z,
 *    без ограничения по Y), что отсекает авто-шахту (`quarry.err.lobby`). Два источника правды
 *    про «где спавн» обязательно разъехались бы: карьер отказывает в одном круге, а защита —
 *    в другом.
 * 2. Слом — отмена `beforeEvents.playerBreakBlock`: игрок даже не начинает добывать.
 * 3. Установка — откат `afterEvents.playerPlaceBlock`: `beforeEvents.playerPlaceBlock` в
 *    @minecraft/server 2.11.0 нет, поэтому ставим и сразу возвращаем инвентарь обратно
 *    (`revertPlacement` кладёт предмет в руки). Итог для игрока тот же, цена — один лишний
 *    прогон события.
 * 4. Взрывы — вырезаем защищённые клетки из `impactedBlocks` вместо отмены всего взрыва:
 *    крёпер у ног должен пугать и отбрасывать, но не уносить пол спавна.
 * 5. Вёдра — в `ItemUseBeforeEvent` 2.11.0 нет ни блока-цели, ни точки попадания (только
 *    `source` и `itemStack`), поэтому «разливать в лобби» судим по позиции игрока. Это
 *    приближение: игрок на краю круга, смотрящий наружу, тоже получит отказ.
 * 6. Скриптовые правки не блокируются вообще: `setBlockPermutation` событий не порождает,
 *    поэтому сборщик спавна и его починка работают при любой защите. Единственный «обход» —
 *    стоп-кран `spawnProtectEnabled`, и он виден всем администраторам.
 */

const lobby = CONFIG.lobby;
const protect = CONFIG.spawnProtect;
const safeTag = "sw:safe";
const inside = new Set<string>();

export const lobbySpawnPoint = (): Vector3 => ({ x: lobby.x + 0.5, y: lobby.y, z: lobby.z + 0.5 });

export const isInsideLobby = (location: Vector3): boolean => distance2d(location, lobbySpawnPoint()) <= lobby.radius;

export const isInsideSafeZone = (location: Vector3): boolean =>
  distance2d(location, lobbySpawnPoint()) <= lobby.safeRadius;

/** Защита активна прямо сейчас? Снимается только стоп-краном, правами — никогда. */
export const spawnProtectActive = (): boolean => getTunables().spawnProtectEnabled;

/** Клетка под защитой? Публичный хелпер: тот же круг, что и у всех гейтов ниже. */
export const isProtectedBlock = (block: { x?: number; y?: number; z?: number } | Block): boolean => {
  if (!spawnProtectActive()) return false;
  const location = "location" in block && block.location ? block.location : { x: block.x, y: block.y, z: block.z };
  if (typeof location?.x !== "number" || typeof location?.z !== "number") return false;
  return isInsideLobby(location as Vector3);
};

/**
 * Счётчики живут в памяти: это диагностика «много ли мы кому-то испортили», а не реестр —
 * после рестарта они обнуляются, и в этом нет потери (владения блоками они не дают).
 */
const stats = {
  breakDenied: 0,
  placeReverted: 0,
  bucketDenied: 0,
  explosionCells: 0,
  noticesSent: 0,
  lastDenyAt: 0,
};

const lastNotice = new Map<string, number>();

/**
 * Отказ обязан быть объяснён, но не спамом: удержание кнопки разрушения выдало бы десятки
 * строк в чат, поэтому напоминание — не чаще раза в `noticeEveryMs` на игрока.
 */
const notice = (player: Player | undefined, key: string): void => {
  if (!player) return;
  const now = Date.now();
  if (now - (lastNotice.get(player.id) ?? 0) < protect.noticeEveryMs) return;
  lastNotice.set(player.id, now);
  stats.noticesSent += 1;
  stats.lastDenyAt = now;
  try {
    player.sendMessage(t(player, key));
  } catch {
    // игрок вышел в ту же секунду, что и получил отказ
  }
};

/**
 * В 1.x список затронутых блоков лежал свойством `impactedBlocks`, в 2.x — геттером. Читаем
 * оба, иначе защита спавна тихо превращается в «ничего не фильтруем».
 */
const impactedOf = (event: ExplosionBeforeEvent): Block[] => {
  try {
    if (typeof event.getImpactedBlocks === "function") return event.getImpactedBlocks() ?? [];
    const legacy = (event as unknown as { impactedBlocks?: Block[] }).impactedBlocks;
    return Array.isArray(legacy) ? legacy : [];
  } catch (error) {
    log.debug("spawn", `список блоков взрыва недоступен: ${String(error)}`);
    return [];
  }
};

/**
 * Откат установки. Обычный случай — «в воздух»: `revertPlacement` убирает блок и возвращает
 * предмет в руки. Но если клетка входит в blueprint спавна, воздух на её месте — это дыра в
 * полу, и тогда возвращаем ожидаемую структуру. Предмет отдаём тот, что игрок поставил (в
 * after-событии блока-цели уже нет, поэтому читаем `typeId` до перезаписи).
 */
const undoPlacement = (player: Player, block: Block): boolean => {
  const placedId = block.typeId;
  const cell = spawnBlueprintCellAt(block.x, block.y, block.z);
  if (!cell) return revertPlacement(player, block);
  if (cell.typeId === placedId) return false;
  try {
    block.setPermutation(BlockPermutation.resolve(cell.typeId));
  } catch (error) {
    log.debug("spawn", `не удалось вернуть ${cell.typeId} в (${block.x}, ${block.y}, ${block.z}): ${String(error)}`);
    return false;
  }
  try {
    const inventory = player.getComponent("minecraft:inventory");
    if (placedId !== "minecraft:air") inventory?.container?.addItem(new ItemStack(placedId, 1));
  } catch {
    // инвентарь забит: предмет упадёт на пол — ровно как при обычной отмене установки
  }
  return true;
};

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
    if (!isProtectedBlock(event.block)) return;
    event.cancel = true;
    stats.breakDenied += 1;
    notice(event.player, "spawn.protect.break");
  });

  world.afterEvents.playerPlaceBlock.subscribe((event) => {
    if (!isInsideLobby(event.block.location) || !spawnProtectActive() || !protect.denyPlace) return;
    // блок уже стоит: убираем его и возвращаем предмет, иначе «защита» была бы кражей
    if (undoPlacement(event.player, event.block)) stats.placeReverted += 1;
    notice(event.player, "spawn.protect.place");
  });

  if (protect.denyBuckets) {
    world.beforeEvents.itemUse.subscribe((event) => {
      if (!spawnProtectActive()) return;
      const typeId = event.itemStack?.typeId ?? "";
      // и ведро, и вода/лава/порошковый снег: typeId всегда кончается на bucket
      if (!typeId.endsWith("bucket")) return;
      if (!isInsideLobby(event.source.location)) return;
      event.cancel = true;
      stats.bucketDenied += 1;
      notice(event.source, "spawn.protect.bucket");
    });
  }

  if (protect.denyExplosions) {
    world.beforeEvents.explosion.subscribe((event) => {
      if (!spawnProtectActive()) return;
      const blocks = impactedOf(event);
      if (blocks.length === 0) return;
      // потолок сканирования: 20 блоков ТНТ — это сотни клеток, и платить за них надо только
      // за те, что реально в зоне; хвост списка остаётся как есть
      const head = blocks.slice(0, protect.explosionScanCap);
      const kept = head.filter((block) => !isInsideLobby(block.location));
      if (kept.length === head.length) return;
      const removed = head.length - kept.length;
      try {
        if (kept.length === 0) {
          event.cancel = true;
        } else {
          event.setImpactedBlocks(kept);
        }
      } catch (error) {
        // если список заменить нельзя, отменяем весь взрыв: лучше лишняя отмена, чем дыра в полу
        event.cancel = true;
        log.debug("spawn", `setImpactedBlocks недоступен, отменяю взрыв: ${String(error)}`);
      }
      stats.explosionCells += removed;
      log.info("spawn", `взрыв у спавна: снято с повреждений ${removed} клеток из ${head.length}`);
    });
  }

  // «открываем меню об алтарь» живёт в bootstrap/world-load; здесь только grace для контейнеров
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

  log.info(
    "spawn",
    `защита спавна: круг r=${lobby.radius} вокруг (${lobby.x}, ${lobby.z}), откаты установки=${protect.denyPlace ? "вкл" : "выкл"}, вёдра=${protect.denyBuckets ? "вкл" : "выкл"}, взрывы=${protect.denyExplosions ? "вкл" : "выкл"}`,
  );
};

export const spawnProtectStatus = (): typeof stats & { enabled: boolean; radius: number } => ({
  ...stats,
  enabled: spawnProtectActive(),
  radius: lobby.radius,
});

/** Строка для админского экрана «Моды мира» — с прямым предупреждением, когда защита снята. */
export const spawnProtectLine = (player: Player): string =>
  t(player, "admin.world.protect.line", {
    state: spawnProtectActive() ? t(player, "admin.world.on") : t(player, "spawn.protect.warn"),
    denied: stats.breakDenied,
    reverted: stats.placeReverted,
    cells: stats.explosionCells,
  });

/** Сброс памятки «почему не ломается» — используется стабом и админской кнопкой проверки. */
export const forgetNotice = (playerId: string): void => {
  lastNotice.delete(playerId);
};
