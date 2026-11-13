import { Player } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { safeRunAsync } from "../kernel/guard";
import { getLang, setLang, t } from "../kernel/i18n";
import { formatDuration } from "../kernel/util";
import { getProfile, saveProfile } from "../meta/profiles";
import { randomTeleport } from "../world/rtp";
import { openAdminPanel } from "./admin";
import { openWallet } from "./economy";
import { openMarket } from "./market";
import { openCases } from "./cases";
import { openClan } from "./clans";
import { openProgress } from "./progress";
import { openDonate } from "./donations";
import "./messages";

export const isAdmin = (player: Player): boolean => player.hasTag("admin");

export const openMenu = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:menu", async () => {
    const actions = ["wallet", "market", "cases", "clan", "progress", "donate", "rtp", "rules", "stats", "lang"];
    if (isAdmin(player)) actions.push("admin");
    actions.push("close");

    const form = new ActionFormData()
      .title(t(player, "menu.title"))
      .body(t(player, "menu.body"))
      .button(t(player, "ui.wallet"))
      .button(t(player, "ui.market"))
      .button(t(player, "ui.cases"))
      .button(t(player, "ui.clan"))
      .button(t(player, "ui.progress"))
      .button(t(player, "ui.donate"))
      .button(t(player, "menu.rtp"))
      .button(t(player, "menu.rules"))
      .button(t(player, "menu.stats"))
      .button(t(player, "menu.lang"));

    if (isAdmin(player)) form.button(t(player, "menu.admin"));
    form.button(t(player, "menu.close"));

    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) return;

    switch (actions[response.selection]) {
      case "wallet":
        await openWallet(player);
        return;
      case "market":
        await openMarket(player);
        return;
      case "cases":
        await openCases(player);
        return;
      case "clan":
        await openClan(player);
        return;
      case "progress":
        await openProgress(player);
        return;
      case "donate":
        await openDonate(player);
        return;
      case "rtp": {
        const result = randomTeleport(player);
        player.sendMessage(result.message);
        return;
      }
      case "rules":
        player.sendMessage(t(player, "rules.text"));
        return;
      case "stats": {
        const profile = getProfile(player);
        player.sendMessage(
          t(player, "stats.text", {
            kills: profile.kills,
            deaths: profile.deaths,
            time: formatDuration(profile.playSeconds * 1000),
            score: profile.acScore,
          }),
        );
        if (profile.mobile) player.sendMessage(t(player, "stats.mobile"));
        return;
      }
      case "lang": {
        const next = getLang(player.id) === "ru" ? "en" : "ru";
        setLang(player.id, next);
        const profile = getProfile(player);
        profile.lang = next;
        saveProfile(player);
        player.sendMessage(next === "ru" ? "Язык: русский" : "Language: English");
        return;
      }
      case "admin":
        await openAdminPanel(player);
        return;
      default:
        return;
    }
  });
};
