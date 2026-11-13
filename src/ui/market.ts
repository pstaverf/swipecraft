import { Player } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { safeRunAsync } from "../kernel/guard";
import { t } from "../kernel/i18n";
import { CURRENCY, MARKET } from "../meta/config";
import { busyNote, labelIndex, numOf, report } from "./common";
import {
  buyListing,
  cancelListing,
  createListing,
  inventoryPreview,
  listingsOf,
  marketLines,
  marketPageSize,
  marketSearch,
  openListings,
} from "../meta/market";
import type { Listing } from "../types/domain";
import { openMenu } from "./menu";

const shortName = (typeId: string): string => typeId.replace("minecraft:", "");

const sorted = (): Listing[] => openListings().sort((left, right) => left.price - right.price);

const pageSlice = (page: number): { rows: Listing[]; page: number; pages: number } => {
  const open = sorted();
  const pages = Math.max(1, Math.ceil(open.length / marketPageSize));
  const current = Math.min(Math.max(page, 0), pages - 1);
  return { rows: open.slice(current * marketPageSize, current * marketPageSize + marketPageSize), page: current, pages };
};

const openSell = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:market:sell", async () => {
    const rows = inventoryPreview(player, 24);
    const usable = rows.filter((row) => !row.forbidden);
    if (usable.length === 0) {
      player.sendMessage(rows.length === 0 ? t(player, "eco.sell.empty") : t(player, "mkt.forbidden"));
      return;
    }
    const labels = usable.map((row) => row.label);
    const form = new ModalFormData()
      .title(t(player, "ui.market.sell"))
      .dropdown(t(player, "ui.pick.item"), labels, { defaultValueIndex: 0 })
      .textField(t(player, "ui.amount"), "1", { defaultValue: "1" })
      .textField(`${t(player, "ui.price")} ${CURRENCY.symbol} · ${MARKET.minPrice}…${MARKET.maxPrice}`, "1000", {
        defaultValue: String(usable[0]?.suggest ?? MARKET.minPrice),
      })
      .submitButton(t(player, "ui.confirm"));

    const response = await form.show(player);
    if (response.canceled || !response.formValues) {
      busyNote(player, response);
      return;
    }
    const chosen = usable[labelIndex(labels, response.formValues[0])];
    if (!chosen) {
      player.sendMessage(t(player, "ui.errInput"));
      return;
    }
    report(player, createListing(player, chosen.slot, numOf(response.formValues[1], 1), numOf(response.formValues[2], chosen.suggest)));
  });
};

const openMyListings = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:market:mine", async () => {
    const mine = listingsOf(player.id);
    const actions: string[] = [];
    const form = new ActionFormData().title(t(player, "ui.market.mine"));
    if (mine.length === 0) {
      form.body(t(player, "ui.err.nothing"));
    } else {
      form.body(
        mine
          .map((row) => `${shortName(row.item.typeId)} x${row.item.amount} · ${row.price} ${CURRENCY.symbol} · ${Math.max(0, Math.round((row.expiresAt - Date.now()) / 86_400_000))} ${t(player, "ui.days")}`)
          .join("\n"),
      );
      for (const row of mine) {
        form.button(`${t(player, "ui.market.cancel")} · ${shortName(row.item.typeId)} x${row.item.amount}`);
        actions.push(row.id);
      }
    }
    form.button(t(player, "ui.market"));
    const tail = actions.length;
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    if (response.selection < tail) {
      const id = actions[response.selection];
      if (id) report(player, cancelListing(player, id));
      return;
    }
    await openBrowse(player, 0);
  });
};

const openSearch = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:market:search", async () => {
    const form = new ModalFormData()
      .title(t(player, "ui.market.search"))
      .textField(t(player, "ui.market.search"), "diamond", { defaultValue: "" })
      .submitButton(t(player, "ui.confirm"));
    const response = await form.show(player);
    if (response.canceled || !response.formValues) {
      busyNote(player, response);
      return;
    }
    const found = marketSearch(String(response.formValues[0] ?? "")).slice(0, marketPageSize);
    if (found.length === 0) {
      player.sendMessage(t(player, "ui.pick.none"));
      return;
    }
    player.sendMessage(
      found
        .map((row) => `${shortName(row.item.typeId)} x${row.item.amount} · ${row.price} ${CURRENCY.symbol} · ${row.sellerName} · #${row.id}`)
        .join("\n"),
    );
  });
};

export const openBrowse = async (player: Player, page: number): Promise<void> => {
  await safeRunAsync("ui:market:browse", async () => {
    const view = pageSlice(page);
    const actions: string[] = [];
    const form = new ActionFormData().title(t(player, "ui.market")).body(marketLines(player, view.page).join("\n").slice(0, 1800));

    for (const listing of view.rows) {
      form.button(`${t(player, "ui.market.buy")} · ${shortName(listing.item.typeId)} x${listing.item.amount} · ${listing.price} ${CURRENCY.symbol}`);
      actions.push(`buy:${listing.id}`);
    }
    if (view.page > 0) {
      form.button(t(player, "ui.market.prev"));
      actions.push("prev");
    }
    if (view.page < view.pages - 1) {
      form.button(t(player, "ui.market.next"));
      actions.push("next");
    }
    form.button(t(player, "ui.market.sell"));
    actions.push("sell");
    form.button(t(player, "ui.market.mine"));
    actions.push("mine");
    form.button(t(player, "ui.market.search"));
    actions.push("search");
    form.button(t(player, "ui.menu"));
    actions.push("menu");

    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    const action = actions[response.selection];
    if (!action) return;
    if (action.startsWith("buy:")) {
      report(player, buyListing(player, action.slice(4)));
      return;
    }
    if (action === "prev") {
      await openBrowse(player, view.page - 1);
      return;
    }
    if (action === "next") {
      await openBrowse(player, view.page + 1);
      return;
    }
    if (action === "sell") {
      await openSell(player);
      return;
    }
    if (action === "mine") {
      await openMyListings(player);
      return;
    }
    if (action === "search") {
      await openSearch(player);
      return;
    }
    await openMenu(player);
  });
};

export const openMarket = async (player: Player): Promise<void> => {
  await openBrowse(player, 0);
};

export const marketAdminList = (count: number): Listing[] =>
  openListings()
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, count);
