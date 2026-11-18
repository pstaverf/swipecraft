import { DisplaySlotId, ObjectiveSortOrder, Player, world } from "@minecraft/server";
import { CONFIG } from "../config";
import { t } from "../kernel/i18n";
import { log } from "../kernel/logger";
import { allMeta } from "../meta/balances";
import { balance, getTunables, metaOf } from "../meta/economy";
import { bestRankOf } from "../meta/ranks";
import { playStats } from "../meta/profiles";
import { currentEvent, nextEvent } from "../events/manager";
import "./messages";

/**
 * Таблица статуса.
 *
 * Разделение ровно такое, каким его диктует API 2.11.0:
 * - персональные строки (ранг, баланс, сыграно сегодня/всего) — action bar. У мода нет
 *   персонального сайдбара: `Player.onScreenDisplay` умеет только setActionBar/title,
 *   а `world.scoreboard` глобален на весь мир;
 * - общие строки (онлайн, топ ₡, таймер ивента) — сайдбар `DisplaySlotId.Sidebar`.
 *
 * Про сайдбар надо знать заранее: строка в Bedrock — это «имя участника + число», и
 * ScoreboardObjectiveDisplayOptions в этой версии не умеет скрывать число, а
 * displayName у объектива readonly (заголовок ставится один раз при создании). Поэтому
 * в сайдбар идут только строки, где число и есть смысл: ₡ у топа, количество игроков,
 * минуты до ивента. Смешивать в одном списке «топ по ₡» и «топ по рангам» нельзя:
 * сортировка одна, по числу, и второй список превратился бы в кашу из монет и порядков.
 *
 * Всё состояние баров (кто включил/выключил, последний текст) живёт в памяти: это
 * витрина, а не учёт. Профиль и кошелёк — единственное, что persist.
 */

const manualOff = new Set<string>();
const lastBar = new Map<string, string>();
let barWrites = 0;
let sidebarWrites = 0;
let sidebarBroken = "";
/** слот занят нами: без флага «выключено» означало бы clear каждое обновление */
let sidebarShown = false;
/** круговой указатель: за один проход пишем не больше CONFIG.hud.budget игроков */
let cursor = 0;

/**
 * Время в баре — с точностью до минуты. formatDuration показывает и секунды,
 * а тогда текст менялся бы каждую секунду у каждого игрока: 30 лишних вызовов
 * setActionBar в минуту на человека, чтобы показать «сыграно 47м 12с».
 */
const barDuration = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}с`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}м`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}ч ${minutes % 60}м`;
  return `${Math.floor(hours / 24)}д ${hours % 24}ч`;
};

const group = (value: number): string => Math.max(0, Math.floor(value)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");

const parts = (player: Player): string[] => {
  const meta = metaOf(player);
  const rank = bestRankOf(player);
  const play = playStats(player);
  return [
    `§6${t(player, "hud.rank")}§7: §f${rank ? rank.label : t(player, "hud.rank.none")}`,
    `§e${t(player, "hud.balance")}§7: §f${group(meta.coins)}`,
    `§a${t(player, "hud.today")}§7: §f${barDuration(play.todaySeconds)}`,
    `§7${t(player, "hud.total")}§7: §f${barDuration(play.totalSeconds)}`,
  ];
};

/** Одна строка: action bar не переносится, поэтому разделитель «·», а не перевод строки. */
export const hudLine = (player: Player): string => parts(player).join(" §8· §7");

export const hudBarEnabledFor = (player: Player): boolean => getTunables().hudBarEnabled && !manualOff.has(player.id);

export const hudSidebarEnabledFor = (): boolean => getTunables().hudSidebarEnabled && sidebarBroken.length === 0;

/** Текст бару игроку; пусто — значит показать пусто (снять старый текст). */
export const hudBarText = (player: Player): string => (hudBarEnabledFor(player) ? hudLine(player) : "");

const writeBar = (player: Player, text: string, force = false): boolean => {
  if (!force && (lastBar.get(player.id) ?? "") === text) return false;
  try {
    player.onScreenDisplay.setActionBar(text);
  } catch (error) {
    // на restricted-execution (-boot) onScreenDisplay бросает: это не повод ронять тик
    log.debug("hud", `action bar ${player.name}: ${String(error)}`);
    return false;
  }
  lastBar.set(player.id, text);
  barWrites += 1;
  return true;
};

/**
 * Обновление персональных строк. Игроки проходят по кругу с бюджетом: при 60 онлайне
 * бар обновляется у всех за 5 проходов, а не у всех в один тик.
 */
export const refreshHudBar = (): number => {
  const players = world.getAllPlayers();
  if (players.length === 0) {
    lastBar.clear();
    return 0;
  }
  const limit = Math.min(players.length, Math.max(1, CONFIG.hud.budget));
  let written = 0;
  for (let index = 0; index < limit; index += 1) {
    const player = players[(cursor + index) % players.length];
    if (writeBar(player, hudBarText(player))) written += 1;
  }
  cursor = (cursor + limit) % players.length;
  return written;
};

const sidebarObjective = () => {
  const scoreboard = world.scoreboard;
  const existing = scoreboard.getObjective(CONFIG.hud.sidebarObjective);
  if (existing) return existing;
  return scoreboard.addObjective(CONFIG.hud.sidebarObjective, CONFIG.hud.sidebarTitle);
};

/** Общий сайдбар: топ по монетам (офлайн-аккаунты тоже — кошельки живут в meta), онлайн, ивент. */
export const hudSidebarRows = (): { label: string; score: number }[] => {
  const top: { name: string; coins: number }[] = [];
  for (const [, record] of Object.entries(allMeta())) {
    if (record.coins > 0) top.push({ name: record.name, coins: record.coins });
  }
  for (const player of world.getAllPlayers()) {
    const live = balance(player);
    const row = top.find((entry) => entry.name === player.name);
    if (row) row.coins = live;
    else top.push({ name: player.name, coins: live });
  }
  top.sort((left, right) => right.coins - left.coins || left.name.localeCompare(right.name));
  const places = ["§6", "§e", "§b", "§7", "§8"];
  const rows: { label: string; score: number }[] = top
    .slice(0, Math.max(0, CONFIG.hud.sidebarRows))
    .map((row, index) => ({ label: `${places[index] ?? "§8"}${index + 1}. §f${row.name}`, score: row.coins }));
  rows.push({ label: `§a${t(undefined, "hud.online")}`, score: world.getAllPlayers().length });
  const active = currentEvent();
  const now = Date.now();
  if (active) {
    rows.push({ label: `§6${t(undefined, "hud.event.running", { name: active.id })}`, score: Math.max(0, Math.round((active.endsAt - now) / 1000)) });
  } else {
    const planned = nextEvent();
    rows.push({ label: `§b${t(undefined, "hud.event.next", { name: planned.id })}`, score: Math.max(0, Math.round((planned.at - now) / 60_000)) });
  }
  return rows;
};

export const refreshHudSidebar = (): void => {
  if (!getTunables().hudSidebarEnabled) {
    // один раз, а не каждые 5 секунд: clearObjectiveAtDisplaySlot по пустому слоту
    // на живом BDS бросает, и мы получили бы бесконечный поток log.debug
    if (sidebarShown) clearSidebar();
    sidebarShown = false;
    return;
  }
  if (sidebarBroken.length > 0) return;
  try {
    const objective = sidebarObjective();
    const rows = hudSidebarRows();
    const wanted = new Set<string>();
    for (const row of rows) {
      wanted.add(row.label);
      objective.setScore(row.label, row.score);
    }
    // движение вниз (больше — выше). Ascending = 0, Descending = 1 — перепутать значит
    // получить «беднейший сверху», поэтому порядок задаётся явно.
    world.scoreboard.setObjectiveAtDisplaySlot(DisplaySlotId.Sidebar, { objective, sortOrder: ObjectiveSortOrder.Descending });
    sidebarShown = true;
    for (const participant of objective.getParticipants()) {
      const label = participant.displayName ?? "";
      if (!wanted.has(label)) objective.removeParticipant(label);
    }
    sidebarWrites += 1;
  } catch (error) {
    // один отказ = выключаем сайдбар до перезапуска: гонать try/catch каждые 5 секунд
    // и писать в лог — значит получить тонну шума вместо таблицы
    sidebarBroken = String(error);
    log.warn("hud", `сайдбар выключен: ${sidebarBroken}`);
  }
};

const clearSidebar = (): void => {
  try {
    world.scoreboard.clearObjectiveAtDisplaySlot(DisplaySlotId.Sidebar);
  } catch (error) {
    log.debug("hud", `clear sidebar: ${String(error)}`);
  }
};

/**
 * Явный on/off, а не toggle: «выключил и выключил ещё раз» должно оставаться выключенным.
 * Снятие текста идёт с force — иначе из кэша следует «мы уже показывали пусто», а на экране
 * всё ещё висит наша строка (её мог перекрать border/koth, и кэш об этом не знает).
 */
export const setHudBar = (player: Player, on: boolean): { key: string; params: Record<string, string | number> } => {
  if (!on) {
    manualOff.add(player.id);
    writeBar(player, "", true);
    return { key: "hud.bar.off", params: {} };
  }
  manualOff.delete(player.id);
  if (!getTunables().hudBarEnabled) {
    writeBar(player, "", true);
    return { key: "hud.bar.gated", params: {} };
  }
  const line = hudLine(player);
  writeBar(player, line, true);
  return { key: "hud.bar.on", params: { line } };
};

export const forgetHud = (playerId: string): void => {
  manualOff.delete(playerId);
  lastBar.delete(playerId);
};

export const hudStatusLines = (player: Player): string[] => [
  `${t(player, "hud.status.bar")}: ${hudBarEnabledFor(player) ? t(player, "hud.on") : t(player, "hud.off")}`,
  `${t(player, "hud.status.sidebar")}: ${hudSidebarEnabledFor() ? t(player, "hud.on") : sidebarBroken.length > 0 ? t(player, "hud.broken") : t(player, "hud.off")}`,
  ...parts(player),
];

export const hudAdminLine = (player: Player): string =>
  t(player, "admin.world.hud.line", {
    bar: getTunables().hudBarEnabled ? t(player, "admin.world.on") : t(player, "admin.world.off"),
    sidebar: sidebarBroken.length > 0 ? t(player, "hud.broken") : getTunables().hudSidebarEnabled ? t(player, "admin.world.on") : t(player, "admin.world.off"),
  });

/** Диагностика для /sw:hud, админ-панели и стаб-тестов. */
export const hudProbe = (): {
  barWrites: number;
  sidebarWrites: number;
  broken: string;
  manualOff: string[];
  lastText: [string, string][];
} => ({
  barWrites,
  sidebarWrites,
  broken: sidebarBroken,
  manualOff: [...manualOff],
  lastText: [...lastBar.entries()],
});

export const registerHudTasks = (register: (name: string, ticks: number, budget: number, fn: () => void) => void): void => {
  register("hud-bar", CONFIG.hud.everyTicks, CONFIG.hud.budget, () => {
    const written = refreshHudBar();
    if (written > 0) log.debug("hud", `строк обновлено: ${written}`);
  });
  register("hud-sidebar", CONFIG.hud.sidebarEveryTicks, 3, () => {
    refreshHudSidebar();
  });
};
