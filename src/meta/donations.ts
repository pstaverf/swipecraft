import { Player, world } from "@minecraft/server";
import { t } from "../kernel/i18n";
import { log } from "../kernel/logger";
import { loadWorldJson, saveWorldJson } from "../kernel/store";
import { distance3d } from "../kernel/util";
import { audit, notifyAdmins } from "../security/audit";
import { DONATIONS, META_KEYS, QUEUE } from "./config";
import { getTunables, grantKeys, metaOf } from "./economy";
import { getMeta, markDirty, peekMeta } from "./balances";
import "./messages";
import type { DonationRequest, DonorTier } from "../types/domain";

interface GrantRow {
  t: number;
  actor: string;
  player: string;
  playerId: string;
  tier: DonorTier;
  days: number;
  note: string;
}

interface UsageRow {
  month: number;
  keys: number;
  noticeAt: number;
}

const TIERS: DonorTier[] = ["none", "bronze", "silver", "gold"];
const DAY_MS = 86_400_000;

let requests: DonationRequest[] = [];
let grants: GrantRow[] = [];
let usage: Record<string, UsageRow> = {};
let dirty = false;

const waiting = new Map<string, { name: string; at: number }>();

export const donorTiers = (): DonorTier[] => TIERS;

export const isDonorTier = (value: string): value is DonorTier => (TIERS as string[]).includes(value);

const monthKey = (): number => {
  const now = new Date();
  return now.getFullYear() * 12 + now.getMonth();
};

const findOnline = (playerId: string): Player | undefined => {
  for (const player of world.getAllPlayers()) {
    if (player.id === playerId) return player;
  }
  return undefined;
};

export const tierById = (playerId: string): DonorTier => {
  const record = peekMeta(playerId);
  if (!record || record.donorTier === "none") return "none";
  return record.donorUntil > Date.now() ? record.donorTier : "none";
};

export const tierOf = (player: Player): DonorTier => {
  const tier = tierById(player.id);
  const meta = metaOf(player);
  if (meta.donorTier !== tier) {
    meta.donorTier = tier;
    if (tier === "none") {
      meta.donorUntil = 0;
      //тариф истёк прямо в сессии — иначе донер ходит с чужим префиксом до ребайна
      refreshNameTag(player);
    }
    markDirty(player.id);
  }
  return tier;
};

export const donorDaysLeft = (player: Player): number => {
  const meta = metaOf(player);
  if (meta.donorTier === "none" || meta.donorUntil <= Date.now()) return 0;
  return Math.max(0, Math.ceil((meta.donorUntil - Date.now()) / DAY_MS));
};

export const tierInfo = (tier: DonorTier): { price: number; days: number; prefix: string; queuePriority: boolean; particles: boolean; keys: number } => ({
  price: DONATIONS.tiers[tier].price * DONATIONS.priceMultiplierRub,
  days: DONATIONS.tiers[tier].days,
  prefix: DONATIONS.tiers[tier].prefix,
  queuePriority: DONATIONS.tiers[tier].queuePriority,
  particles: DONATIONS.tiers[tier].particles,
  keys: DONATIONS.keysPerMonth[tier],
});

export const isPriorityPlayer = (player: Player): boolean => {
  const tier = tierOf(player);
  if (tier === "none") return false;
  return DONATIONS.tiers[tier].queuePriority;
};

const persist = (force = false): void => {
  if (!dirty && !force) return;
  saveWorldJson(META_KEYS.donRequests, requests);
  saveWorldJson(META_KEYS.donGrants, grants);
  saveWorldJson(META_KEYS.donUsage, usage);
  dirty = false;
};

export const loadDonations = (): void => {
  const storedRequests = loadWorldJson<DonationRequest[] | undefined>(META_KEYS.donRequests, undefined);
  if (Array.isArray(storedRequests)) {
    requests = storedRequests.filter((row): row is DonationRequest => !!row && typeof row.playerId === "string" && isDonorTier(String(row.tier)));
  }
  const storedGrants = loadWorldJson<GrantRow[] | undefined>(META_KEYS.donGrants, undefined);
  if (Array.isArray(storedGrants)) {
    grants = storedGrants.filter((row): row is GrantRow => !!row && typeof row.t === "number" && isDonorTier(String(row.tier)));
  }
  const storedUsage = loadWorldJson<Record<string, UsageRow> | undefined>(META_KEYS.donUsage, undefined);
  if (storedUsage && typeof storedUsage === "object") usage = storedUsage;
};

export const applyTier = (actor: string, playerId: string, playerName: string, tier: DonorTier, days: number, note: string): string => {
  const known = peekMeta(playerId) !== undefined || findOnline(playerId) !== undefined;
  const meta = getMeta(playerId, playerName);
  meta.donorTier = tier;
  meta.donorUntil = tier === "none" ? 0 : Math.max(Date.now(), meta.donorUntil) + Math.max(1, days) * DAY_MS;
  meta.updatedAt = Date.now();
  markDirty(playerId);
  grants.push({ t: Date.now(), actor, player: playerName, playerId, tier, days, note });
  if (grants.length > DONATIONS.grantsMax) grants = grants.slice(-DONATIONS.grantsMax);
  dirty = true;
  persist(true);
  audit("donate", tier === "none" ? "revoke" : "grant", playerName, `${tier} ${days}д от ${actor}${note ? ` (${note})` : ""}`);
  const online = findOnline(playerId);
  if (online) refreshNameTag(online);
  if (tier !== "none") autoGrantKeysById(playerId, playerName);
  if (online) {
    try {
      online.sendMessage(
        tier === "none"
          ? t(online, "don.revoked")
          : t(online, "don.thanks", { tier, until: new Date(meta.donorUntil).toISOString().slice(0, 10) }),
      );
    } catch (error) {
      log.debug("donate", `notify: ${String(error)}`);
    }
  }
  return known ? `готово: ${playerName} → ${tier}` : `готово: ${playerName} → ${tier} (новая запись)`;
};

export const revokeTier = (actor: string, target: Player): string => applyTier(actor, target.id, target.name, "none", 0, "отозвано админом");

export const refreshNameTag = (player: Player): void => {
  const tier = tierOf(player);
  const prefix = tier === "none" ? "" : DONATIONS.tiers[tier].prefix;
  try {
    if (prefix.length > 0) {
      const wanted = `${prefix}${player.name}`;
      if (player.nameTag !== wanted) player.nameTag = wanted;
      return;
    }
    if (player.nameTag.length > 0 && player.nameTag !== player.name) player.nameTag = player.name;
  } catch (error) {
    log.debug("donate", `nameTag: ${String(error)}`);
  }
};

const autoGrantKeysById = (playerId: string, playerName: string): number => {
  const tier = tierById(playerId);
  if (tier === "none") return 0;
  const keys = DONATIONS.keysPerMonth[tier];
  if (keys <= 0) return 0;
  const month = monthKey();
  const row = usage[playerId];
  if (row && row.month === month) return 0;
  usage[playerId] = { month, keys: (row?.keys ?? 0) + keys, noticeAt: Date.now() };
  dirty = true;
  persist(true);
  const online = findOnline(playerId);
  if (online) {
    grantKeys(online, keys, `донат ${tier} за ${new Date().toISOString().slice(0, 7)}`);
    try {
      online.sendMessage(t(online, "don.keys", { keys, month: new Date().toISOString().slice(0, 7) }));
    } catch (error) {
      log.debug("donate", `keys: ${String(error)}`);
    }
    return keys;
  }
  const meta = getMeta(playerId, playerName.length > 0 ? playerName : playerId);
  meta.caseKeys += keys;
  meta.updatedAt = Date.now();
  markDirty(playerId);
  audit("economy", "keys", meta.name, `+${keys} донат ${tier} (офлайн)`);
  return keys;
};

export const autoGrantKeys = (player: Player): number => autoGrantKeysById(player.id, player.name);

export const submitRequest = (player: Player, tier: DonorTier, days: number, note: string): string => {
  if (tier === "none") return t(player, "don.tierNone");
  const open = requests.find((row) => row.playerId === player.id && row.status === "open");
  if (open) return t(player, "don.requestExists", { id: open.id });
  const id = `${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 1296).toString(36)}`;
  requests.push({ id, playerId: player.id, player: player.name, tier, days, note, at: Date.now(), status: "open", by: "" });
  if (requests.length > DONATIONS.requestsMax) requests = requests.slice(-DONATIONS.requestsMax);
  dirty = true;
  persist(true);
  audit("donate", "request", player.name, `${tier} ${days}д: ${note}`);
  notifyAdmins(`[donate] заявка #${id}: ${player.name} → ${tier} на ${days} дн. (${note})`);
  return t(player, "don.requestSubmitted", { id });
};

export const decideRequest = (actor: string, requestId: string, approve: boolean): string => {
  const request = requests.find((row) => row.id === requestId);
  if (!request) return "заявка не найдена";
  if (request.status !== "open") return "заявка уже обработана";
  request.status = approve ? "approved" : "rejected";
  request.by = actor;
  dirty = true;
  persist(true);
  if (approve) applyTier(actor, request.playerId, request.player, request.tier, request.days, `заявка #${request.id}`);
  audit("donate", approve ? "approve" : "reject", request.player, `#${request.id} ${request.tier}`);
  const online = findOnline(request.playerId);
  if (online) {
    try {
      online.sendMessage(
        approve
          ? t(online, "don.approved", { id: request.id, tier: request.tier })
          : t(online, "don.rejected", { id: request.id }),
      );
    } catch (error) {
      log.debug("donate", `decide: ${String(error)}`);
    }
  }
  return approve ? "одобрено" : "отклонено";
};

export const openRequests = (): DonationRequest[] => requests.filter((row) => row.status === "open");

export const requestLines = (): string[] => {
  const rows = requests.slice(-12).reverse();
  if (rows.length === 0) return ["заявок нет"];
  return rows.map((row) => {
    const time = new Date(row.at).toISOString().slice(5, 16).replace("T", " ");
    return `${row.id} ${time} ${row.player} → ${row.tier} ${row.days}д [${row.status}]${row.by ? ` ${row.by}` : ""}`;
  });
};

export const grantLines = (count: number): string[] => {
  const rows = grants.slice(-count).reverse();
  if (rows.length === 0) return ["выдач не было"];
  return rows.map((row) => {
    const time = new Date(row.t).toISOString().slice(5, 16).replace("T", " ");
    return `${time} ${row.actor} → ${row.player}: ${row.tier} ${row.days}д ${row.note}`;
  });
};

export const catalogLines = (player: Player): string[] => {
  const lines = [t(player, "don.catalog.1"), t(player, "don.catalog.2"), t(player, "don.catalog.3"), ""];
  for (const tier of TIERS) {
    if (tier === "none") continue;
    const info = tierInfo(tier);
    lines.push(
      t(player, "don.tier.line", {
        tier,
        price: info.price,
        cur: DONATIONS.currency,
        days: info.days,
        keys: info.keys,
        queue: t(player, info.queuePriority ? "don.queue.yes" : "don.queue.no"),
        fx: t(player, info.particles ? "don.fx.yes" : "don.fx.no"),
        prefix: info.prefix.replace(/§./g, ""),
      }),
    );
  }
  const tier = tierOf(player);
  lines.push("");
  lines.push(
    tier === "none"
      ? t(player, "don.you.none")
      : t(player, "don.you", { tier, days: donorDaysLeft(player), keys: metaOf(player).caseKeys }),
  );
  return lines;
};

export const trailSweep = (): void => {
  const players = world.getAllPlayers();
  if (players.length === 0) return;
  for (const player of players) {
    const tier = tierOf(player);
    if (tier === "none") continue;
    if (!DONATIONS.tiers[tier].particles) continue;
    try {
      const spot = { x: player.location.x, y: player.location.y + 0.4, z: player.location.z };
      try {
        player.dimension.spawnParticle(DONATIONS.trailParticle, spot);
      } catch {
        player.dimension.spawnParticle(DONATIONS.trailFallbackParticle, spot);
      }
    } catch (error) {
      log.debug("donate", `трейл: ${String(error)}`);
      continue;
    }
  }
};

export const queueReport = (): string[] => {
  const tun = getTunables();
  const online = world.getAllPlayers().length;
  return [
    `онлайн: ${online}, мягкий кап: ${tun.queueSoftCap}, отпускание: ${tun.queueReleaseAt}, включено: ${tun.queueEnabled}`,
    `в ожидании: ${waiting.size}${waiting.size > 0 ? ` (${[...waiting.values()].map((row) => row.name).join(", ")})` : ""}`,
  ];
};

const waitPoint = () => ({ x: QUEUE.waitSpot.x, y: QUEUE.waitSpot.y, z: QUEUE.waitSpot.z });

export const queueOnSpawn = (player: Player): boolean => {
  const tun = getTunables();
  if (!tun.queueEnabled) return false;
  if (isPriorityPlayer(player)) return false;
  const online = world.getAllPlayers().length;
  if (online <= tun.queueSoftCap) return false;
  waiting.set(player.id, { name: player.name, at: Date.now() });
  try {
    player.addTag("sw:queued");
    player.teleport(waitPoint(), { dimension: world.getDimension(QUEUE.dimensionId) });
    player.sendMessage(t(player, "queue.enter", { online }));
  } catch (error) {
    log.error("donate", `queue: ${String(error)}`);
  }
  notifyAdmins(`[queue] ${player.name} в ожидании: онлайн ${online}, кап ${tun.queueSoftCap}`);
  return true;
};

export const queueTick = (): void => {
  if (waiting.size === 0) return;
  const tun = getTunables();
  const online = world.getAllPlayers().length;
  const now = Date.now();
  for (const [playerId, row] of waiting) {
    const player = findOnline(playerId);
    if (!player) {
      waiting.delete(playerId);
      continue;
    }
    if (!tun.queueEnabled || online <= tun.queueReleaseAt || isPriorityPlayer(player)) {
      waiting.delete(playerId);
      try {
        player.removeTag("sw:queued");
        player.sendMessage(t(player, "queue.release"));
      } catch (error) {
        log.debug("donate", `release: ${String(error)}`);
      }
      continue;
    }
    try {
      if (distance3d(player.location, waitPoint()) > 40) {
        player.teleport(waitPoint(), { dimension: world.getDimension(QUEUE.dimensionId) });
      }
      player.onScreenDisplay.setActionBar(t(player, "queue.bar", { seconds: Math.round((now - row.at) / 1000), online, cap: tun.queueSoftCap }));
    } catch (error) {
      log.debug("donate", `notice: ${String(error)}`);
    }
  }
};

export const flushDonations = (): void => {
  persist();
};

export const unqueue = (playerId: string): void => {
  waiting.delete(playerId);
};

export const releaseAll = (): number => {
  const count = waiting.size;
  for (const playerId of [...waiting.keys()]) {
    const player = findOnline(playerId);
    if (player) {
      try {
        player.removeTag("sw:queued");
      } catch {
        continue;
      }
    }
    waiting.delete(playerId);
  }
  return count;
};

export const donorReport = (): string[] => {
  const lines: string[] = [];
  for (const player of world.getAllPlayers()) {
    const tier = tierOf(player);
    if (tier === "none") continue;
    lines.push(`${player.name}: ${tier}, ${donorDaysLeft(player)} дн., ключей ${metaOf(player).caseKeys}`);
  }
  if (lines.length === 0) lines.push("донатеров онлайн нет");
  lines.push(`заявок в ожидании: ${openRequests().length}`);
  lines.push(`выдач в журнале: ${grants.length}`);
  return lines;
};
