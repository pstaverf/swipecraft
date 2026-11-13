import { Player } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { safeRunAsync } from "../kernel/guard";
import { t } from "../kernel/i18n";
import { CURRENCY, TRANSFERS } from "../meta/config";
import { byName, busyNote, numOf, onlinePlayers, report } from "./common";
import { balance, canTransfer, getTunables, lockedBalance, sellHeld, transfer, walletLines } from "../meta/economy";
import { leaderboardLines } from "../meta/progress";
import { openProgress } from "./progress";
import { openMenu } from "./menu";

export const openTop = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:top", async () => {
    const kinds = ["kills", "coins", "points"] as const;
    const labels = [t(player, "ui.top.kills"), t(player, "ui.top.coins"), t(player, "ui.top.points")];
    const form = new ActionFormData().title(t(player, "ui.top")).body(labels.join("\n"));
    for (const label of labels) form.button(label);
    form.button(t(player, "ui.close"));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    const kind = kinds[response.selection];
    if (!kind) return;
    player.sendMessage(leaderboardLines(player, kind).join("\n"));
  });
};

const openTransferForm = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:transfer", async () => {
    const candidates = onlinePlayers(player.id).map((candidate) => candidate.name);
    if (candidates.length === 0) {
      player.sendMessage(t(player, "ui.err.noPlayer"));
      return;
    }
    const tunables = getTunables();
    const amountLabel = `${t(player, "ui.amount")} ${CURRENCY.symbol} · ${t(player, "eco.transfer.min", { min: TRANSFERS.minAmount })} · ${t(player, "eco.transfer.max", { max: tunables.maxTransferPerTx })}`;
    const form = new ModalFormData()
      .title(t(player, "ui.transfer"))
      .dropdown(t(player, "ui.pick.player"), candidates, { defaultValueIndex: 0 })
      .textField(amountLabel, "1000", { defaultValue: "1000" })
      .submitButton(t(player, "ui.confirm"));

    const response = await form.show(player);
    if (response.canceled || !response.formValues) {
      busyNote(player, response);
      return;
    }
    const values = response.formValues;
    const target = byName(String(values[0] ?? ""));
    const amount = numOf(values[1], 0);
    if (!target || amount <= 0) {
      player.sendMessage(t(player, "ui.errInput"));
      return;
    }
    report(player, transfer(player, target, amount));
  });
};

const openSellHeld = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:wallet:sell", async () => {
    const form = new ModalFormData()
      .title(t(player, "ui.sell.held"))
      .textField(`${t(player, "ui.amount")} — 1…64`, "1", { defaultValue: "1" })
      .submitButton(t(player, "ui.confirm"));
    const response = await form.show(player);
    if (response.canceled || !response.formValues) {
      busyNote(player, response);
      return;
    }
    report(player, sellHeld(player, numOf(response.formValues[0], 1)));
    player.sendMessage(
      t(player, "eco.wallet.balance", {
        coins: balance(player),
        locked: lockedBalance(player),
        symbol: CURRENCY.symbol,
      }),
    );
  });
};

export const openWallet = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:wallet", async () => {
    const form = new ActionFormData()
      .title(t(player, "ui.wallet"))
      .body(walletLines(player).join("\n").slice(0, 1800))
      .button(t(player, "ui.transfer"))
      .button(t(player, "ui.sell.held"))
      .button(t(player, "ui.progress"))
      .button(t(player, "ui.top"))
      .button(t(player, "ui.menu"));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    if (response.selection === 0) {
      await openTransferForm(player);
      return;
    }
    if (response.selection === 1) {
      await openSellHeld(player);
      return;
    }
    if (response.selection === 2) {
      await openProgress(player);
      return;
    }
    if (response.selection === 3) {
      await openTop(player);
      return;
    }
    await openMenu(player);
  });
};
