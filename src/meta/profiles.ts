import { Player, world } from "@minecraft/server";
import { CONFIG, STORE_KEYS } from "../config";
import { setLang } from "../kernel/i18n";
import { log } from "../kernel/logger";
import { loadPlayerJson, savePlayerJson } from "../kernel/store";
import { isMobile } from "../kernel/util";
import type { Profile } from "../types/domain";

const cache = new Map<string, Profile>();
const sessionStart = new Map<string, number>();

const createProfile = (player: Player): Profile => ({
  name: player.name,
  lang: "ru",
  kills: 0,
  deaths: 0,
  playSeconds: 0,
  joinedAt: Date.now(),
  lastSeen: Date.now(),
  banned: false,
  banReason: "",
  banUntil: 0,
  acScore: 0,
  flags: {},
  rtpReadyAt: 0,
  mobile: isMobile(player),
});

export const getProfile = (player: Player): Profile => {
  const cached = cache.get(player.id);
  if (cached) return cached;
  const stored = loadPlayerJson<Profile | undefined>(player, `${STORE_KEYS.profilePrefix}${player.id}`, undefined);
  const profile = stored ? { ...createProfile(player), ...stored } : createProfile(player);
  profile.mobile = isMobile(player);
  cache.set(player.id, profile);
  sessionStart.set(player.id, Date.now());
  setLang(player.id, profile.lang);
  return profile;
};

export const saveProfile = (player: Player): void => {
  const profile = cache.get(player.id);
  if (!profile) return;
  const started = sessionStart.get(player.id);
  if (started) profile.playSeconds += Math.floor((Date.now() - started) / 1000);
  sessionStart.set(player.id, Date.now());
  profile.lastSeen = Date.now();
  savePlayerJson(player, `${STORE_KEYS.profilePrefix}${player.id}`, profile);
};

export const flushProfiles = (): void => {
  for (const player of world.getAllPlayers()) saveProfile(player);
};

export const forgetPlayer = (playerId: string): void => {
  cache.delete(playerId);
  sessionStart.delete(playerId);
};

export const allCachedProfiles = (): [string, Profile][] => [...cache.entries()];

export const findProfileByName = (name: string): Profile | undefined => {
  const lowered = name.toLowerCase();
  for (const profile of cache.values()) {
    if (profile.name.toLowerCase() === lowered) return profile;
  }
  return undefined;
};

export const setBanned = (player: Player, reason: string, until: number): void => {
  const profile = getProfile(player);
  profile.banned = true;
  profile.banReason = reason;
  profile.banUntil = until;
  saveProfile(player);
};

export const clearBan = (player: Player): void => {
  const profile = getProfile(player);
  profile.banned = false;
  profile.banReason = "";
  profile.banUntil = 0;
  saveProfile(player);
};

export const isBannedNow = (player: Player): boolean => {
  const profile = getProfile(player);
  if (!profile.banned) return false;
  if (profile.banUntil > 0 && profile.banUntil < Date.now()) {
    profile.banned = false;
    profile.banReason = "";
    profile.banUntil = 0;
    return false;
  }
  return true;
};

export const profileFlushIntervalTicks = CONFIG.profiles.flushTicks;

export const registerProfileTasks = (register: (name: string, ticks: number, budget: number, fn: () => void) => void): void => {
  register("profiles-flush", CONFIG.profiles.flushTicks, 20, () => {
    flushProfiles();
    log.debug("profiles", `сохранено профилей: ${cache.size}`);
  });
};
