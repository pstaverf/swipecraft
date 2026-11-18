import { Player } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { safeRunAsync } from "../kernel/guard";
import { t } from "../kernel/i18n";
import { CURRENCY, CASE_ECONOMY, CASE_IDS } from "../meta/config";
import type { CaseId } from "../types/domain";
import { busyNote } from "./common";
import { caseLogFor, casePrice, oddsLines, openCase } from "../meta/cases";
import { openMenu } from "./menu";

const isCaseId = (value: string | undefined): value is CaseId => value !== undefined && (CASE_IDS as string[]).includes(value);

const fivePullPrice = (caseId: CaseId): number => {
  const price = casePrice(caseId);
  const percent = 100 - CASE_ECONOMY.fivePullDiscountPercent;
  return Math.max(1, Math.round((price.coins * 5 * percent) / 100));
};

const caseName = (player: Player, caseId: CaseId): string => t(player, `case.name.${caseId}`);

const pull = async (player: Player, caseId: CaseId, count: number, useKeys: boolean): Promise<void> => {
  const result = openCase(player, caseId, count, useKeys);
  player.sendMessage(t(player, result.key, result.params));
  if (result.lines && result.lines.length > 0) player.sendMessage(result.lines.join("\n"));
  if (result.ok) await openCaseDetail(player, caseId);
};

const openCaseDetail = async (player: Player, caseId: CaseId): Promise<void> => {
  await safeRunAsync("ui:case:detail", async () => {
    const price = casePrice(caseId);
    const actions = ["coins1", "coins5", "keys1", "log", "list", "menu"];
    const form = new ActionFormData()
      .title(`${caseName(player, caseId)} · ${price.coins} ${CURRENCY.symbol} / ${price.keys} ${t(player, "case.keys.word")}`)
      .body(oddsLines(player, caseId).join("\n").slice(0, 1800))
      .button(`${t(player, "ui.case.open.coins")} ×1 · ${price.coins} ${CURRENCY.symbol}`)
      .button(`${t(player, "ui.case.open.coins")} ×5 · ${fivePullPrice(caseId)} ${CURRENCY.symbol}`)
      .button(`${t(player, "ui.case.open.keys")} ×1 · ${price.keys}`)
      .button(t(player, "ui.case.log"))
      .button(t(player, "ui.cases"))
      .button(t(player, "ui.menu"));

    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    switch (actions[response.selection]) {
      case "coins1":
        await pull(player, caseId, 1, false);
        return;
      case "coins5":
        await pull(player, caseId, 5, false);
        return;
      case "keys1":
        await pull(player, caseId, 1, true);
        return;
      case "log":
        player.sendMessage(caseLogFor(player.name, 10).join("\n"));
        return;
      case "list":
        await openCases(player);
        return;
      default:
        await openMenu(player);
    }
  });
};

export const openCases = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:cases", async () => {
    const actions: string[] = [];
    const form = new ActionFormData().title(t(player, "ui.cases")).body(t(player, "case.note"));
    for (const caseId of CASE_IDS) {
      const price = casePrice(caseId);
      form.button(`${caseId === "basic" ? "§f" : "§d"}${caseName(player, caseId)} · ${price.coins} ${CURRENCY.symbol}${price.keys > 0 ? ` / ${price.keys} ${t(player, "case.keys.word")}` : ""}`);
      actions.push(caseId);
    }
    form.button(t(player, "ui.case.log"));
    actions.push("log");
    form.button(t(player, "ui.menu"));
    actions.push("menu");

    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    const action = actions[response.selection];
    if (action === "log") {
      player.sendMessage(caseLogFor(player.name, 12).join("\n"));
      return;
    }
    if (action === "menu") {
      await openMenu(player);
      return;
    }
    if (isCaseId(action)) await openCaseDetail(player, action);
  });
};
