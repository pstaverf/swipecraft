import { Player } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { safeRunAsync } from "../kernel/guard";
import { t } from "../kernel/i18n";
import { CURRENCY, RANK_CASE } from "../meta/config";
import { getTunables } from "../meta/economy";
import { rankLines, rankOddsLines, rankStatus, rankTopLines, rollRanks } from "../meta/ranks";
import { busyNote } from "./common";
import { openMenu } from "./menu";
import "./messages";

/**
 * Кейс рангов. Один экран: сверху — что у игрока сейчас и сколько стоит крутка,
 * ниже — лестница и шансы. Кнопки и действия перечислены одним списком, чтобы
 * «меню разъехалось с действиями» было нельзя: см. соглашение в ui/menu.ts.
 */
const ACTIONS = ["one", "five", "menu"] as const;

export const openRanks = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:ranks", async () => {
    const gated = !getTunables().ranksEnabled;
    const body = [
      ...rankStatus(player),
      "",
      ...rankTopLines(player),
      "",
      t(player, "rank.ladder"),
      ...rankLines(player),
      "",
      ...rankOddsLines(player),
      ...(gated ? ["", `§c${t(player, "rank.off")}`] : []),
    ]
      .join("\n")
      .slice(0, 1800);
    const rollLabel = t(player, "rank.roll");
    const form = new ActionFormData()
      .title(`${t(player, "rank.title")} · ${player.name}`)
      .body(body)
      .button(`${rollLabel} ×1 · ${RANK_CASE.priceCoins} ${CURRENCY.symbol}`)
      .button(`${rollLabel} ×5 · ${RANK_CASE.priceCoins * 5} ${CURRENCY.symbol}`)
      .button(t(player, "ui.menu"));

    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    const action = ACTIONS[response.selection];
    if (action === "menu") {
      await openMenu(player);
      return;
    }
    const result = rollRanks(player, action === "five" ? 5 : 1);
    player.sendMessage(t(player, result.key, result.params));
    if (result.lines && result.lines.length > 0) player.sendMessage(result.lines.join("\n"));
    if (result.ok) await openRanks(player);
  });
};
