import { Player } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { safeRunAsync } from "../kernel/guard";
import { t } from "../kernel/i18n";
import { QUESTS } from "../meta/config";
import { busyNote, report } from "./common";
import { claimDaily, claimQuest, dailyState, progressSummary } from "../meta/progress";
import { metaOf } from "../meta/economy";
import { openMenu } from "./menu";

const claimableQuests = (player: Player): string[] => {
  const meta = metaOf(player);
  return QUESTS.filter((quest) => (meta.quests[quest.id] ?? 0) >= quest.target && meta.claimedQuests[quest.id] === undefined).map((quest) => quest.id);
};

export const openProgress = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:progress", async () => {
    const state = dailyState(player);
    const claims = claimableQuests(player);
    const actions = ["daily", ...claims, "menu"];
    const form = new ActionFormData().title(t(player, "ui.progress")).body(progressSummary(player).join("\n").slice(0, 1800));
    form.button(`${t(player, "ui.daily")}${state.ready ? " §a●" : ""}`);
    for (const questId of claims) {
      const quest = QUESTS.find((candidate) => candidate.id === questId);
      form.button(`${t(player, "ui.quest.claim")} · ${quest?.label ?? questId}`);
    }
    form.button(t(player, "ui.menu"));

    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    const action = actions[response.selection];
    if (action === "daily") {
      report(player, claimDaily(player));
      return;
    }
    if (action === "menu" || action === undefined) {
      await openMenu(player);
      return;
    }
    report(player, claimQuest(player, action));
  });
};
