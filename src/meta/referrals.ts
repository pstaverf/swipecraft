import { Player, world } from "@minecraft/server";
import { t } from "../kernel/i18n";
import { log } from "../kernel/logger";
import { loadWorldJson, saveWorldJson } from "../kernel/store";
import { audit, notifyAdmins } from "../security/audit";
import { META_KEYS, REFERRALS } from "./config";
import { allMeta, getMeta, markDirty, peekMeta } from "./balances";
import { grantKeys, metaOf, mintToId } from "./economy";
import "./messages";
import type { ReferralLogRow, ReferralRow } from "../types/domain";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

let codes: Record<string, ReferralRow> = {};
let logRows: ReferralLogRow[] = [];
let dirty = false;

const dayIndex = (): number => Math.floor(Date.now() / DAY_MS);
const monthIndex = (): number => {
  const now = new Date();
  return now.getFullYear() * 12 + now.getMonth();
};

const hash = (value: string): number => {
  let acc = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    acc ^= value.charCodeAt(index);
    acc = Math.imul(acc, 16777619);
  }
  return acc >>> 0;
};

const encode = (seed: number, length: number): string => {
  let value = seed;
  let out = "";
  for (let index = 0; index < length; index += 1) {
    value = Math.imul(value, 1103515245) + 12345;
    out += ALPHABET[(value >>> 13) % ALPHABET.length];
  }
  return out;
};

const pushRow = (kind: ReferralLogRow["kind"], referrer: string, referee: string, detail: string): void => {
  logRows.push({ t: Date.now(), kind, referrer, referee, detail });
  if (logRows.length > REFERRALS.logMax) logRows = logRows.slice(-REFERRALS.logMax);
  dirty = true;
};

const persist = (force = false): void => {
  if (!dirty && !force) return;
  saveWorldJson(META_KEYS.refCodes, codes);
  saveWorldJson(META_KEYS.refLog, logRows);
  dirty = false;
};

export const loadReferrals = (): number => {
  const storedCodes = loadWorldJson<Record<string, ReferralRow> | undefined>(META_KEYS.refCodes, undefined);
  if (storedCodes && typeof storedCodes === "object") {
    codes = {};
    for (const [code, row] of Object.entries(storedCodes)) {
      if (!row || typeof row !== "object" || typeof row.playerId !== "string") continue;
      codes[code] = { code, playerId: row.playerId, name: String(row.name ?? "") };
    }
  }
  const storedLog = loadWorldJson<ReferralLogRow[] | undefined>(META_KEYS.refLog, undefined);
  logRows = Array.isArray(storedLog) ? storedLog.filter((row) => !!row && typeof row.t === "number").slice(-REFERRALS.logMax) : [];
  return Object.keys(codes).length;
};

export const flushReferrals = (): void => {
  persist();
};

const normalize = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .split("")
    .filter((char) => ALPHABET.includes(char))
    .join("")
    .slice(0, 12);

const findByPlayer = (playerId: string): ReferralRow | undefined => {
  for (const row of Object.values(codes)) {
    if (row.playerId === playerId) return row;
  }
  return undefined;
};

export const codeOf = (player: Player): string => {
  const meta = metaOf(player);
  const existing = findByPlayer(player.id);
  if (existing) {
    if (meta.refCode !== existing.code) {
      meta.refCode = existing.code;
      markDirty(player.id);
    }
    return existing.code;
  }
  let candidate = encode(hash(player.id), REFERRALS.codeLength);
  let guard = 0;
  while (codes[candidate] !== undefined && codes[candidate].playerId !== player.id && guard < 40) {
    guard += 1;
    candidate = `${encode(hash(`${player.id}:${guard}`), REFERRALS.codeLength)}`;
  }
  if (Object.keys(codes).length >= REFERRALS.codesMax) {
    log.warn("ref", "лист кодов переполнен, новые коды не регистрируются");
    return "";
  }
  codes[candidate] = { code: candidate, playerId: player.id, name: player.name };
  dirty = true;
  persist(true);
  meta.refCode = candidate;
  meta.updatedAt = Date.now();
  markDirty(player.id);
  return candidate;
};

export const resolveCode = (value: string): ReferralRow | undefined => codes[normalize(value)];

const referrerMeta = (row: ReferralRow) => peekMeta(row.playerId);

export const bindCode = (player: Player, value: string): { ok: boolean; key: string; params?: Record<string, string | number> } => {
  const meta = metaOf(player);
  const clean = normalize(value);
  if (meta.refBy.length > 0) return { ok: false, key: "ref.exists" };
  if (Date.now() - meta.joinedAt > REFERRALS.bindWindowHours * HOUR_MS) {
    return { ok: false, key: "ref.tooLate", params: { hours: Math.max(1, Math.round(REFERRALS.bindWindowHours)) } };
  }
  const row = codes[clean];
  if (!row) return { ok: false, key: "ref.unknownCode" };
  if (row.playerId === player.id) return { ok: false, key: "ref.self" };
  const inviter = referrerMeta(row);
  if (!inviter) return { ok: false, key: "ref.unknownCode" };
  if (inviter.banned) {
    pushRow("reject", inviter.name, player.name, "приглашающий под ограничениями");
    return { ok: false, key: "ref.referrerBanned" };
  }
  if (inviter.playSeconds < REFERRALS.minReferrerPlaySeconds || Date.now() - inviter.joinedAt < REFERRALS.minReferrerAgeDays * DAY_MS) {
    pushRow("reject", inviter.name, player.name, "приглашающий слишком молодой");
    return { ok: false, key: "ref.referrerYoung" };
  }
  meta.refBy = row.playerId;
  meta.refBoundAt = Date.now();
  meta.updatedAt = Date.now();
  markDirty(player.id);
  pushRow("bind", inviter.name, player.name, `код ${clean}`);
  persist(true);
  audit("ref", "bind", player.name, `${inviter.name} (${clean})`);
  const online = findOnline(row.playerId);
  if (online) {
    try {
      online.sendMessage(
        t(online, "ref.waiting", {
          name: player.name,
          left: Math.max(0, Math.ceil((REFERRALS.rewardAfterSeconds - metaOf(player).playSeconds) / 3600)),
        }),
      );
    } catch (error) {
      log.debug("ref", `notify: ${String(error)}`);
    }
  }
  return { ok: true, key: "ref.boundOk", params: { name: inviter.name } };
};

const findOnline = (playerId: string): Player | undefined => {
  for (const player of world.getAllPlayers()) {
    if (player.id === playerId) return player;
  }
  return undefined;
};

export const referralSummary = (player: Player): string[] => {
  const meta = metaOf(player);
  const invited = Object.values(allMeta()).filter((row) => row.refBy === player.id);
  const rewarded = invited.filter((row) => row.refRewarded).length;
  const code = meta.refCode.length > 0 ? meta.refCode : "";
  const hours = Math.round(REFERRALS.rewardAfterSeconds / 3600);
  const lines = [
    code.length > 0 ? t(player, "ref.my", { code }) : t(player, "ref.noCode"),
    t(player, "ref.body", { hours }),
    t(player, "ref.invited", { count: invited.length, rewarded }),
    t(player, "ref.rewardToday", { today: meta.refDay === dayIndex() ? meta.refToday : 0, max: REFERRALS.maxRewardedPerDay }),
    t(player, "ref.monthCoins", { coins: meta.refMonth === monthIndex() ? meta.refMonthCoins : 0, cap: REFERRALS.maxCoinsPerMonth }),
  ];
  lines.push(
    meta.refBy.length === 0
      ? t(player, "ref.notBound", { hours: Math.max(1, Math.round(REFERRALS.bindWindowHours)) })
      : t(player, "ref.bound", { name: peekMeta(meta.refBy)?.name ?? meta.refBy.slice(0, 8), hours }),
  );
  return lines;
};

export const rewardSweep = (): number => {
  for (const player of world.getAllPlayers()) metaOf(player);
  let paid = 0;
  for (const [playerId, meta] of Object.entries(allMeta())) {
    if (meta.refBy.length === 0 || meta.refRewarded) continue;
    if (meta.playSeconds < REFERRALS.rewardAfterSeconds) continue;
    if (meta.banned) continue;
    const inviter = peekMeta(meta.refBy);
    if (!inviter) continue;
    if (inviter.refDay !== dayIndex()) {
      inviter.refDay = dayIndex();
      inviter.refToday = 0;
    }
    if (inviter.refToday >= REFERRALS.maxRewardedPerDay) continue;
    if (inviter.refMonth !== monthIndex()) {
      inviter.refMonth = monthIndex();
      inviter.refMonthCoins = 0;
    }
    if (inviter.refMonthCoins + REFERRALS.rewardCoinsReferrer > REFERRALS.maxCoinsPerMonth) continue;
    const referee = mintToId(playerId, meta.name, REFERRALS.rewardCoinsReferee, "реферальная награда новичку");
    const referrer = mintToId(meta.refBy, inviter.name, REFERRALS.rewardCoinsReferrer, "реферальная награда за приглашение");
    meta.refRewarded = true;
    meta.updatedAt = Date.now();
    markDirty(playerId);
    if (referrer.ok) {
      inviter.refToday += 1;
      inviter.refMonthCoins += REFERRALS.rewardCoinsReferrer;
      inviter.updatedAt = Date.now();
      markDirty(meta.refBy);
    }
    grantKeysTo(meta.refBy, inviter.name, 1, "привёл друга");
    pushRow("reward", inviter.name, meta.name, `${REFERRALS.rewardCoinsReferrer}+${REFERRALS.rewardCoinsReferee} ₡, реферер ${referrer.ok ? "выплачен" : referrer.key}, новичок ${referee.ok ? "выплачен" : referee.key}`);
    paid += 1;
    const onlineInviter = findOnline(meta.refBy);
    if (onlineInviter) {
      try {
        onlineInviter.sendMessage(t(onlineInviter, "ref.rewardReferrer", { name: meta.name, hours: Math.round(REFERRALS.rewardAfterSeconds / 3600), coins: REFERRALS.rewardCoinsReferrer }));
      } catch (error) {
        log.debug("ref", `notify: ${String(error)}`);
      }
    }
    const onlineReferee = findOnline(playerId);
    if (onlineReferee && referee.ok) {
      try {
        onlineReferee.sendMessage(t(onlineReferee, "ref.rewardReferee", { coins: REFERRALS.rewardCoinsReferee, hours: Math.round(REFERRALS.rewardAfterSeconds / 3600) }));
      } catch (error) {
        log.debug("ref", `notify: ${String(error)}`);
      }
    }
  }
  if (paid > 0) {
    persist(true);
    notifyAdmins(`[ref] наград выдано: ${paid}`);
  }
  return paid;
};

const grantKeysTo = (playerId: string, name: string, count: number, reason: string): void => {
  const online = findOnline(playerId);
  if (online) {
    grantKeys(online, count, reason);
    return;
  }
  const meta = getMeta(playerId, name);
  meta.caseKeys += count;
  meta.updatedAt = Date.now();
  markDirty(playerId);
};

export const referralReport = (): string[] => {
  const rows = [...logRows].reverse().slice(0, 10);
  const lines = [`кодов выдано: ${Object.keys(codes).length}, записей в журнале: ${logRows.length}`];
  if (rows.length === 0) lines.push("журнал приглашений пуст");
  for (const row of rows) {
    const time = new Date(row.t).toISOString().slice(5, 16).replace("T", " ");
    lines.push(`${time} ${row.kind}: ${row.referrer} → ${row.referee} ${row.detail}`);
  }
  return lines;
};

export const topReferrers = (): string[] => {
  const counted = new Map<string, { name: string; invited: number; rewarded: number }>();
  for (const meta of Object.values(allMeta())) {
    if (meta.refBy.length === 0) continue;
    const row = counted.get(meta.refBy) ?? { name: peekMeta(meta.refBy)?.name ?? meta.refBy.slice(0, 8), invited: 0, rewarded: 0 };
    row.invited += 1;
    if (meta.refRewarded) row.rewarded += 1;
    counted.set(meta.refBy, row);
  }
  const rows = [...counted.values()].sort((left, right) => right.rewarded - left.rewarded || right.invited - left.invited).slice(0, 10);
  if (rows.length === 0) return ["приглашений пока не было"];
  return rows.map((row, index) => `${index + 1}. ${row.name}: наград ${row.rewarded}, приведено ${row.invited}`);
};

export const resetBinding = (actor: string, target: Player, reason: string): string => {
  const meta = metaOf(target);
  const previous = meta.refBy;
  meta.refBy = "";
  meta.refBoundAt = 0;
  meta.refRewarded = false;
  meta.updatedAt = Date.now();
  markDirty(target.id);
  pushRow("reset", previous.slice(0, 8), target.name, `${reason} от ${actor}`);
  persist(true);
  audit("ref", "reset", target.name, reason);
  return t(target, "ref.reset");
};
