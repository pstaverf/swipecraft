import { Player } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { safeRunAsync } from "../kernel/guard";
import { getLang, setLang, t } from "../kernel/i18n";
import { formatDuration } from "../kernel/util";
import { getProfile, saveProfile } from "../meta/profiles";
import { randomTeleport } from "../world/rtp";
import { openAdminPanel } from "./admin";

export const isAdmin = (player: Player): boolean => player.hasTag("admin");

export const openMenu = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:menu", async () => {
    const form = new ActionFormData()
      .title(t(player, "menu.title"))
      .body(t(player, "menu.body"))
      .button(t(player, "menu.rtp"))
      .button(t(player, "menu.rules"))
      .button(t(player, "menu.stats"))
      .button(t(player, "menu.lang"));

    if (isAdmin(player)) form.button(t(player, "menu.admin"));
    form.button(t(player, "menu.close"));

    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) return;

    const buttons: string[] = ["rtp", "rules", "stats", "lang"];
    if (isAdmin(player)) buttons.push("admin");
    buttons.push("close");
    const action = buttons[response.selection];

    if (action === "rtp") {
      const result = randomTeleport(player);
      player.sendMessage(result.message);
      return;
    }
    if (action === "rules") {
      player.sendMessage(t(player, "rules.text"));
      return;
    }
    if (action === "stats") {
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
    if (action === "lang") {
      const next = getLang(player.id) === "ru" ? "en" : "ru";
      setLang(player.id, next);
      const profile = getProfile(player);
      profile.lang = next;
      saveProfile(player);
      player.sendMessage(next === "ru" ? "Язык: русский" : "Language: English");
      return;
    }
    if (action === "admin") {
      await openAdminPanel(player);
    }
  });
};
