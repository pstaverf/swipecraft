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

/**
 * Декор. Правила подбора такие: только блоки без обязательных состояний (у `BlockPermutation`
 * в blueprint'е нет состояний, а лестницы и двери без `facing_direction` легли бы «всё в одну
 * сторону») и только то, что есть в `MinecraftBlockTypes` проверяемой версии — стаб сверяет
 * каждый id, иначе «красивый спавн» превратился бы в «спавн с дырками».
 */
const INLAY = "minecraft:deepslate_tiles";
const RAIL = "minecraft:iron_bars";
const ARCH = "minecraft:stone_bricks";
const COLD_LAMP = "minecraft:soul_lantern";
const LANTERN = "minecraft:lantern";
const WATER = "minecraft:water";
const BASIN = "minecraft:polished_blackstone_bricks";
const PLANTER = "minecraft:moss_block";
const FLOWERS = [
  "minecraft:poppy",
  "minecraft:oxeye_daisy",
  "minecraft:allium",
  "minecraft:cornflower",
  "minecraft:short_grass",
];
/** Высота арок и столбов над плитой; лампы ставятся ровно над ними, чтобы было на чём стоять. */
const ARCH_HEIGHT = 3;
const GATE_HALF = 1;

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
  const index = new Map<string, number>();

  /**
   * Последняя запись выигрывает. Декор дорисовывается поверх плиты, и если бы на одну клетку
   * пришлось две записи, `sameBlock` вечно видел бы расхождение: починка перестраивала бы
   * площадь по кругу, а «красивый спавн» превратился бы в вечную стройку.
   */
  const push = (x: number, y: number, z: number, typeId: string): void => {
    const key = `${x}:${y}:${z}`;
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, cells.length);
      cells.push({ x, y, z, typeId });
      return;
    }
    cells[at] = { x, y, z, typeId };
  };

  /** Клетка на расстоянии `along` от центра по направлению (ax, az) и `side` вбок. */
  const edge = (ax: number, az: number, along: number, side: number): [number, number] => [
    lobby.x + ax * along - az * side,
    lobby.z + az * along + ax * side,
  ];
  const AXES = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;

  // 1. плита: шахматная кладка — самый дешёвый способ перестать выглядеть «площадкой из ванили»
  for (let dx = -half; dx <= half; dx += 1) {
    for (let dz = -half; dz <= half; dz += 1) {
      const rim = Math.abs(dx) === half || Math.abs(dz) === half;
      const light = (Math.abs(dx) + Math.abs(dz)) % 2 === 0;
      push(lobby.x + dx, floorY, lobby.z + dz, rim ? RIM : light ? FLOOR : INLAY);
    }
  }

  // 2. ограда по внутреннему краю с четырьмя проёмами ровно там, где дорожки
  for (let dx = -half + 1; dx <= half - 1; dx += 1) {
    for (let dz = -half + 1; dz <= half - 1; dz += 1) {
      const onRim = Math.abs(dx) === half - 1 || Math.abs(dz) === half - 1;
      if (!onRim) continue;
      const gate =
        (dx === 0 && Math.abs(dz) >= half - 1 - GATE_HALF) || (dz === 0 && Math.abs(dx) >= half - 1 - GATE_HALF);
      if (gate) continue;
      push(lobby.x + dx, floorY + 1, lobby.z + dz, RAIL);
    }
  }

  // 3. колонны с лампами + башенки по углам (холодный свет на углах, тёплый над площадью)
  const pillarOffset = half - 2;
  for (const dx of [-pillarOffset, pillarOffset]) {
    for (const dz of [-pillarOffset, pillarOffset]) {
      for (let step = 1; step <= s.pillarHeight; step += 1) {
        push(lobby.x + dx, floorY + step, lobby.z + dz, PILLAR);
      }
      push(lobby.x + dx, floorY + s.pillarHeight + 1, lobby.z + dz, LAMP);
    }
  }
  for (const dx of [-half + 1, half - 1]) {
    for (const dz of [-half + 1, half - 1]) {
      for (let step = 1; step <= 3; step += 1) push(lobby.x + dx, floorY + step, lobby.z + dz, PILLAR);
      push(lobby.x + dx, floorY + 4, lobby.z + dz, COLD_LAMP);
    }
  }

  // 4. четыре дорожки наружу: чтобы с точки возрождения было видно, куда идти
  for (const [ax, az] of AXES) {
    for (let step = 1; step <= s.pathLength; step += 1) {
      for (const side of [-1, 0, 1]) {
        const [x, z] = edge(ax, az, half + step, side);
        push(x, floorY, z, PATH);
      }
    }
  }

  // 5. арки на дорожках: пилоны, прогон и лампы сверху — вход ощущается входом, а не дырой
  for (const [ax, az] of AXES) {
    for (const side of [-2, 2]) {
      for (let step = 1; step <= ARCH_HEIGHT; step += 1) {
        const [x, z] = edge(ax, az, half - 1, side);
        push(x, floorY + step, z, PILLAR);
      }
      const [top, topZ] = edge(ax, az, half - 1, side);
      push(top, floorY + ARCH_HEIGHT + 2, topZ, LANTERN);
    }
    for (let side = -2; side <= 2; side += 1) {
      const [x, z] = edge(ax, az, half - 1, side);
      push(x, floorY + ARCH_HEIGHT + 1, z, ARCH);
    }
    // фонари вдоль дорожки: середина и конец, чтобы ночью дорога была видна с площади
    for (const along of [half + Math.ceil(s.pathLength / 2), half + s.pathLength]) {
      const [x, z] = edge(ax, az, along, 2);
      push(x, floorY + 1, z, PILLAR);
      push(x, floorY + 2, z, LANTERN);
    }
  }

  // 6. фонтан: вода идёт клеткой ниже уровня плиты — источник некуда растекать, и пол не размывает
  const fountain = { x: lobby.x, z: lobby.z + 6 };
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) push(fountain.x + dx, floorY, fountain.z + dz, WATER);
  }
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dz = -2; dz <= 2; dz += 1) {
      if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2) continue;
      push(fountain.x + dx, floorY + 1, fountain.z + dz, BASIN);
    }
  }
  push(fountain.x, floorY - 1, fountain.z, LAMP);

  // 7. клумбы в четырёх квадрантах: углы — грунт, крестовина — цветы
  let flower = 0;
  for (const [bx, bz] of [[-6, -6], [6, -6], [-6, 6], [6, 6]] as const) {
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        const cross = Math.abs(dx) + Math.abs(dz) <= 1;
        const typeId = cross ? FLOWERS[flower++ % FLOWERS.length] : PLANTER;
        push(lobby.x + bx + dx, floorY + 1, lobby.z + bz + dz, typeId);
      }
    }
  }

  // 8. алтарь меню: смещён от точки возрождения, чтобы не оказаться под ногами у игрока
  const altarX = lobby.x;
  const altarZ = lobby.z - 4;
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      push(altarX + dx, floorY + 1, altarZ + dz, DAIS);
    }
  }
  push(altarX, floorY + 2, altarZ, MENU_BLOCK);
  for (const dx of [-1, 1]) {
    for (const dz of [-1, 1]) push(altarX + dx, floorY + 2, altarZ + dz, LANTERN);
  }

  cache = cells;
  cellIndex = undefined; // новый blueprint = старый индекс клеток протух
  return cells;
};

export const spawnMenuBlockLocation = (): Vector3 => ({ x: lobby.x, y: floorY + 2, z: lobby.z - 4 });

let cellIndex: Map<string, BlueprintCell> | undefined;
let clearCache: BlueprintCell[] | undefined;

/**
 * Клетки, которых в blueprint'е нет, но которые ОБЯЗАНЫ быть пустыми: внутренний объём
 * площади от плиты до самой верхней клетки плана (столбы, арки, фонари).
 *
 * Нужны затем, чтобы спавн возвращался к плану целиком, а не «наполовину». Проверка
 * сверяла только blueprint-клетки, и из этого вылезало два: (1) блок, притащенный на площадь
 * при снятом стоп-кране, оставался там навсегда — план его не описывает, значит и чинить
 * нечего; (2) выбитая клетка пола лечилась только если выборка нашла сразу
 * `repairAfterMissing` дырок, а при 1–3 находках проверка просто писала число в статус.
 */
export const spawnClearCells = (): BlueprintCell[] => {
  if (clearCache) return clearCache;
  const blueprint = spawnBlueprint();
  const known = new Set(blueprint.map((cell) => `${cell.x}:${cell.y}:${cell.z}`));
  let top = floorY;
  for (const cell of blueprint) top = Math.max(top, cell.y);
  const cells: BlueprintCell[] = [];
  for (let dx = -half + 1; dx <= half - 1; dx += 1) {
    for (let dz = -half + 1; dz <= half - 1; dz += 1) {
      for (let y = floorY + 1; y <= top; y += 1) {
        const x = lobby.x + dx;
        const z = lobby.z + dz;
        if (known.has(`${x}:${y}:${z}`)) continue;
        cells.push({ x, y, z, typeId: "minecraft:air" });
      }
    }
  }
  clearCache = cells;
  return cells;
};

/** Клетка blueprint'а, которую надо записать, — или клетка зачистки (typeId = air). */
const cellKeyOf = (cell: BlueprintCell): string => `${cell.x}:${cell.y}:${cell.z}`;

/**
 * Пустые клетки, которые сверяются ВСЕГДА, а не по выборке: воздух над точкой возрождения
 * (иначе игрок встаёт в блок) и четыре проёма в ограде (иначе площадь превращается в клетку,
 * из которой не выйти). Их шесть, стоимость — шесть чтений на проверку.
 */
export const spawnCriticalClearCells = (): BlueprintCell[] => {
  const known = new Set(spawnBlueprint().map((cell) => cellKeyOf(cell)));
  const candidates: BlueprintCell[] = [
    { x: lobby.x, y: floorY + 1, z: lobby.z, typeId: "minecraft:air" },
    { x: lobby.x, y: floorY + 2, z: lobby.z, typeId: "minecraft:air" },
    { x: lobby.x, y: floorY + 1, z: lobby.z + half - 1, typeId: "minecraft:air" },
    { x: lobby.x, y: floorY + 1, z: lobby.z - half + 1, typeId: "minecraft:air" },
    { x: lobby.x + half - 1, y: floorY + 1, z: lobby.z, typeId: "minecraft:air" },
    { x: lobby.x - half + 1, y: floorY + 1, z: lobby.z, typeId: "minecraft:air" },
  ];
  return candidates.filter((cell) => !known.has(cellKeyOf(cell)));
};

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
  sweep: false,
  clearCursor: 0,
  cleared: 0,
  foreign: 0,
};

/**
 * Точечные записи последней проверки (выбитые клетки плана и чужие блоки). В память, не в
 * хранилище:список короткий (≤ blocksPerRun), а после рестарта проверка пройдёт заново и
 * соберёт её снова — терять тут нечего, а поле в JSON только бы протухало.
 */
let pendingPins: BlueprintCell[] = [];

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
    sweep: state.sweep,
    clearCursor: state.clearCursor,
    cleared: state.cleared,
    foreign: state.foreign,
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
  state.sweep = stored.sweep === true;
  const clearTotal = spawnClearCells().length;
  state.clearCursor = Number.isFinite(stored.clearCursor) ? Math.min(Math.max(0, Math.floor(stored.clearCursor as number)), clearTotal) : 0;
  state.cleared = Number.isFinite(stored.cleared) ? Math.max(0, Math.floor(stored.cleared as number)) : 0;
  state.foreign = Number.isFinite(stored.foreign) ? Math.max(0, Math.floor(stored.foreign as number)) : 0;
};

export interface SpawnBuildRequest {
  /** записать/очистить эти клетки первыми, до общего прохода по плану */
  pins?: BlueprintCell[];
  /** после плана пройтись и по «должен быть пуст» объёму (только repair) */
  sweep?: boolean;
}

export const startSpawnBuild = (
  actor: string,
  mode: SpawnBuildMode,
  request: SpawnBuildRequest = {},
): { ok: boolean; key: string; params?: Record<string, string | number> } => {
  const blueprint = spawnBlueprint();
  if (state.running) return { ok: false, key: "spawn.err.running", params: { done: state.written, total: state.total } };
  state.mode = mode;
  state.cursor = 0;
  state.written = 0;
  state.missing = 0;
  state.sweep = mode === "repair" && request.sweep === true;
  state.clearCursor = 0;
  state.cleared = 0;
  state.foreign = 0;
  // список короткий по построению: его собирает выборка проверки (≤ 3 × sampleCells)
  pendingPins = [...(request.pins ?? [])];
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
  // 1. точечные находки последней проверки — их ждёт игрок прямо сейчас, поэтому они идут
  //    до общего прохода и не зависят от того, «созрел» ли порог полной пересборки
  while (pendingPins.length > 0 && spent < s.blocksPerRun) {
    spent += 1;
    if (writeCell(pendingPins.shift() as BlueprintCell)) dirty = true;
  }
  // 2. план
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
  // 3. уборка: объём, который по плану обязан быть пустым. Только в repair и только когда
  //    проверка сочла повреждения массовыми — иначе платим 4700 чтений за каждую ерунду
  const clearCells = state.sweep ? spawnClearCells() : [];
  while (state.sweep && state.clearCursor < clearCells.length && spent < s.blocksPerRun) {
    const cell = clearCells[state.clearCursor];
    state.clearCursor += 1;
    spent += 1;
    if (writeCell(cell)) {
      state.cleared += 1;
      dirty = true;
    }
  }
  if (state.sweep && state.clearCursor < clearCells.length) {
    persist();
    return;
  }
  state.running = false;
  state.sweep = false;
  dirty = true;
  persist();
  notifyAdmins(
    `[spawn] сборка завершена: записано ${state.written} ячеек из ${blueprint.length}` +
      (state.cleared > 0 ? `, убрано чужих блоков: ${state.cleared}` : ""),
  );
};

/**
 * Дешёвая проверка целостности: не обходим весь blueprint (755 чтений каждые 30 с —
 * лишняя нагрузка на пустом сервере), а берём детерминированную выборку со сдвигом.
 */
export const checkSpawnIntegrity = (
  force = false,
): { checked: number; missing: number; foreign: number; pinned: number } => {
  const blueprint = spawnBlueprint();
  const clearCells = spawnClearCells();
  const samples = Math.min(s.sampleCells, blueprint.length);
  const stride = Math.max(1, Math.floor(blueprint.length / samples));
  const shift = Math.floor(Date.now() / 1000) % stride;
  const seen = new Set<number>();
  for (let index = 0; index < samples; index += 1) {
    seen.add((index * stride + shift) % blueprint.length);
  }
  for (const cell of spawnCriticalCells()) {
    const position = blueprint.indexOf(cell);
    if (position >= 0) seen.add(position);
  }
  const pins: BlueprintCell[] = [];
  let missing = 0;
  for (const position of seen) {
    const cell = blueprint[position];
    if (sameBlock(cell)) continue;
    missing += 1;
    pins.push(cell);
  }
  // та же выборка по «должен быть пуст»: свой stride, потому что объём зачистки больше плана
  const clearSamples = Math.min(s.sampleCells, clearCells.length);
  const clearStride = Math.max(1, Math.floor(clearCells.length / clearSamples));
  const clearShift = Math.floor(Date.now() / 1000) % clearStride;
  const checkedClear = new Set<number>();
  for (let index = 0; index < clearSamples; index += 1) {
    checkedClear.add((index * clearStride + clearShift) % Math.max(1, clearCells.length));
  }
  for (const cell of spawnCriticalClearCells()) {
    checkedClear.add(clearCells.findIndex((row) => row.x === cell.x && row.y === cell.y && row.z === cell.z));
  }
  let foreign = 0;
  for (const position of checkedClear) {
    const cell = clearCells[position];
    if (!cell || sameBlock(cell)) continue;
    foreign += 1;
    pins.push(cell);
  }
  state.missing = missing + foreign;
  state.foreign = foreign;
  state.lastCheckAt = Date.now();
  dirty = true;
  persist();
  if (force) return { checked: seen.size + checkedClear.size, missing, foreign, pinned: pins.length };
  if (state.running || pins.length === 0) return { checked: seen.size + checkedClear.size, missing, foreign, pinned: 0 };
  const sweep = missing + foreign >= s.repairAfterMissing;
  log.warn(
    "spawn",
    `проверка нашла расхождений: ${missing} плана + ${foreign} чужих блоков, чиню точечно${sweep ? " и запускаю уборку" : ""}`,
  );
  startSpawnBuild("spawn-watch", "repair", { pins, sweep });
  return { checked: seen.size + checkedClear.size, missing, foreign, pinned: pins.length };
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

/** Все id, которые blueprint вообще где-то использует — нужны стабу как «нет несуществующих блоков». */
export const spawnBlueprintTypeIds = (): string[] => [
  ...new Set(spawnBlueprint().map((cell) => cell.typeId)),
];

/** Сколько клеток пришлось бы записать с нуля: используется проверкой «второй проход ничего не пишет». */
export const spawnBlueprintSize = (): number => spawnBlueprint().length;

export const setSpawnPoint = (): void => {
  try {
    world.setDefaultSpawnLocation(lobbySpawnPoint());
  } catch (error) {
    log.debug("spawn", `setDefaultSpawnLocation: ${String(error)}`);
  }
};

export const spawnStatus = (): {
  built: number;
  total: number;
  running: boolean;
  missing: number;
  mode: SpawnBuildMode;
  cursor: number;
  foreign: number;
  cleared: number;
  sweep: boolean;
  pinned: number;
} => ({
  built: state.written,
  total: state.total,
  running: state.running,
  missing: state.missing,
  mode: state.mode,
  cursor: state.cursor,
  foreign: state.foreign,
  cleared: state.cleared,
  sweep: state.sweep,
  pinned: pendingPins.length,
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
    state.sweep = false;
    state.clearCursor = 0;
    state.cleared = 0;
    state.foreign = 0;
    pendingPins = [];
    dirty = true;
    persist();
    log.info("spawn", `сезон ${seasonIndex}: спавн пересобирается с нуля (${blueprint.length} ячеек)`);
  }
  setSpawnPoint();
  registerTask("spawn-build", s.everyTicks, 3, () => spawnBuildTick());
  registerTask("spawn-watch", s.checkEveryTicks, 2, () => checkSpawnIntegrity());
  log.info("spawn", `blueprint: ${blueprint.length} ячеек, проверка каждые ${s.checkEveryTicks} тиков`);
};
