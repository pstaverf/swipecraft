import { STORE_KEYS } from "../../config";
import { log } from "../../kernel/logger";
import { loadWorldJson, saveWorldJson } from "../../kernel/store";
import type { AcConfig, DetectorConfig, DetectorId } from "../../types/domain";

export const DEFAULT_AC_CONFIG: AcConfig = {
  threshold: 60,
  alertCooldownMs: 300_000,
  decayPerMinute: 2,
  detectors: {
    reach: { enabled: true, weight: 12, windowMs: 6000, hits: 3, tolerance: 1.2, mobileToleranceBonus: 1.2, graceMs: 1500 },
    attackRate: { enabled: true, weight: 6, windowMs: 4000, hits: 12, tolerance: 0, mobileToleranceBonus: 0, graceMs: 800 },
    speed: { enabled: true, weight: 10, windowMs: 5000, hits: 4, tolerance: 1.4, mobileToleranceBonus: 0.6, graceMs: 2500 },
    fly: { enabled: true, weight: 12, windowMs: 8000, hits: 4, tolerance: 0.4, mobileToleranceBonus: 0.3, graceMs: 3000 },
    nuke: { enabled: true, weight: 10, windowMs: 3000, hits: 12, tolerance: 0, mobileToleranceBonus: 0, graceMs: 0 },
    placeRate: { enabled: true, weight: 6, windowMs: 3000, hits: 14, tolerance: 0, mobileToleranceBonus: 0, graceMs: 0 },
    containerSpam: { enabled: true, weight: 4, windowMs: 5000, hits: 20, tolerance: 0, mobileToleranceBonus: 0, graceMs: 0 },
    entitySpam: { enabled: true, weight: 4, windowMs: 5000, hits: 25, tolerance: 0, mobileToleranceBonus: 0, graceMs: 0 },
    stackAnomaly: { enabled: true, weight: 25, windowMs: 1000, hits: 1, tolerance: 0, mobileToleranceBonus: 0, graceMs: 0 },
  },
  limits: {
    maxStackAmount: 64,
    containerOpsPerWindow: 20,
    containerWindowMs: 5000,
    entityOpsPerWindow: 25,
    entityWindowMs: 5000,
    maxTntPerArea: 24,
    tntAreaRadius: 40,
    hopperPerChunk: 12,
    observerPerChunk: 16,
    pistonPerChunk: 16,
    breakRatePerWindow: 20,
    breakWindowMs: 4000,
    placeRatePerWindow: 20,
    placeWindowMs: 3000,
  },
};

export const DETECTOR_IDS: DetectorId[] = [
  "reach",
  "attackRate",
  "speed",
  "fly",
  "nuke",
  "placeRate",
  "containerSpam",
  "entitySpam",
  "stackAnomaly",
];

let config: AcConfig = clone(DEFAULT_AC_CONFIG);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const mergeConfig = (base: AcConfig, stored: Partial<AcConfig>): AcConfig => {
  const merged = clone(base);
  if (typeof stored.threshold === "number") merged.threshold = stored.threshold;
  if (typeof stored.alertCooldownMs === "number") merged.alertCooldownMs = stored.alertCooldownMs;
  if (typeof stored.decayPerMinute === "number") merged.decayPerMinute = stored.decayPerMinute;
  if (stored.limits) merged.limits = { ...merged.limits, ...stored.limits };
  if (stored.detectors) {
    for (const id of DETECTOR_IDS) {
      const incoming = stored.detectors[id];
      if (incoming) merged.detectors[id] = { ...merged.detectors[id], ...incoming };
    }
  }
  return merged;
};

export const loadAcConfig = (): AcConfig => {
  const stored = loadWorldJson<Partial<AcConfig> | undefined>(STORE_KEYS.acConfig, undefined);
  config = stored ? mergeConfig(DEFAULT_AC_CONFIG, stored) : clone(DEFAULT_AC_CONFIG);
  log.info("anticheat", `конфиг загружен, порог ${config.threshold}`);
  return config;
};

export const saveAcConfig = (): void => {
  saveWorldJson(STORE_KEYS.acConfig, config);
};

export const getAcConfig = (): AcConfig => config;

export const detectorConfig = (id: DetectorId): DetectorConfig => config.detectors[id];

export const resetAcConfig = (): AcConfig => {
  config = clone(DEFAULT_AC_CONFIG);
  saveAcConfig();
  return config;
};

const parseValue = (raw: string): number | boolean | undefined => {
  if (raw === "true") return true;
  if (raw === "false") return false;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric;
  return undefined;
};

export const setAcParam = (path: string, rawValue: string): { ok: boolean; message: string } => {
  const value = parseValue(rawValue);
  if (value === undefined) return { ok: false, message: `не число и не boolean: ${rawValue}` };
  const parts = path.split(".");
  if (parts.length === 1) {
    if (parts[0] === "threshold" && typeof value === "number") {
      config.threshold = Math.max(1, Math.round(value));
      saveAcConfig();
      return { ok: true, message: `threshold=${config.threshold}` };
    }
    if (parts[0] === "alertCooldownMs" && typeof value === "number") {
      config.alertCooldownMs = Math.max(1000, Math.round(value));
      saveAcConfig();
      return { ok: true, message: `alertCooldownMs=${config.alertCooldownMs}` };
    }
    if (parts[0] === "decayPerMinute" && typeof value === "number") {
      config.decayPerMinute = Math.max(0, value);
      saveAcConfig();
      return { ok: true, message: `decayPerMinute=${config.decayPerMinute}` };
    }
    return { ok: false, message: `неизвестный параметр ${path}` };
  }

  if (parts[0] === "detectors" && parts.length === 3) {
    const id = parts[1] as DetectorId;
    if (!DETECTOR_IDS.includes(id)) return { ok: false, message: `неизвестный детектор ${parts[1]}` };
    const field = parts[2] as keyof DetectorConfig;
    const target = config.detectors[id] as unknown as Record<string, unknown>;
    if (!(field in target)) return { ok: false, message: `неизвестное поле ${parts[2]}` };
    if (field === "enabled") {
      if (typeof value !== "boolean") return { ok: false, message: "enabled принимает true/false" };
      config.detectors[id].enabled = value;
    } else {
      if (typeof value !== "number") return { ok: false, message: `${field} принимает число` };
      (config.detectors[id] as unknown as Record<string, number>)[field] = Math.max(0, value);
    }
    saveAcConfig();
    return { ok: true, message: `${id}.${field} обновлён` };
  }

  if (parts[0] === "limits" && parts.length === 2) {
    const key = parts[1] as keyof AcConfig["limits"];
    if (!(key in config.limits)) return { ok: false, message: `неизвестный лимит ${parts[1]}` };
    if (typeof value !== "number") return { ok: false, message: "лимит принимает число" };
    config.limits[key] = Math.max(0, Math.round(value));
    saveAcConfig();
    return { ok: true, message: `limits.${key}=${config.limits[key]}` };
  }

  return { ok: false, message: `неизвестный путь ${path}` };
};
