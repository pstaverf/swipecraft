const registry = new Map();

const signal = (name) => {
  let entry = registry.get(name);
  if (entry) return entry;
  entry = {
    handlers: [],
    subscribe: (callback) => {
      entry.handlers.push(callback);
      return callback;
    },
    unsubscribe: (callback) => {
      const index = entry.handlers.indexOf(callback);
      if (index >= 0) entry.handlers.splice(index, 1);
    },
    dispatch: (event) => {
      for (const callback of [...entry.handlers]) {
        try {
          callback(event);
        } catch (error) {
          state.dispatchErrors.push(`${name}: ${String(error?.message ?? error)}`);
        }
      }
      if (name === "after:entityDie") reap(event?.deadEntity);
    },
  };
  registry.set(name, entry);
  return entry;
};

const namespaced = (prefix) =>
  new Proxy(
    {},
    {
      get: (_target, name) => signal(`${prefix}:${String(name)}`),
    },
  );

const reap = (entity) => {
  if (!entity || typeof entity !== "object") return;
  entity._removed = true;
  entity.isValid = false;
  const index = state.entities.indexOf(entity);
  if (index >= 0) state.entities.splice(index, 1);
};

export const state = {
  tick: 0,
  clock: 1_700_000_000_000,
  props: new Map(),
  players: [],
  entities: [],
  items: [],
  particles: [],
  sounds: [],
  chat: [],
  titles: [],
  actionBars: [],
  intervals: [],
  timeouts: [],
  runQueue: [],
  commands: [],
  sentMessages: [],
  hazardAt: new Set(),
  blockContainers: new Map(),
  groundY: 70,
  nextId: 1,
  dimensionId: "minecraft:overworld",
  failures: [],
  dispatchErrors: [],
  byteOverride: undefined,
  timeOfDay: 6000,
  kicked: [],
};

export const setClock = (value) => {
  state.clock = value;
};

export const advance = (ms) => {
  state.clock += ms;
};

Date.now = () => state.clock;

const bytesOf = (key) => {
  const value = state.props.get(key);
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return 8;
  return 0;
};

const blockContainerFor = (x, y, z) => {
  const key = `${x}:${y}:${z}`;
  let container = state.blockContainers.get(key);
  if (container) return container;
  const holder = {};
  container = makeContainer(holder, 27).container;
  holder.container = container;
  state.blockContainers.set(key, holder);
  return container;
};

const blockAt = (location) => {
  const y = Math.floor(location?.y ?? state.groundY);
  const x = Math.floor(location?.x ?? 0);
  const z = Math.floor(location?.z ?? 0);
  const blockContainer = blockContainerFor(x, y, z);
  const blockInventory = { container: blockContainer, size: 27 };
  const hazard = state.hazardAt.has(`${x}:${y}:${z}`);
  const air = y > state.groundY;
  return {
    x,
    y,
    z,
    location: { x, y, z },
    isAir: air && !hazard,
    isLiquid: hazard,
    isSolidBlocking: !air,
    typeId: hazard ? "minecraft:lava" : air ? "minecraft:air" : y === state.groundY ? "minecraft:grass" : "minecraft:stone",
    type: { id: hazard ? "minecraft:lava" : air ? "minecraft:air" : y === state.groundY ? "minecraft:grass" : "minecraft:stone" },
    above: () => blockAt({ x, y: y + 1, z }),
    below: () => blockAt({ x, y: y - 1, z }),
    setPermutation: () => {},
    getState: () => ({}),
    getComponent: (id) => (id === "minecraft:inventory" ? blockInventory : undefined),
    getContainer: () => blockContainer,
    dimension: dimensionApi(state.dimensionId),
  };
};

const healthOf = (entity, max) => {
  const health = {
    currentValue: max,
    defaultValue: max,
    effectiveMax: max,
    effectiveMin: 0,
    resetToDefaultValue: () => {
      health.currentValue = max;
    },
    resetToMaxValue: () => {
      health.currentValue = max;
    },
    setCurrentValue: (value) => {
      health.currentValue = Math.max(0, Math.min(max, value));
    },
  };
  return health;
};

const baseComponent = (entity) => (id) => {
  if (id === "minecraft:health") return entity._health;
  if (id === "minecraft:inventory") return entity._inventory;
  if (id === "minecraft:nameable") return { allowNameTagging: true };
  if (id === "minecraft:equatable") return { isEquatable: () => true };
  if (id === "minecraft:translatable") return { value: entity.nameTag };
  return undefined;
};

const makeContainer = (entity, size = 36) => {
  const slots = new Array(size).fill(undefined);
  const container = {
    size,
    emptySlots: () => slots.filter((row) => row === undefined).length,
    getItem: (index) => slots[index],
    setItem: (index, stack) => {
      slots[index] = stack;
    },
    addItem: (stack) => {
      for (let index = 0; index < size; index += 1) {
        const current = slots[index];
        if (!current) {
          slots[index] = stack;
          return undefined;
        }
        if (current.typeId === stack.typeId && current.amount + stack.amount <= current.maxAmount) {
          current.amount += stack.amount;
          return undefined;
        }
      }
      return stack;
    },
    removeItem: (index) => {
      const removed = slots[index];
      slots[index] = undefined;
      return removed ?? new ItemStackApi("minecraft:air", 0);
    },
    getSlot: (index) => slots[index],
    _slots: slots,
  };
  entity._inventory = { container, selectedSlotIndex: 0 };
  return container;
};

export class ItemStackApi {
  constructor(typeId, amount = 1) {
    this.typeId = typeId;
    this.amount = amount;
    this.maxAmount = 64;
    this.nameTag = "";
    this._lore = [];
    this._enchants = [];
    this.isStackable = true;
    this.keepOnDeath = false;
    this.lockMode = "unlocked";
  }
  getLore() {
    return [...this._lore];
  }
  setLore(lines) {
    this._lore = [...lines];
  }
  getComponent(id) {
    if (id === "minecraft:enchantable") {
      const list = this._enchants;
      return {
        getEnchantments: () => [...list],
        addEnchantment: (entry) => {
          list.push(entry);
        },
        getLevel: () => list.reduce((sum, entry) => sum + entry.level, 0),
        maxLevel: 5,
      };
    }
    if (id === "minecraft:display") {
      return {
        setName: (value) => {
          this.nameTag = value;
        },
        setLore: (lines) => {
          this._lore = [...lines];
        },
      };
    }
    return undefined;
  }
  clone() {
    const copy = new ItemStackApi(this.typeId, this.amount);
    copy.nameTag = this.nameTag;
    copy._lore = [...this._lore];
    copy._enchants = [...this._enchants];
    return copy;
  }
}

export class EnchantmentType {
  constructor(id) {
    this.id = id;
    this.maxLevel = 5;
    this.type = id;
  }
}

export const MolangVariableScope = {};
export const GameMode = { survival: "survival", creative: "creative", adventure: "adventure", spectator: "spectator" };
export const InputPermissionCategory = { Camera: "Camera", Movement: "Movement", LateralMovement: "LateralMovement" };
export const CommandPermissionLevel = { Any: 0, GameDirectors: 1, Admin: 2, Host: 3, Owner: 4 };
export const CustomCommandStatus = { Success: 0, Failure: 1 };
export const CustomCommandParamType = { String: "String", Integer: "Integer", Float: "Float", Boolean: "Boolean", Enum: "Enum" };
export const DeviceOS = { Android: 2, iOS: 3, Windows: 1 };
export const GameType = { Survival: 0, Creative: 1, Adventure: 2, Spectator: 6 };
export const EntityComponentTypes = { Health: "minecraft:health", Inventory: "minecraft:inventory" };
export const ItemComponentTypes = { Enchantable: "minecraft:enchantable", Display: "minecraft:display" };
export const BlockPermutationApi = { resolve: (id) => ({ id }) };

const makeEntity = (typeId, location, dimension, healthMax = 20, prototype = EntityApi.prototype) => {
  const entity = Object.assign(Object.create(prototype), {
    id: `e${state.nextId}`,
    typeId,
    type: { id: typeId },
    location: { ...location },
    velocity: { x: 0, y: 0, z: 0 },
    nameTag: "",
    dimension,
    isValid: true,
    isOnGround: true,
    _tags: new Set(),
    _effects: new Map(),
    _removed: false,
    teleport: (target, options) => {
      entity.location = { ...target };
      if (options?.dimension) entity.dimension = options.dimension;
      return true;
    },
    runCommand: () => ({ successCount: 0, result: 0 }),
    sendMessage: (text) => state.chat.push({ to: entity.name, text: String(text) }),
    addTag: (tag) => {
      entity._tags.add(tag);
      return true;
    },
    removeTag: (tag) => {
      entity._tags.delete(tag);
      return true;
    },
    hasTag: (tag) => entity._tags.has(tag),
    getTags: () => [...entity._tags],
    addEffect: (id, seconds, options) => {
      entity._effects.set(id, { duration: seconds, ...options });
    },
    getEffect: (id) => entity._effects.get(id),
    removeEffect: (id) => entity._effects.delete(id),
    applyDamage: (amount, options) => {
      entity._health.currentValue = Math.max(0, entity._health.currentValue - amount);
      if (entity._health.currentValue === 0) {
        registry.get("after:entityDie")?.dispatch({
          deadEntity: entity,
          damageSource: options?.damageSource ?? { cause: "entityAttack" },
        });
        entity._removed = true;
        entity.isValid = false;
        const index = state.entities.indexOf(entity);
        if (index >= 0) state.entities.splice(index, 1);
      }
      return entity._health.currentValue === 0;
    },
    applyKnockback: () => {},
    playSound: (id, options) => state.sounds.push({ id, entity: entity.name ?? typeId, options }),
    spawnParticle: (id, options) => state.particles.push({ id, entity: typeId, options }),
    getComponent: (_id) => undefined,
    remove: () => {
      entity._removed = true;
      entity.isValid = false;
      const index = state.entities.indexOf(entity);
      if (index >= 0) state.entities.splice(index, 1);
    },
  });
  entity.getComponent = baseComponent(entity);
  state.nextId += 1;
  entity._health = healthOf(entity, healthMax);
  makeContainer(entity);
  state.entities.push(entity);
  return entity;
};

export class EntityApi {}
export class PlayerApi extends EntityApi {}

export const blockContainerAt = (x, y, z) => blockContainerFor(Math.floor(x), Math.floor(y), Math.floor(z));

export const makePlayer = (id, name, location = { x: 0, y: 71, z: 0 }) => {
  const dimension = dimensionApi(state.dimensionId);
  const player = makeEntity("minecraft:player", location, dimension, 20, PlayerApi.prototype);
  player.id = id;
  player.name = name;
  player.nameTag = name;
  player.isPlayer = true;
  player.selectedSlotIndex = 0;
  player.viewRange = 8;
  player.spawnPoint = location;
  player.spawnDimension = dimension;
  player.clientSystemInfo = { platformType: "Android", maxRenderDistance: 12, locale: "ru_RU", deviceId: id };
  player.inputPermissions = { setPermissionCategory: () => {} };
  player.onScreenDisplay = {
    setTitle: (value, options) => state.titles.push({ to: name, value, options }),
    setActionBar: (value) => state.actionBars.push({ to: name, value }),
    clearTitle: () => {},
    fadeOutTitle: () => {},
  };
  player.sendMessage = (text) => state.chat.push({ to: name, text: String(text) });
  player.clearTitle = () => {};
  player.setDynamicProperty = (key, value) => {
    if (value === undefined) player._props?.delete(key);
    else (player._props ??= new Map()).set(key, value);
  };
  player.getDynamicProperty = (key) => player._props?.get(key);
  player.runCommand = (command) => {
    state.kicked.push({ player: name, command });
    if (command.startsWith("kick ")) return { successCount: 1, result: 1 };
    return { successCount: 0, result: 0 };
  };
  player.dimension = dimension;
  player.isFlying = false;
  player.isSneaking = false;
  player.isSprinting = false;
  player.isSwimming = false;
  player.isJumping = false;
  player.isGliding = false;
  player.isInWater = false;
  player.isUnderwater = false;
  player.isOutOfControl = false;
  player.isSleeping = false;
  player.headLocation = { ...location, y: location.y + 1.6 };
  player.getBlockFromViewDirection = () => undefined;
  player.getEntitiesFromViewDirection = () => [];
  player.applyExhaustion = () => {};
  player.setRespawnPosition = () => {};
  player.teleport = (target, options) => {
    player.location = { ...target };
    if (options?.dimension) player.dimension = options.dimension;
    return true;
  };
  state.players.push(player);
  registry.get("after:playerSpawn")?.dispatch({ player, initialSpawn: true });
  return player;
};

export const removePlayer = (player) => {
  const index = state.players.indexOf(player);
  if (index >= 0) state.players.splice(index, 1);
  registry.get("after:playerLeave")?.dispatch({ playerId: player.id, playerName: player.name, isClientLeft: true });
};

const dimensionApi = (id) => ({
  id,
  getBlock: (location) => blockAt(location),
  getTopmostBlock: (location) => blockAt({ x: location.x, y: state.groundY, z: location.z }),
  getEntities: (query) => {
    const tags = query?.tags ?? [];
    return state.entities.filter((entity) => {
      if (entity._removed) return false;
      if (tags.length > 0 && !tags.some((tag) => entity._tags.has(tag))) return false;
      if (query?.location && query.maxDistance !== undefined) {
        const dx = entity.location.x - query.location.x;
        const dy = entity.location.y - query.location.y;
        const dz = entity.location.z - query.location.z;
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) > query.maxDistance) return false;
      }
      if (query?.type && entity.typeId !== query.type) return false;
      if (query?.closest) return true;
      return true;
    });
  },
  getEntity: (entityId) => state.entities.find((entity) => entity.id === entityId),
  getPlayers: () => state.players.slice(),
  spawnEntity: (type, location) => makeEntity(type, location ?? { x: 0, y: 71, z: 0 }, dimensionApi(id), type === "swipecraft:war_boss" ? 520 : 20),
  spawnItem: (stack, location) => {
    state.items.push({ stack, location: { ...location }, dimension: id });
    return { id: `i${state.nextId++}` };
  },
  runCommand: (command) => {
    state.kicked.push({ player: "console", command });
    return { successCount: 1, result: 1, message: "" };
  },
  applyExplosion: () => {},
  setTimeOfDay: (value) => {
    state.timeOfDay = value;
  },
  getTimeOfDay: () => state.timeOfDay,
  createExplosion: () => {},
  setBlockPermutation: () => {},
  setWeather: () => {},
  clearWeather: () => {},
});

export const world = {
  beforeEvents: namespaced("before"),
  afterEvents: namespaced("after"),
  getDimension: (id) => dimensionApi(id ?? state.dimensionId),
  getAllPlayers: () => state.players.slice(),
  getPlayers: () => state.players.slice(),
  getEntities: (query) => dimensionApi(state.dimensionId).getEntities(query),
  getEntity: (id) => state.entities.find((entity) => entity.id === id),
  sendMessage: (text) => state.sentMessages.push(String(text)),
  getDynamicProperty: (key) => state.props.get(key),
  setDynamicProperty: (key, value) => {
    if (value === undefined) state.props.delete(key);
    else state.props.set(key, value);
  },
  getDynamicPropertyIds: () => [...state.props.keys()],
  getDynamicPropertyTotalByteCount: () =>
    state.byteOverride ?? [...state.props.keys()].reduce((sum, key) => sum + bytesOf(key), 0),
  setWeather: () => {},
  clearWeather: () => {},
  getTimeOfDay: () => state.timeOfDay,
  setTimeOfDay: (value) => {
    state.timeOfDay = value;
  },
  getDimensionIds: () => ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"],
  gameRules: {
    keepInventory: true,
    doDayLightCycle: true,
    doWeatherCycle: true,
    doFireTick: true,
    doMobSpawning: true,
    doMobLoot: true,
    doEntityDrops: true,
    doInsomnia: true,
    naturalRegeneration: true,
    mobGriefing: true,
    fallDamage: true,
    fireDamage: true,
    drowningDamage: true,
    freezeDamage: true,
    maxCommandChainLength: 0,
    randomTickSpeed: 1,
    commandBlockOutput: false,
    sendCommandFeedback: false,
    showCoordinates: false,
    showDeathMessages: true,
    spawnRadius: 0,
  },
};

export const system = {
  get currentTick() {
    return state.tick;
  },
  beforeEvents: namespaced("system:before"),
  afterEvents: namespaced("system:after"),
  run: (fn) => {
    state.runQueue.push(fn);
    return state.runQueue.length;
  },
  runInterval: (fn, ticks) => {
    state.intervals.push({ fn, ticks: Math.max(1, ticks ?? 1), last: 0, id: state.intervals.length + 1 });
    return state.intervals.length;
  },
  runTimeout: (fn, ticks) => {
    state.timeouts.push({ fn, ticks: Math.max(1, ticks ?? 1), at: state.tick + Math.max(1, ticks ?? 1) });
    return state.timeouts.length;
  },
  runJob: (fn) => {
    state.runQueue.push(fn);
    return 1;
  },
  clearRun: (id) => {
    const interval = state.intervals.find((row) => row.id === id);
    if (interval) state.intervals.splice(state.intervals.indexOf(interval), 1);
  },
  sendScriptEvent: () => {},
};

export const tickOnce = () => {
  state.tick += 1;
  for (const fn of state.runQueue.splice(0)) fn();
  for (const interval of [...state.intervals]) {
    if (state.tick - interval.last >= interval.ticks) {
      interval.last = state.tick;
      interval.fn();
    }
  }
  for (const timeout of [...state.timeouts]) {
    if (state.tick >= timeout.at) {
      state.timeouts.splice(state.timeouts.indexOf(timeout), 1);
      timeout.fn();
    }
  }
};

export const tickTimes = (count) => {
  for (let index = 0; index < count; index += 1) tickOnce();
};

export const dispatch = (name, event) => {
  registry.get(name)?.dispatch(event);
};

export const fire = (kind, name, event) => {
  registry.get(`${kind}:${name}`)?.dispatch(event);
};

export const Block = class {};
export const BlockPermutation = BlockPermutationApi;
export const ItemStack = ItemStackApi;
export const Player = PlayerApi;
export const Entity = EntityApi;
export const Dimension = {};
export const Vector3 = (x, y, z) => ({ x, y, z });
export const EquipmentSlot = { Head: "Head", Chest: "Chest", Legs: "Legs", Feet: "Feet", Mainhand: "Mainhand", Offhand: "Offhand" };
export const EffectTypes = { get: (id) => ({ id }) };
export const minecraftDimension = { overworld: "minecraft:overworld" };
