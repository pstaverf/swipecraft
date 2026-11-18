import { Player, world } from "@minecraft/server";
import { t } from "../kernel/i18n";
import { audit } from "../security/audit";
import { RANKS, RANK_CASE } from "./config";
import { burn, getTunables, metaOf, refundBurn } from "./economy";
import { markDirty } from "./balances";
import { applyIdentity } from "./cosmetics";
import { formatDuration } from "../kernel/util";
import type { RankDef } from "../types/domain";
import "./messages";

/**
 * Ранги — косметика, которую нельзя «потерять»: выданный ранг остаётся навсегда,
 * повторный дроп того же ранга (или ранга ниже текущего) компенсируется монетами —
 * ровно та же схема, что у косметического кейса.
 *
 * Единственный владелец nameTag — cosmetics.identityName, поэтому сюда импортирован
 * applyIdentity, а не наоборот: обратно cosmetics импортировать нельзя (там уже есть
 * burn/metaOf, получился бы цикл). Чтобы cosmetics не зависел от этого модуля, он
 * читает готовый префикс из meta.rankTag — а синхронизацией rankTag владеет только
 * этот файл (syncRankTags), включая снятие префикса по стоп-крану.
 */

const byId = new Map<string, RankDef>(RANKS.map((row) => [row.id, row]));

/** память: сколько рангов роздано — диагностика, а не реестр (реестр = rankOwned в кошельке) */
let issued: Record<string, number> = {};
let compensated = 0;

/**
 * Возвращает **живой** массив кошелька, а не копию: на нём держится выдача (push в
 * rankOwned), и копия здесь означала бы «ранг выдан и молча потерялся». Вымершие id
 * (таблица правится между сезонами) вычищаются на чтении.
 */
const ownedOf = (player: Player): string[] => {
  const meta = metaOf(player);
  if (!Array.isArray(meta.rankOwned)) {
    meta.rankOwned = [];
    markDirty(player.id);
  }
  const clean = meta.rankOwned.filter((id) => byId.has(id));
  if (clean.length !== meta.rankOwned.length) {
    meta.rankOwned = clean;
    markDirty(player.id);
  }
  return meta.rankOwned;
};

/**
 * Лучший ранг = максимальный order из собранных. meta.rank — только кэш (его читает
 * nameTag), поэтому он пересчитывается здесь же и чинится, если реестр и кэш разъехались.
 */
export const bestRankOf = (player: Player): RankDef | undefined => {
  let best: RankDef | undefined;
  for (const id of ownedOf(player)) {
    const row = byId.get(id);
    if (row && (best === undefined || row.order > best.order)) best = row;
  }
  const meta = metaOf(player);
  const wanted = best?.id ?? "";
  if (meta.rank !== wanted) {
    meta.rank = wanted;
    meta.rankAt = best ? Date.now() : 0;
    markDirty(player.id);
  }
  return best;
};

/** Префикс над головой. Пусто, если стоп-кран рангов выключен — снятие тоже отсюда. */
export const activeRankTag = (player: Player): string => {
  if (!getTunables().ranksEnabled) return "";
  return bestRankOf(player)?.tag ?? "";
};

/**
 * Приводит meta.rankTag (и, следом, nameTag) к текущему состоянию. Вызывается на выдаче,
 * на входе игрока и раз в тике задачи — иначе поворот стоп-крана остался бы «незамеченным»
 * до первой смены косметики.
 */
export const syncRankTags = (): number => {
  const players = world.getAllPlayers();
  let changed = 0;
  for (const player of players) {
    const meta = metaOf(player);
    const wanted = activeRankTag(player);
    if (meta.rankTag === wanted) continue;
    meta.rankTag = wanted;
    markDirty(player.id);
    applyIdentity(player);
    changed += 1;
  }
  return changed;
};

export const syncRankTagsFor = (player: Player): void => {
  const meta = metaOf(player);
  const wanted = activeRankTag(player);
  if (meta.rankTag === wanted) return;
  meta.rankTag = wanted;
  markDirty(player.id);
  applyIdentity(player);
};

export interface RankGrantResult {
  ok: boolean;
  key: string;
  params?: Record<string, string | number>;
  /** что выпало/выдано */
  rank?: RankDef;
  /** дубликат или ранг ниже текущего: монетами */
  refund?: number;
}

/**
 * Выдача ранга. paidUsed — сколько монет сгорело на кейс (для квитанций); для админской
 * выдачи = 0. Отказ один: неизвестный id. Дубликаты НЕ отказ — они компенсируются,
 * потому что ранг навсегда и «выбросить» его игрок не может.
 */
export const grantRank = (player: Player, id: string, opts: { actor?: string; paid?: number } = {}): RankGrantResult => {
  const def = byId.get(id);
  if (!def) return { ok: false, key: "rank.err.unknown", params: { id } };
  const meta = metaOf(player);
  const owned = ownedOf(player);
  const paid = Math.max(0, Math.floor(opts.paid ?? 0));
  if (owned.includes(def.id)) {
    const refund = compensation(paid);
    compensated += 1;
    if (refund > 0) refundBurn(player, refund, `дубликат ранга ${def.id}`);
    meta.updatedAt = Date.now();
    markDirty(player.id);
    audit("ranks", "duplicate", player.name, `${def.id} → компенсация ${refund} ₡`);
    return { ok: true, key: refund > 0 ? "rank.dup.refund" : "rank.dup", params: { label: def.label, refund }, rank: def, refund };
  }
  const best = bestRankOf(player);
  owned.push(def.id);
  meta.updatedAt = Date.now();
  markDirty(player.id);
  issued[def.id] = (issued[def.id] ?? 0) + 1;
  audit("ranks", "grant", opts.actor && opts.actor.length > 0 ? opts.actor : player.name, `${def.id} через ${paid > 0 ? `кейс (${paid} ₡)` : "выдачу"}`);
  const before = best?.order ?? 0;
  syncRankTagsFor(player);
  if (def.order > before) {
    const lines = [`§6★ ${player.name} ${t(player, "rank.up", { rank: def.label })}`];
    for (const target of world.getAllPlayers()) {
      try {
        target.sendMessage(lines[0]);
      } catch {
        continue;
      }
    }
    return { ok: true, key: "rank.upgraded", params: { label: def.label, paid }, rank: def };
  }
  // ранг ниже текущего: collectible, но не показывается — компенсируем, как дубль
  const refund = compensation(paid);
  compensated += 1;
  if (refund > 0) refundBurn(player, refund, `ранг ниже текущего ${def.id}`);
  return {
    ok: true,
    key: refund > 0 ? "rank.below.refund" : "rank.below",
    params: { label: def.label, refund, best: best?.label ?? "" },
    rank: def,
    refund,
  };
};

const compensation = (paid: number): number => Math.round((paid * RANK_CASE.duplicateRefundPercent) / 100);

export const rankOdds = (): { def: RankDef; percent: number }[] => {
  const total = RANKS.reduce((sum, row) => sum + Math.max(0, row.weight), 0);
  if (total <= 0) return [];
  return RANKS.filter((row) => row.weight > 0).map((row) => ({ def: row, percent: (row.weight / total) * 100 }));
};

export interface RankRollResult {
  ok: boolean;
  key: string;
  params?: Record<string, string | number>;
  lines?: string[];
  paid: number;
}

/** Крутка кейса рангов: монеты сгорают до броска, возврат — только за дубликат. */
export const rollRanks = (player: Player, count: number): RankRollResult => {
  if (!getTunables().ranksEnabled) return { ok: false, key: "rank.off", params: {}, paid: 0 };
  const pulls = Math.max(1, Math.min(Math.floor(count), RANK_CASE.maxRollsPerCall));
  const price = RANK_CASE.priceCoins * pulls;
  const burned = burn(player, price, `${RANK_CASE.id} x${pulls}`);
  if (!burned.ok) return { ok: false, key: burned.key, params: burned.params, paid: 0 };
  const lines: string[] = [];
  let refunded = 0;
  for (let index = 0; index < pulls; index += 1) {
    const entry = pickRank();
    if (!entry) continue;
    const result = grantRank(player, entry.id, { actor: player.name, paid: RANK_CASE.priceCoins });
    if (result.refund) refunded += result.refund;
    lines.push(
      result.rank
        ? `${colorOf(result.rank)}${result.rank.label}§r${result.refund ? ` — ${t(player, "rank.refund.tag", { refund: result.refund })}` : ""}`
        : `§7${t(player, result.key, result.params)}`,
    );
  }
  metaOf(player).updatedAt = Date.now();
  markDirty(player.id);
  return {
    ok: true,
    key: "rank.rolled",
    params: { count: pulls, paid: price, refunded },
    lines,
    paid: price,
  };
};

const pickRank = (): RankDef | undefined => {
  const pool = RANKS.filter((row) => row.weight > 0);
  const total = pool.reduce((sum, row) => sum + Math.max(0, row.weight), 0);
  if (total <= 0) return undefined;
  let ticket = Math.random() * total;
  for (const row of pool) {
    ticket -= Math.max(0, row.weight);
    if (ticket > 0) continue;
    return row;
  }
  return pool[pool.length - 1];
};

const colorOf = (def: RankDef): string =>
  def.rarity === "legendary" ? "§6" : def.rarity === "epic" ? "§5" : def.rarity === "rare" ? "§b" : "§f";

export const rankLines = (player: Player): string[] => {
  const owned = metaOf(player).rankOwned;
  const best = bestRankOf(player);
  const lines: string[] = [];
  for (const row of [...RANKS].sort((left, right) => right.order - left.order)) {
    const mine = owned.includes(row.id);
    const mark = best?.id === row.id ? "§a★" : mine ? "§a✓" : row.weight === 0 ? "§7•" : "§8·";
    lines.push(`${mark} ${colorOf(row)}${row.label}§r ${mine ? t(player, "rank.owned") : row.weight === 0 ? t(player, "rank.unroll") : `${t(player, "rank.odds")}: ${oddsPercent(row.weight)}%`}`);
  }
  if (best) {
    lines.push("");
    lines.push(t(player, "rank.since", { time: formatDuration(Date.now() - metaOf(player).rankAt) }));
  }
  return lines;
};

const oddsPercent = (weight: number): string => {
  const total = RANKS.reduce((sum, row) => sum + Math.max(0, row.weight), 0);
  return total <= 0 ? "0" : ((weight / total) * 100).toFixed(2).replace(/\.?0+$/, "");
};

export const rankOddsLines = (player: Player): string[] => {
  const rows = rankOdds();
  if (rows.length === 0) return [t(player, "rank.off")];
  return [t(player, "rank.case.price", { price: RANK_CASE.priceCoins }), ...rows.map((row) => `${colorOf(row.def)}${row.def.label}§r — ${row.percent.toFixed(2)}%`)];
};

/** Топ по старшинству ранга — для сайдбара и для админ-сводки. */
export const rankLeaders = (limit: number): { name: string; label: string; order: number }[] => {
  const rows: { name: string; label: string; order: number }[] = [];
  for (const player of world.getAllPlayers()) {
    const best = bestRankOf(player);
    if (!best) continue;
    rows.push({ name: player.name, label: best.label, order: best.order });
  }
  rows.sort((left, right) => right.order - left.order || left.name.localeCompare(right.name));
  return rows.slice(0, Math.max(0, limit));
};

export const rankStatus = (player: Player): string[] => {
  const meta = metaOf(player);
  const best = bestRankOf(player);
  return [
    t(player, "rank.status.line", { rank: best ? best.label : t(player, "rank.none"), owned: meta.rankOwned.length, total: RANKS.length }),
    t(player, "rank.case.price", { price: RANK_CASE.priceCoins }),
    `${t(player, "rank.duplicate.refund")}: ${RANK_CASE.duplicateRefundPercent}%`,
    best ? t(player, "rank.tag.line", { tag: best.tag.trim() }) : t(player, "rank.tag.none"),
  ];
};

export const rankReport = (): string[] => {
  const rows = Object.entries(issued).sort((left, right) => right[1] - left[1]);
  const total = rows.reduce((sum, [, count]) => sum + count, 0);
  return [
    `рангов роздано: ${total}, компенсировано дублей: ${compensated}`,
    ...(rows.length === 0 ? ["выдач с запуска не было"] : rows.map(([id, count]) => `${byId.get(id)?.label ?? id}: ${count}`)),
    `кран: ${getTunables().ranksEnabled ? "вкл" : "выкл (префиксы сняты, кейс закрыт)"}`,
  ];
};

export const rankStats = (): { issued: number; compensated: number } => ({
  issued: Object.values(issued).reduce((sum, count) => sum + count, 0),
  compensated,
});

export const rankAdminLine = (player: Player): string => {
  const stats = rankStats();
  return t(player, "admin.world.ranks.line", {
    state: getTunables().ranksEnabled ? t(player, "admin.world.on") : t(player, "admin.world.off"),
    issued: stats.issued,
    compensated: stats.compensated,
  });
};

/** Для теста и для /sw:rank info: состояние без побочных эффектов, кроме починки кэша. */
export const rankProbe = (player: Player): { best: string; owned: number; tag: string } => {
  const best = bestRankOf(player);
  return { best: best?.id ?? "", owned: metaOf(player).rankOwned.length, tag: metaOf(player).rankTag };
};
