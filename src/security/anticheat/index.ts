import { Player, system, world } from "@minecraft/server";
import { getLang, t } from "../../kernel/i18n";
import { log } from "../../kernel/logger";
import { registerTask } from "../../kernel/ticker";
import { distance3d, stdDev } from "../../kernel/util";
import { getProfile } from "../../meta/profiles";
import type { DetectorId } from "../../types/domain";
import { adminPlayers, audit } from "../audit";
import { detectorConfig, getAcConfig, loadAcConfig, resetAcConfig, setAcParam } from "./config";

interface AcState {
  score: number;
  graceUntil: number;
  lastAlertAt: number;
  lastDecayAt: number;
  attackTimes: number[];
  breakTimes: number[];
  placeTimes: number[];
  containerTimes: number[];
  dropTimes: number[];
  reachHits: number;
  reachWindowStart: number;
  flySamples: number;
  speedHits: number;
  speedWindowStart: number;
  lastSample: { x: number; y: number; z: number } | undefined;
  lastSampleAt: number;
  lastDimension: string;
  scanOffset: number;
}

const states = new Map<string, AcState>();

const createState = (): AcState => ({
  score: 0,
  graceUntil: 0,
  lastAlertAt: 0,
  lastDecayAt: Date.now(),
  attackTimes: [],
  breakTimes: [],
  placeTimes: [],
  containerTimes: [],
  dropTimes: [],
  reachHits: 0,
  reachWindowStart: 0,
  flySamples: 0,
  speedHits: 0,
  speedWindowStart: 0,
  lastSample: undefined,
  lastSampleAt: 0,
  lastDimension: "",
  scanOffset: 0,
});

const stateOf = (playerId: string): AcState => {
  const existing = states.get(playerId);
  if (existing) return existing;
  const created = createState();
  states.set(playerId, created);
  return created;
};

export const grantGrace = (playerId: string, ms: number): void => {
  const state = stateOf(playerId);
  state.graceUntil = Math.max(state.graceUntil, Date.now() + ms);
  state.reachHits = 0;
  state.speedHits = 0;
  state.flySamples = 0;
  state.lastSample = undefined;
  state.attackTimes = [];
  state.breakTimes = [];
  state.placeTimes = [];
};

export const resetState = (playerId: string): void => {
  states.delete(playerId);
};

export const playerScore = (playerId: string): number => stateOf(playerId).score;

const inGrace = (state: AcState): boolean => Date.now() < state.graceUntil;

const prune = (times: number[], windowMs: number): void => {
  const limit = Date.now() - windowMs;
  while (times.length > 0 && times[0] < limit) times.shift();
};

const alertAdmins = (player: Player, detector: DetectorId, weight: number, score: number, detail: string): void => {
  const config = getAcConfig();
  for (const admin of adminPlayers()) {
    try {
      admin.sendMessage(
        t(admin, "ac.alert", {
          player: player.name,
          detector,
          weight,
          score: Math.round(score),
          threshold: config.threshold,
        }),
      );
    } catch {
      continue;
    }
  }
  const lang = getLang(player.id);
  log.warn("anticheat", `${lang} ${player.name} ${detector} +${weight} score=${Math.round(score)} ${detail}`);
};

const addScore = (player: Player, detector: DetectorId, detail: string, multiplier = 1): void => {
  const config = getAcConfig();
  const cfg = detectorConfig(detector);
  if (!cfg.enabled) return;
  const state = stateOf(player.id);
  if (inGrace(state)) return;
  const weight = cfg.weight * multiplier;
  state.score += weight;
  const profile = getProfile(player);
  profile.acScore = Math.round(state.score);
  profile.flags[detector] = (profile.flags[detector] ?? 0) + 1;
  audit("anticheat", detector, player.name, detail);
  if (state.score >= config.threshold && Date.now() - state.lastAlertAt > config.alertCooldownMs) {
    state.lastAlertAt = Date.now();
    alertAdmins(player, detector, weight, state.score, detail);
  }
};

const isContainerBlock = (typeId: string): boolean =>
  typeId.includes("chest") ||
  typeId.includes("barrel") ||
  typeId.includes("shulker") ||
  typeId.includes("hopper") ||
  typeId.includes("furnace") ||
  typeId.includes("dispenser") ||
  typeId.includes("dropper") ||
  typeId.includes("brewing");

const hasMovementModifier = (player: Player): boolean => {
  try {
    if (player.isInWater) return true;
    if (player.isGliding) return true;
    if (player.isFlying) return true;
    if (player.isSwimming) return true;
    if (player.isJumping) return true;
    if (player.getEffect("speed") || player.getEffect("jump_boost")) return true;
    if (player.getComponent("minecraft:riding")) return true;
  } catch {
    return true;
  }
  return false;
};

const reachesPlayers = (player: Player, victim: Player): void => {
  const state = stateOf(player.id);
  if (inGrace(state)) return;
  const cfg = detectorConfig("reach");
  if (!cfg.enabled) return;
  const profile = getProfile(player);
  const distance = distance3d(player.location, victim.location);
  const bonus = profile.mobile ? cfg.mobileToleranceBonus : 0;
  const allowed = 3.05 + cfg.tolerance + bonus;
  if (distance <= allowed) return;
  const now = Date.now();
  if (now - state.reachWindowStart > cfg.windowMs) {
    state.reachWindowStart = now;
    state.reachHits = 0;
  }
  state.reachHits += 1;
  if (state.reachHits >= cfg.hits) {
    state.reachHits = 0;
    state.reachWindowStart = now;
    addScore(player, "reach", `dist=${distance.toFixed(2)} allowed=${allowed.toFixed(2)}`);
  }
};

const checksAutoclick = (player: Player): void => {
  const state = stateOf(player.id);
  const cfg = detectorConfig("attackRate");
  if (!cfg.enabled) return;
  prune(state.attackTimes, 2000);
  if (state.attackTimes.length < 15) return;
  const intervals: number[] = [];
  for (let index = 1; index < state.attackTimes.length; index += 1) {
    intervals.push(state.attackTimes[index] - state.attackTimes[index - 1]);
  }
  const deviation = stdDev(intervals);
  if (deviation > 0 && deviation < 15 && state.attackTimes.length >= cfg.hits) {
    state.attackTimes = [];
    addScore(player, "attackRate", `attacks=${cfg.hits}+ intervalStdev=${deviation.toFixed(1)}ms`);
  }
};

const samplesMovement = (player: Player): void => {
  const state = stateOf(player.id);
  const now = Date.now();
  const location = player.location;

  if (state.lastDimension !== player.dimension.id) {
    state.lastDimension = player.dimension.id;
    state.lastSample = { x: location.x, y: location.y, z: location.z };
    state.lastSampleAt = now;
    grantGrace(player.id, 1500);
    return;
  }

  if (!state.lastSample) {
    state.lastSample = { x: location.x, y: location.y, z: location.z };
    state.lastSampleAt = now;
    return;
  }

  const elapsed = now - state.lastSampleAt;
  if (elapsed < 200) return;

  const from = state.lastSample;
  const horizontal = Math.hypot(location.x - from.x, location.z - from.z);
  const vertical = location.y - from.y;
  const blocksPerSecond = (horizontal * 1000) / elapsed;
  state.lastSample = { x: location.x, y: location.y, z: location.z };
  state.lastSampleAt = now;

  if (inGrace(state) || hasMovementModifier(player)) return;
  if (elapsed > 1200) return;

  const profile = getProfile(player);
  const speedCfg = detectorConfig("speed");
  if (speedCfg.enabled) {
    const bonus = profile.mobile ? speedCfg.mobileToleranceBonus : 0;
    const limit = 5.8 * speedCfg.tolerance + bonus;
    if (blocksPerSecond > limit) {
      if (now - state.speedWindowStart > speedCfg.windowMs) {
        state.speedWindowStart = now;
        state.speedHits = 0;
      }
      state.speedHits += 1;
      if (state.speedHits >= speedCfg.hits) {
        state.speedHits = 0;
        state.speedWindowStart = now;
        addScore(player, "speed", `${blocksPerSecond.toFixed(1)} b/s > ${limit.toFixed(1)}`);
      }
    }
  }

  const flyCfg = detectorConfig("fly");
  if (flyCfg.enabled && Math.abs(vertical) < 0.02 && blocksPerSecond < 1.5) {
    let support = true;
    try {
      const below = player.dimension.getBlock({ x: location.x, y: location.y - 3, z: location.z });
      support = !below || below.typeId !== "minecraft:air";
    } catch {
      support = true;
    }
    if (!support) {
      state.flySamples += 1;
      if (state.flySamples >= flyCfg.hits) {
        state.flySamples = 0;
        addScore(player, "fly", `y=${location.y.toFixed(1)} без опоры, вертикальная скорость ~0`);
      }
    } else {
      state.flySamples = 0;
    }
  }
};

const decaysScores = (): void => {
  const config = getAcConfig();
  const now = Date.now();
  for (const [playerId, state] of states.entries()) {
    const elapsed = now - state.lastDecayAt;
    if (elapsed < 20_000) continue;
    state.lastDecayAt = now;
    const drop = (config.decayPerMinute * elapsed) / 60_000;
    state.score = Math.max(0, state.score - drop);
    const player = world.getAllPlayers().find((candidate) => candidate.id === playerId);
    if (player) getProfile(player).acScore = Math.round(state.score);
  }
};

const scansInventories = (): void => {
  const config = getAcConfig();
  const players = world.getAllPlayers();
  for (const player of players) {
    const state = stateOf(player.id);
    state.scanOffset = (state.scanOffset + 1) % 3;
    if (state.scanOffset !== 0) continue;
    try {
      const inventory = player.getComponent("minecraft:inventory");
      const container = inventory?.container;
      if (!container) continue;
      for (let slot = 0; slot < container.size; slot += 1) {
        const item = container.getItem(slot);
        if (!item) continue;
        if (item.amount > config.limits.maxStackAmount || item.amount <= 0) {
          addScore(player, "stackAnomaly", `${item.typeId} x${item.amount} в слоте ${slot}`);
          audit("antidupe", "stack", player.name, `${item.typeId} x${item.amount}`);
          break;
        }
      }
    } catch {
      continue;
    }
  }
};

let initialized = false;

export const initAnticheat = (): void => {
  if (initialized) return;
  initialized = true;
  loadAcConfig();

  world.afterEvents.entityHitEntity.subscribe((event) => {
    const attacker = event.damagingEntity;
    const victim = event.hitEntity;
    if (!(attacker instanceof Player) || !(victim instanceof Player)) return;
    const state = stateOf(attacker.id);
    state.attackTimes.push(Date.now());
    reachesPlayers(attacker, victim);
    checksAutoclick(attacker);
  });

  world.afterEvents.entityHurt.subscribe((event) => {
    if (event.hurtEntity instanceof Player) grantGrace(event.hurtEntity.id, 1200);
  });

  world.afterEvents.playerBreakBlock.subscribe((event) => {
    const player = event.player;
    if (!player) return;
    const state = stateOf(player.id);
    const cfg = detectorConfig("nuke");
    const now = Date.now();
    state.breakTimes.push(now);
    prune(state.breakTimes, getAcConfig().limits.breakWindowMs);
    if (cfg.enabled && state.breakTimes.length > getAcConfig().limits.breakRatePerWindow) {
      state.breakTimes = [];
      addScore(player, "nuke", `>${getAcConfig().limits.breakRatePerWindow} блоков за ${getAcConfig().limits.breakWindowMs}мс`);
    }
  });

  world.afterEvents.playerPlaceBlock.subscribe((event) => {
    const player = event.player;
    if (!player) return;
    const state = stateOf(player.id);
    const config = getAcConfig();
    const now = Date.now();
    state.placeTimes.push(now);
    prune(state.placeTimes, config.limits.placeWindowMs);
    if (state.placeTimes.length > config.limits.placeRatePerWindow) {
      state.placeTimes = [];
      addScore(player, "placeRate", `>${config.limits.placeRatePerWindow} блоков за ${config.limits.placeWindowMs}мс`);
    }
  });

  world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    const player = event.player;
    if (!player) return;
    if (!isContainerBlock(event.block.typeId)) return;
    const state = stateOf(player.id);
    const config = getAcConfig();
    state.containerTimes.push(Date.now());
    prune(state.containerTimes, config.limits.containerWindowMs);
    if (state.containerTimes.length > config.limits.containerOpsPerWindow) {
      state.containerTimes = [];
      addScore(player, "containerSpam", `>${config.limits.containerOpsPerWindow} открытий за ${config.limits.containerWindowMs}мс`);
    }
  });

  world.afterEvents.entityItemDrop.subscribe((event) => {
    const source = event.entity;
    if (!(source instanceof Player)) return;
    const state = stateOf(source.id);
    const config = getAcConfig();
    state.dropTimes.push(Date.now());
    prune(state.dropTimes, config.limits.entityWindowMs);
    if (state.dropTimes.length > config.limits.entityOpsPerWindow) {
      state.dropTimes = [];
      addScore(source, "entitySpam", `>${config.limits.entityOpsPerWindow} дропов за ${config.limits.entityWindowMs}мс`);
    }
  });

  world.afterEvents.playerSpawn.subscribe((event) => {
    grantGrace(event.player.id, 3000);
    resetState(event.player.id);
  });

  system.runTimeout(() => {
    registerTask("anticheat-sample", 4, 3, () => {
      const players = world.getAllPlayers();
      if (players.length === 0) return;
      const index = system.currentTick % players.length;
      samplesMovement(players[index]);
    });
    registerTask("anticheat-decay", 20, 2, decaysScores);
    registerTask("anticheat-inventory", 60, 4, scansInventories);
  }, 40);

  log.info("anticheat", "детекты активны (только скоринг и аудит)");
};

export const acScores = (): { name: string; score: number; flags: string }[] => {
  const rows: { name: string; score: number; flags: string }[] = [];
  for (const player of world.getAllPlayers()) {
    const state = states.get(player.id);
    if (!state || state.score <= 0) continue;
    const flags = Object.entries(getProfile(player).flags)
      .map(([key, value]) => `${key}:${value}`)
      .join(" ");
    rows.push({ name: player.name, score: Math.round(state.score), flags });
  }
  return rows.sort((left, right) => right.score - left.score);
};

export const acRuntimeSummary = (): string[] => {
  const config = getAcConfig();
  return [
    `порог=${config.threshold} затухание=${config.decayPerMinute}/мин cooldown=${Math.round(config.alertCooldownMs / 1000)}с`,
    ...Object.entries(config.detectors).map(
      ([id, cfg]) => `${id}: ${cfg.enabled ? "on" : "off"} weight=${cfg.weight} hits=${cfg.hits} window=${cfg.windowMs}мс`,
    ),
  ];
};

export { setAcParam, getAcConfig, resetAcConfig };

export const acConfigReset = (): void => {
  resetAcConfig();
  log.info("anticheat", "конфиг сброшен к дефолту");
};

export const changeAcParam = (path: string, value: string): { ok: boolean; message: string } => {
  const result = setAcParam(path, value);
  audit("admin", "ac-config", path, `${value} -> ${result.ok ? "ok" : "fail"}`);
  return result;
};
