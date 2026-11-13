import { InputPermissionCategory, Player, world } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { safeRunAsync } from "../kernel/guard";
import { t } from "../kernel/i18n";
import { breakerReport } from "../kernel/guard";
import { log } from "../kernel/logger";
import { tickerReport } from "../kernel/ticker";
import { clearBan, getProfile, setBanned } from "../meta/profiles";
import { changeAcParam, acRuntimeSummary, acScores, getAcConfig, resetAcConfig } from "../security/anticheat";
import { audit, auditReport, recentAudit } from "../security/audit";
import { borderInfo, borderRadius } from "../world/border";
import { armWipe, disarmWipe, getSeason, seasonStatus } from "../world/season";
import { isAdmin, openMenu } from "./menu";
import { EVENT_IDS, eventName, eventsStatus, startEvent, stopEvent } from "../events/manager";

const DETECTORS = ["reach", "attackRate", "speed", "fly", "nuke", "placeRate", "containerSpam", "entitySpam", "stackAnomaly"];

const kickPlayer = (player: Player, reason: string): void => {
  try {
    player.runCommand(`kick @s ${reason}`.slice(0, 250));
    return;
  } catch {
    try {
      player.remove();
    } catch {
      return;
    }
  }
};

const freezePlayer = (player: Player): void => {
  try {
    player.inputPermissions.setPermissionCategory(InputPermissionCategory.Movement, false);
    player.inputPermissions.setPermissionCategory(InputPermissionCategory.Camera, false);
    audit("admin", "freeze", player.name, "ввод отключён");
  } catch (error) {
    log.error("admin", `freeze: ${String(error)}`);
  }
};

const unfreezePlayer = (player: Player): void => {
  try {
    player.inputPermissions.setPermissionCategory(InputPermissionCategory.Movement, true);
    player.inputPermissions.setPermissionCategory(InputPermissionCategory.Camera, true);
  } catch {
    return;
  }
};

export const openAdminPanel = async (player: Player): Promise<void> => {
  if (!isAdmin(player)) {
    player.sendMessage(t(player, "admin.noPermission"));
    return;
  }
  await safeRunAsync("ui:admin", async () => {
    const form = new ActionFormData()
      .title(t(player, "admin.title"))
      .body(seasonStatus())
      .button(t(player, "admin.anticheat"))
      .button(t(player, "admin.config"))
      .button(t(player, "admin.audit"))
      .button(t(player, "admin.sanctions"))
      .button(t(player, "admin.season"))
      .button(t(player, "admin.border"))
      .button(t(player, "admin.events"))
      .button(t(player, "admin.modules"))
      .button(t(player, "common.back"));

    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) return;

    switch (response.selection) {
      case 0:
        await openScores(player);
        return;
      case 1:
        await openConfig(player);
        return;
      case 2:
        await openAudit(player);
        return;
      case 3:
        await openSanctions(player);
        return;
      case 4:
        await openSeason(player);
        return;
      case 5:
        await openBorder(player);
        return;
      case 6:
        await openEvents(player);
        return;
      case 7:
        await openModules(player);
        return;
      default:
        await openMenu(player);
    }
  });
};

const openScores = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:admin:scores", async () => {
    const scores = acScores();
    if (scores.length === 0) {
      player.sendMessage(t(player, "admin.noScores"));
      return;
    }
    const form = new ActionFormData().title(t(player, "admin.anticheat"));
    for (const row of scores) form.button(`${row.name} — ${row.score}\n${row.flags}`);
    form.button(t(player, "common.back"));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) return;
    if (response.selection >= scores.length) {
      await openAdminPanel(player);
      return;
    }
    const selected = scores[response.selection];
    if (!selected) return;
    const target = world.getAllPlayers().find((candidate) => candidate.name === selected.name);
    if (!target) return;
    await openPlayerActions(player, target);
  });
};

const openPlayerActions = async (admin: Player, target: Player): Promise<void> => {
  const profile = getProfile(target);
  await safeRunAsync("ui:admin:player", async () => {
    const form = new ActionFormData()
      .title(target.name)
      .body(
        `скор: ${Math.round(profile.acScore)}\nфлаги: ${Object.entries(profile.flags)
          .map(([key, value]) => `${key}:${value}`)
          .join(" ")}`,
      )
      .button(t(admin, "admin.kick"))
      .button(t(admin, "admin.ban"))
      .button(t(admin, "admin.freeze"))
      .button(t(admin, "admin.unban"))
      .button(t(admin, "common.back"));

    const response = await form.show(admin);
    if (response.canceled || response.selection === undefined) return;
    switch (response.selection) {
      case 0:
        kickPlayer(target, "manual moderation");
        audit(admin.name, "kick", target.name, "вручную из админ-меню");
        break;
      case 1:
        setBanned(target, "manual moderation", 0);
        audit(admin.name, "ban", target.name, "вручную из админ-меню");
        kickPlayer(target, "banned");
        break;
      case 2:
        freezePlayer(target);
        break;
      case 3:
        clearBan(target);
        audit(admin.name, "unban", target.name, "вручную из админ-меню");
        break;
      default:
        await openAdminPanel(admin);
        return;
    }
    admin.sendMessage(t(admin, "admin.done"));
  });
};

const openConfig = async (player: Player): Promise<void> => {
  const config = getAcConfig();
  await safeRunAsync("ui:admin:config", async () => {
    const form = new ModalFormData()
      .title(t(player, "admin.config"))
      .slider("Порог тревоги", 10, 200, { defaultValue: config.threshold, valueStep: 5 })
      .slider("Затухание в минуту", 0, 20, { defaultValue: config.decayPerMinute, valueStep: 1 })
      .slider("Cooldown тревоги, сек", 30, 1800, { defaultValue: Math.round(config.alertCooldownMs / 1000), valueStep: 30 })
      .dropdown("Детектор для правки", DETECTORS, { defaultValueIndex: 0 })
      .slider("Вес детектора", 1, 50, { defaultValue: 12, valueStep: 1 })
      .slider("Порог hits", 1, 40, { defaultValue: 3, valueStep: 1 })
      .slider("Tolerance x10", 0, 40, { defaultValue: 12, valueStep: 1 })
      .toggle("Детектор включён", { defaultValue: true })
      .submitButton(t(player, "admin.done"));

    const response = await form.show(player);
    if (response.canceled || !response.formValues) return;

    const values = response.formValues;
    changeAcParam("threshold", String(values[0]));
    changeAcParam("decayPerMinute", String(values[1]));
    changeAcParam("alertCooldownMs", String(Number(values[2]) * 1000));
    const detector = DETECTORS[Number(values[3])] ?? DETECTORS[0];
    changeAcParam(`detectors.${detector}.weight`, String(values[4]));
    changeAcParam(`detectors.${detector}.hits`, String(values[5]));
    changeAcParam(`detectors.${detector}.tolerance`, String(Number(values[6]) / 10));
    changeAcParam(`detectors.${detector}.enabled`, values[7] ? "true" : "false");

    player.sendMessage(t(player, "admin.saved"));
    player.sendMessage(acRuntimeSummary().slice(0, 4).join("\n"));
  });
};

const openAudit = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:admin:audit", async () => {
    const entries = recentAudit(12);
    const body = entries.length === 0 ? t(player, "admin.auditEmpty") : auditReport(12).join("\n");
    const form = new ActionFormData().title(t(player, "admin.audit")).body(body).button(t(player, "common.back"));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) return;
    await openAdminPanel(player);
  });
};

const openSanctions = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:admin:sanctions", async () => {
    const players = world.getAllPlayers();
    if (players.length === 0) {
      player.sendMessage(t(player, "admin.playerNotFound"));
      return;
    }
    const form = new ActionFormData().title(t(player, "admin.sanctions"));
    for (const target of players) form.button(`${target.name}\nскор ${getProfile(target).acScore}`);
    form.button(t(player, "common.back"));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) return;
    if (response.selection >= players.length) {
      await openAdminPanel(player);
      return;
    }
    await openPlayerActions(player, players[response.selection]);
  });
};

const openSeason = async (player: Player): Promise<void> => {
  const season = getSeason();
  await safeRunAsync("ui:admin:season", async () => {
    const form = new ActionFormData()
      .title(t(player, "admin.season"))
      .body(`${seasonStatus()}\nкод: ${season.code || "-"}`)
      .button(t(player, "admin.armed"))
      .button(t(player, "admin.disarm"))
      .button(t(player, "common.back"));

    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) return;
    if (response.selection === 0) {
      const modal = new ModalFormData()
        .title(t(player, "admin.confirmCode"))
        .textField("Введи WIPE для подтверждения", "WIPE", { defaultValue: "" })
        .submitButton(t(player, "admin.done"));
      const modalResponse = await modal.show(player);
      if (modalResponse.canceled || !modalResponse.formValues) return;
      const confirmation = String(modalResponse.formValues[0] ?? "");
      const result = armWipe(player, confirmation);
      player.sendMessage(result.ok ? `${t(player, "admin.armed")}\nкод: ${result.code}` : "нужно ввести WIPE");
      return;
    }
    if (response.selection === 1) {
      disarmWipe(player, "manual");
      player.sendMessage(t(player, "season.disarmed"));
      return;
    }
    await openAdminPanel(player);
  });
};

const openBorder = async (player: Player): Promise<void> => {
  const info = borderInfo();
  await safeRunAsync("ui:admin:border", async () => {
    const form = new ActionFormData()
      .title(t(player, "admin.border"))
      .body(
        `радиус: ${borderRadius()}\nнеделя: ${info.week}\nобновлено: ${new Date(info.updatedAt).toISOString().slice(0, 16).replace("T", " ")}`,
      )
      .button(t(player, "common.back"));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) return;
    await openAdminPanel(player);
  });
};

const openEvents = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:admin:events", async () => {
    const form = new ActionFormData().title(t(player, "admin.events")).body(eventsStatus().join("\n"));
    for (const id of EVENT_IDS) form.button(`▶ ${eventName(id)}`);
    form.button(t(player, "admin.eventStop"));
    form.button(t(player, "common.back"));

    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) return;
    if (response.selection < EVENT_IDS.length) {
      const id = EVENT_IDS[response.selection];
      const message = startEvent(id, true, player.name);
      player.sendMessage(message);
      audit(player.name, "event-start-ui", id, "из админ-меню");
      return;
    }
    if (response.selection === EVENT_IDS.length) {
      player.sendMessage(stopEvent(player.name));
      return;
    }
    await openAdminPanel(player);
  });
};

const openModules = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:admin:modules", async () => {
    const body = [...tickerReport(), ...breakerReport()].join("\n").slice(0, 900);
    const form = new ActionFormData().title(t(player, "admin.modules")).body(body || "-").button(t(player, "common.back"));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) return;
    await openAdminPanel(player);
  });
};

export const adminResetAcConfig = (): void => {
  resetAcConfig();
};

export const findByTag = (tag: string): Player[] => world.getAllPlayers().filter((candidate) => candidate.hasTag(tag));
