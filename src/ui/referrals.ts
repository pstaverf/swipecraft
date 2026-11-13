import { Player } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { safeRunAsync } from "../kernel/guard";
import { t } from "../kernel/i18n";
import { COSMETIC_CASE } from "../meta/config";
import {
  buyCosmetic,
  cosmeticCatalog,
  cosmeticsOf,
  catalogLines as cosmeticsCatalogLines,
  equipCosmetic,
  purchaseHistory,
  rollCosmetics,
} from "../meta/cosmetics";
import type { CosmeticKind } from "../types/domain";
import { metaOf } from "../meta/economy";
import { bindCode, codeOf, referralSummary } from "../meta/referrals";
import { busyNote, labelIndex, report } from "./common";
import { openMenu } from "./menu";
import "./messages";

const KINDS: CosmeticKind[] = ["trail", "prefix", "suffix", "join"];

interface Row {
  label: string;
  kind: string;
  id: string;
}

export const openCosmetics = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:cosmetics", async () => {
    const state = cosmeticsOf(player);
    const catalog = cosmeticCatalog();
    const rows: Row[] = [];
    if (state.rolls > 0) rows.push({ label: t(player, "cos.roll.button", { rolls: state.rolls }), kind: "roll", id: "" });
    rows.push({ label: `${t(player, "cos.case.button")} · ${COSMETIC_CASE.priceCoins} ₡`, kind: "buycase", id: "" });
    for (const row of catalog.filter((item) => !state.owned.includes(item.id))) {
      rows.push({ label: `${row.label} · ${row.priceCoins} ₡`, kind: "buy", id: row.id });
    }
    for (const row of catalog.filter((item) => state.owned.includes(item.id))) {
      const equipped = state.equipped[row.kind] === row.id;
      rows.push({ label: `${equipped ? "✓" : "·"} ${row.label}`, kind: equipped ? `clear:${row.kind}` : "equip", id: row.id });
    }
    rows.push({ label: t(player, "cos.history.button"), kind: "history", id: "" });
    rows.push({ label: t(player, "ui.menu"), kind: "menu", id: "" });

    const form = new ActionFormData()
      .title(t(player, "ui.cosmetics"))
      .body(cosmeticsCatalogLines(player).join("\n").slice(0, 1800));
    for (const row of rows) form.button(row.label);

    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    const action = rows[response.selection];
    if (!action) return;
    if (action.kind === "menu") {
      await openMenu(player);
      return;
    }
    if (action.kind === "history") {
      player.sendMessage(purchaseHistory(player).join("\n").slice(0, 900));
      return;
    }
    if (action.kind === "roll") {
      const result = rollCosmetics(player, state.rolls, true);
      report(player, result);
      if (result.lines && result.lines.length > 0) player.sendMessage(result.lines.join("\n").slice(0, 900));
      return;
    }
    if (action.kind === "buycase") {
      await openRollConfirm(player);
      return;
    }
    if (action.kind === "buy") {
      report(player, buyCosmetic(player, action.id));
      return;
    }
    if (action.kind === "equip") {
      const row = cosmeticCatalog().find((candidate) => candidate.id === action.id);
      if (row) report(player, equipCosmetic(player, row.kind, row.id));
      return;
    }
    if (action.kind.startsWith("clear:")) {
      report(player, equipCosmetic(player, action.kind.slice(6) as (typeof KINDS)[number], ""));
    }
  });
};

const openRollConfirm = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:cosmetics:roll", async () => {
    const counts = [1, 2, 3, 5];
    const labels = counts.map((count) => `${count} × ${COSMETIC_CASE.priceCoins} ₡`);
    const form = new ModalFormData()
      .title(t(player, "cos.case.title"))
      .dropdown(t(player, "cos.count"), labels, { defaultValueIndex: 0 })
      .submitButton(t(player, "ui.confirm"));
    const response = await form.show(player);
    if (response.canceled || !response.formValues) {
      busyNote(player, response);
      return;
    }
    const index = labelIndex(labels, response.formValues[0], 0);
    const result = rollCosmetics(player, counts[index] ?? 1, false);
    report(player, result);
    if (result.lines && result.lines.length > 0) player.sendMessage(result.lines.join("\n").slice(0, 900));
  });
};

export const openReferral = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:referral", async () => {
    const code = codeOf(player);
    const actions = ["copy", "enter", "menu"];
    const form = new ActionFormData()
      .title(t(player, "ui.ref"))
      .body(referralSummary(player).join("\n").slice(0, 1800))
      .button(t(player, "ref.showCode"))
      .button(t(player, "ref.enter"))
      .button(t(player, "ui.menu"));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    const action = actions[response.selection];
    if (action === "menu") {
      await openMenu(player);
      return;
    }
    if (action === "copy") {
      player.sendMessage(
        code.length > 0 ? `${t(player, "ref.copyHint", { code })}\n${t(player, "ref.copyRule")}` : t(player, "ref.noCode"),
      );
      return;
    }
    if (metaOf(player).refBy.length > 0) {
      player.sendMessage(t(player, "ref.exists"));
      return;
    }
    const modal = new ModalFormData()
      .title(t(player, "ref.enter"))
      .textField(t(player, "ref.field"), "abcdef23", { defaultValue: "" })
      .submitButton(t(player, "ui.confirm"));
    const filled = await modal.show(player);
    if (filled.canceled || !filled.formValues) {
      busyNote(player, filled);
      return;
    }
    report(player, bindCode(player, String(filled.formValues[0] ?? "")));
  });
};
