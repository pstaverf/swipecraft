import { Player, world } from "@minecraft/server";
import { t } from "../kernel/i18n";
import { log } from "../kernel/logger";
import { audit } from "../security/audit";
import { loadWorldJson, saveWorldJson } from "../kernel/store";
import { COSMETICS, COSMETIC_CASE, DONATIONS, META_KEYS } from "./config";
import type { ProgressResult } from "./progress";
import { markDirty } from "./balances";
import { burn, metaOf, refundBurn } from "./economy";
import "./messages";
import type { CosmeticDef, CosmeticKind, Rarity, ReceiptRow } from "../types/domain";

const KINDS: CosmeticKind[] = ["trail", "prefix", "suffix", "join"];

let receipts: ReceiptRow[] = [];
let receiptsDirty = false;

const byId = new Map<string, CosmeticDef>(COSMETICS.map((row) => [row.id, row]));

const rarityColor = (rarity: Rarity): string =>
  rarity === "legendary" ? "§6" : rarity === "epic" ? "§5" : rarity === "rare" ? "§b" : "§f";

export const cosmeticCatalog = (): CosmeticDef[] => COSMETICS;

export const cosmeticById = (id: string): CosmeticDef | undefined => byId.get(id);

export const cosmeticsOf = (player: Player) => {
  const meta = metaOf(player);
  if (!meta.cosmetics || typeof meta.cosmetics !== "object") {
    meta.cosmetics = { owned: [], rolls: 0, equipped: { trail: "", prefix: "", suffix: "", join: "" } };
  }
  const state = meta.cosmetics;
  state.owned = Array.isArray(state.owned) ? state.owned.filter((id: string) => byId.has(id)) : [];
  state.rolls = Number.isFinite(state.rolls) ? Math.max(0, Math.floor(state.rolls)) : 0;
  if (!state.equipped || typeof state.equipped !== "object") state.equipped = { trail: "", prefix: "", suffix: "", join: "" };
  for (const kind of KINDS) {
    const value = state.equipped[kind];
    if (typeof value !== "string" || (value.length > 0 && !state.owned.includes(value))) state.equipped[kind] = "";
  }
  return state;
};

export const donorPrefix = (player: Player): string => {
  const meta = metaOf(player);
  if (meta.donorTier === "none" || meta.donorUntil <= Date.now()) return "";
  return DONATIONS.tiers[meta.donorTier]?.prefix ?? "";
};

export const ownsCosmetic = (player: Player, id: string): boolean => cosmeticsOf(player).owned.includes(id);

export const equippedValue = (player: Player, kind: CosmeticKind): string => {
  const id = cosmeticsOf(player).equipped[kind];
  if (id.length === 0) return "";
  return byId.get(id)?.value ?? "";
};

export const identityName = (player: Player): string => {
  const prefix = `${donorPrefix(player)}${equippedValue(player, "prefix")}`;
  const suffix = equippedValue(player, "suffix");
  if (prefix.length === 0 && suffix.length === 0) return player.name;
  return `${prefix}${player.name}${suffix}§r`;
};

export const applyIdentity = (player: Player): void => {
  try {
    const wanted = identityName(player);
    if (player.nameTag !== wanted) player.nameTag = wanted;
  } catch (error) {
    log.debug("cosmetics", `nameTag: ${String(error)}`);
  }
};

export const trailFor = (player: Player): string => {
  const custom = equippedValue(player, "trail");
  if (custom.length > 0) return custom;
  const meta = metaOf(player);
  if (meta.donorTier !== "none" && meta.donorUntil > Date.now() && DONATIONS.tiers[meta.donorTier]?.particles) {
    return DONATIONS.trailParticle;
  }
  return "";
};

export const spawnTrail = (player: Player): boolean => {
  const id = trailFor(player);
  if (id.length === 0) return false;
  const spot = { x: player.location.x, y: player.location.y + 0.4, z: player.location.z };
  try {
    player.dimension.spawnParticle(id, spot);
    return true;
  } catch {
    try {
      player.dimension.spawnParticle(DONATIONS.trailFallbackParticle, spot);
      return true;
    } catch (error) {
      log.debug("cosmetics", `trail: ${String(error)}`);
      return false;
    }
  }
};

export const announceJoin = (player: Player): void => {
  const template = equippedValue(player, "join");
  if (template.length === 0) return;
  try {
    world.sendMessage(template.replace("{name}", player.name));
  } catch (error) {
    log.debug("cosmetics", `join: ${String(error)}`);
  }
};

export const addReceipt = (playerId: string, name: string, item: string, via: ReceiptRow["via"], amount: number, by: string): void => {
  receipts.push({ t: Date.now(), playerId, name, item, via, amount, by });
  if (receipts.length > DONATIONS.receiptsMax) receipts = receipts.slice(-DONATIONS.receiptsMax);
  receiptsDirty = true;
  persistReceipts();
};

const persistReceipts = (): void => {
  if (!receiptsDirty) return;
  saveWorldJson(META_KEYS.donReceipts, receipts);
  receiptsDirty = false;
};

export const loadCosmetics = (): number => {
  const stored = loadWorldJson<ReceiptRow[] | undefined>(META_KEYS.donReceipts, undefined);
  receipts = Array.isArray(stored) ? stored.filter((row) => !!row && typeof row.playerId === "string").slice(-DONATIONS.receiptsMax) : [];
  return receipts.length;
};

export const flushCosmetics = (): void => {
  persistReceipts();
};

export const spawnTrailFor = (player: Player): boolean => spawnTrail(player);

export const receiptsFor = (playerId: string): ReceiptRow[] => receipts.filter((row) => row.playerId === playerId);

export const receiptsCount = (): number => receipts.length;

export const purchaseHistory = (player: Player): string[] => {
  const rows = receipts.filter((row) => row.playerId === player.id).slice(-12).reverse();
  if (rows.length === 0) return [t(player, "cos.history.empty")];
  return rows.map((row) => {
    const date = new Date(row.t).toISOString().slice(0, 16).replace("T", " ");
    return `${date} · ${row.item} · ${t(player, `cos.via.${row.via}`)}${row.amount > 0 ? ` (${row.amount} ₡)` : ""}${row.by.length > 0 ? ` · ${row.by}` : ""}`;
  });
};

export const catalogLines = (player: Player): string[] => {
  const state = cosmeticsOf(player);
  const lines: string[] = [t(player, "cos.body", { coins: state.rolls, price: COSMETIC_CASE.priceCoins })];
  for (const kind of KINDS) {
    const rows = COSMETICS.filter((row) => row.kind === kind);
    lines.push("");
    lines.push(t(player, `cos.kind.${kind}`));
    for (const row of rows) {
      const owned = state.owned.includes(row.id);
      const equipped = state.equipped[kind] === row.id;
      lines.push(
        equipped
          ? `§a✓ ${row.label}§7 (${row.rarity})`
          : owned
            ? `§e• ${row.label}§7 (${row.rarity}) — ${t(player, "cos.owned")}`
            : `§f· ${row.label}§7 (${row.rarity}) — ${row.priceCoins} ₡`,
      );
    }
  }
  return lines;
};

export const buyCosmetic = (player: Player, id: string): ProgressResult => {
  const def = byId.get(id);
  if (!def) return { ok: false, key: "cos.unknown" };
  const state = cosmeticsOf(player);
  if (state.owned.includes(id)) return { ok: false, key: "cos.alreadyOwned" };
  const paid = burn(player, def.priceCoins, `cosmetic ${id}`);
  if (!paid.ok) return { ok: false, key: paid.key, params: paid.params };
  state.owned.push(id);
  state.equipped[def.kind] = id;
  markDirty(player.id);
  addReceipt(player.id, player.name, def.label, "coins", def.priceCoins, "");
  applyIdentity(player);
  audit("cosmetics", "buy", player.name, `${id} за ${def.priceCoins} ₡`);
  return { ok: true, key: "cos.bought", params: { label: def.label, price: def.priceCoins } };
};

const rollOne = (): CosmeticDef | undefined => {
  const total = COSMETICS.reduce((sum, row) => sum + row.weight, 0);
  if (total <= 0) return undefined;
  let value = Math.random() * total;
  for (const row of COSMETICS) {
    value -= row.weight;
    if (value <= 0) return row;
  }
  return COSMETICS[COSMETICS.length - 1];
};

export const rollCosmetics = (player: Player, count: number, useRolls: boolean): ProgressResult & { lines?: string[] } => {
  const pulls = Math.max(1, Math.min(Math.floor(count), COSMETIC_CASE.maxRollsPerCall));
  const state = cosmeticsOf(player);
  let paid = 0;
  if (useRolls) {
    if (state.rolls < pulls) return { ok: false, key: "cos.roll.missing", params: { need: pulls, have: state.rolls } };
  } else {
    paid = COSMETIC_CASE.priceCoins * pulls;
    const burned = burn(player, paid, `${COSMETIC_CASE.id} x${pulls}`);
    if (!burned.ok) return { ok: false, key: burned.key, params: burned.params };
  }
  const lines: string[] = [];
  let refunds = 0;
  for (let index = 0; index < pulls; index += 1) {
    const def = rollOne();
    if (!def) continue;
    if (state.owned.includes(def.id)) {
      const refund = Math.round((COSMETIC_CASE.priceCoins * COSMETIC_CASE.duplicateRefundPercent) / 100);
      refunds += refund;
      lines.push(`§7${def.label} — ${t(player, "cos.duplicate")}`);
      continue;
    }
    state.owned.push(def.id);
    if (state.equipped[def.kind].length === 0) state.equipped[def.kind] = def.id;
    lines.push(`${rarityColor(def.rarity)}${def.label}`);
    addReceipt(player.id, player.name, def.label, useRolls ? "roll" : "coins", useRolls ? 0 : COSMETIC_CASE.priceCoins, "");
  }
  if (useRolls) state.rolls -= pulls;
  if (refunds > 0) {
    refundBurn(player, refunds, "дубликат косметики");
    lines.push(`§a+${refunds} ₡ ${t(player, "cos.refund")}`);
    addReceipt(player.id, player.name, t(player, "cos.refund"), "refund", refunds, "");
  }
  state.rolls = Math.max(0, state.rolls);
  metaOf(player).updatedAt = Date.now();
  markDirty(player.id);
  applyIdentity(player);
  return {
    ok: true,
    key: "cos.roll.result",
    params: { count: pulls, paid: useRolls ? 0 : paid },
    lines,
  };
};

export const grantRolls = (player: Player, count: number, reason: string): number => {
  const clean = Math.max(0, Math.floor(count));
  if (clean === 0) return 0;
  const state = cosmeticsOf(player);
  state.rolls += clean;
  metaOf(player).updatedAt = Date.now();
  markDirty(player.id);
  addReceipt(player.id, player.name, `${t(player, "cos.roll.grant")} x${clean}`, "gift", 0, reason);
  return clean;
};

export const grantCosmetic = (actor: string, player: Player, id: string): ProgressResult => {
  const def = byId.get(id);
  if (!def) return { ok: false, key: "cos.unknown" };
  const state = cosmeticsOf(player);
  if (state.owned.includes(id)) return { ok: false, key: "cos.alreadyOwned" };
  state.owned.push(id);
  state.equipped[def.kind] = id;
  metaOf(player).updatedAt = Date.now();
  markDirty(player.id);
  addReceipt(player.id, player.name, def.label, "gift", 0, actor);
  applyIdentity(player);
  audit("cosmetics", "grant", player.name, `${id} от ${actor}`);
  return { ok: true, key: "cos.granted", params: { label: def.label } };
};

export const equipCosmetic = (player: Player, kind: CosmeticKind, id: string): ProgressResult => {
  if (!KINDS.includes(kind)) return { ok: false, key: "cos.unknown" };
  const state = cosmeticsOf(player);
  if (id.length > 0) {
    const def = byId.get(id);
    if (!def || def.kind !== kind) return { ok: false, key: "cos.unknown" };
    if (!state.owned.includes(id)) return { ok: false, key: "cos.notOwned" };
  }
  state.equipped[kind] = id;
  metaOf(player).updatedAt = Date.now();
  markDirty(player.id);
  applyIdentity(player);
  return { ok: true, key: "cos.equipped", params: { kind: t(player, `cos.kind.${kind}`), label: id.length === 0 ? t(player, "cos.none") : byId.get(id)?.label ?? id } };
};

export const cosmeticsReport = (): string[] => [
  `предметов в каталоге: ${COSMETICS.length}, чеков в истории: ${receipts.length}/${DONATIONS.receiptsMax}`,
  `цена кейса: ${COSMETIC_CASE.priceCoins} ₡, возврат за дубликат: ${COSMETIC_CASE.duplicateRefundPercent}%`,
  `донатные подарки: ${Object.entries(DONATIONS.tiers).filter(([tier]) => tier !== "none").map(([tier, row]) => `${tier}=${row.giftRolls}`).join(" ")}`,
];

