import { Player } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { CONFIG } from "../config";
import { safeRunAsync } from "../kernel/guard";
import { t } from "../kernel/i18n";
import { metaChangeParam } from "../meta/index";
import { CURRENCY } from "../meta/config";
import { getTunables } from "../meta/economy";
import {
  canPlaceQuarry,
  closeQuarry,
  collectQuarry,
  createQuarry,
  findQuarry,
  listQuarries,
  quarryAdminLines,
  quarryCells,
  quarryLines,
  quarryItems,
  quarryShape,
  quarrySummary,
  releaseQuarry,
  teleportToQuarry,
} from "../world/quarry";
import { checkSpawnIntegrity, spawnBlueprint, spawnPreviewLines, spawnStatus, startSpawnBuild, spawnStatusLines, setSpawnPoint } from "../world/spawnbuild";
import { openMenu } from "./menu";
import { busyNote, report } from "./common";
import "../world/messages";

type Entry = { readonly key: string; readonly action: string; readonly params?: Record<string, string | number> };

/**
 * Подписи и действия карьерного экрана живут в одном списке (§5.6 ARCHITECTURE): кнопка
 * «Забрать добычу» физически не может оказаться привязанной к «Закрыть карьер».
 */
const QUARRY_OWN_ENTRIES: readonly Entry[] = [
  { key: "quarry.collect", action: "collect" },
  { key: "quarry.go", action: "go" },
  { key: "quarry.close", action: "close" },
  { key: "quarry.how", action: "how" },
];
const QUARRY_FREE_ENTRIES: readonly Entry[] = [{ key: "quarry.how", action: "how" }];
const START_ENTRY: Entry = { key: "quarry.start", action: "start" };
const BACK_ENTRY: Entry = { key: "ui.menu", action: "back" };
const BACK_TO_WORLD: Entry = { key: "common.back", action: "back" };
const CONFIRM_ENTRIES: readonly Entry[] = [
  { key: "ui.confirm", action: "yes" },
  { key: "common.back", action: "back" },
];

const quarryBody = (player: Player): string => {
  const claim = findQuarry(player.id);
  if (claim) return quarryLines(player).join("\n");
  const shape = quarryShape();
  const can = canPlaceQuarry(player);
  const lines = [
    t(player, "quarry.body.none", {
      side: shape.side,
      depth: shape.depth,
      cells: quarryCells(),
      cost: CONFIG.quarry.setupCost,
      symbol: CURRENCY.symbol,
      stacks: CONFIG.quarry.bufferStacks,
    }),
  ];
  if (can.ok) lines.push(t(player, "quarry.ready", can.params));
  else lines.push(`§c${t(player, can.key, can.params)}`);
  return lines.join("\n");
};

const confirmLaunch = async (player: Player): Promise<void> => {
  const can = canPlaceQuarry(player);
  if (!can.ok) {
    report(player, { ok: false, key: can.key, params: can.params });
    return;
  }
  const form = new ActionFormData().title(t(player, "quarry.title")).body(t(player, "quarry.ready", can.params).slice(0, 1800));
  for (const entry of CONFIRM_ENTRIES) form.button(t(player, entry.key));
  const response = await form.show(player);
  if (response.canceled || response.selection === undefined) {
    busyNote(player, response);
    return;
  }
  if (CONFIRM_ENTRIES[response.selection]?.action === "yes") report(player, createQuarry(player));
};

export const openQuarry = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:quarry", async () => {
    const claim = findQuarry(player.id);
    const entries = [...(claim ? QUARRY_OWN_ENTRIES : [START_ENTRY, ...QUARRY_FREE_ENTRIES]), BACK_ENTRY];
    const form = new ActionFormData().title(t(player, "quarry.title")).body(quarryBody(player).slice(0, 1800));
    for (const entry of entries) {
      const params = entry.action === "collect" && claim ? { items: quarryItems(claim) } : entry.params;
      form.button(t(player, entry.key, params));
    }
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    switch (entries[response.selection]?.action) {
      case "collect":
        report(player, collectQuarry(player));
        return;
      case "go":
        report(player, teleportToQuarry(player));
        return;
      case "close":
        report(player, closeQuarry(player));
        return;
      case "start":
        await confirmLaunch(player);
        return;
      case "how":
        player.sendMessage(t(player, "quarry.info", { cost: CONFIG.quarry.setupCost, symbol: CURRENCY.symbol, stacks: CONFIG.quarry.bufferStacks }));
        return;
      default:
        await openMenu(player);
    }
  });
};

const SPAWN_ENTRIES: readonly Entry[] = [
  { key: "admin.world.spawn.preview", action: "preview" },
  { key: "admin.world.spawn.check", action: "check" },
  { key: "admin.world.spawn.repair", action: "repair" },
  { key: "admin.world.spawn.build", action: "build" },
  { key: "admin.world.spawn.point", action: "point" },
];

const openSpawnAdmin = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:admin:spawn", async () => {
    const entries = [...SPAWN_ENTRIES, BACK_TO_WORLD];
    const body = [...spawnStatusLines(player), `blueprint: ${spawnBlueprint().length} ячеек, за проход ≤ ${CONFIG.spawn.blocksPerRun}`];
    const form = new ActionFormData().title(t(player, "ui.admin.world.spawn")).body(body.join("\n").slice(0, 1800));
    for (const entry of entries) form.button(t(player, entry.key));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    const action = entries[response.selection]?.action;
    if (action === "preview") {
      player.sendMessage(spawnPreviewLines().join("\n").slice(0, 1800));
      return;
    }
    if (action === "check") {
      const check = checkSpawnIntegrity(true);
      player.sendMessage(
        t(player, "spawn.status", {
          done: spawnStatus().built,
          total: spawnStatus().total,
          cursor: spawnStatus().cursor,
          mode: t(player, spawnStatus().mode === "repair" ? "spawn.mode.repair" : "spawn.mode.build"),
          state: t(player, spawnStatus().running ? "spawn.state.running" : "spawn.state.idle"),
          missing: check.missing,
        }),
      );
      return;
    }
    if (action === "repair" || action === "build") {
      report(player, startSpawnBuild(player.name, action));
      return;
    }
    if (action === "point") {
      setSpawnPoint();
      report(player, { ok: true, key: "common.raw", params: { text: t(player, "spawn.point.set", { x: CONFIG.lobby.x, y: CONFIG.lobby.y, z: CONFIG.lobby.z }) } });
      return;
    }
    await openWorldMods(player);
  });
};

const QUARRY_ADMIN_BACK: Entry = BACK_TO_WORLD;

const MOD_TOGGLES: readonly { readonly key: string; readonly path: "queueEnabled" | "donorTrailsEnabled" | "quarryEnabled" }[] = [
  { key: "ui.admin.eco.queue", path: "queueEnabled" },
  { key: "ui.admin.eco.trails", path: "donorTrailsEnabled" },
  { key: "admin.world.quarry.toggle", path: "quarryEnabled" },
];

/**
 * Стоп-краны: три булева тумблера мира в одном списке (§5.6). Ничего не меняется молча —
 * применённые флаги печатаются, а «изменений нет» тоже ответ, а не тишина.
 */
const openModToggles = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:admin:mods", async () => {
    const tunables = getTunables();
    const form = new ModalFormData().title(t(player, "ui.admin.world.mods"));
    for (const toggle of MOD_TOGGLES) form.toggle(t(player, toggle.key), { defaultValue: Boolean(tunables[toggle.path]) });
    form.submitButton(t(player, "ui.confirm"));
    const response = await form.show(player);
    if (response.canceled || !response.formValues) {
      busyNote(player, response);
      return;
    }
    const values = response.formValues;
    const applied: string[] = [];
    const refused: string[] = [];
    MOD_TOGGLES.forEach((toggle, index) => {
      const raw = values[index];
      const next = raw === true || raw === "true";
      if (Boolean(tunables[toggle.path]) === next) return;
      const result = metaChangeParam(toggle.path, next ? "true" : "false");
      if (result.ok) applied.push(result.message);
      else refused.push(`${toggle.path}: ${result.message}`);
    });
    if (applied.length > 0) {
      for (const line of applied) report(player, { ok: true, key: "common.raw", params: { text: line } });
    } else if (refused.length === 0) {
      player.sendMessage(t(player, "admin.world.mods.none"));
    }
    if (refused.length > 0) player.sendMessage(t(player, "admin.world.mods.partial", { count: refused.length, detail: refused.join("; ") }));
  });
};

const openQuarryAdmin = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:admin:quarry", async () => {
    const rows = listQuarries();
    const entries: Entry[] = rows.map((claim) => ({
      key: "admin.quarry.release",
      action: `release:${claim.id}`,
      params: { id: claim.id, owner: claim.ownerName },
    }));
    entries.push(QUARRY_ADMIN_BACK);
    const form = new ActionFormData()
      .title(t(player, "ui.admin.world.quarry"))
      .body((rows.length === 0 ? t(player, "admin.quarry.none") : quarryAdminLines().join("\n")).slice(0, 1800));
    for (const entry of entries) form.button(t(player, entry.key, entry.params));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    const action = entries[response.selection]?.action;
    if (action?.startsWith("release:")) {
      report(player, releaseQuarry(player.name, action.slice("release:".length)));
      return;
    }
    await openWorldMods(player);
  });
};

const WORLD_ADMIN_ENTRIES: readonly Entry[] = [
  { key: "ui.admin.world.quarry", action: "quarry" },
  { key: "ui.admin.world.spawn", action: "spawn" },
  { key: "ui.admin.world.mods", action: "toggles" },
  { key: "ui.menu", action: "back" },
];

export const openWorldMods = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:admin:world", async () => {
    const summary = quarrySummary();
    const status = spawnStatus();
    const body = [
      t(player, "admin.world.quarry.line", {
        claims: summary.claims,
        online: summary.online,
        mined: summary.mined,
        items: summary.items,
        state: summary.enabled ? t(player, "admin.world.on") : t(player, "admin.world.off"),
      }),
      t(player, "admin.world.spawn.line", {
        done: status.built,
        total: status.total,
        mode: t(player, status.mode === "repair" ? "spawn.mode.repair" : "spawn.mode.build"),
        state: t(player, status.running ? "spawn.state.running" : "spawn.state.idle"),
        missing: status.missing,
      }),
      t(player, "admin.world.quarry.shape", { cells: quarryCells(), cost: CONFIG.quarry.setupCost, symbol: CURRENCY.symbol, max: CONFIG.quarry.maxClaims }),
    ].join("\n");
    const form = new ActionFormData().title(t(player, "ui.admin.world")).body(body.slice(0, 1800));
    for (const entry of WORLD_ADMIN_ENTRIES) form.button(t(player, entry.key));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    switch (WORLD_ADMIN_ENTRIES[response.selection]?.action) {
      case "quarry":
        await openQuarryAdmin(player);
        return;
      case "spawn":
        await openSpawnAdmin(player);
        return;
      case "toggles":
        await openModToggles(player);
        return;
      default:
        await openMenu(player);
    }
  });
};
