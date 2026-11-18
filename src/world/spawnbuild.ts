import { BlockPermutation, Player, Vector3, world } from "@minecraft/server";
import { CONFIG, STORE_KEYS } from "../config";
import { t } from "../kernel/i18n";
import { log } from "../kernel/logger";
import { loadWorldJson, saveWorldJson } from "../kernel/store";
import { registerTask } from "../kernel/ticker";
import { audit, notifyAdmins } from "../security/audit";
import { lobbySpawnPoint } from "./spawn";
import type { SpawnBuildMode, SpawnBuildState } from "../types/domain";

/**
 * Сборщик спавна.
 *
 * Мир сезонный: после вайпа (`deploy/season-wipe.sh`) спавна нет как класса, а игрок
 * прилетает в сгенерированный рельеф. Поэтому площадь спавна описана blueprint'ом и
 * перестраивается скриптом — детерминированно, по одному и тому же плану, с бюджетом на
 * такт (755 ячеек — это не «зависание на минуту», а ~7 проходов по 120 блоков) и с
 * умением чинить дыры: проход сверяет ожидаемый блок с фактическим и пишет только то,
 * чего не хватает.
 *
 * Тот же blueprint — источник истины для «алтаря меню»: взаимодействие с центральным
 * золотым блоком открывает `/sw:menu`, поэтому игроку не нужно помнить команды.
 */

const s = CONFIG.spawn;
const lobby = CONFIG.lobby;
const half = Math.floor(s.size / 2);
const floorY = lobby.y - 1;

const FLOOR = "minecraft:polished_andesite";
const RIM = "minecraft:deepslate_bricks";
const PILLAR = "minecraft:polished_deepslate";
const LAMP = "minecraft:sea_lantern";
const PATH = "minecraft:stone_bricks";
const DAIS = "minecraft:polished_blackstone";
const MENU_BLOCK = "minecraft:gold_block";

export interface BlueprintCell {
  x: number;
  y: number;
  z: number;
  typeId: string;
}

let cache: BlueprintCell[] | undefined;

export const spawnBlueprint = (): BlueprintCell[] => {
  if (cache) return cache;
  const cells: BlueprintCell[] = [];
  const push = (x: number, y: number, z: number, typeId: string): void => {
    cells.push({ x, y, z, typeId });
  };

  for (let dx = -half; dx <= half; dx += 1) {
    for (let dz = -half; dz <= half; dz += 1) {
      const rim = Math.abs(dx) === half || Math.abs(dz) === half;
      push(lobby.x + dx, floorY, lobby.z + dz, rim ? RIM : FLOOR);
    }
  }

  const pillarOffset = half - 2;
  for (const dx of [-pillarOffset, pillarOffset]) {
    for (const dz of [-pillarOffset, pillarOffset]) {
      for (let step = 1; step <= s.pillarHeight; step += 1) {
        push(lobby.x + dx, floorY + step, lobby.z + dz, PILLAR);
      }
      push(lobby.x + dx, floorY + s.pillarHeight + 1, lobby.z + dz, LAMP);
    }
  }

  // четыре дорожки наружу: чтобы с точки возрождения было видно, куда идти
  for (const [axisX, axisZ] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const) {
    for (let step = 1; step <= s.pathLength; step += 1) {
      for (const side of [-1, 0, 1]) {
        const x = lobby.x + axisX * (half + step) + axisZ * side;
        const z = lobby.z + axisZ * (half + step) + axisX * side;
        push(x, floorY, z, PATH);
      }
    }
  }

  // алтарь меню: смещён от точки возрождения, чтобы не оказаться под ногами у игрока
  const altarX = lobby.x;
  const altarZ = lobby.z - 4;
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      push(altarX + dx, floorY + 1, altarZ + dz, DAIS);
    }
  }
  push(altarX, floorY + 2, altarZ, MENU_BLOCK);

  cache = cells;
  cellIndex = undefined; // новый blueprint = старый индекс клеток протух
  return cells;
};

export const spawnMenuBlockLocation = (): Vector3 => ({ x: lobby.x, y: floorY + 2, z: lobby.z - 4 });

let cellIndex: Map<string, BlueprintCell> | undefined;

/**
 * Ожидание blueprint'а для конкретной клетки. Нужно затем, чтобы откат установки блока на
 * спавне возвращал *структуру*, а не дыру: если игрок поставил блок туда, где по плану лежит
 * плита или вода фонтана, «просто убрать блок» означало бы, что защиту спавна ломает сама
 * защита спавна.
 */
export const spawnBlueprintCellAt = (x: number, y: number, z: number): BlueprintCell | undefined => {
  if (!cellIndex) cellIndex = new Map(spawnBlueprint().map((cell) => [`${cell.x}:${cell.y}:${cell.z}`, cell]));
  return cellIndex.get(`${Math.floor(x)}:${Math.floor(y)}:${Math.floor(z)}`);
};

export const isSpawnMenuBlock = (block: { typeId?: string; x?: number; y?: number; z?: number }): boolean => {
  if (block?.typeId !== MENU_BLOCK) return false;
  const spot = spawnMenuBlockLocation();
  return block.x === spot.x && block.y === spot.y && block.z === spot.z;
};

const state: SpawnBuildState = {
  mode: "build",
  cursor: 0,
  total: 0,
  written: 0,
  running: false,
  startedAt: 0,
  lastCheckAt: 0,
  missing: 0,
  season: 0,
};

let dirty = false;

const persist = (): void => {
  if (!dirty) return;
  dirty = false;
  saveWorldJson(STORE_KEYS.spawnBuild, {
    mode: state.mode,
    cursor: state.cursor,
    total: state.total,
    written: state.written,
    running: state.running,
    startedAt: state.startedAt,
    lastCheckAt: state.lastCheckAt,
    missing: state.missing,
    season: state.season,
  });
};

export const loadSpawnBuild = (): void => {
  const stored = loadWorldJson<Partial<SpawnBuildState>>(STORE_KEYS.spawnBuild, {});
  const blueprint = spawnBlueprint();
  state.total = blueprint.length;
  state.mode = stored.mode === "repair" ? "repair" : "build";
  state.cursor = Number.isFinite(stored.cursor) ? Math.min(Math.max(0, Math.floor(stored.cursor as number)), blueprint.length) : 0;
  state.written = Number.isFinite(stored.written) ? Math.max(0, Math.floor(stored.written as number)) : 0;
  state.running = stored.running === true;
  state.startedAt = Number.isFinite(stored.startedAt) ? (stored.startedAt as number) : 0;
  state.lastCheckAt = Number.isFinite(stored.lastCheckAt) ? (stored.lastCheckAt as number) : 0;
  state.missing = Number.isFinite(stored.missing) ? Math.max(0, Math.floor(stored.missing as number)) : 0;
  state.season = Number.isFinite(stored.season) ? (stored.season as number) : 0;
};

export const startSpawnBuild = (actor: string, mode: SpawnBuildMode): { ok: boolean; key: string; params?: Record<string, string | number> } => {
  const blueprint = spawnBlueprint();
  if (state.running) return { ok: false, key: "spawn.err.running", params: { done: state.written, total: state.total } };
  state.mode = mode;
  state.cursor = 0;
  state.written = 0;
  state.missing = 0;
  state.running = true;
  state.startedAt = Date.now();
  state.total = blueprint.length;
  dirty = true;
  persist();
  audit(actor, "spawn", mode, `запущено ${blueprint.length} ячеек`);
  return { ok: true, key: mode === "repair" ? "spawn.repair.started" : "spawn.build.started", params: { total: blueprint.length, perRun: s.blocksPerRun } };
};

const dimension = (): ReturnType<typeof world.getDimension> => world.getDimension(lobby.dimension);

const sameBlock = (spot: BlueprintCell): boolean => {
  try {
    const block = dimension().getBlock({ x: spot.x, y: spot.y, z: spot.z });
    return block?.typeId === spot.typeId;
  } catch {
    return false;
  }
};

const writeCell = (spot: BlueprintCell): boolean => {
  if (sameBlock(spot)) return false;
  try {
    dimension().setBlockPermutation({ x: spot.x, y: spot.y, z: spot.z }, BlockPermutation.resolve(spot.typeId));
  } catch (error) {
    log.debug("spawn", `не удалось поставить ${spot.typeId} в ${spot.x},${spot.y},${spot.z}: ${String(error)}`);
    return false;
  }
  return true;
};

export const spawnBuildTick = (): void => {
  const blueprint = spawnBlueprint();
  if (!state.running) return;
  let spent = 0;
  while (state.cursor < blueprint.length && spent < s.blocksPerRun) {
    const cell = blueprint[state.cursor];
    state.cursor += 1;
    spent += 1;
    if (writeCell(cell)) {
      state.written += 1;
      dirty = true;
    }
  }
  // курсор двигается всегда — его и надо пережить рестарту, даже если за проход не поставлено ничего
  dirty = true;
  persist();
  if (state.cursor < blueprint.length) return;
  state.running = false;
  dirty = true;
  persist();
  notifyAdmins(`[spawn] сборка завершена: записано ${state.written} ячеек из ${blueprint.length}`);
};

/**
 * Дешёвая проверка целостности: не обходим весь blueprint (755 чтений каждые 30 с —
 * лишняя нагрузка на пустом сервере), а берём детерминированную выборку со сдвигом.
 */
export const checkSpawnIntegrity = (force = false): { checked: number; missing: number } => {
  const blueprint = spawnBlueprint();
  const samples = Math.min(s.sampleCells, blueprint.length);
  const stride = Math.max(1, Math.floor(blueprint.length / samples));
  const shift = Math.floor(Date.now() / 1000) % stride;
  const seen = new Set<number>();
  let missing = 0;
  for (let index = 0; index < samples; index += 1) {
    seen.add((index * stride + shift) % blueprint.length);
  }
  for (const cell of spawnCriticalCells()) {
    const position = blueprint.indexOf(cell);
    if (position >= 0) seen.add(position);
  }
  for (const position of seen) {
    if (!sameBlock(blueprint[position])) missing += 1;
  }
  state.missing = missing;
  state.lastCheckAt = Date.now();
  dirty = true;
  persist();
  if (force) return { checked: seen.size, missing };
  if (missing >= s.repairAfterMissing && !state.running) {
    log.warn("spawn", `проверка нашла расхождений: ${missing} из ${samples}, запускаю починку`);
    startSpawnBuild("spawn-watch", "repair");
  }
  return { checked: seen.size, missing };
};

/**
 * Клетки, которые сверяются ВСЕГДА, а не по выборке: плита под точкой возрождения и алтарь
 * меню. Игрок, упавший в дыру на спавне, или недоступный алтарь — это ЧП, а не «не повезло
 * с выборкой», поэтому эти 10 ячеек проверяются целиком и независимо от stride.
 */
export const spawnCriticalCells = (): BlueprintCell[] => {
  const altar = spawnMenuBlockLocation();
  const nearSpawn = (cell: BlueprintCell): boolean => Math.abs(cell.x - lobby.x) <= 1 && Math.abs(cell.z - lobby.z) <= 1;
  return spawnBlueprint().filter(
    (cell) => (cell.y === floorY && nearSpawn(cell)) || (cell.x === altar.x && cell.y === altar.y && cell.z === altar.z),
  );
};

export const setSpawnPoint = (): void => {
  try {
    world.setDefaultSpawnLocation(lobbySpawnPoint());
  } catch (error) {
    log.debug("spawn", `setDefaultSpawnLocation: ${String(error)}`);
  }
};

export const spawnStatus = (): { built: number; total: number; running: boolean; missing: number; mode: SpawnBuildMode; cursor: number } => ({
  built: state.written,
  total: state.total,
  running: state.running,
  missing: state.missing,
  mode: state.mode,
  cursor: state.cursor,
});

export const spawnPreviewLines = (): string[] => {
  const blueprint = spawnBlueprint();
  const counts = new Map<string, number>();
  for (const cell of blueprint) counts.set(cell.typeId, (counts.get(cell.typeId) ?? 0) + 1);
  const lines = [`площадь ${s.size}×${s.size} на y=${floorY}, алтарь меню в (${spawnMenuBlockLocation().x}, ${spawnMenuBlockLocation().y}, ${spawnMenuBlockLocation().z})`, `ячеек всего: ${blueprint.length}, за проход ≤ ${s.blocksPerRun}`];
  for (const [typeId, count] of [...counts.entries()].sort((left, right) => right[1] - left[1])) {
    lines.push(`  ${typeId.replace("minecraft:", "")} × ${count}`);
  }
  return lines;
};

export const spawnStatusLines = (player?: Player): string[] => {
  const status = spawnStatus();
  return [
    player
      ? t(player, "spawn.status", {
          done: status.built,
          total: status.total,
          cursor: status.cursor,
          mode: status.mode === "repair" ? t(player, "spawn.mode.repair") : t(player, "spawn.mode.build"),
          state: status.running ? t(player, "spawn.state.running") : t(player, "spawn.state.idle"),
          missing: status.missing,
        })
      : `спавн: ${status.built}/${status.total} записано, режим ${status.mode}, расхождений ${status.missing}`,
  ];
};

export const initSpawnBuild = (seasonIndex: number): void => {
  loadSpawnBuild();
  const blueprint = spawnBlueprint();
  if (state.season !== seasonIndex) {
    // новый сезон = новый сид: прогресс прошлой сборки обнуляем, иначе курсор укажет в никуда
    state.cursor = 0;
    state.written = 0;
    state.running = true;
    state.mode = "build";
    state.season = seasonIndex;
    dirty = true;
    persist();
    log.info("spawn", `сезон ${seasonIndex}: спавн пересобирается с нуля (${blueprint.length} ячеек)`);
  }
  setSpawnPoint();
  registerTask("spawn-build", s.everyTicks, 3, () => spawnBuildTick());
  registerTask("spawn-watch", s.checkEveryTicks, 2, () => checkSpawnIntegrity());
  log.info("spawn", `blueprint: ${blueprint.length} ячеек, проверка каждые ${s.checkEveryTicks} тиков`);
};
