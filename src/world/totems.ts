import { ItemStack, Player } from "@minecraft/server";
import { CONFIG, STORE_KEYS } from "../config";
import { t } from "../kernel/i18n";
import { log } from "../kernel/logger";
import { loadWorldJson, saveWorldJson } from "../kernel/store";
import { registerTask } from "../kernel/ticker";
import { clamp, shortId } from "../kernel/util";
import { audit, notifyAdmins } from "../security/audit";
import { grantGrace } from "../security/anticheat";
import { burn, getTunables, metaOf, refundBurn, sellPrice } from "../meta/economy";
import { getSeason } from "./season";
import type { EntityHurtBeforeEvent, EntityHealthComponent } from "@minecraft/server";
import type { TotemRegistry, TotemResult, TotemRow, TotemTierId, TotemTierView } from "../types/domain";
import "./messages";

/**
 * Зачарованные тотемы.
 *
 * Игрок приносит ванический тотем бессмертия (лут, рынок игроков, своя ферма) и проводит
 * обряд: монеты сгорают, из инвентаря вынимаются изумруды, а предмет на руках становится
 * «тотемом с зарядом» — имя, лор с серийником и N спасений.
 *
 * Пять правил, которые делают фичу безопасной:
 * 1. ₡ из воздуха не появляется: обряд только сжигает монеты (`burn`) и съедает изумруды из
 *    инвентаря. Отдача — предмет, а не деньги.
 * 2. Источник истины — реестр в dynamic properties, а не лор предмета. Серийник в лоре —
 *    просто указатель: подсмотреть и скопировать его можно, но заряды всё равно кончатся на
 *    том числе, за которое игрок заплатил.
 * 3. Разряженный тотем не исчезает: предмет деградирует обратно в ванический тотем, который
 *    по-прежнему продаётся по `sellPrice`. Мод ничего не уничтожает и не печатает.
 * 4. Спасение меняет HP и вешает эффекты, поэтому на время неуязвимости выдаётся grace —
 *    иначе античит прочитает «выздоровление после 0,5 HP» как аномалию.
 * 5. Стоп-кран `totemsEnabled` выключает всё целиком: обряд недоступен, спасение не
 *    срабатывает, реестр и предметы не трогаются.
 *
 * Спасение устроено как ОТМЕНА УРОНА, а не как воскрешение: `beforeEvents.entityHurt` с
 * `damage >= currentValue` отменяется, и смерть не наступает вовсе. Через `entityDie` так
 * нельзя — в 2.11.0 событие смерти только after-событие, `cancel` у него нет.
 */

const cfg = CONFIG.totems;
const SERIAL_RE = /#([a-z0-9]{4,12})(?:\s|$)/;
const EMERALD = "minecraft:emerald";

const emptyRegistry = (season: number): TotemRegistry => ({ season, rows: [], day: {}, lastSave: {} });

let state: TotemRegistry = emptyRegistry(0);
let loaded = false;

/** Окно неуязвимости после спасения (в памяти: рестарт сервера = сброс, это косметика). */
const immunity = new Map<string, number>();

const dayKey = (now = Date.now()): string => new Date(now).toISOString().slice(0, 10);

const result = (ok: boolean, key: string, params?: Record<string, string | number>): TotemResult => ({ ok, key, params });

const save = (): void => {
  try {
    saveWorldJson(STORE_KEYS.totems, state);
  } catch (error) {
    log.error("totems", `не удалось сохранить реестр: ${String(error)}`);
  }
};

const genSerial = (salt: number): string =>
  `${Date.now().toString(36).slice(-5)}${clamp(Math.floor(salt), 0, 4095).toString(36).padStart(3, "0")}`;

const tierSpec = (tier: TotemTierId) => cfg.tiers[tier];

/** HP-компонент игрока: `getComponent` возвращает `undefined`, если сущность уже невалидна. */
type PlayerHealth = EntityHealthComponent;

export const TOTEM_TIER_IDS: TotemTierId[] = ["whisper", "oath", "ash"];

/** Предмет-носитель обряда: модуль работает только с ним, новых предметов не создаёт. */
export const TOTEM_CARRIER = cfg.carrier;

export const totemTiers = (): TotemTierView[] =>
  TOTEM_TIER_IDS.map((id) => {
    const spec = tierSpec(id);
    return { id, charges: spec.charges, coinCost: spec.coinCost, emeralds: spec.emeralds, effects: spec.effects.map((row) => ({ ...row })) };
  });

export const totemTierCost = (tier: TotemTierId): { coin: number; emeralds: number; emeraldValue: number; total: number } => {
  const spec = tierSpec(tier);
  const emeraldValue = sellPrice(EMERALD);
  return { coin: spec.coinCost, emeralds: spec.emeralds, emeraldValue, total: spec.coinCost + spec.emeralds * emeraldValue };
};

export const loadTotems = (): number => {
  const stored = loadWorldJson<Partial<TotemRegistry>>(STORE_KEYS.totems, {});
  const rows = Array.isArray(stored.rows) ? stored.rows : [];
  state = {
    season: typeof stored.season === "number" ? stored.season : 0,
    rows: rows.filter((row): row is TotemRow => !!row && typeof row.serial === "string" && typeof row.tier === "string"),
    day: stored.day && typeof stored.day === "object" ? stored.day : {},
    lastSave: stored.lastSave && typeof stored.lastSave === "object" ? stored.lastSave : {},
  };
  loaded = true;
  return state.rows.length;
};

export const flushTotems = (): void => {
  if (loaded) save();
};

const findRow = (serial: string): TotemRow | undefined => state.rows.find((row) => row.serial === serial);

/** Заряд живёт, только пока запись активна и принадлежит текущему сезону. */
export const isRowLive = (row: TotemRow | undefined): row is TotemRow =>
  !!row && row.charges > 0 && row.spentAt === 0 && row.season === getSeason().index;

const containerOf = (player: Player) => {
  try {
    return player.getComponent("minecraft:inventory")?.container;
  } catch (error) {
    log.debug("totems", `инвентарь ${player.name}: ${String(error)}`);
    return undefined;
  }
};

const itemAt = (container: { size: number; getItem: (index: number) => ItemStack | undefined } | undefined, slot: number) => {
  if (!container) return undefined;
  try {
    return container.getItem(clamp(Math.floor(slot), 0, Math.max(0, container.size - 1)));
  } catch {
    return undefined;
  }
};

export const readSerial = (stack: ItemStack | undefined): string | undefined => {
  if (!stack || stack.typeId !== cfg.carrier) return undefined;
  let lore: string[] = [];
  try {
    lore = stack.getLore();
  } catch {
    return undefined;
  }
  for (const line of lore) {
    const hit = SERIAL_RE.exec(line);
    if (hit?.[1]) return hit[1];
  }
  return undefined;
};

interface HeldTotem {
  slot: number;
  stack: ItemStack;
  serial: string;
  row: TotemRow;
}

/** Тотем с живым зарядом: сначала рука, потом весь инвентарь — как в ваниле, где важен сам предмет. */
export const findHeldTotem = (player: Player): HeldTotem | undefined => {
  const container = containerOf(player);
  if (!container) return undefined;
  const size = clamp(Math.floor(container.size ?? 0), 0, 36);
  if (size <= 0) return undefined;
  const prefer = clamp(Math.floor(player.selectedSlotIndex ?? 0), 0, size - 1);
  const order = [prefer, ...Array.from({ length: size }, (_unused, index) => index).filter((index) => index !== prefer)];
  for (const slot of order) {
    const stack = itemAt(container, slot);
    const serial = readSerial(stack);
    if (!serial || !stack) continue;
    const row = findRow(serial);
    if (!isRowLive(row)) continue;
    return { slot, stack, serial, row };
  }
  return undefined;
};

const writeCharm = (player: Player, stack: ItemStack, tier: TotemTierId, serial: string, charges: number): boolean => {
  let ok = true;
  try {
    stack.nameTag = t(player, `totem.name.${tier}`);
  } catch (error) {
    ok = false;
    log.debug("totems", `имя предмета: ${String(error)}`);
  }
  try {
    stack.setLore([
      `#${serial} · ${tier}`,
      t(player, "totem.lore.charges", { charges, max: tierSpec(tier).charges }),
      t(player, "totem.lore.note"),
    ]);
  } catch (error) {
    ok = false;
    log.debug("totems", `лор предмета: ${String(error)}`);
  }
  return ok;
};

const countItem = (player: Player, typeId: string, exceptSlot: number): number => {
  const container = containerOf(player);
  if (!container) return 0;
  const size = clamp(Math.floor(container.size ?? 0), 0, 36);
  let total = 0;
  for (let index = 0; index < size; index += 1) {
    if (index === exceptSlot) continue;
    const stack = itemAt(container, index);
    if (stack && stack.typeId === typeId) total += stack.amount;
  }
  return total;
};

/**
 * Обряд: сжигаем ₡ и вынимаем изумруды, превращаем ванический тотем на руках в тотем с
 * зарядом. Порядок такой: проверка → `burn` → изумруды → запись предмета. Если изумруды не
 * списались, монеты возвращаются через `refundBurn` — «деньги взялись, а предмета нет»
 * невозможнен.
 */
export const forgeTotem = (player: Player, tier: TotemTierId): TotemResult => {
  if (!getTunables().totemsEnabled) return result(false, "totem.err.off");
  if (!TOTEM_TIER_IDS.includes(tier)) return result(false, "totem.err.tier");
  const spec = tierSpec(tier);
  const container = containerOf(player);
  if (!container) return result(false, "totem.err.inventory");
  const size = clamp(Math.floor(container.size ?? 0), 0, 36);
  if (size <= 0) return result(false, "totem.err.inventory");
  const slot = clamp(Math.floor(player.selectedSlotIndex ?? 0), 0, size - 1);
  const held = itemAt(container, slot);
  if (!held || held.typeId !== cfg.carrier) return result(false, "totem.err.item");
  if (readSerial(held)) return result(false, "totem.err.charmed");
  const counter = state.day[player.id];
  const day = counter && counter.day === dayKey() ? counter : { day: dayKey(), saves: 0, forges: 0 };
  if (day.forges >= cfg.forgesPerDay) return result(false, "totem.err.forge.day", { max: cfg.forgesPerDay });
  if (metaOf(player).coins < spec.coinCost) {
    return result(false, "totem.err.money", { cost: spec.coinCost, have: metaOf(player).coins, symbol: "₡" });
  }
  const have = countItem(player, EMERALD, slot);
  if (have < spec.emeralds) {
    return result(false, "totem.err.emeralds", { need: spec.emeralds, have, price: sellPrice(EMERALD), symbol: "₡" });
  }

  let serial = genSerial(state.rows.length + 1);
  for (let attempt = 1; findRow(serial) && attempt < 8; attempt += 1) {
    serial = genSerial(state.rows.length + 1 + attempt);
  }
  if (findRow(serial)) return result(false, "totem.err.busy");
  const paid = burn(player, spec.coinCost, `тотем ${tier} #${serial}`);
  if (!paid.ok) return result(false, "totem.err.money", { cost: spec.coinCost, have: metaOf(player).coins, symbol: "₡" });

  let removed = 0;
  for (let index = 0; index < size && removed < spec.emeralds; index += 1) {
    if (index === slot) continue; // тотем на руках изумрудом не станет
    const stack = itemAt(container, index);
    if (!stack || stack.typeId !== EMERALD) continue;
    const take = Math.min(stack.amount, spec.emeralds - removed);
    removed += take;
    try {
      if (stack.amount > take) {
        const rest = stack.clone();
        rest.amount = stack.amount - take;
        container.setItem(index, rest);
      } else {
        container.setItem(index, undefined);
      }
    } catch (error) {
      log.error("totems", `списание изумрудов ${player.name}: ${String(error)}`);
      break;
    }
  }
  if (removed < spec.emeralds) {
    // изумрудов не хватило уже после списания — возвращаем монеты и выходим
    refundBurn(player, spec.coinCost, `тотем ${tier} #${serial}: изумруды не списались`);
    return result(false, "totem.err.emeralds", { need: spec.emeralds, have: removed, price: sellPrice(EMERALD), symbol: "₡" });
  }

  const row: TotemRow = {
    serial,
    tier,
    charges: spec.charges,
    forgedAt: Date.now(),
    forgedBy: player.name,
    season: getSeason().index,
    spentAt: 0,
  };
  state.rows.unshift(row);
  const bare = !writeCharm(player, held, tier, serial, spec.charges);
  try {
    container.setItem(slot, held);
  } catch (error) {
    log.error("totems", `не удалось записать предмет ${player.name}: ${String(error)}`);
  }
  state.day[player.id] = { ...day, forges: day.forges + 1 };
  save();
  audit(player.name, "totems", "forge", `#${serial} ${tier}, −${spec.coinCost} ₡, −${spec.emeralds} изумрудов`);
  notifyAdmins(`[totems] #${shortId(serial)} (${tier}) выдан ${player.name}: зарядов ${spec.charges}${bare ? ", лор не записался" : ""}`);
  return result(
    true,
    bare ? "totem.forged.bare" : "totem.forged",
    { serial, tier: t(player, `totem.tier.${tier}`), charges: spec.charges, cost: spec.coinCost, emeralds: spec.emeralds, symbol: "₡" },
  );
};

/** Заряд кончился — предмет снова ванический тотем: его можно продать или зачесть как лут. */
const downgrade = (player: Player, slot: number, stack: ItemStack): void => {
  try {
    stack.nameTag = "";
  } catch {
    void 0;
  }
  try {
    stack.setLore([]);
  } catch {
    void 0;
  }
  try {
    containerOf(player)?.setItem(slot, stack);
  } catch (error) {
    log.debug("totems", `возврат ванического тотема ${player.name}: ${String(error)}`);
  }
};

/**
 * Спасение. Вызывается из `beforeEvents.entityHurt`; возвращает true, если урон отменён
 * (функция сама ставит `event.cancel = true`), false — значит игрок умирает как обычно.
 */
export const savePlayer = (player: Player, event: EntityHurtBeforeEvent): boolean => {
  if (!getTunables().totemsEnabled) return false;
  const now = Date.now();
  if ((immunity.get(player.id) ?? 0) > now) {
    // добивать в окне неуязвимости нельзя, но и заряд не тратим
    event.cancel = true;
    return true;
  }
  let health: PlayerHealth | undefined;
  try {
    health = player.getComponent("minecraft:health");
  } catch {
    health = undefined;
  }
  // если компонент HP недоступен, удар считаем смертельным при damage >= 20 (ванический максимум)
  const current = typeof health?.currentValue === "number" ? health.currentValue : 20;
  if (current <= 0 || event.damage < current) return false;

  const found = findHeldTotem(player);
  if (!found) return false;
  if ((state.lastSave[player.id] ?? 0) + cfg.saveCooldownMs > now) return false;
  const counter = state.day[player.id];
  const day = counter && counter.day === dayKey() ? counter : { day: dayKey(), saves: 0, forges: 0 };
  if (day.saves >= cfg.savesPerDay) {
    player.sendMessage(t(player, "totem.err.save.day", { max: cfg.savesPerDay }));
    return false;
  }

  event.cancel = true;
  const { row, stack, slot, serial } = found;
  row.charges = Math.max(0, row.charges - 1);
  const empty = row.charges === 0;
  if (empty) {
    row.spentAt = now;
    downgrade(player, slot, stack);
  } else {
    writeCharm(player, stack, row.tier, row.serial, row.charges);
    try {
      containerOf(player)?.setItem(slot, stack);
    } catch {
      void 0;
    }
  }
  state.lastSave[player.id] = now;
  state.day[player.id] = { ...day, saves: day.saves + 1 };
  immunity.set(player.id, now + cfg.immunityMs);
  save();

  try {
    health?.setCurrentValue(health.effectiveMax);
  } catch (error) {
    log.debug("totems", `лечение ${player.name}: ${String(error)}`);
  }
  for (const effect of tierSpec(row.tier).effects) {
    try {
      player.addEffect(effect.id, effect.seconds, { amplifier: effect.amplifier, showParticles: false });
    } catch (error) {
      log.debug("totems", `эффект ${effect.id} ${player.name}: ${String(error)}`);
    }
  }
  // спасение лечит и ускоряет — античит не должен прочесть это как полёт или «импульс»
  grantGrace(player.id, cfg.immunityMs);
  try {
    player.playSound("totem.use", { volume: 1 });
  } catch {
    void 0;
  }
  player.sendMessage(
    t(player, empty ? "totem.spent" : "totem.saved", {
      tier: t(player, `totem.tier.${row.tier}`),
      serial,
      charges: row.charges,
      price: sellPrice(cfg.carrier),
      symbol: "₡",
    }),
  );
  audit(player.name, "totems", "save", `#${serial} ${row.tier}, зарядов осталось ${row.charges}`);
  notifyAdmins(`[totems] ${player.name} спасён тотемом #${shortId(serial)} (зарядов осталось ${row.charges})`);
  return true;
};

export const totemLines = (player: Player): string[] => {
  const lines: string[] = [t(player, "totem.status.head", { state: getTunables().totemsEnabled ? t(player, "totem.state.on") : t(player, "totem.state.off") })];
  const found = findHeldTotem(player);
  if (!found) {
    lines.push(t(player, "totem.status.none"));
  } else {
    const spec = tierSpec(found.row.tier);
    lines.push(
      t(player, "totem.status.active", {
        tier: t(player, `totem.tier.${found.row.tier}`),
        serial: found.serial,
        charges: found.row.charges,
        max: spec.charges,
        slot: found.slot + 1,
        effects: spec.effects.map((row) => t(player, `totem.effect.${row.id}`, { level: row.amplifier + 1, seconds: row.seconds })).join(", "),
      }),
    );
  }
  const counter = state.day[player.id];
  const day = counter && counter.day === dayKey() ? counter : undefined;
  lines.push(
    t(player, "totem.status.quota", {
      saves: day?.saves ?? 0,
      savesMax: cfg.savesPerDay,
      forges: day?.forges ?? 0,
      forgesMax: cfg.forgesPerDay,
    }),
  );
  const left = state.lastSave[player.id] ? Math.max(0, state.lastSave[player.id] + cfg.saveCooldownMs - Date.now()) : 0;
  if (left > 0) lines.push(t(player, "totem.status.cool", { seconds: Math.ceil(left / 1000) }));
  const guard = immunityLeft(player.id);
  if (guard > 0) lines.push(t(player, "totem.status.immunity", { seconds: Math.ceil(guard / 1000) }));
  return lines;
};

export const totemTiersAsLines = (player: Player): string[] =>
  TOTEM_TIER_IDS.map((id) => {
    const price = totemTierCost(id);
    const spec = tierSpec(id);
    return t(player, "totem.tier.line", {
      name: t(player, `totem.tier.${id}`),
      charges: spec.charges,
      cost: price.total,
      coin: price.coin,
      emeralds: price.emeralds,
      effects: spec.effects.map((row) => t(player, `totem.effect.${row.id}`, { level: row.amplifier + 1, seconds: row.seconds })).join(", "),
      symbol: "₡",
    });
  });

export const totemMenuLines = (player: Player): string[] => [...totemLines(player), "", ...totemTiersAsLines(player)];

export const totemHowLines = (player: Player): string[] => [
  t(player, "totem.info", {
    saves: cfg.savesPerDay,
    forges: cfg.forgesPerDay,
    cooldown: Math.round(cfg.saveCooldownMs / 1000),
    immunity: Math.round(cfg.immunityMs / 1000),
    price: sellPrice(cfg.carrier),
    symbol: "₡",
  }),
];

/** Предпросмотр обряда для формы подтверждения — списывать ещё ничего нельзя. */
export const canForgeTotem = (player: Player, tier: TotemTierId): TotemResult => {
  if (!getTunables().totemsEnabled) return result(false, "totem.err.off");
  const container = containerOf(player);
  const size = clamp(Math.floor(container?.size ?? 0), 0, 36);
  if (!container || size <= 0) return result(false, "totem.err.inventory");
  const slot = clamp(Math.floor(player.selectedSlotIndex ?? 0), 0, size - 1);
  const held = itemAt(container, slot);
  if (!held || held.typeId !== cfg.carrier) return result(false, "totem.err.item");
  if (readSerial(held)) return result(false, "totem.err.charmed");
  const spec = tierSpec(tier);
  if (metaOf(player).coins < spec.coinCost) {
    return result(false, "totem.err.money", { cost: spec.coinCost, have: metaOf(player).coins, symbol: "₡" });
  }
  if (countItem(player, EMERALD, slot) < spec.emeralds) {
    return result(false, "totem.err.emeralds", { need: spec.emeralds, have: countItem(player, EMERALD, slot), price: sellPrice(EMERALD), symbol: "₡" });
  }
  return result(true, "totem.confirm.body", {
    tier: t(player, `totem.tier.${tier}`),
    charges: spec.charges,
    cost: spec.coinCost,
    emeralds: spec.emeralds,
    symbol: "₡",
  });
};

export const totemAdminLines = (player: Player): string[] => {
  const rows = state.rows.slice(0, 12);
  if (rows.length === 0) return [t(player, "totem.admin.none")];
  return rows.map(
    (row) =>
      t(player, "totem.admin.row", {
        serial: row.serial,
        tier: t(player, `totem.tier.${row.tier}`),
        owner: row.forgedBy,
        charges: row.charges,
        max: tierSpec(row.tier).charges,
        state: isRowLive(row) ? t(player, "totem.state.live") : t(player, "totem.state.spent"),
      }),
  );
};

export const revokeTotem = (actor: string, serial: string): TotemResult => {
  const row = findRow(serial.trim().toLowerCase());
  if (!isRowLive(row)) return result(false, "totem.err.serial", { serial });
  row.charges = 0;
  row.spentAt = Date.now();
  save();
  audit(actor, "totems", "revoke", `#${row.serial}`);
  notifyAdmins(`[totems] ${actor} отозвал #${shortId(row.serial)}`);
  return result(true, "totem.revoked", { serial: row.serial });
};

export const totemSummary = (): { rows: number; live: number; savesToday: number; forgesToday: number; enabled: boolean } => {
  const today = dayKey();
  let saves = 0;
  let forges = 0;
  for (const row of Object.values(state.day)) {
    if (row.day !== today) continue;
    saves += row.saves;
    forges += row.forges;
  }
  return {
    rows: state.rows.length,
    live: state.rows.filter((row) => isRowLive(row)).length,
    savesToday: saves,
    forgesToday: forges,
    enabled: getTunables().totemsEnabled,
  };
};

/** Реестр обязан оставаться маленьким: бюджет dynamic properties не резиновый. */
export const pruneTotems = (now = Date.now()): number => {
  const before = state.rows.length;
  const ttl = cfg.spentTtlDays * 24 * 60 * 60 * 1000;
  const keep = state.rows.filter((row) => row.charges > 0 || now - row.spentAt < ttl);
  if (keep.length > cfg.maxActive) {
    // `unshift` держит свежие записи в начале, поэтому срез с хвоста — это самые старые;
    // если среди них есть живые, заряд игрока гаснет молча, и это должно быть видно в логе
    log.warn("totems", `реестр переполнен: ${keep.length} записей при лимите ${cfg.maxActive}, ${keep.length - cfg.maxActive} устаревших выкинуто`);
  }
  state.rows = keep.slice(0, cfg.maxActive);
  const dropped = before - state.rows.length;
  if (dropped > 0) save();
  return dropped;
};

export const initTotems = (seasonIndex: number): void => {
  const rows = loadTotems();
  if (state.season !== seasonIndex) {
    // записи прошлых сезонов бессмысленны: их серийники больше не живые
    state = emptyRegistry(seasonIndex);
    save();
    log.info("totems", `реестр обнулён под сезон ${seasonIndex} (было ${rows} записей)`);
  }
  pruneTotems();
  registerTask("totem-prune", cfg.pruneEveryTicks, 2, () => {
    pruneTotems();
  });
};

export const totemRows = (): TotemRow[] => state.rows.slice();

export const immunityLeft = (playerId: string, now = Date.now()): number => Math.max(0, (immunity.get(playerId) ?? 0) - now);

/** только для headless-стаба и диагностики: окно неуязвимости сбрасывается без ожидания */
export const clearImmunity = (playerId: string): void => {
  immunity.delete(playerId);
};
