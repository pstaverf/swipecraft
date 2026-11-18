import { BlockPermutation, ItemStack, Player, world } from "@minecraft/server";
import { CONFIG, STORE_KEYS } from "../config";
import { t } from "../kernel/i18n";
import { log } from "../kernel/logger";
import { loadWorldJson, saveWorldJson } from "../kernel/store";
import { registerTask } from "../kernel/ticker";
import { distance2d } from "../kernel/util";
import { audit, notifyAdmins } from "../security/audit";
import { burn, getTunables, metaOf } from "../meta/economy";
import { borderRadius } from "./border";
import { grantGrace } from "../security/anticheat";
import { isInsideLobby } from "./spawn";
import type { Vector3 } from "@minecraft/server";
import type { QuarryDrop, QuarryRow } from "../types/domain";
import "./messages";

/**
 * Авто-шахта («карьер»).
 *
 * Игрок платит ₡ за слот, карьер физически вынимает природную породу под точкой запуска и
 * складывает добычу в буфер; забирает игрок сам — через UI или `/sw:quarry collect`.
 *
 * Четыре правила, которые делают фичу безопасной:
 * 1. роется ТОЛЬКО порода из `QUARRY_MINABLE`: постройки, фермы, редстоун и всё, что поставил
 *    игрок, для карьера невидимы — его нельзя подвести к чужой базе как «грефер-машину»;
 * 2. копаем, только пока владелец в игре, и бюджет считается на такт, а не на карьер:
 *    `claims · cellsPerClaim + extraCells` записей блоков и не более `maxAdvance` проверок;
 * 3. ₡ из воздуха не появляется: карьер отдаёт предметы, монеты игрок получает только через
 *    существующие каналы (продажа с `mintCapPerDay`, рынок игроков);
 * 4. добыча не исчезает: буфер живёт в dynamic properties до `collect`/`close`, полный буфер
 *    не переполняется, а остаток при нехватке места возвращается в буфер, а не в void.
 */

const q = CONFIG.quarry;
const AIR = "minecraft:air";

/**
 * Природные блоки, которые карьер готов вынуть, и что от них остаётся. Каждый id сверяется
 * со `@minecraft/vanilla-data` в headless-стабе: «minecraft:nether_quartz_ore» в Bedrock не
 * существует (тамошний id — `minecraft:quartz_ore`), и без такой проверки опечатка жила бы
 * в конфиге вечно.
 */
export const QUARRY_MINABLE: Record<string, QuarryDrop> = {
  "minecraft:stone": { typeId: "minecraft:cobblestone", amount: 1 },
  "minecraft:cobblestone": { typeId: "minecraft:cobblestone", amount: 1 },
  "minecraft:andesite": { typeId: "minecraft:andesite", amount: 1 },
  "minecraft:diorite": { typeId: "minecraft:diorite", amount: 1 },
  "minecraft:granite": { typeId: "minecraft:granite", amount: 1 },
  "minecraft:tuff": { typeId: "minecraft:tuff", amount: 1 },
  "minecraft:calcite": { typeId: "minecraft:calcite", amount: 1 },
  "minecraft:dripstone_block": { typeId: "minecraft:dripstone_block", amount: 1 },
  "minecraft:deepslate": { typeId: "minecraft:cobbled_deepslate", amount: 1 },
  "minecraft:cobbled_deepslate": { typeId: "minecraft:cobbled_deepslate", amount: 1 },
  "minecraft:polished_deepslate": { typeId: "minecraft:cobbled_deepslate", amount: 1 },
  "minecraft:clay": { typeId: "minecraft:clay_ball", amount: 4 },
  "minecraft:dirt": { typeId: "minecraft:dirt", amount: 1 },
  "minecraft:coarse_dirt": { typeId: "minecraft:dirt", amount: 1 },
  "minecraft:grass_block": { typeId: "minecraft:dirt", amount: 1 },
  "minecraft:sand": { typeId: "minecraft:sand", amount: 1 },
  "minecraft:red_sand": { typeId: "minecraft:red_sand", amount: 1 },
  "minecraft:gravel": { typeId: "minecraft:gravel", amount: 1 },
  "minecraft:sandstone": { typeId: "minecraft:sandstone", amount: 1 },
  "minecraft:red_sandstone": { typeId: "minecraft:red_sandstone", amount: 1 },
  "minecraft:netherrack": { typeId: "minecraft:netherrack", amount: 1 },
  "minecraft:soul_sand": { typeId: "minecraft:soul_sand", amount: 1 },
  "minecraft:soul_soil": { typeId: "minecraft:soul_soil", amount: 1 },
  "minecraft:end_stone": { typeId: "minecraft:end_stone", amount: 1 },
  "minecraft:obsidian": { typeId: "minecraft:obsidian", amount: 1 },
  "minecraft:coal_ore": { typeId: "minecraft:coal", amount: 1 },
  "minecraft:deepslate_coal_ore": { typeId: "minecraft:coal", amount: 1 },
  "minecraft:iron_ore": { typeId: "minecraft:raw_iron", amount: 1 },
  "minecraft:deepslate_iron_ore": { typeId: "minecraft:raw_iron", amount: 1 },
  "minecraft:copper_ore": { typeId: "minecraft:raw_copper", amount: 3 },
  "minecraft:deepslate_copper_ore": { typeId: "minecraft:raw_copper", amount: 3 },
  "minecraft:gold_ore": { typeId: "minecraft:raw_gold", amount: 1 },
  "minecraft:deepslate_gold_ore": { typeId: "minecraft:raw_gold", amount: 1 },
  "minecraft:redstone_ore": { typeId: "minecraft:redstone", amount: 4 },
  "minecraft:deepslate_redstone_ore": { typeId: "minecraft:redstone", amount: 4 },
  "minecraft:lapis_ore": { typeId: "minecraft:lapis_lazuli", amount: 8 },
  "minecraft:deepslate_lapis_ore": { typeId: "minecraft:lapis_lazuli", amount: 8 },
  "minecraft:diamond_ore": { typeId: "minecraft:diamond", amount: 1 },
  "minecraft:deepslate_diamond_ore": { typeId: "minecraft:diamond", amount: 1 },
  "minecraft:emerald_ore": { typeId: "minecraft:emerald", amount: 1 },
  "minecraft:deepslate_emerald_ore": { typeId: "minecraft:emerald", amount: 1 },
  "minecraft:quartz_ore": { typeId: "minecraft:quartz", amount: 1 },
  "minecraft:glowstone": { typeId: "minecraft:glowstone_dust", amount: 4 },
  "minecraft:ancient_debris": { typeId: "minecraft:ancient_debris", amount: 1 },
};

interface QuarryState {
  claims: QuarryRow[];
  season: number;
}

const state: QuarryState = { claims: [], season: 0 };

let dirty = false;

const markDirty = (): void => {
  dirty = true;
};

export const quarryCells = (): number => {
  const side = q.radius * 2 + 1;
  return side * side * q.depth;
};

/** Детерминированный порядок ячеек: ярус за ярусом сверху вниз, внутри яруса — змейка по X. */
export const quarryCellAt = (claim: Pick<QuarryRow, "x" | "z" | "topY">, index: number): Vector3 => {
  const side = q.radius * 2 + 1;
  const layer = Math.floor(index / (side * side));
  const inLayer = index % (side * side);
  const row = Math.floor(inLayer / side);
  const column = row % 2 === 0 ? inLayer % side : side - 1 - (inLayer % side);
  return { x: claim.x - q.radius + column, y: claim.topY - layer, z: claim.z - q.radius + row };
};

export const quarryItems = (claim: Pick<QuarryRow, "buffer">): number => claim.buffer.reduce((sum, row) => sum + row.amount, 0);

export const quarryStacks = (claim: Pick<QuarryRow, "buffer">): number => Math.ceil(quarryItems(claim) / 64);

const addToBuffer = (claim: QuarryRow, drop: QuarryDrop): void => {
  const row = claim.buffer.find((entry) => entry.typeId === drop.typeId);
  if (row) row.amount += drop.amount;
  else claim.buffer.push({ typeId: drop.typeId, amount: drop.amount });
};

export const findQuarry = (playerId: string): QuarryRow | undefined => state.claims.find((row) => row.ownerId === playerId);

export const listQuarries = (): QuarryRow[] => state.claims.slice();

export const quarryAt = (id: string): QuarryRow | undefined => state.claims.find((row) => row.id === id);

export const loadQuarries = (): number => {
  const stored = loadWorldJson<Partial<QuarryState>>(STORE_KEYS.quarry, {});
  const claims = Array.isArray(stored.claims) ? stored.claims : [];
  state.claims = claims
    .filter((row) => row && typeof row.ownerId === "string" && typeof row.x === "number" && typeof row.topY === "number")
    .map((row) => ({
      ...row,
      scan: Number.isFinite(row.scan) ? Math.max(0, Math.floor(row.scan)) : 0,
      mined: Number.isFinite(row.mined) ? Math.max(0, Math.floor(row.mined)) : 0,
      skipped: Number.isFinite(row.skipped) ? Math.max(0, Math.floor(row.skipped)) : 0,
      full: row.full === true,
      buffer: Array.isArray(row.buffer) ? row.buffer.filter((drop) => drop && typeof drop.typeId === "string" && Number.isFinite(drop.amount) && drop.amount > 0) : [],
    }));
  state.season = Number.isFinite(stored.season) ? (stored.season as number) : 0;
  return state.claims.length;
};

export const flushQuarries = (): void => {
  if (!dirty) return;
  dirty = false;
  saveWorldJson(STORE_KEYS.quarry, { claims: state.claims, season: state.season });
};

export const quarryCost = (): number => q.setupCost;

export const quarryShape = (): { side: number; cells: number; depth: number } => {
  const side = q.radius * 2 + 1;
  return { side, cells: side * side * q.depth, depth: q.depth };
};

const result = (ok: boolean, key: string, params?: Record<string, string | number>): { ok: boolean; key: string; params?: Record<string, string | number> } => ({
  ok,
  key,
  params,
});

export const quarryLines = (player: Player): string[] => {
  const claim = findQuarry(player.id);
  if (!claim) return [t(player, "quarry.status.none")];
  const total = quarryCells();
  const status = claim.full ? t(player, "quarry.state.full") : claim.scan >= total ? t(player, "quarry.state.done") : t(player, "quarry.state.works");
  return [
    t(player, "quarry.progress", {
      mined: claim.mined,
      total,
      items: quarryItems(claim),
      stacks: quarryStacks(claim),
      limit: q.bufferStacks,
      skipped: claim.skipped,
      status,
    }),
    t(player, "quarry.where", { x: claim.x, z: claim.z, top: claim.topY, bottom: claim.topY - q.depth + 1 }),
  ];
};

const claimFrom = (player: Player): QuarryRow => {
  const center = player.location;
  return { x: Math.floor(center.x), z: Math.floor(center.z), topY: Math.floor(center.y) - 1 } as QuarryRow;
};

export const canPlaceQuarry = (player: Player): { ok: boolean; key: string; params?: Record<string, string | number> } => {
  if (!getTunables().quarryEnabled) return result(false, "quarry.err.disabled");
  if (findQuarry(player.id)) return result(false, "quarry.err.exists");
  if (state.claims.length >= q.maxClaims) return result(false, "quarry.err.full", { max: q.maxClaims });
  const site = claimFrom(player);
  if (isInsideLobby({ x: site.x, y: 0, z: site.z })) return result(false, "quarry.err.lobby", { distance: CONFIG.lobby.radius + q.radius + 2 });
  if (site.topY > q.maxY) return result(false, "quarry.err.height", { y: q.maxY });
  if (site.topY - q.depth + 1 < q.minY) return result(false, "quarry.err.depth", { y: q.minY });
  const radius = Math.round(borderRadius());
  const span = q.radius + 1;
  if (Math.hypot(site.x, site.z) + span > radius) return result(false, "quarry.err.border", { radius });
  for (const other of state.claims) {
    if (distance2d({ x: site.x, y: 0, z: site.z }, { x: other.x, y: 0, z: other.z }) < q.minDistance) {
      return result(false, "quarry.err.near", { distance: q.minDistance });
    }
  }
  const balance = metaOf(player).coins;
  if (balance < q.setupCost) return result(false, "eco.balance.low", { need: q.setupCost, have: balance });
  return result(true, "quarry.ready", {
    cost: q.setupCost,
    symbol: "₡",
    top: site.topY,
    bottom: site.topY - q.depth + 1,
    cells: quarryCells(),
  });
};

export const createQuarry = (player: Player): { ok: boolean; key: string; params?: Record<string, string | number> } => {
  const check = canPlaceQuarry(player);
  if (!check.ok) return check;
  const site = claimFrom(player);
  const claim: QuarryRow = {
    id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1296)
      .toString(36)
      .padStart(2, "0")}`,
    ownerId: player.id,
    ownerName: player.name,
    x: site.x,
    z: site.z,
    topY: site.topY,
    createdAt: Date.now(),
    season: state.season,
    scan: 0,
    mined: 0,
    skipped: 0,
    full: false,
    buffer: [],
  };
  const paid = burn(player, q.setupCost, `quarry #${claim.id}`);
  if (!paid.ok) return paid;
  state.claims.push(claim);
  markDirty();
  flushQuarries();
  audit(player.name, "quarry", "create", `#${claim.id} (${claim.x},${claim.z}) y${claim.topY}, −${q.setupCost}`);
  return result(true, "quarry.created", { id: claim.id, cells: quarryCells(), cost: q.setupCost, symbol: "₡" });
};

export const closeQuarry = (player: Player): { ok: boolean; key: string; params?: Record<string, string | number> } => {
  const claim = findQuarry(player.id);
  if (!claim) return result(false, "quarry.err.none");
  const left = quarryItems(claim);
  state.claims = state.claims.filter((row) => row.id !== claim.id);
  markDirty();
  flushQuarries();
  audit(player.name, "quarry", "close", `#${claim.id} добыто ${claim.mined}, буфер ${left}`);
  return result(true, "quarry.closed", { mined: claim.mined, left });
};

/**
 * Раздача добычи в инвентарь. Остаток всегда возвращается в буфер: «буфер очищен, а
 * предметы пропали» — единственный исход, который игроки не прощают.
 */
export const collectQuarry = (player: Player): { ok: boolean; key: string; params?: Record<string, string | number> } => {
  const claim = findQuarry(player.id);
  if (!claim) return result(false, "quarry.err.none");
  if (claim.buffer.length === 0) return result(false, "quarry.err.empty");
  let container;
  try {
    container = player.getComponent("minecraft:inventory")?.container;
  } catch (error) {
    log.error("quarry", `инвентарь ${player.name}: ${String(error)}`);
    return result(false, "quarry.err.inventory");
  }
  if (!container) return result(false, "quarry.err.inventory");
  let taken = 0;
  for (const row of [...claim.buffer]) {
    let remaining = row.amount;
    while (remaining > 0) {
      const chunk = Math.min(remaining, stackLimitOf(row.typeId));
      let placed = 0;
      try {
        const leftover = container.addItem(new ItemStack(row.typeId, chunk));
        placed = leftover ? chunk - leftover.amount : chunk;
      } catch (error) {
        log.error("quarry", `addItem ${row.typeId} для ${player.name}: ${String(error)}`);
        placed = 0;
      }
      if (placed <= 0) break;
      taken += placed;
      remaining -= placed;
    }
    if (remaining <= 0) claim.buffer = claim.buffer.filter((candidate) => candidate.typeId !== row.typeId);
    else {
      const entry = claim.buffer.find((candidate) => candidate.typeId === row.typeId);
      if (entry) entry.amount = remaining;
    }
    if (remaining > 0) break;
  }
  claim.full = false;
  markDirty();
  flushQuarries();
  const left = quarryItems(claim);
  audit(player.name, "quarry", "collect", `#${claim.id} +${taken}, в буфере ${left}`);
  if (taken === 0) return result(false, "quarry.err.space", { left });
  return result(true, "quarry.collected", { count: taken, left });
};

const stackLimitOf = (typeId: string): number => {
  try {
    const max = new ItemStack(typeId, 1).maxAmount;
    return Number.isFinite(max) && max > 0 ? Math.min(max, 64) : 64;
  } catch {
    return 64;
  }
};

const dimensionOf = (): ReturnType<typeof world.getDimension> => world.getDimension(CONFIG.lobby.dimension);

/** Один шаг сканирования. false — копать в этом карьере больше нечего. */
const digOne = (claim: QuarryRow, dimension: ReturnType<typeof world.getDimension>, budget: { advances: number }): boolean => {
  const total = quarryCells();
  while (claim.scan < total && budget.advances > 0) {
    budget.advances -= 1;
    const spot = quarryCellAt(claim, claim.scan);
    claim.scan += 1;
    let block;
    try {
      block = dimension.getBlock(spot);
    } catch {
      claim.skipped += 1;
      continue;
    }
    if (!block || block.isAir) {
      claim.skipped += 1;
      continue;
    }
    const drop = QUARRY_MINABLE[block.typeId];
    if (!drop) {
      claim.skipped += 1;
      continue;
    }
    try {
      dimension.setBlockPermutation(spot, BlockPermutation.resolve(AIR));
    } catch (error) {
      // блок мог исчезнуть или быть защищён ядром: это пропуск, а не ошибка такта
      log.debug("quarry", `setBlockPermutation ${spot.x},${spot.y},${spot.z}: ${String(error)}`);
      claim.skipped += 1;
      continue;
    }
    claim.mined += 1;
    addToBuffer(claim, drop);
    return true;
  }
  return false;
};

const onlineOwners = (): Map<string, Player> => new Map(world.getAllPlayers().map((player) => [player.id, player]));

const whisper = (owner: Player | undefined, key: string, params?: Record<string, string | number>): void => {
  if (!owner) return;
  try {
    owner.sendMessage(t(owner, key, params));
  } catch (error) {
    log.debug("quarry", `notify ${owner.name}: ${String(error)}`);
  }
};

/**
 * Объём вычерпан: карьер перестаёт копать, но НЕ удаляется — иначе буфер с добычей
 * исчез бы вместе с записью. Игрок забирает добычу и закрывает слот сам.
 */
const markExhausted = (claim: QuarryRow, owner: Player | undefined): void => {
  audit(claim.ownerName, "quarry", "exhausted", `#${claim.id} добыто ${claim.mined}, пропущено ${claim.skipped}`);
  notifyAdmins(`[quarry] #${claim.id} вычерпан: ${claim.mined} ячеек (${claim.ownerName}), в буфере ${quarryItems(claim)}`);
  whisper(owner, "quarry.notify.done", { mined: claim.mined, skipped: claim.skipped });
};

export const quarryTick = (): void => {
  if (state.claims.length === 0 || !getTunables().quarryEnabled) return;
  const dimension = dimensionOf();
  const owners = onlineOwners();
  const total = quarryCells();
  const working = state.claims.filter((claim) => !claim.full && claim.scan < total && owners.has(claim.ownerId));
  if (working.length === 0) return;
  const writes = working.length * q.cellsPerClaim + q.extraCells;
  const budget = { advances: writes * q.maxSkipPerCell };
  let spent = 0;
  for (const claim of working) {
    while (spent < writes) {
      if (claim.full || claim.scan >= total) break;
      if (!digOne(claim, dimension, budget)) break;
      spent += 1;
      if (quarryStacks(claim) >= q.bufferStacks) {
        claim.full = true;
        whisper(owners.get(claim.ownerId), "quarry.notify.full", { stacks: q.bufferStacks });
        break;
      }
    }
    if (claim.scan >= total) markExhausted(claim, owners.get(claim.ownerId));
  }
  if (spent > 0) markDirty();
};

/**
 * Посадка внутри карьера: ищем первую клетку сверху вниз, где воздух твёрдой опорой снизу.
 * Тупо «y = topY + depth + 1» означало бы телепорт в невскрытую породу (удушье), потому что
 * карьер открывает объём снизу вверх по ярусам, а не «колодец» до дна.
 */
const pickLanding = (claim: QuarryRow, dimension: ReturnType<typeof world.getDimension>): Vector3 | undefined => {
  for (let y = claim.topY; y >= claim.topY - q.depth + 1; y -= 1) {
    try {
      const cell = dimension.getBlock({ x: claim.x, y, z: claim.z });
      if (!cell || !cell.isAir) continue;
      const below = dimension.getBlock({ x: claim.x, y: y - 1, z: claim.z });
      if (!below || below.isAir) continue;
      return { x: claim.x + 0.5, y, z: claim.z + 0.5 };
    } catch {
      continue;
    }
  }
  return undefined;
};

/** Телепорт к своей площадке: grace нужен, чтобы anticheat не счёл перелёт спидхак-взломом. */
export const teleportToQuarry = (player: Player): { ok: boolean; key: string; params?: Record<string, string | number> } => {
  const claim = findQuarry(player.id);
  if (!claim) return result(false, "quarry.err.none");
  const spot = pickLanding(claim, dimensionOf());
  // «приземлиться в породу» — верный способ убить игрока, поэтому лучше отказ
  if (!spot) return result(false, "quarry.err.land");
  try {
    player.teleport(spot, { dimension: dimensionOf() });
  } catch (error) {
    log.debug("quarry", `teleport ${player.name}: ${String(error)}`);
    return result(false, "quarry.err.none");
  }
  grantGrace(player.id, 3000);
  audit(player.name, "quarry", "teleport", `#${claim.id} y${spot.y}`);
  return result(true, "quarry.go.done", { id: claim.id, y: spot.y });
};

/** Административный отчёт: строки без i18n-игрока, как в `queueReport`/`ecoSummary`. */
export const quarryAdminLines = (): string[] =>
  state.claims.map((claim) => {
    const total = quarryCells();
    const status = claim.full ? "буфер полон" : claim.scan >= total ? "вычерпан" : "роет";
    return `#${claim.id} · ${claim.ownerName} · (${claim.x},${claim.z}) y${claim.topY} · ${claim.mined}/${total} · буфер ${quarryItems(claim)} шт. (${quarryStacks(claim)}/${q.bufferStacks}) · ${status}`;
  });

export const releaseQuarry = (actor: string, id: string): { ok: boolean; key: string; params?: Record<string, string | number> } => {
  const claim = quarryAt(id);
  if (!claim) return result(false, "quarry.err.id", { id });
  const lost = quarryItems(claim);
  state.claims = state.claims.filter((row) => row.id !== id);
  markDirty();
  flushQuarries();
  const owner = world.getAllPlayers().find((player) => player.id === claim.ownerId);
  if (owner) whisper(owner, "quarry.released", { id, lost });
  audit(actor, "quarry", "release", `#${id} владельца ${claim.ownerName}, буфер ${lost} предметов`);
  notifyAdmins(`[quarry] ${actor} освободил #${id} (в буфере было ${lost} предметов — игрок их не получил)`);
  return result(true, "quarry.released", { id, lost });
};

export const quarrySummary = (): { claims: number; mined: number; items: number; online: number; enabled: boolean } => {
  const owners = onlineOwners();
  return {
    claims: state.claims.length,
    mined: state.claims.reduce((sum, claim) => sum + claim.mined, 0),
    items: state.claims.reduce((sum, claim) => sum + quarryItems(claim), 0),
    online: state.claims.filter((claim) => owners.has(claim.ownerId)).length,
    enabled: getTunables().quarryEnabled,
  };
};

/**
 * @param seasonIndex индекс сезона: карьеры из вайпнутого мира списываются при загрузке,
 *   потому что координаты после смены сида теряют смысл.
 */
export const initQuarry = (seasonIndex: number): void => {
  const loaded = loadQuarries();
  const stale = state.claims.filter((claim) => claim.season !== seasonIndex);
  if (stale.length > 0) {
    state.claims = state.claims.filter((claim) => claim.season === seasonIndex);
    log.info("quarry", `списано карьеров прошлого сезона: ${stale.length}`);
  }
  state.season = seasonIndex;
  markDirty();
  flushQuarries();
  registerTask("quarry-dig", q.everyTicks, 4, () => {
    quarryTick();
    flushQuarries();
  });
  log.info("quarry", `задача quarry-dig каждые ${q.everyTicks} тиков; карьеров загружено ${state.claims.length} (в мире было ${loaded})`);
};
