import { Entity, Player, world } from "@minecraft/server";
import { STORE_KEYS } from "../config";
import { raw } from "../kernel/i18n";
import { log } from "../kernel/logger";
import { registerTask } from "../kernel/ticker";
import { formatDuration } from "../kernel/util";
import { loadWorldJson, saveWorldJson } from "../kernel/store";
import { audit, notifyAdmins } from "../security/audit";
import { announce, announceTo, soundAll, titleAllNamed } from "./api";
import { EVENT_LABELS, EVENT_ORDER, EVENT_SCHEDULE } from "./config";
import "./messages";
import { airdropEvent } from "./impl/airdrop";
import { bloodmoonEvent } from "./impl/bloodmoon";
import { bossraidEvent } from "./impl/bossraid";
import { bountyhuntEvent } from "./impl/bountyhunt";
import { doublelootEvent } from "./impl/doubleloot";
import { kothEvent } from "./impl/koth";
import { lifestealEvent } from "./impl/lifesteal";
import { flushPendingFor, loadPending, pendingCount, pendingQueue } from "./pending";
import type { ActiveEvent, EventHandler, EventId, FinishReason, PersistentEvents } from "./types";

const HANDLERS: Record<EventId, EventHandler> = {
  airdrop: airdropEvent,
  bloodmoon: bloodmoonEvent,
  koth: kothEvent,
  bossraid: bossraidEvent,
  doubleloot: doublelootEvent,
  bountyhunt: bountyhuntEvent,
  lifesteal: lifestealEvent,
};

const EMPTY_GRACE_MS = 5 * 60_000;

let state: PersistentEvents = {
  history: [],
  nextAt: 0,
  planned: "airdrop",
  postponed: 0,
  announced5: 0,
  announced1: 0,
  emptySince: 0,
  lastFinishedAt: 0,
  pending: [],
};

let initialized = false;

export const EVENT_IDS: EventId[] = EVENT_ORDER;

export const isEventId = (value: string): value is EventId => (EVENT_ORDER as string[]).includes(value);

export const eventName = (id: EventId): string => `${EVENT_LABELS[id].ru} / ${EVENT_LABELS[id].en}`;

const persist = (): void => {
  state.pending = pendingQueue().slice(-200);
  saveWorldJson(STORE_KEYS.events, state);
};

const pickPlanned = (): EventId => {
  const recent = state.history.slice(-EVENT_SCHEDULE.rotationMemory);
  const pool = EVENT_ORDER.filter((id) => !recent.includes(id));
  const last = state.history[state.history.length - 1];
  const source = pool.length > 0 ? pool : EVENT_ORDER.filter((id) => id !== last);
  const list = source.length > 0 ? source : EVENT_ORDER;
  return list[Math.floor(Math.random() * list.length)];
};

const finishActive = (reason: FinishReason, actor: string): void => {
  const active = state.active;
  if (!active) return;
  const handler = HANDLERS[active.id];
  try {
    handler.finish(active, reason);
  } catch (error) {
    log.error("events", `finish ${active.id}: ${String(error)}`);
  }
  state.history.push(active.id);
  if (state.history.length > 12) state.history = state.history.slice(-12);
  state.lastFinishedAt = Date.now();
  state.active = undefined;
  state.nextAt = Date.now() + EVENT_SCHEDULE.intervalMs;
  state.planned = pickPlanned();
  state.postponed = 0;
  state.announced5 = 0;
  state.announced1 = 0;
  state.emptySince = 0;
  audit(actor, `event-finish:${reason}`, active.id, `длительность ${Math.round((Date.now() - active.startedAt) / 1000)}с`);
  persist();
};

export const startEvent = (id: EventId, manual: boolean, actor: string): string => {
  if (!isEventId(id)) return raw("ru", "ev.admin.unknown", { id });
  if (state.active) {
    if (state.active.id === id) return `Ивент ${eventName(id)} уже идёт`;
    finishActive("manual", actor);
  }
  const handler = HANDLERS[id];
  const now = Date.now();
  const active: ActiveEvent = {
    id,
    startedAt: now,
    endsAt: now + handler.defaultDurationMs,
    manual,
    data: {},
  };
  state.active = active;
  state.announced5 = 0;
  state.announced1 = 0;
  state.emptySince = 0;
  try {
    handler.start(active);
  } catch (error) {
    log.error("events", `start ${id}: ${String(error)}`);
    state.active = undefined;
    persist();
    return `Ошибка запуска ${eventName(id)}: ${String(error)}`;
  }
  audit(actor, manual ? "event-start-manual" : "event-start", id, `до ${new Date(active.endsAt).toISOString()}`);
  persist();
  return `Запущен ивент ${eventName(id)} (${manual ? "вручную" : "по расписанию"})`;
};

export const stopEvent = (actor: string): string => {
  if (!state.active) return raw("ru", "ev.admin.none", {});
  const id = state.active.id;
  finishActive("manual", actor);
  announce("ev.finished", { name: EVENT_LABELS[id].ru });
  return `Остановлен ивент ${eventName(id)}`;
};

export const currentEvent = (): ActiveEvent | undefined => state.active;

export const nextEvent = (): { id: EventId; at: number } => ({ id: state.planned, at: state.nextAt });

export const eventsStatus = (): string[] => {
  const now = Date.now();
  const lines: string[] = [];
  if (state.active) {
    lines.push(
      `Активен: ${eventName(state.active.id)}, осталось ${formatDuration(state.active.endsAt - now)}` +
        `${state.active.manual ? " (ручной)" : ""}`,
    );
  } else {
    lines.push("Активных ивентов нет");
  }
  lines.push(`Следующий: ${eventName(state.planned)} через ${formatDuration(state.nextAt - now)}`);
  lines.push(`Игроков онлайн: ${world.getAllPlayers().length}, минимум для запуска: ${HANDLERS[state.planned].minPlayers}`);
  lines.push(`Переносов подряд: ${state.postponed}/${EVENT_SCHEDULE.maxPostpones}`);
  lines.push(`История: ${state.history.slice(-7).map((id) => EVENT_LABELS[id].ru).join(" → ") || "пусто"}`);
  lines.push(`Отложенных наград: ${pendingCount()}`);
  return lines;
};

const handleEntityDie = (entity: Entity, killer: Player | undefined): void => {
  const active = state.active;
  if (!active) return;
  const handler = HANDLERS[active.id];
  try {
    handler.onEntityDie?.(active, entity, killer);
    if (killer && entity instanceof Player) handler.onPlayerKill?.(active, killer, entity);
  } catch (error) {
    log.error("events", `entityDie ${active.id}: ${String(error)}`);
  }
};

const tickEvents = (now: number): void => {
  const players = world.getAllPlayers();

  if (state.active) {
    const active = state.active;
    const handler = HANDLERS[active.id];
    if (players.length === 0) {
      if (state.emptySince === 0) state.emptySince = now;
      if (now - state.emptySince > EMPTY_GRACE_MS) {
        finishActive("empty", "system");
        return;
      }
    } else {
      state.emptySince = 0;
    }
    if (now >= active.endsAt) {
      finishActive("timeout", "system");
      return;
    }
    try {
      handler.tick(active, now);
    } catch (error) {
      log.error("events", `tick ${active.id}: ${String(error)}`);
    }
    return;
  }

  if (state.nextAt === 0) {
    state.nextAt = now + EVENT_SCHEDULE.intervalMs;
    state.planned = pickPlanned();
    persist();
    return;
  }

  const handler = HANDLERS[state.planned];
  if (now >= state.nextAt) {
    if (players.length < handler.minPlayers) {
      state.postponed += 1;
      if (state.postponed > EVENT_SCHEDULE.maxPostpones) {
        state.nextAt = now + 30 * 60_000;
        state.postponed = 0;
        state.planned = pickPlanned();
        notifyAdmins(`Ивент ${eventName(state.planned)}: нет игроков, перенос на 30 минут`);
        persist();
        return;
      }
      state.nextAt = now + EVENT_SCHEDULE.postponeMs;
      state.announced5 = 0;
      state.announced1 = 0;
      persist();
      return;
    }
    const nameKey = `ev.name.${state.planned}`;
    titleAllNamed("ev.started.title", nameKey);
    soundAll("random.levelup", 0.9);
    announce("ev.started.title", { name: raw("ru", nameKey, {}) });
    startEvent(state.planned, false, "scheduler");
    return;
  }

  const remaining = state.nextAt - now;
  const nameKey = `ev.name.${state.planned}`;
  if (remaining <= EVENT_SCHEDULE.announceLead5Ms && state.announced5 !== state.nextAt) {
    state.announced5 = state.nextAt;
    titleAllNamed("ev.sched.5.title", nameKey);
    soundAll("random.orb", 0.9);
    persist();
  }
  if (remaining <= EVENT_SCHEDULE.announceLead1Ms && state.announced1 !== state.nextAt) {
    state.announced1 = state.nextAt;
    titleAllNamed("ev.sched.1.title", nameKey);
    soundAll("random.orb", 1.2);
    persist();
  }
};

const recover = (): void => {
  const active = state.active;
  if (!active) return;
  const now = Date.now();
  if (now < active.endsAt) {
    try {
      HANDLERS[active.id].resume?.(active);
    } catch (error) {
      log.error("events", `resume ${active.id}: ${String(error)}`);
    }
    announce("ev.resume", {});
    audit("system", "event-resume", active.id, `осталось ${Math.round((active.endsAt - now) / 1000)}с`);
    return;
  }
  const handler = HANDLERS[active.id];
  try {
    handler.finish(active, "recover");
  } catch (error) {
    log.error("events", `recover ${active.id}: ${String(error)}`);
  }
  state.history.push(active.id);
  if (state.history.length > 12) state.history = state.history.slice(-12);
  state.active = undefined;
  state.lastFinishedAt = now;
  state.nextAt = now + EVENT_SCHEDULE.intervalMs;
  state.planned = pickPlanned();
  state.postponed = 0;
  state.announced5 = 0;
  state.announced1 = 0;
  announce("ev.recovered", {});
  audit("system", "event-recover", active.id, "ивент истёк во время простоя");
  persist();
};

export const initEvents = (): void => {
  if (initialized) return;
  initialized = true;
  const loaded = loadWorldJson<PersistentEvents | undefined>(STORE_KEYS.events, undefined);
  if (loaded) {
    state = {
      history: Array.isArray(loaded.history) ? loaded.history.filter((id) => isEventId(id)) : [],
      nextAt: typeof loaded.nextAt === "number" ? loaded.nextAt : 0,
      planned: isEventId(String(loaded.planned)) ? loaded.planned : "airdrop",
      postponed: typeof loaded.postponed === "number" ? loaded.postponed : 0,
      active: loaded.active && isEventId(String(loaded.active.id)) ? loaded.active : undefined,
      announced5: typeof loaded.announced5 === "number" ? loaded.announced5 : 0,
      announced1: typeof loaded.announced1 === "number" ? loaded.announced1 : 0,
      emptySince: 0,
      lastFinishedAt: typeof loaded.lastFinishedAt === "number" ? loaded.lastFinishedAt : 0,
      pending: Array.isArray(loaded.pending) ? loaded.pending : [],
    };
    loadPending(state.pending);
  }
  if (state.nextAt === 0) state.nextAt = Date.now() + EVENT_SCHEDULE.intervalMs;
  recover();
  world.afterEvents.entityDie.subscribe((event) => {
    const attacker = event.damageSource.damagingEntity;
    hotEventHooks.entityDie(event.deadEntity, attacker instanceof Player ? attacker : undefined);
  });
  world.afterEvents.entityHurt.subscribe((event) => {
    const attacker = event.damageSource.damagingEntity;
    if (!(attacker instanceof Player)) return;
    hotEventHooks.entityHurt(event.hurtEntity, attacker, event.damage);
  });
  world.afterEvents.playerBreakBlock.subscribe((event) => {
    hotEventHooks.blockBreak(event.player, event.brokenBlockPermutation.type.id, event.block.location);
  });
  world.afterEvents.playerSpawn.subscribe((event) => {
    if (!event.initialSpawn) return;
    const granted = flushPendingFor(event.player);
    if (granted !== 0) persist();
    if (state.active) {
      announceTo(event.player, "ev.activeNow", { name: EVENT_LABELS[state.active.id].ru });
    }
  });
  registerTask("events-scheduler", 20, 5, () => tickEvents(Date.now()));
  log.info("events", `инициализировано, план: ${state.planned}, активен: ${state.active?.id ?? "нет"}`);
};

const hotEventHooks = {
  entityDie(deadEntity: Entity, killer: Player | undefined): void {
    handleEntityDie(deadEntity, killer);
  },
  entityHurt(entity: Entity, attacker: Player, damage: number): void {
    const active = state.active;
    if (!active) return;
    try {
      HANDLERS[active.id].onEntityHurt?.(active, entity, attacker, damage);
    } catch (error) {
      log.error("events", `entityHurt ${active.id}: ${String(error)}`);
    }
  },
  blockBreak(player: Player, blockTypeId: string, location: { x: number; y: number; z: number }): void {
    const active = state.active;
    if (!active) return;
    try {
      HANDLERS[active.id].onPlayerBreakBlock?.(active, player, blockTypeId, location);
    } catch (error) {
      log.error("events", `blockBreak ${active.id}: ${String(error)}`);
    }
  },
};
