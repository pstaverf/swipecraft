import { Player } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { safeRunAsync } from "../kernel/guard";
import { t } from "../kernel/i18n";
import { DONATIONS } from "../meta/config";
import type { DonorTier } from "../types/domain";
import { busyNote, labelIndex, numOf, onlinePlayers, report } from "./common";
import {
  applyTier,
  catalogLines,
  decideRequest,
  donorDaysLeft,
  donorReport,
  donorTiers,
  grantLines,
  openRequests,
  queueReport,
  releaseAll,
  requestLines,
  revokeTier,
  submitRequest,
  tierInfo,
  tierOf,
} from "../meta/donations";
import { openMetaAdmin } from "./admin-meta";
import { openMenu } from "./menu";

const isDonorTier = (value: string | undefined): value is DonorTier =>
  value !== undefined && (donorTiers() as string[]).includes(value);

const text = (value: string): { ok: boolean; key: string; params: Record<string, string> } => ({
  ok: true,
  key: "common.raw",
  params: { text: value },
});

const openApply = async (player: Player, tier: DonorTier): Promise<void> => {
  await safeRunAsync("ui:donate:apply", async () => {
    const info = tierInfo(tier);
    const form = new ModalFormData()
      .title(`${t(player, "ui.donate.apply")} · ${info.price} ${DONATIONS.currency}`)
      .textField(`${t(player, "ui.donate.days")} · ${DONATIONS.minDays}…${DONATIONS.maxDays}`, String(info.days), {
        defaultValue: String(info.days),
      })
      .textField(t(player, "ui.note"), "Discord / ID", { defaultValue: "" })
      .submitButton(t(player, "ui.confirm"));

    const response = await form.show(player);
    if (response.canceled || !response.formValues) {
      busyNote(player, response);
      return;
    }
    const days = Math.min(DONATIONS.maxDays, Math.max(DONATIONS.minDays, numOf(response.formValues[0], info.days)));
    player.sendMessage(submitRequest(player, tier, days, String(response.formValues[1] ?? "").slice(0, 90)));
  });
};

export const openDonate = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:donate", async () => {
    const tiers = donorTiers().filter((row) => row !== "none");
    const actions = [...tiers, "log", "menu"];
    const myRequests = openRequests().filter((row) => row.playerId === player.id);
    const form = new ActionFormData()
      .title(t(player, "ui.donate"))
      .body([...catalogLines(player), `${t(player, "ui.donate.my")}: ${myRequests.length}`].join("\n").slice(0, 1800));
    for (const tier of tiers) {
      const info = tierInfo(tier);
      form.button(`${tier} · ${info.price} ${DONATIONS.currency} · ${info.days} ${t(player, "ui.days")}`);
    }
    form.button(t(player, "ui.donate.log"));
    form.button(t(player, "ui.menu"));

    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    const action = actions[response.selection];
    if (action === "log") {
      const lines = myRequests.map((row) => `#${row.id} · ${row.tier} · ${row.days} ${t(player, "ui.days")} · ${row.status}`);
      if (lines.length === 0) lines.push(t(player, "ui.pick.none"));
      lines.push(t(player, "don.you", { tier: tierOf(player), days: donorDaysLeft(player), keys: 0 }));
      player.sendMessage(lines.join("\n"));
      return;
    }
    if (action === "menu" || action === undefined) {
      await openMenu(player);
      return;
    }
    if (isDonorTier(action)) await openApply(player, action);
  });
};

const openDonDecision = async (player: Player, requestId: string): Promise<void> => {
  await safeRunAsync("ui:don:decision", async () => {
    const actions = ["approve", "decline", "back"];
    const form = new ActionFormData()
      .title(`#${requestId}`)
      .body(requestLines().join("\n").slice(0, 1200))
      .button(t(player, "ui.admin.don.approve"))
      .button(t(player, "ui.admin.don.decline"))
      .button(t(player, "ui.admin.don"));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    const action = actions[response.selection];
    if (action === "back") {
      await openDonRequests(player);
      return;
    }
    player.sendMessage(decideRequest(player.name, requestId, action === "approve"));
  });
};

export const openDonRequests = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:don:requests", async () => {
    const open = openRequests();
    const actions: string[] = [];
    const form = new ActionFormData().title(t(player, "ui.admin.don")).body(requestLines().join("\n").slice(0, 1800));
    for (const row of open) {
      form.button(`${t(player, "ui.admin.don.approve")}/${t(player, "ui.admin.don.decline")} · #${row.id} ${row.player} · ${row.tier}`);
      actions.push(row.id);
    }
    form.button(t(player, "ui.admin.don.log"));
    actions.push("log");
    form.button(t(player, "ui.admin.don"));
    actions.push("back");

    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    const action = actions[response.selection];
    if (action === "log") {
      player.sendMessage(grantLines(20).join("\n"));
      return;
    }
    if (action === "back" || action === undefined) {
      await openDonAdmin(player);
      return;
    }
    await openDonDecision(player, action);
  });
};

const pickRevoked = async (player: Player): Promise<Player | undefined> => {
  const candidates = onlinePlayers().filter((row) => tierOf(row) !== "none");
  if (candidates.length === 0) {
    player.sendMessage(t(player, "ui.pick.none"));
    return undefined;
  }
  const form = new ActionFormData().title(t(player, "ui.admin.don.revoke"));
  for (const row of candidates) form.button(`${row.name} · ${tierOf(row)}`);
  const response = await form.show(player);
  if (response.canceled || response.selection === undefined) {
    busyNote(player, response);
    return undefined;
  }
  return candidates[response.selection];
};

const openDonGrant = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:don:grant", async () => {
    const candidates = onlinePlayers();
    const tiers = donorTiers();
    if (candidates.length === 0) {
      player.sendMessage(t(player, "ui.err.noPlayer"));
      return;
    }
    const form = new ModalFormData()
      .title(t(player, "ui.admin.don.grant"))
      .dropdown(t(player, "ui.pick.player"), candidates.map((row) => row.name), { defaultValueIndex: 0 })
      .dropdown(t(player, "ui.donate.tier"), tiers, { defaultValueIndex: 1 })
      .textField(`${t(player, "ui.donate.days")} · ${DONATIONS.minDays}…${DONATIONS.maxDays}`, String(tierInfo("bronze").days), {
        defaultValue: String(tierInfo("bronze").days),
      })
      .textField(t(player, "ui.note"), "manual", { defaultValue: "manual" })
      .submitButton(t(player, "ui.confirm"));

    const response = await form.show(player);
    if (response.canceled || !response.formValues) {
      busyNote(player, response);
      return;
    }
    const values = response.formValues;
    const target = candidates.find((row) => row.name === String(values[0] ?? ""));
    const chosen = tiers[labelIndex(tiers as unknown as string[], values[1])];
    if (!target || chosen === undefined) {
      player.sendMessage(t(player, "ui.errInput"));
      return;
    }
    const days = numOf(values[2], tierInfo(chosen).days);
    const note = String(values[3] ?? "").slice(0, 90);
    report(player, text(applyTier(player.name, target.id, target.name, chosen, days, note)));
  });
};

export const openDonAdmin = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:don:admin", async () => {
    const actions = ["requests", "grant", "revoke", "log", "queue", "release", "back"];
    const form = new ActionFormData()
      .title(t(player, "ui.admin.don"))
      .body([...donorReport(), ...queueReport()].join("\n").slice(0, 1800))
      .button(`${t(player, "ui.admin.don")} · ${openRequests().length}`)
      .button(t(player, "ui.admin.don.grant"))
      .button(t(player, "ui.admin.don.revoke"))
      .button(t(player, "ui.admin.don.log"))
      .button(t(player, "ui.admin.queue"))
      .button(t(player, "ui.admin.queue.release"))
      .button(t(player, "ui.admin.meta"));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    switch (actions[response.selection]) {
      case "requests":
        await openDonRequests(player);
        return;
      case "grant":
        await openDonGrant(player);
        return;
      case "revoke": {
        const target = await pickRevoked(player);
        if (target) report(player, text(revokeTier(player.name, target)));
        return;
      }
      case "log":
        player.sendMessage(grantLines(24).join("\n"));
        return;
      case "queue":
        player.sendMessage([...queueReport(), ...donorReport()].join("\n"));
        return;
      case "release":
        player.sendMessage(t(player, "ui.admin.queue.released", { count: releaseAll() }));
        return;
      default:
        await openMetaAdmin(player);
    }
  });
};
