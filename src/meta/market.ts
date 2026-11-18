import { ItemStack, Player, world } from "@minecraft/server";
import { EnchantmentType } from "@minecraft/server";
import { t } from "../kernel/i18n";
import { log } from "../kernel/logger";
import { loadWorldJson, saveWorldJson } from "../kernel/store";
import { clamp } from "../kernel/util";
import { CONFIG } from "../config";
import { audit, notifyAdmins } from "../security/audit";
import { FORBIDDEN_LISTINGS, MARKET, META_KEYS } from "./config";
import { getTunables, metaOf, payToId, sellPrice } from "./economy";
import { markDirty, peekMeta } from "./balances";
import { recordTrade } from "./progress";
import "./messages";
import type { Listing, SerializedItem } from "../types/domain";

const MAX_BYTES = 400_000;

let listings: Listing[] = [];
let dirty = false;

const idOf = (): string => `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

export interface MarketPreviewRow {
  slot: number;
  label: string;
  suggest: number;
  forbidden: boolean;
}

const containerOf = (player: Player) => {
  try {
    return player.getComponent("minecraft:inventory")?.container;
  } catch (error) {
    log.error("market", `инвентарь: ${String(error)}`);
    return undefined;
  }
};

export const isForbiddenItem = (typeId: string): boolean =>
  FORBIDDEN_LISTINGS.some((blocked) => typeId === blocked || typeId.startsWith("minecraft:shulker_box"));

export const serializeStack = (stack: ItemStack): SerializedItem | undefined => {
  if (isForbiddenItem(stack.typeId)) return undefined;
  const data: SerializedItem = { typeId: stack.typeId, amount: clamp(stack.amount, 1, stack.maxAmount) };
  try {
    if (typeof stack.nameTag === "string" && stack.nameTag.length > 0) data.nameTag = stack.nameTag;
  } catch {
    data.nameTag = undefined;
  }
  try {
    const lore = stack.getLore();
    if (lore.length > 0) data.lore = lore.slice(0, 6);
  } catch {
    data.lore = undefined;
  }
  try {
    const enchantable = stack.getComponent("minecraft:enchantable");
    const list = enchantable?.getEnchantments() ?? [];
    if (list.length > 0) {
      data.enchant = list.slice(0, 8).map((row) => ({ id: row.type.id, level: row.level }));
    }
  } catch {
    data.enchant = undefined;
  }
  if (JSON.stringify(data).length > 900) return undefined;
  return data;
};

export const deserializeItem = (data: SerializedItem): ItemStack | undefined => {
  if (!data || typeof data.typeId !== "string") return undefined;
  if (isForbiddenItem(data.typeId)) return undefined;
  let stack: ItemStack;
  try {
    stack = new ItemStack(data.typeId, clamp(Math.floor(data.amount), 1, 99));
  } catch (error) {
    log.error("market", `предмет ${data.typeId}: ${String(error)}`);
    return undefined;
  }
  try {
    if (data.amount > stack.maxAmount) stack.amount = stack.maxAmount;
  } catch {
    return stack;
  }
  try {
    if (data.nameTag) stack.nameTag = data.nameTag;
  } catch {
    void 0;
  }
  try {
    if (data.lore && data.lore.length > 0) stack.setLore(data.lore);
  } catch {
    void 0;
  }
  if (data.enchant && data.enchant.length > 0) {
    try {
      const enchantable = stack.getComponent("minecraft:enchantable");
      if (enchantable) {
        for (const row of data.enchant) {
          const type = new EnchantmentType(row.id);
          if (!type.id) continue;
          try {
            enchantable.addEnchantment({ type, level: clamp(Math.floor(row.level), 1, type.maxLevel || 1) });
          } catch {
            continue;
          }
        }
      }
    } catch (error) {
      log.debug("market", `зачарования ${data.typeId}: ${String(error)}`);
    }
  }
  return stack;
};

const persist = (force = false): void => {
  const bytes = JSON.stringify(listings).length;
  if (bytes > MAX_BYTES) {
    notifyAdmins(`[market] хранилище объявлений переполнено (${bytes} байт): новые объявления заблокированы`);
    return;
  }
  if (!dirty && !force) return;
  saveWorldJson(META_KEYS.market, listings);
  dirty = false;
};

export const loadMarket = (): number => {
  const stored = loadWorldJson<Listing[] | undefined>(META_KEYS.market, undefined);
  listings = Array.isArray(stored)
    ? stored.filter(
        (row): row is Listing =>
          !!row && typeof row.id === "string" && typeof row.price === "number" && !!row.item && typeof row.item.typeId === "string",
      )
    : [];
  return listings.length;
};

export const marketSizeBytes = (): number => JSON.stringify(listings).length;

export const openListings = (): Listing[] => listings.filter((row) => !row.expired);

export const listingsOf = (playerId: string): Listing[] => listings.filter((row) => row.sellerId === playerId);

export const findListing = (id: string): Listing | undefined => listings.find((row) => row.id === id);

export const marketStats = (): string[] => {
  const total = listings.reduce((sum, row) => sum + row.price, 0);
  const ttl = getTunables().marketTtlDays;
  return [
    `объявлений: ${listings.length}/${MARKET.maxListings}, активных: ${openListings().length}`,
    `сумма: ${total}, средний чек: ${listings.length > 0 ? Math.round(total / listings.length) : 0}`,
    `комиссия: ${getTunables().marketCommissionPercent}%, срок: ${ttl} дн.`,
    `байт в хранилище: ${marketSizeBytes()}/${MAX_BYTES}`,
  ];
};

export const inventoryPreview = (
  player: Player,
  limit: number,
): MarketPreviewRow[] => {
  const container = containerOf(player);
  if (!container) return [];
  const rows: MarketPreviewRow[] = [];
  const size = Math.min(container.size, 36);
  for (let slot = 0; slot < size; slot += 1) {
    let stack: ItemStack | undefined;
    try {
      stack = container.getItem(slot);
    } catch {
      stack = undefined;
    }
    if (!stack) continue;
    const serialized = isForbiddenItem(stack.typeId) ? undefined : serializeStack(stack);
    const hint = sellPrice(stack.typeId) * stack.amount;
    rows.push({
      slot,
      label: `${stack.typeId.replace("minecraft:", "")} x${stack.amount}${serialized ? "" : t(player, "mkt.cannot")}`,
      suggest: hint > 0 ? hint : MARKET.minPrice,
      forbidden: serialized === undefined,
    });
    if (rows.length >= limit) break;
  }
  return rows;
};

export interface ListingResult {
  ok: boolean;
  key: string;
  params?: Record<string, string | number>;
}

export const createListing = (player: Player, slot: number, amount: number, price: number): ListingResult => {
  const container = containerOf(player);
  if (!container) return { ok: false, key: "mkt.noContainer" };
  if (listings.length >= MARKET.maxListings) return { ok: false, key: "mkt.full" };
  if (listingsOf(player.id).length >= MARKET.maxPerSeller) return { ok: false, key: "mkt.perSeller", params: { max: MARKET.maxPerSeller } };
  const cleanPrice = Math.floor(price);
  if (!Number.isFinite(cleanPrice) || cleanPrice < MARKET.minPrice || cleanPrice > MARKET.maxPrice) {
    return { ok: false, key: "mkt.price.range", params: { min: MARKET.minPrice, max: MARKET.maxPrice } };
  }
  let stack: ItemStack | undefined;
  try {
    stack = container.getItem(slot);
  } catch (error) {
    log.error("market", `чтение слота: ${String(error)}`);
    return { ok: false, key: "mkt.slotError" };
  }
  if (!stack) return { ok: false, key: "mkt.emptySlot" };
  if (isForbiddenItem(stack.typeId)) return { ok: false, key: "mkt.forbidden" };
  const cleanAmount = clamp(Math.floor(amount), 1, stack.amount);
  const serialized = serializeStack(stack);
  if (!serialized) return { ok: false, key: "mkt.forbidden" };
  const data: SerializedItem = { ...serialized, amount: cleanAmount };
  try {
    if (stack.amount > cleanAmount) {
      const rest = stack.clone();
      rest.amount = stack.amount - cleanAmount;
      container.setItem(slot, rest);
    } else {
      container.setItem(slot, undefined);
    }
  } catch (error) {
    log.error("market", `списание: ${String(error)}`);
    return { ok: false, key: "mkt.takeFail" };
  }
  const now = Date.now();
  const listing: Listing = {
    id: idOf(),
    sellerId: player.id,
    sellerName: player.name,
    item: data,
    price: cleanPrice,
    createdAt: now,
    expiresAt: now + getTunables().marketTtlDays * 86_400_000,
    expired: false,
  };
  listings.push(listing);
  dirty = true;
  persist(true);
  audit("market", "list", player.name, `${data.typeId.replace("minecraft:", "")} x${cleanAmount} за ${cleanPrice} (${listing.id})`);
  return { ok: true, key: "mkt.created", params: { id: listing.id, item: data.typeId.replace("minecraft:", ""), amount: cleanAmount, price: cleanPrice } };
};

export const cancelListing = (player: Player, id: string): ListingResult => {
  const index = listings.findIndex((row) => row.id === id);
  if (index < 0) return { ok: false, key: "mkt.notFound" };
  const listing = listings[index];
  if (listing.sellerId !== player.id) return { ok: false, key: "mkt.notOwner" };
  const stack = deserializeItem(listing.item);
  const container = containerOf(player);
  if (stack && container) {
    const leftover = container.addItem(stack);
    if (leftover) {
      try {
        player.dimension.spawnItem(leftover, player.location);
      } catch (error) {
        log.error("market", `возврат: ${String(error)}`);
      }
    }
  }
  listings.splice(index, 1);
  dirty = true;
  persist(true);
  audit("market", "cancel", player.name, `${listing.item.typeId.replace("minecraft:", "")} (${listing.id})`);
  return { ok: true, key: "mkt.cancelled", params: { id: listing.id } };
};

export const buyListing = (buyer: Player, id: string): ListingResult => {
  const index = listings.findIndex((row) => row.id === id);
  if (index < 0) return { ok: false, key: "mkt.notFound" };
  const listing = listings[index];
  if (listing.expired) return { ok: false, key: "mkt.expired" };
  if (listing.sellerId === buyer.id) return { ok: false, key: "mkt.selfBuy" };
  const meta = metaOf(buyer);
  const commission = Math.max(1, Math.round((listing.price * getTunables().marketCommissionPercent) / 100));
  if (meta.coins < listing.price) return { ok: false, key: "eco.balance.low", params: { need: listing.price, have: meta.coins } };
  const result = payToId(buyer, listing.sellerId, listing.sellerName, listing.price - commission, commission, "market");
  if (!result.ok) return result;
  const stack = deserializeItem(listing.item);
  const container = containerOf(buyer);
  if (stack && container) {
    const leftover = container.addItem(stack);
    if (leftover) {
      try {
        buyer.dimension.spawnItem(leftover, buyer.location);
      } catch (error) {
        log.error("market", `выдача: ${String(error)}`);
      }
    }
  } else if (stack) {
    try {
      buyer.dimension.spawnItem(stack, buyer.location);
    } catch (error) {
      log.error("market", `спавн предмета: ${String(error)}`);
    }
  }
  listings.splice(index, 1);
  dirty = true;
  persist(true);
  markDirty(buyer.id);
  audit("market", "buy", `${buyer.name}<=${listing.sellerName}`, `${listing.item.typeId.replace("minecraft:", "")} x${listing.item.amount} за ${listing.price} (комиссия ${commission})`);
  recordTrade(buyer);
  notifyOfflineSeller(listing.sellerName, listing.id);
  return { ok: true, key: "mkt.bought", params: { item: listing.item.typeId.replace("minecraft:", ""), amount: listing.item.amount, price: listing.price, commission } };
};

const notifyOfflineSeller = (sellerName: string, listingId: string): void => {
  const online = world.getAllPlayers().some((player) => player.name === sellerName);
  if (online) return;
  notifyAdmins(`[market] продано офлайн-продавцу ${sellerName}, деньги на балансе (${listingId})`);
};

export const sweepMarket = (): number => {
  const now = Date.now();
  let changed = 0;
  for (const listing of listings) {
    if (listing.expired || listing.expiresAt > now) continue;
    listing.expired = true;
    changed += 1;
  }
  if (changed > 0) {
    dirty = true;
    persist();
  }
  return changed;
};

export const claimExpiredFor = (player: Player): number => {
  const mine = listings.filter((row) => row.sellerId === player.id && row.expired);
  if (mine.length === 0) return 0;
  const container = containerOf(player);
  let returned = 0;
  for (const listing of mine) {
    const stack = deserializeItem(listing.item);
    if (!stack) {
      listings = listings.filter((row) => row.id !== listing.id);
      returned += 1;
      continue;
    }
    if (container) {
      const leftover = container.addItem(stack);
      if (leftover) {
        try {
          player.dimension.spawnItem(leftover, player.location);
        } catch {
          continue;
        }
      }
    } else {
      try {
        player.dimension.spawnItem(stack, player.location);
      } catch {
        continue;
      }
    }
    listings = listings.filter((row) => row.id !== listing.id);
    returned += 1;
    audit("market", "expired-return", player.name, `${listing.item.typeId.replace("minecraft:", "")} x${listing.item.amount} (${listing.id})`);
  }
  if (returned > 0) {
    dirty = true;
    persist(true);
  }
  return returned;
};

export const marketPageSize = 10;

export const marketLines = (viewer: Player, page: number): string[] => {
  const open = openListings().sort((left, right) => left.price - right.price);
  const pages = Math.max(1, Math.ceil(open.length / marketPageSize));
  const current = clamp(page, 0, pages - 1);
  const slice = open.slice(current * marketPageSize, current * marketPageSize + marketPageSize);
  const lines = [t(viewer, "mkt.header", { page: current + 1, pages, count: open.length })];
  if (slice.length === 0) {
    lines.push(t(viewer, "mkt.none"));
    return lines;
  }
  for (const listing of slice) {
    lines.push(
      t(viewer, "mkt.line", {
        id: listing.id,
        item: listing.item.typeId.replace("minecraft:", ""),
        amount: listing.item.amount,
        flags: listing.item.enchant && listing.item.enchant.length > 0 ? t(viewer, "mkt.line.flags") : "",
        price: listing.price,
        seller: listing.sellerName,
        days: Math.max(0, Math.round((listing.expiresAt - Date.now()) / 86_400_000)),
      }),
    );
  }
  return lines;
};

export const marketSearch = (text: string): Listing[] => {
  const needle = text.trim().toLowerCase();
  if (needle.length === 0) return openListings();
  return openListings().filter(
    (row) => row.item.typeId.toLowerCase().includes(needle) || row.sellerName.toLowerCase().includes(needle),
  );
};

export const flushMarket = (): void => {
  persist();
};

export const marketRemove = (actor: string, id: string): boolean => {
  const index = listings.findIndex((row) => row.id === id);
  if (index < 0) return false;
  const listing = listings[index];
  listings.splice(index, 1);
  dirty = true;
  persist(true);
  const stack = deserializeItem(listing.item);
  if (stack) {
    const lobby = world.getDimension("overworld");
    try {
      lobby.spawnItem(stack, { x: CONFIG.lobby.x, y: CONFIG.lobby.y + 1, z: CONFIG.lobby.z });
    } catch (error) {
      log.error("market", `возврат в лобби: ${String(error)}`);
    }
  }
  audit("market", "admin-remove", actor, `${listing.id} продавца ${listing.sellerName}: предмет возвращён в лобби`);
  return true;
};
