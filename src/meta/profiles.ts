import { Player, world } from "@minecraft/server";
import { CONFIG, STORE_KEYS } from "../config";
import { setLang } from "../kernel/i18n";
import { log } from "../kernel/logger";
import { loadPlayerJson, savePlayerJson } from "../kernel/store";
import { DAY_MS, dayIndex, isMobile } from "../kernel/util";
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
  playToday: 0,
  playDay: dayIndex(),
});

export const getProfile = (player: Player): Profile => {
  const cached = cache.get(player.id);
  if (cached) return cached;
  const stored = loadPlayerJson<Profile | undefined>(player, `${STORE_KEYS.profilePrefix}${player.id}`, undefined);
  const profile = stored ? { ...createProfile(player), ...stored } : createProfile(player);
  profile.name = player.name;
  profile.mobile = isMobile(player);
  cache.set(player.id, profile);
  sessionStart.set(player.id, Date.now());
  setLang(player.id, profile.lang);
  return profile;
};

export const liveSessionSeconds = (player: Player): number => {
  const started = sessionStart.get(player.id);
  if (!started) return 0;
  // часы сервера могут отстать/уйти вперёд — отрицательную сессию не копить
  return Math.max(0, Math.floor((Date.now() - started) / 1000));
};

/**
 * Единственный аккумулятор игрового времени. Раньше здесь было только
 * `playSeconds += …`, и «сколько игрок сыграл сегодня» пришлось бы считать второй
 * копией той же арифметики — расхождение на границе суток было бы видно игроку
 * (в таблице «0м», в статистике «23ч»).
 */
const accumulate = (profile: Profile, from: number, to: number): void => {
  if (to <= from) return;
  // Если с последнего сейва прошло больше месяца, дробить по суткам бессмысленно:
  // такие дыры — выключенный сервер, а не игровое время. Относим их на последний день.
  if (to - from > 30 * 86_400_000) {
    const day = dayIndex(to);
    if (profile.playDay !== day) {
      profile.playDay = day;
      profile.playToday = 0;
    }
    profile.playToday += Math.floor((to - from) / 1000);
    return;
  }
  let cursor = from;
  while (cursor < to) {
    const day = dayIndex(cursor);
    const dayEnd = (day + 1) * 86_400_000;
    const slice = Math.min(to, dayEnd);
    if (profile.playDay !== day) {
      profile.playDay = day;
      profile.playToday = 0;
    }
    profile.playToday += Math.floor((slice - cursor) / 1000);
    cursor = slice;
  }
};

export const saveProfile = (player: Player): void => {
  const profile = cache.get(player.id);
  if (!profile) return;
  const now = Date.now();
  const spent = liveSessionSeconds(player);
  if (spent > 0) {
    profile.playSeconds += spent;
    // границы суток режет accumulate: дельта делится на части, иначе вчерашние
    // 23:59:30 записались бы сегодняшнему дню
    const started = sessionStart.get(player.id) ?? now - spent * 1000;
    accumulate(profile, started, now);
  }
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

/**
 * Сыгранное время без записи в хранилище: профиль копит session-дельту, а «за сегодня»
 * ещё и проверяет ключ суток. Значения живые (текущая сессия включена), поэтому их
 * можно показывать в таблице статуса хоть каждые 5 секунд.
 */
export const playStats = (player: Player): { todaySeconds: number; totalSeconds: number } => {
  const profile = getProfile(player);
  const day = dayIndex();
  const carried = profile.playDay === day ? profile.playToday : 0;
  const live = liveSessionSeconds(player);
  const started = sessionStart.get(player.id);
  if (!started) return { todaySeconds: carried, totalSeconds: profile.playSeconds + live };
  // живую часть тоже надо резать по полуночи: иначе в 00:01 «за сегодня» покажет
  // всю вчерашнюю сессию, хотя сейв ещё не случился
  const from = Math.max(started, day * DAY_MS);
  const liveToday = Math.max(0, Math.floor((Date.now() - from) / 1000));
  return { todaySeconds: carried + liveToday, totalSeconds: profile.playSeconds + live };
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

export const effectivePlaySeconds = (player: Player): number => {
  const profile = getProfile(player);
  return profile.playSeconds + liveSessionSeconds(player);
};

export const registerProfileTasks = (register: (name: string, ticks: number, budget: number, fn: () => void) => void): void => {
  register("profiles-flush", CONFIG.profiles.flushTicks, 20, () => {
    flushProfiles();
    log.debug("profiles", `сохранено профилей: ${cache.size}`);
  });
};
