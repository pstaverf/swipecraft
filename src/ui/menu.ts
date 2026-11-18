import { Player } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { safeRunAsync } from "../kernel/guard";
import { getLang, setLang, t } from "../kernel/i18n";
import { formatDuration } from "../kernel/util";
import { getProfile, saveProfile } from "../meta/profiles";
import { randomTeleport } from "../world/rtp";
import { openQuarry, openTotems } from "./world";
import { openAdminPanel } from "./admin";
import { openWallet } from "./economy";
import { openMarket } from "./market";
import { openCases } from "./cases";
import { openClan } from "./clans";
import { openProgress } from "./progress";
import { openDonate } from "./donations";
import { openCosmetics, openReferral } from "./referrals";
import "./messages";

export const isAdmin = (player: Player): boolean => player.hasTag("admin");

type MenuAction = "quarry" | "totems" | "wallet" | "market" | "cases" | "clan" | "progress" | "donate" | "cosmetics" | "ref" | "rtp" | "rules" | "stats" | "lang" | "admin" | "close";
type MenuEntry = { readonly key: string; readonly action: MenuAction };

/**
 * Один список вместо двух параллельных: подписи кнопок и действия выводятся из
 * `MENU_ENTRIES`, поэтому «менее/более чем на единицу разъехавшееся меню» нельзя ни
 * добавить, ни потерять при правке. Порядок здесь = порядок кнопок на экране.
 */
const MENU_ENTRIES: readonly MenuEntry[] = [
  { key: "ui.wallet", action: "wallet" },
  { key: "ui.market", action: "market" },
  { key: "ui.cases", action: "cases" },
  { key: "ui.clan", action: "clan" },
  { key: "ui.progress", action: "progress" },
  { key: "ui.donate", action: "donate" },
  { key: "ui.cosmetics", action: "cosmetics" },
  { key: "ui.ref", action: "ref" },
  { key: "ui.quarry", action: "quarry" },
  { key: "ui.totems", action: "totems" },
  { key: "menu.rtp", action: "rtp" },
  { key: "menu.rules", action: "rules" },
  { key: "menu.stats", action: "stats" },
  { key: "menu.lang", action: "lang" },
];
const ADMIN_ENTRY: MenuEntry = { key: "menu.admin", action: "admin" };
const CLOSE_ENTRY: MenuEntry = { key: "menu.close", action: "close" };

export const openMenu = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:menu", async () => {
    const entries = [...MENU_ENTRIES, ...(isAdmin(player) ? [ADMIN_ENTRY] : []), CLOSE_ENTRY];
    const form = new ActionFormData().title(t(player, "menu.title")).body(t(player, "menu.body"));
    for (const entry of entries) form.button(t(player, entry.key));

    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) return;

    switch (entries[response.selection]?.action) {
      case "quarry":
        await openQuarry(player);
        return;
      case "totems":
        await openTotems(player);
        return;
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
      case "cosmetics":
        await openCosmetics(player);
        return;
      case "ref":
        await openReferral(player);
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
