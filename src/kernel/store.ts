import { Player, world } from "@minecraft/server";
import { CONFIG } from "../config";
import { log } from "./logger";

const chunkSize = CONFIG.store.chunkSize;

const countKey = (key: string): string => `${key}:n`;

export const saveWorldJson = (key: string, value: unknown): void => {
  const text = JSON.stringify(value);
  const total = Math.max(1, Math.ceil(text.length / chunkSize));
  const previous = world.getDynamicProperty(countKey(key));
  const previousCount = typeof previous === "number" ? previous : 0;
  for (let index = 0; index < total; index += 1) {
    world.setDynamicProperty(`${key}:${index}`, text.slice(index * chunkSize, (index + 1) * chunkSize));
  }
  if (previousCount > total) {
    for (let index = total; index < previousCount; index += 1) {
      world.setDynamicProperty(`${key}:${index}`, undefined);
    }
  }
  world.setDynamicProperty(countKey(key), total);
};

export const loadWorldJson = <T>(key: string, fallback: T): T => {
  try {
    const countValue = world.getDynamicProperty(countKey(key));
    const count = typeof countValue === "number" ? countValue : 0;
    if (count <= 0) return fallback;
    let text = "";
    for (let index = 0; index < count; index += 1) {
      const part = world.getDynamicProperty(`${key}:${index}`);
      if (typeof part !== "string") return fallback;
      text += part;
    }
    return JSON.parse(text) as T;
  } catch (error) {
    log.error("store", `не удалось прочитать ${key}: ${String(error)}`);
    return fallback;
  }
};

export const clearWorldJson = (key: string): void => {
  const previous = world.getDynamicProperty(countKey(key));
  const previousCount = typeof previous === "number" ? previous : 0;
  for (let index = 0; index < previousCount; index += 1) {
    world.setDynamicProperty(`${key}:${index}`, undefined);
  }
  world.setDynamicProperty(countKey(key), undefined);
};

export const savePlayerJson = (player: Player, key: string, value: unknown): void => {
  try {
    player.setDynamicProperty(key, JSON.stringify(value));
  } catch (error) {
    log.error("store", `профиль ${player.name}: ${String(error)}`);
  }
};

export const loadPlayerJson = <T>(player: Player, key: string, fallback: T): T => {
  try {
    const raw = player.getDynamicProperty(key);
    if (typeof raw !== "string" || raw.length === 0) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

export const dynamicPropertyBudget = (): number => {
  try {
    return world.getDynamicPropertyTotalByteCount();
  } catch {
    return -1;
  }
};
