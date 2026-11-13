import { Player, world } from "@minecraft/server";
import { t } from "../kernel/i18n";
import { log } from "../kernel/logger";
import { loadWorldJson, saveWorldJson } from "../kernel/store";
import { clamp } from "../kernel/util";
import { audit } from "../security/audit";
import { effectivePlaySeconds, getProfile } from "./profiles";
import { flushBalances, getMeta, markDirty } from "./balances";
import { CURRENCY, DEFAULT_ECO_TUNABLES, META_KEYS, TRANSFERS } from "./config";
import "./messages";
import type { EcoLedger, EcoTunables, PlayerMeta, TxRecord } from "../types/domain";

export interface MoneyResult {
  ok: boolean;
  key: string;
  params?: Record<string, string | number>;
}

const DAY_MS = 86_400_000;
const TX_LIMIT = 400;
const FRESH_WINDOW_MS = 48 * 60 * 60 * 1000;

let tunables: EcoTunables = { ...DEFAULT_ECO_TUNABLES };
let ledger: EcoLedger = { accounts: {}, minted: 0, burned: 0, fees: 0, day: 0, mintToday: 0, txCount: 0 };
let txLog: TxRecord[] = [];
let ledgerDirty = false;
let initialized = false;

const today = (): number => Math.floor(Date.now() / DAY_MS);

export const getTunables = (): EcoTunables => tunables;

export const circulation = (): number => Math.max(0, ledger.minted - ledger.burned);

export const metaOf = (player: Player): PlayerMeta => {
  const record = getMeta(player.id, player.name);
  const profile = getProfile(player);
  if (record.joinedAt !== profile.joinedAt) record.joinedAt = profile.joinedAt;
  if (record.banned !== profile.banned) record.banned = profile.banned;
  const seconds = effectivePlaySeconds(player);
  if (Math.abs(record.playSeconds - seconds) >= 30) record.playSeconds = seconds;
  return record;
};

const persist = (): void => {
  flushBalances();
  if (ledgerDirty) {
    saveWorldJson(META_KEYS.ledger, ledger);
    saveWorldJson(META_KEYS.tx, txLog);
    ledgerDirty = false;
  }
};

export const priceMultiplier = (): number => {
  const target = CURRENCY.targetCirculation;
  const ratio = target <= 0 ? 1 : circulation() / target;
  if (ratio <= 1) return CURRENCY.multiplierCap;
  return clamp(CURRENCY.multiplierCap - (ratio - 1) * 0.6, CURRENCY.multiplierFloor, CURRENCY.multiplierCap);
};

export const sellPrice = (typeId: string): number => {
  const base = CURRENCY.sellPrices[typeId];
  if (base === undefined) return 0;
  return Math.max(1, Math.round(base * priceMultiplier()));
};

export const balance = (player: Player): number => metaOf(player).coins;

export const lockedBalance = (player: Player): number => metaOf(player).lockedCoins;

const resetDaily = (meta: PlayerMeta): void => {
  const day = today();
  if (meta.mintDay !== day) {
    meta.mintDay = day;
    meta.mintToday = 0;
  }
  if (meta.receiveDay !== day) {
    meta.receiveDay = day;
    meta.receiveToday = 0;
    meta.pair = {};
    meta.pairDay = day;
  }
  if (meta.soldDay !== day) {
    meta.soldDay = day;
    meta.sold = {};
  }
};

const recordTx = (from: string, to: string, amount: number, fee: number, kind: string): void => {
  txLog.push({ t: Date.now(), from, to, amount, fee, kind });
  if (txLog.length > TX_LIMIT) txLog = txLog.slice(-TX_LIMIT);
  ledger.txCount += 1;
  ledgerDirty = true;
};

export const mint = (player: Player, amount: number, reason: string): MoneyResult =>
  mintToId(player.id, player.name, amount, reason);

export const mintToId = (playerId: string, playerName: string, amount: number, reason: string): MoneyResult => {
  const clean = Math.floor(amount);
  if (!Number.isFinite(clean) || clean <= 0) return { ok: false, key: "eco.amount.invalid" };
  const meta = getMeta(playerId, playerName);
  resetDaily(meta);
  const day = today();
  if (ledger.day !== day) {
    ledger.day = day;
    ledger.mintToday = 0;
  }
  const left = tunables.mintCapPerDay - meta.mintToday;
  if (left <= 0) return { ok: false, key: "eco.mint.capped" };
  const granted = Math.min(clean, left);
  if (meta.coins + granted > CURRENCY.maxBalance) {
    markDirty(playerId);
    persist();
    return { ok: false, key: "eco.balance.max", params: { max: CURRENCY.maxBalance } };
  }
  meta.coins += granted;
  meta.mintToday += granted;
  meta.updatedAt = Date.now();
  ledger.minted += granted;
  ledger.mintToday += granted;
  ledgerDirty = true;
  markDirty(playerId);
  persist();
  audit("economy", "mint", meta.name, `${granted} ${reason}`);
  if (granted < clean) return { ok: true, key: "eco.mint.partial", params: { granted, asked: clean, cap: tunables.mintCapPerDay } };
  return { ok: true, key: "eco.mint.ok", params: { amount: granted } };
};

export const burn = (player: Player, amount: number, reason: string): MoneyResult => {
  const clean = Math.floor(amount);
  if (!Number.isFinite(clean) || clean <= 0) return { ok: false, key: "eco.amount.invalid" };
  const meta = metaOf(player);
  if (meta.coins < clean) return { ok: false, key: "eco.balance.low", params: { need: clean, have: meta.coins } };
  meta.coins -= clean;
  meta.updatedAt = Date.now();
  ledger.burned += clean;
  ledgerDirty = true;
  markDirty(player.id);
  persist();
  audit("economy", "burn", player.name, `${clean} ${reason}`);
  return { ok: true, key: "eco.burn.ok", params: { amount: clean } };
};

export const spend = (player: Player, amount: number, reason: string): MoneyResult => burn(player, amount, reason);

export const refundBurn = (player: Player, amount: number, reason: string): MoneyResult => {
  const clean = Math.floor(amount);
  if (!Number.isFinite(clean) || clean <= 0) return { ok: false, key: "eco.amount.invalid" };
  const meta = metaOf(player);
  const target = Math.min(CURRENCY.maxBalance, meta.coins + clean);
  const credited = target - meta.coins;
  if (credited <= 0) return { ok: false, key: "eco.balance.max", params: { max: CURRENCY.maxBalance } };
  meta.coins = target;
  meta.updatedAt = Date.now();
  ledger.burned = Math.max(0, ledger.burned - credited);
  ledgerDirty = true;
  markDirty(player.id);
  persist();
  audit("economy", "refund", meta.name, `${credited} ${reason}`);
  return { ok: true, key: "eco.refund.ok", params: { amount: credited } };
};

export const accountBalance = (accountId: string): number => ledger.accounts[accountId]?.coins ?? 0;

export const accountLabel = (accountId: string): string => ledger.accounts[accountId]?.name ?? accountId;

const ensureAccount = (accountId: string, name: string): void => {
  const existing = ledger.accounts[accountId];
  if (existing) {
    if (name.length > 0 && existing.name !== name) existing.name = name;
    return;
  }
  ledger.accounts[accountId] = { name: name.length > 0 ? name : accountId, coins: 0 };
  ledgerDirty = true;
};

export const depositToAccount = (player: Player, accountId: string, accountName: string, amount: number): MoneyResult => {
  const clean = Math.floor(amount);
  if (!Number.isFinite(clean) || clean <= 0) return { ok: false, key: "eco.amount.invalid" };
  const meta = metaOf(player);
  if (meta.coins < clean) return { ok: false, key: "eco.balance.low", params: { need: clean, have: meta.coins } };
  ensureAccount(accountId, accountName);
  meta.coins -= clean;
  meta.updatedAt = Date.now();
  ledger.accounts[accountId].coins += clean;
  ledgerDirty = true;
  markDirty(player.id);
  persist();
  recordTx(player.name, `счёт:${accountLabel(accountId)}`, clean, 0, "deposit");
  audit("economy", "deposit", accountLabel(accountId), `${clean} от ${player.name}`);
  return { ok: true, key: "eco.deposit.ok", params: { amount: clean, account: accountLabel(accountId) } };
};

export const withdrawFromAccount = (player: Player, accountId: string, amount: number): MoneyResult => {
  const clean = Math.floor(amount);
  const account = ledger.accounts[accountId];
  if (!Number.isFinite(clean) || clean <= 0) return { ok: false, key: "eco.amount.invalid" };
  if (!account || account.coins < clean) return { ok: false, key: "eco.account.low", params: { have: account?.coins ?? 0 } };
  const meta = metaOf(player);
  if (meta.coins + clean > CURRENCY.maxBalance) return { ok: false, key: "eco.balance.max", params: { max: CURRENCY.maxBalance } };
  account.coins -= clean;
  meta.coins += clean;
  meta.updatedAt = Date.now();
  ledgerDirty = true;
  markDirty(player.id);
  persist();
  recordTx(`счёт:${account.name}`, player.name, clean, 0, "withdraw");
  audit("economy", "withdraw", account.name, `${clean} игроку ${player.name}`);
  return { ok: true, key: "eco.withdraw.ok", params: { amount: clean, account: account.name } };
};

export const burnAccount = (accountId: string, amount: number, reason: string): boolean => {
  const account = ledger.accounts[accountId];
  const clean = Math.floor(amount);
  if (!account || !Number.isFinite(clean) || clean <= 0 || account.coins < clean) return false;
  account.coins -= clean;
  ledger.burned += clean;
  ledger.fees += clean;
  ledgerDirty = true;
  persist();
  audit("economy", "burn-account", account.name, `${clean} ${reason}`);
  return true;
};

export const transferBetweenAccounts = (fromId: string, toId: string, amount: number, fee: number): boolean => {
  const from = ledger.accounts[fromId];
  const clean = Math.floor(amount);
  const burn = Math.max(0, Math.floor(fee));
  if (!from || !Number.isFinite(clean) || clean <= 0 || from.coins < clean + burn) return false;
  ensureAccount(toId, "");
  from.coins -= clean + burn;
  ledger.accounts[toId].coins += clean;
  if (burn > 0) {
    ledger.burned += burn;
    ledger.fees += burn;
  }
  ledgerDirty = true;
  persist();
  audit("economy", "account-move", `${from.name}->${ledger.accounts[toId].name}`, `${clean} (сбор ${burn})`);
  return true;
};

export const accountsReport = (): string[] =>
  Object.entries(ledger.accounts)
    .filter(([, account]) => account.coins > 0)
    .sort((left, right) => right[1].coins - left[1].coins)
    .slice(0, 12)
    .map(([id, account]) => `${account.name} (${id}): ${account.coins}`);

export const payToId = (from: Player, toId: string, toName: string, amount: number, fee: number, kind: string): MoneyResult => {
  const clean = Math.floor(amount);
  const burnFee = Math.max(0, Math.floor(fee));
  if (!Number.isFinite(clean) || clean <= 0) return { ok: false, key: "eco.amount.invalid" };
  if (from.id === toId) return { ok: false, key: "eco.transfer.self" };
  const fromMeta = metaOf(from);
  resetDaily(fromMeta);
  const toMeta = getMeta(toId, toName);
  resetDaily(toMeta);
  if (toMeta.banned) return { ok: false, key: "eco.transfer.banned" };
  if (fromMeta.coins < clean + burnFee) return { ok: false, key: "eco.balance.low", params: { need: clean + burnFee, have: fromMeta.coins } };
  if (toMeta.receiveToday + clean > tunables.maxReceivePerDay) {
    return { ok: false, key: "eco.receive.capped", params: { left: Math.max(0, tunables.maxReceivePerDay - toMeta.receiveToday) } };
  }
  const pairUsed = Math.max(fromMeta.pair[toId] ?? 0, toMeta.pair[from.id] ?? 0);
  if (pairUsed + clean > tunables.maxPerPairPerDay) {
    return { ok: false, key: "eco.pair.capped", params: { left: Math.max(0, tunables.maxPerPairPerDay - pairUsed) } };
  }
  if (toMeta.coins + clean > CURRENCY.maxBalance) return { ok: false, key: "eco.balance.max", params: { max: CURRENCY.maxBalance } };
  const fresh = Date.now() - toMeta.joinedAt < FRESH_WINDOW_MS || toMeta.playSeconds < tunables.minPlaySecondsForTransfers;
  fromMeta.coins -= clean + burnFee;
  fromMeta.pair[toId] = (fromMeta.pair[toId] ?? 0) + clean;
  toMeta.pair[from.id] = (toMeta.pair[from.id] ?? 0) + clean;
  toMeta.receiveToday += clean;
  if (fresh) {
    toMeta.lockedCoins += clean;
    toMeta.lockedUntil = Date.now() + TRANSFERS.holdHours * 3_600_000;
  } else {
    toMeta.coins += clean;
  }
  fromMeta.updatedAt = Date.now();
  toMeta.updatedAt = Date.now();
  if (burnFee > 0) {
    ledger.burned += burnFee;
    ledger.fees += burnFee;
  }
  ledgerDirty = true;
  markDirty(from.id);
  markDirty(toId);
  persist();
  recordTx(from.name, toMeta.name, clean, burnFee, kind);
  audit("economy", kind, `${from.name}->${toMeta.name}`, `${clean}${burnFee > 0 ? ` + сбор ${burnFee}` : ""}${fresh ? ` (hold ${TRANSFERS.holdHours}ч)` : ""}`);
  return {
    ok: true,
    key: fresh ? "eco.transfer.held" : "eco.transfer.ok",
    params: { amount: clean, fee: burnFee, to: toMeta.name, hours: TRANSFERS.holdHours },
  };
};

export const canTransfer = (from: Player, to: Player, amount: number): MoneyResult => {
  const clean = Math.floor(amount);
  if (!Number.isFinite(clean) || clean <= 0) return { ok: false, key: "eco.amount.invalid" };
  if (from.id === to.id) return { ok: false, key: "eco.transfer.self" };
  if (clean < TRANSFERS.minAmount) return { ok: false, key: "eco.transfer.min", params: { min: TRANSFERS.minAmount } };
  if (clean > tunables.maxTransferPerTx) return { ok: false, key: "eco.transfer.max", params: { max: tunables.maxTransferPerTx } };
  const fromMeta = metaOf(from);
  const now = Date.now();
  if (now - fromMeta.lastTransferAt < TRANSFERS.cooldownMs) {
    return { ok: false, key: "eco.transfer.cooldown", params: { seconds: Math.ceil((TRANSFERS.cooldownMs - (now - fromMeta.lastTransferAt)) / 1000) } };
  }
  const profileFrom = getProfile(from);
  const profileTo = getProfile(to);
  if (profileFrom.banned || profileTo.banned) return { ok: false, key: "eco.transfer.banned" };
  if (now - profileFrom.joinedAt < tunables.minAccountAgeHours * 3_600_000) {
    return { ok: false, key: "eco.transfer.age", params: { hours: tunables.minAccountAgeHours } };
  }
  if (effectivePlaySeconds(from) < tunables.minPlaySecondsForTransfers) {
    return { ok: false, key: "eco.transfer.playtime", params: { minutes: Math.round(tunables.minPlaySecondsForTransfers / 60) } };
  }
  return { ok: true, key: "eco.transfer.ready", params: { amount: clean } };
};

export const transfer = (from: Player, to: Player, amount: number): MoneyResult => {
  const check = canTransfer(from, to, amount);
  if (!check.ok) return check;
  const clean = Math.floor(amount);
  const fee = Math.max(1, Math.round((clean * tunables.transferFeePercent) / 100));
  const result = payToId(from, to.id, to.name, clean, fee, "transfer");
  if (result.ok) {
    const meta = metaOf(from);
    meta.lastTransferAt = Date.now();
    markDirty(from.id);
    persist();
  }
  return result;
};

export const releaseLocked = (player: Player): number => {
  const meta = metaOf(player);
  if (meta.lockedCoins <= 0) return 0;
  if (meta.lockedUntil > Date.now()) return 0;
  const released = meta.lockedCoins;
  meta.coins = Math.min(CURRENCY.maxBalance, meta.coins + released);
  meta.lockedCoins = 0;
  meta.lockedUntil = 0;
  meta.updatedAt = Date.now();
  markDirty(player.id);
  persist();
  audit("economy", "unlock", player.name, String(released));
  return released;
};

export const grantKeys = (player: Player, count: number, reason: string): void => {
  const meta = metaOf(player);
  meta.caseKeys += Math.max(0, Math.floor(count));
  meta.updatedAt = Date.now();
  markDirty(player.id);
  persist();
  audit("economy", "keys", player.name, `+${Math.floor(count)} ${reason}`);
};

export const payKeys = (player: Player, count: number): boolean => {
  const meta = metaOf(player);
  if (meta.caseKeys < count) return false;
  meta.caseKeys -= count;
  meta.updatedAt = Date.now();
  markDirty(player.id);
  persist();
  return true;
};

export const heldItem = (player: Player): { slot: number; containerIndex: number } | undefined => {
  try {
    const inventory = player.getComponent("minecraft:inventory");
    const container = inventory?.container;
    if (!container) return undefined;
    const slot = clamp(Math.floor(container.size > 0 ? player.selectedSlotIndex : 0), 0, container.size - 1);
    return { slot, containerIndex: slot };
  } catch (error) {
    log.error("eco", `слот инвентаря: ${String(error)}`);
    return undefined;
  }
};

export const sellHeld = (player: Player, amount: number): MoneyResult => {
  const held = heldItem(player);
  if (!held) return { ok: false, key: "eco.sell.empty" };
  let stack;
  try {
    const container = player.getComponent("minecraft:inventory")?.container;
    stack = container?.getItem(held.slot);
  } catch (error) {
    log.error("eco", `чтение слота: ${String(error)}`);
    return { ok: false, key: "eco.sell.empty" };
  }
  if (!stack) return { ok: false, key: "eco.sell.empty" };
  const typeId = stack.typeId;
  const price = sellPrice(typeId);
  if (price <= 0) return { ok: false, key: "eco.sell.unknown", params: { item: typeId.replace("minecraft:", "") } };
  const meta = metaOf(player);
  resetDaily(meta);
  const soldToday = meta.sold[typeId] ?? 0;
  const volumeCap = 640;
  if (soldToday >= volumeCap) return { ok: false, key: "eco.sell.volume" };
  const clean = clamp(Math.floor(amount), 1, Math.min(stack.amount, volumeCap - soldToday));
  const total = price * clean;
  const before = meta.coins;
  const result = mint(player, total, `продажа ${typeId.replace("minecraft:", "")} x${clean}`);
  if (!result.ok) return result;
  const credited = meta.coins - before;
  const items = credited <= 0 ? 0 : Math.max(1, Math.min(clean, Math.floor(credited / price)));
  meta.sold[typeId] = soldToday + items;
  try {
    const container = player.getComponent("minecraft:inventory")?.container;
    if (!container) throw new Error("нет контейнера");
    const current = container.getItem(held.slot);
    if (!current) throw new Error("слот пуст");
    if (current.amount > items) {
      const rest = current.clone();
      rest.amount = current.amount - items;
      container.setItem(held.slot, rest);
    } else {
      container.setItem(held.slot, undefined);
    }
  } catch (error) {
    log.error("eco", `списание при продаже: ${String(error)}`);
    burn(player, credited, "откат продажи");
    return { ok: false, key: "eco.sell.failed" };
  }
  meta.updatedAt = Date.now();
  markDirty(player.id);
  persist();
  return { ok: true, key: "eco.sell.ok", params: { amount: items, item: typeId.replace("minecraft:", ""), total: price * items, left: Math.max(0, volumeCap - items - soldToday) } };
};

type NumericTunable = Exclude<keyof EcoTunables, "queueEnabled">;

const NUMERIC_PARAMS: NumericTunable[] = [
  "transferFeePercent",
  "marketCommissionPercent",
  "mintCapPerDay",
  "maxTransferPerTx",
  "maxReceivePerDay",
  "maxPerPairPerDay",
  "minPlaySecondsForTransfers",
  "minAccountAgeHours",
  "clanMaxMembers",
  "marketTtlDays",
  "casePricePercent",
  "queueSoftCap",
  "queueReleaseAt",
];

const normalizeTunables = (stored: Partial<EcoTunables> | undefined): EcoTunables => {
  const merged: EcoTunables = { ...DEFAULT_ECO_TUNABLES };
  if (!stored) return merged;
  for (const key of NUMERIC_PARAMS) {
    const value = stored[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) merged[key] = value;
  }
  if (typeof stored.queueEnabled === "boolean") merged.queueEnabled = stored.queueEnabled;
  return merged;
};

export const saveTunables = (): void => {
  saveWorldJson(META_KEYS.tunables, tunables);
};

export const changeEcoParam = (path: string, value: string): { ok: boolean; message: string } => {
  if (path === "queueEnabled") {
    tunables.queueEnabled = value === "true" || value === "1";
    saveTunables();
    audit("admin", "eco-config", path, String(tunables.queueEnabled));
    return { ok: true, message: `queueEnabled=${tunables.queueEnabled}` };
  }
  if (!(NUMERIC_PARAMS as string[]).includes(path)) return { ok: false, message: `неизвестный параметр: ${path}` };
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return { ok: false, message: `нужно число >= 0, получено ${value}` };
  const target = tunables as unknown as Record<string, number>;
  target[path] = parsed;
  saveTunables();
  audit("admin", "eco-config", path, String(parsed));
  return { ok: true, message: `${path}=${parsed}` };
};

export const resetEcoConfig = (): void => {
  tunables = { ...DEFAULT_ECO_TUNABLES };
  saveTunables();
  audit("admin", "eco-config", "reset", "значения по умолчанию");
};

export const recentTx = (count: number): TxRecord[] => txLog.slice(-count);

export const txReport = (count: number): string[] =>
  recentTx(count).map((row) => {
    const time = new Date(row.t).toISOString().slice(11, 19);
    return `${time} ${row.from} -> ${row.to}: ${row.amount} (сбор ${row.fee}) ${row.kind}`;
  });

export const ecoSummary = (): string[] => [
  `циркуляция: ${circulation()} ${CURRENCY.symbol}`,
  `эмитировано: ${ledger.minted}, сожжено: ${ledger.burned} (сборы ${ledger.fees})`,
  `множитель цен продажи: x${priceMultiplier().toFixed(2)} (цель ${CURRENCY.targetCirculation})`,
  `эмитировано сегодня миром: ${ledger.mintToday}, лимит на игрока: ${tunables.mintCapPerDay}`,
  `комиссии: перевод ${tunables.transferFeePercent}%, рынок ${tunables.marketCommissionPercent}%`,
  `лимиты: перевод ${tunables.maxTransferPerTx}, приём/сутки ${tunables.maxReceivePerDay}, пара/сутки ${tunables.maxPerPairPerDay}`,
  `допуск: игра ${Math.round(tunables.minPlaySecondsForTransfers / 60)} мин, аккаунт ${tunables.minAccountAgeHours} ч`,
  `очередь входа: ${tunables.queueEnabled ? `вкл (кап ${tunables.queueSoftCap}, отпускание ${tunables.queueReleaseAt})` : "выкл"}`,
  `сделок всего: ${ledger.txCount}, в журнале: ${txLog.length}`,
];

export const walletLines = (player: Player): string[] => {
  const meta = metaOf(player);
  resetDaily(meta);
  const lines = [
    t(player, "eco.wallet.balance", { coins: meta.coins, symbol: CURRENCY.symbol, locked: meta.lockedCoins }),
    t(player, "eco.wallet.mint", { today: meta.mintToday, cap: tunables.mintCapPerDay }),
    t(player, "eco.wallet.receive", { today: meta.receiveToday, cap: tunables.maxReceivePerDay }),
    t(player, "eco.wallet.keys", { keys: meta.caseKeys, pulls: meta.casePulls, pity: meta.pity }),
    t(player, "eco.wallet.market", { multiplier: priceMultiplier().toFixed(2) }),
  ];
  return lines;
};

export const initEconomy = (): void => {
  if (initialized) return;
  initialized = true;
  tunables = normalizeTunables(loadWorldJson<Partial<EcoTunables> | undefined>(META_KEYS.tunables, undefined));
  const loadedLedger = loadWorldJson<EcoLedger | undefined>(META_KEYS.ledger, undefined);
  if (loadedLedger) {
    ledger = {
      accounts: loadedLedger.accounts && typeof loadedLedger.accounts === "object" ? loadedLedger.accounts : {},
      minted: Number(loadedLedger.minted) || 0,
      burned: Number(loadedLedger.burned) || 0,
      fees: Number(loadedLedger.fees) || 0,
      day: Number(loadedLedger.day) || 0,
      mintToday: Number(loadedLedger.mintToday) || 0,
      txCount: Number(loadedLedger.txCount) || 0,
    };
  }
  const storedTx = loadWorldJson<TxRecord[] | undefined>(META_KEYS.tx, undefined);
  txLog = Array.isArray(storedTx) ? storedTx.filter((row) => row && typeof row.amount === "number") : [];
  log.info("economy", `загружено: ${Object.keys(ledger.accounts).length} счетов, циркуляция ${circulation()}`);
};

export const flushEconomy = (): void => {
  persist();
};

export const unlockSweep = (): void => {
  for (const player of world.getAllPlayers()) {
    const meta = metaOf(player);
    if (meta.lockedCoins <= 0 || meta.lockedUntil > Date.now()) continue;
    const released = releaseLocked(player);
    if (released <= 0) continue;
    try {
      player.sendMessage(t(player, "eco.unlock", { coins: released }));
    } catch {
      continue;
    }
  }
};

export const syncAllBalances = (): void => {
  for (const player of world.getAllPlayers()) metaOf(player);
};
