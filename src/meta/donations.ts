import { Player, world } from "@minecraft/server";
import { t } from "../kernel/i18n";
import { log } from "../kernel/logger";
import { loadWorldJson, saveWorldJson } from "../kernel/store";
import { distance3d } from "../kernel/util";
import { audit, notifyAdmins } from "../security/audit";
import { DONATIONS, META_KEYS, QUEUE } from "./config";
import { getTunables, grantKeys, metaOf, mintToId } from "./economy";
import { allMeta, getMeta, markDirty, peekMeta } from "./balances";
import { addReceipt, applyIdentity, grantRolls, receiptsCount, spawnTrailFor } from "./cosmetics";
import "./messages";
import type { DonationGoal, DonationRequest, DonorTier } from "../types/domain";

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
  gifts: number;
  noticeAt: number;
}

const TIERS: DonorTier[] = ["none", "bronze", "silver", "gold"];
const DAY_MS = 86_400_000;

let requests: DonationRequest[] = [];
let grants: GrantRow[] = [];
let usage: Record<string, UsageRow> = {};
let dirty = false;

const waiting = new Map<string, { name: string; at: number }>();

const emptyGoal = (): DonationGoal => ({ label: "", target: 0, raised: 0, deadline: 0, paidAt: 0 });

let goal: DonationGoal = emptyGoal();

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

export const tierInfo = (tier: DonorTier): { price: number; days: number; prefix: string; queuePriority: boolean; particles: boolean; rolls: number } => ({
  price: DONATIONS.tiers[tier].price * DONATIONS.priceMultiplierRub,
  days: DONATIONS.tiers[tier].days,
  prefix: DONATIONS.tiers[tier].prefix,
  queuePriority: DONATIONS.tiers[tier].queuePriority,
  particles: DONATIONS.tiers[tier].particles,
  rolls: DONATIONS.tiers[tier].giftRolls,
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
  saveWorldJson(META_KEYS.donGoal, goal);
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
  if (storedUsage && typeof storedUsage === "object") {
    usage = {};
    for (const [id, row] of Object.entries(storedUsage)) {
      if (!row || typeof row !== "object") continue;
      usage[id] = { month: Number(row.month) || 0, gifts: Number((row as unknown as { gifts: number }).gifts ?? (row as unknown as { keys: number }).keys) || 0, noticeAt: Number(row.noticeAt) || 0 };
    }
  }
  const storedGoal = loadWorldJson<DonationGoal | undefined>(META_KEYS.donGoal, undefined);
  if (storedGoal && typeof storedGoal === "object") goal = { ...emptyGoal(), ...storedGoal };
};

export const applyTier = (actor: string, playerId: string, playerName: string, tier: DonorTier, days: number, note: string): string => {
  const known = peekMeta(playerId) !== undefined || findOnline(playerId) !== undefined;
  const meta = getMeta(playerId, playerName);
  if (tier !== "none" && meta.donBlockUntil > Date.now()) {
    audit("donate", "blocked", playerName, `${tier} ${days}д от ${actor}: спорный платёж`);
    notifyAdmins(`[donate] выдача ${playerName} заблокирована: ${meta.donBlockReason || "спорный платёж"} до ${new Date(meta.donBlockUntil).toISOString().slice(0, 10)}`);
    return `выдача заблокирована: спорный платёж до ${new Date(meta.donBlockUntil).toISOString().slice(0, 10)} (причина: ${meta.donBlockReason || "—"})`;
  }
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
  if (tier !== "none") {
    addRaised(Math.round((tierInfo(tier).price * days) / DONATIONS.tiers[tier].days), actor, `заявка/выдача ${playerName}`);
    addReceipt(playerId, meta.name, `${tier} ${days} дн.`, "donate", Math.round((tierInfo(tier).price * days) / DONATIONS.tiers[tier].days), actor);
  }
  if (tier !== "none") autoGrantGiftById(playerId, playerName);
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
  if (note.trim().length === 0 && tier !== "none" && DONATIONS.requireNote) {
    return `выдача проведена, но без комментария: укажи ID платежа в заметке (${playerName} → ${tier})`;
  }
  return known ? `готово: ${playerName} → ${tier}` : `готово: ${playerName} → ${tier} (новая запись)`;
};

export const revokeTier = (actor: string, target: Player): string => applyTier(actor, target.id, target.name, "none", 0, "отозвано админом");

export const refreshNameTag = (player: Player): void => {
  tierOf(player);
  applyIdentity(player);
};

const autoGrantGiftById = (playerId: string, playerName: string): number => {
  const tier = tierById(playerId);
  if (tier === "none") return 0;
  const rolls = DONATIONS.tiers[tier].giftRolls;
  if (rolls <= 0) return 0;
  const month = monthKey();
  const row = usage[playerId];
  if (row && row.month === month) return 0;
  usage[playerId] = { month, gifts: (row?.gifts ?? 0) + rolls, noticeAt: Date.now() };
  dirty = true;
  persist(true);
  const online = findOnline(playerId);
  const granted = grantRollsFor(online, playerId, playerName, rolls, `донат ${tier} за ${new Date().toISOString().slice(0, 7)}`);
  if (online) {
    try {
      online.sendMessage(t(online, "don.gift", { rolls: granted, month: new Date().toISOString().slice(0, 7) }));
    } catch (error) {
      log.debug("donate", `gift: ${String(error)}`);
    }
  }
  audit("donate", "gift", online?.name ?? playerName, `+${granted} прокруток косметики (${tier})`);
  return granted;
};

const grantRollsFor = (online: Player | undefined, playerId: string, playerName: string, rolls: number, reason: string): number => {
  if (online) return grantRolls(online, rolls, reason);
  const meta = getMeta(playerId, playerName.length > 0 ? playerName : playerId);
  if (!meta.cosmetics || typeof meta.cosmetics !== "object") return 0;
  meta.cosmetics.rolls += rolls;
  meta.updatedAt = Date.now();
  markDirty(playerId);
  return rolls;
};

export const autoGrantGift = (player: Player): number => autoGrantGiftById(player.id, player.name);

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
  const lines = [t(player, "don.catalog.1"), t(player, "don.catalog.2"), t(player, "don.catalog.3"), t(player, "don.rules.1"), ""];
  for (const tier of TIERS) {
    if (tier === "none") continue;
    const info = tierInfo(tier);
    lines.push(
      t(player, "don.tier.line", {
        tier,
        price: info.price,
        cur: DONATIONS.currency,
        days: info.days,
        rolls: info.rolls,
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
      : t(player, "don.you", { tier, days: donorDaysLeft(player), rolls: metaOf(player).cosmetics.rolls }),
  );
  return lines;
};

export const trailSweep = (): void => {
  for (const player of world.getAllPlayers()) {
    tierOf(player);
    spawnTrailFor(player);
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

export const goalState = (): DonationGoal => ({ ...goal });

export const goalLines = (player: Player): string[] => {
  if (goal.target <= 0) return [t(player, "don.goal.none")];
  if (goal.paidAt > 0) return [t(player, "don.goal.done", { label: goal.label })];
  return [
    t(player, "don.goal.line", {
      label: goal.label,
      raised: goal.raised,
      target: goal.target,
      cur: DONATIONS.currency,
      date: goal.deadline > 0 ? new Date(goal.deadline).toISOString().slice(0, 10) : "—",
      coins: DONATIONS.goal.rewardCoins,
      keys: DONATIONS.goal.rewardKeys,
    }),
  ];
};

const goalPayout = (): number => {
  if (goal.target <= 0 || goal.paidAt > 0 || goal.raised < goal.target) return 0;
  goal.paidAt = Date.now();
  dirty = true;
  persist(true);
  let paid = 0;
  for (const [playerId, meta] of Object.entries(allMeta())) {
    const result = mintToId(playerId, meta.name, DONATIONS.goal.rewardCoins, "цель доната");
    if (result.ok) paid += 1;
    const online = findOnline(playerId);
    if (online && DONATIONS.goal.rewardKeys > 0) {
      grantKeys(online, DONATIONS.goal.rewardKeys, "цель доната");
    } else if (DONATIONS.goal.rewardKeys > 0) {
      meta.caseKeys += DONATIONS.goal.rewardKeys;
      meta.updatedAt = Date.now();
      markDirty(playerId);
    }
    addReceipt(playerId, meta.name, `цель «${goal.label}»`, "gift", DONATIONS.goal.rewardCoins, "system");
  }
  notifyAdmins(`[donate] цель «${goal.label}» достигнута: ${goal.raised}/${goal.target} ${DONATIONS.currency}`);
  try {
    world.sendMessage(`§6[донат]§r цель «${goal.label}» собрана — награда выдана всем: ${DONATIONS.goal.rewardCoins} ₡ и ${DONATIONS.goal.rewardKeys} ключ(а)`);
  } catch (error) {
    log.debug("donate", `goal broadcast: ${String(error)}`);
  }
  audit("donate", "goal-payout", goal.label, `собрано ${goal.raised}/${goal.target}, выплат на ${paid}`);
  notifyAdmins(`[donate] цель «${goal.label}» собрана: ${goal.raised}/${goal.target} ${DONATIONS.currency}, награда выдана всем (${paid})`);
  return paid;
};

export const addRaised = (amount: number, actor: string, note: string): void => {
  const clean = Math.max(0, Math.floor(amount));
  if (clean === 0) return;
  if (goal.paidAt > 0) return;
  goal.raised += clean;
  dirty = true;
  persist(true);
  audit("donate", "goal-raise", actor, `+${clean} ${note}`);
  if (goal.target > 0 && goal.raised >= goal.target) goalPayout();
};

export const setGoal = (actor: string, label: string, target: number, days: number): string => {
  const clean = Math.max(0, Math.floor(target));
  if (clean === 0) {
    goal = emptyGoal();
    dirty = true;
    persist(true);
    audit("donate", "goal-close", actor, "цель снята");
    return "цель сбора снята";
  }
  goal = {
    label: label.slice(0, 60),
    target: clean,
    raised: 0,
    deadline: Date.now() + Math.max(1, Math.min(120, days)) * DAY_MS,
    paidAt: 0,
  };
  dirty = true;
  persist(true);
  audit("donate", "goal-set", actor, `«${goal.label}» ${clean} ${DONATIONS.currency}`);
  return `цель «${goal.label}»: ${clean} ${DONATIONS.currency} до ${new Date(goal.deadline).toISOString().slice(0, 10)}`;
};

export const markDispute = (actor: string, target: Player, reason: string): string => {
  const meta = getMeta(target.id, target.name);
  meta.donBlockUntil = Date.now() + DONATIONS.disputeBlockDays * DAY_MS;
  meta.donBlockReason = reason.slice(0, 80) || "без указания причины";
  meta.updatedAt = Date.now();
  markDirty(target.id);
  applyTier(actor, target.id, target.name, "none", 0, `спорный платёж: ${reason}`.slice(0, 90));
  audit("donate", "dispute", target.name, `${reason} от ${actor}`);
  notifyAdmins(`[donate] спорный платёж у ${target.name}: тариф снят, блокировка выдач на ${DONATIONS.disputeBlockDays} дн. (${reason})`);
  try {
    target.sendMessage(t(target, "don.dispute.marked", { days: DONATIONS.disputeBlockDays }));
  } catch (error) {
    log.debug("donate", `dispute: ${String(error)}`);
  }
  return t(target, "don.dispute.marked", { days: DONATIONS.disputeBlockDays });
};

export const clearDispute = (actor: string, target: Player): string => {
  const meta = getMeta(target.id, target.name);
  meta.donBlockUntil = 0;
  meta.donBlockReason = "";
  meta.updatedAt = Date.now();
  markDirty(target.id);
  audit("donate", "dispute-clear", target.name, `от ${actor}`);
  return t(target, "don.dispute.cleared");
};

export const disputeLines = (): string[] => {
  const now = Date.now();
  const rows = Object.entries(allMeta())
    .filter(([, meta]) => meta.donBlockUntil > now)
    .map(([id, meta]) => `${meta.name} (${id.slice(0, 8)}): до ${new Date(meta.donBlockUntil).toISOString().slice(0, 10)} — ${meta.donBlockReason || "—"}`);
  if (rows.length === 0) return ["спорных платежей нет"];
  return rows.slice(0, 12);
};

export const goalReport = (): string[] => {
  const lines = [`цель: ${goal.target > 0 ? `«${goal.label}» ${goal.raised}/${goal.target} ${DONATIONS.currency}` : "не назначена"}`];
  if (goal.paidAt > 0) lines.push(`выплата: ${new Date(goal.paidAt).toISOString().slice(0, 16).replace("T", " ")}`);
  lines.push(`чеков: ${receiptsCount()}`);
  return lines;
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
