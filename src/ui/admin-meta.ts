import { Player } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { safeRunAsync } from "../kernel/guard";
import { t } from "../kernel/i18n";
import { CURRENCY } from "../meta/config";
import { busyNote, labelIndex, numOf, onlinePlayers, report } from "./common";
import {
  metaAdminLines,
  metaCaseLines,
  metaChangeParam,
  metaFlush,
  metaResetConfig,
  metaStatusLines,
  metaTxLines,
} from "../meta/index";
import { accountsReport, balance, burn, ecoSummary, getTunables, lockedBalance, mint } from "../meta/economy";
import { forceDisband, pruneClans, storageReport, warInfo, clanCacheStats, flushClans, syncMembers } from "../meta/clans";
import { marketRemove, marketSizeBytes, marketStats } from "../meta/market";
import { caseStatsLines } from "../meta/cases";
import { donorReport, queueReport, releaseAll } from "../meta/donations";
import { openDonAdmin } from "./donations";
import { openAdminPanel } from "./admin";
import { marketAdminList } from "./market";

const ECO_PARAMS = [
  "transferFeePercent",
  "marketCommissionPercent",
  "mintCapPerDay",
  "maxTransferPerTx",
  "maxReceivePerDay",
  "maxPerPairPerDay",
  "minPlaySecondsForTransfers",
  "minAccountAgeHours",
  "clanMaxMembers",
  "marketTtlDays",
  "casePricePercent",
  "queueSoftCap",
  "queueReleaseAt",
];

const text = (value: string): { ok: boolean; key: string; params: Record<string, string> } => ({
  ok: true,
  key: "common.raw",
  params: { text: value },
});

const openEcoParams = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:admin:eco:params", async () => {
    const tunables = getTunables();
    const form = new ModalFormData()
      .title(t(player, "ui.admin.eco.params"))
      .dropdown(t(player, "ui.admin.eco.param"), ECO_PARAMS, { defaultValueIndex: 0 })
      .textField(t(player, "ui.value"), "5", { defaultValue: String(tunables.transferFeePercent) })
      .toggle(t(player, "ui.admin.eco.queue"), { defaultValue: tunables.queueEnabled })
      .submitButton(t(player, "ui.confirm"));

    const response = await form.show(player);
    if (response.canceled || !response.formValues) {
      busyNote(player, response);
      return;
    }
    const values = response.formValues;
    const path = ECO_PARAMS[labelIndex(ECO_PARAMS, values[0])];
    if (!path) {
      player.sendMessage(t(player, "ui.errInput"));
      return;
    }
    report(player, text(metaChangeParam(path, String(values[1] ?? "")).message));
    report(player, text(metaChangeParam("queueEnabled", values[2] ? "true" : "false").message));
    player.sendMessage(ecoSummary().slice(0, 4).join("\n"));
  });
};

const openMintBurn = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:admin:eco:mint", async () => {
    const candidates = onlinePlayers();
    if (candidates.length === 0) {
      player.sendMessage(t(player, "ui.err.noPlayer"));
      return;
    }
    const form = new ModalFormData()
      .title(t(player, "ui.admin.eco.mint"))
      .dropdown(t(player, "ui.pick.player"), candidates.map((row) => row.name), { defaultValueIndex: 0 })
      .toggle(t(player, "ui.admin.eco.mintMode"), { defaultValue: true })
      .textField(`${t(player, "ui.amount")} ${CURRENCY.symbol}`, "1000", { defaultValue: "1000" })
      .textField(t(player, "ui.note"), "manual", { defaultValue: "manual" })
      .submitButton(t(player, "ui.confirm"));

    const response = await form.show(player);
    if (response.canceled || !response.formValues) {
      busyNote(player, response);
      return;
    }
    const values = response.formValues;
    const target = candidates.find((row) => row.name === String(values[0] ?? ""));
    const amount = numOf(values[2], 0);
    const note = String(values[3] ?? "manual").slice(0, 60);
    if (!target || amount <= 0) {
      player.sendMessage(t(player, "ui.errInput"));
      return;
    }
    const result = values[1] ? mint(target, amount, `admin:${note}`) : burn(target, amount, `admin:${note}`);
    report(player, result);
    player.sendMessage(
      t(player, "eco.wallet.balance", { coins: balance(target), locked: lockedBalance(target), symbol: CURRENCY.symbol }),
    );
  });
};

const openEcoAdmin = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:admin:eco", async () => {
    const actions = ["params", "mint", "tx", "accounts", "reset", "back"];
    const form = new ActionFormData()
      .title(t(player, "ui.admin.eco"))
      .body([...ecoSummary(), ...accountsReport().slice(0, 6)].join("\n").slice(0, 1800))
      .button(t(player, "ui.admin.eco.params"))
      .button(t(player, "ui.admin.eco.mint"))
      .button(t(player, "ui.admin.eco.tx"))
      .button(t(player, "ui.admin.accounts"))
      .button(t(player, "ui.admin.eco.reset"))
      .button(t(player, "ui.admin.meta"));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    switch (actions[response.selection]) {
      case "params":
        await openEcoParams(player);
        return;
      case "mint":
        await openMintBurn(player);
        return;
      case "tx":
        player.sendMessage(metaTxLines(15).join("\n"));
        return;
      case "accounts":
        player.sendMessage(accountsReport().join("\n"));
        return;
      case "reset":
        report(player, text(metaResetConfig()));
        return;
      default:
        await openMetaAdmin(player);
    }
  });
};

const openClanAdmin = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:admin:clans", async () => {
    const rows = warInfo().slice(0, 12);
    const actions = rows.map((row) => row.id);
    const form = new ActionFormData()
      .title(t(player, "ui.admin.clans"))
      .body(
        [
          ...storageReport(),
          `кэш: ${clanCacheStats().docs}/${clanCacheStats().dirty}`,
          ...rows.map((row) => `${row.name} · ${row.members} · ${row.score} · ${row.bank} ${CURRENCY.symbol} · ${row.wars}`),
        ]
          .join("\n")
          .slice(0, 1800),
      );
    for (const row of rows) form.button(`${t(player, "ui.admin.forceDisband")} · ${row.name}`);
    actions.push("prune");
    form.button(t(player, "ui.admin.clans.prune"));
    actions.push("sync");
    form.button(t(player, "ui.admin.clans.sync"));
    actions.push("flush");
    form.button(t(player, "ui.admin.clans.flush"));
    actions.push("back");
    form.button(t(player, "ui.admin.meta"));

    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    const action = actions[response.selection];
    if (!action) return;
    if (action === "prune") {
      report(player, text(`${t(player, "ui.admin.clans.prune")}: ${pruneClans()}`));
      return;
    }
    if (action === "sync") {
      report(player, text(`${t(player, "ui.admin.clans.sync")}: ${syncMembers()}`));
      return;
    }
    if (action === "flush") {
      metaFlush();
      report(player, text(`${t(player, "ui.admin.clans.flush")}: ${flushClans()}`));
      return;
    }
    await confirmDisband(player, action);
  });
};

const confirmDisband = async (player: Player, clanId: string): Promise<void> => {
  const actions = ["yes", "no"];
  const form = new ActionFormData()
    .title(t(player, "ui.admin.forceDisband"))
    .body(`${clanId}\n${t(player, "ui.clan.disband.warn")}`)
    .button(t(player, "common.yes"))
    .button(t(player, "common.no"));
  const response = await form.show(player);
  if (response.canceled || response.selection === undefined) {
    busyNote(player, response);
    return;
  }
  if (actions[response.selection] === "yes") report(player, forceDisband(player.name, clanId));
};

const openMarketAdmin = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:admin:market", async () => {
    const rows = marketAdminList(10);
    const actions = rows.map((row) => row.id);
    const form = new ActionFormData()
      .title(t(player, "ui.admin.market"))
      .body(
        [...marketStats(), `байт: ${marketSizeBytes()}`, ...rows.map((row) => `${row.id} · ${row.item.typeId.replace("minecraft:", "")} x${row.item.amount} · ${row.price} · ${row.sellerName}`)].join("\n").slice(0, 1800),
      );
    for (const row of rows) form.button(`${t(player, "ui.admin.market.remove")} · ${row.item.typeId.replace("minecraft:", "")} x${row.item.amount}`);
    actions.push("back");
    form.button(t(player, "ui.admin.meta"));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    const action = actions[response.selection];
    if (!action || action === "back") {
      await openMetaAdmin(player);
      return;
    }
    report(player, text(marketRemove(player.name, action) ? t(player, "mkt.cancelled", { id: action, item: "", amount: 0, price: 0 }) : t(player, "mkt.notFound")));
  });
};

const openCasesAdmin = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:admin:cases", async () => {
    const form = new ActionFormData()
      .title(t(player, "ui.admin.cases"))
      .body([...caseStatsLines(), ...metaCaseLines(10)].join("\n").slice(0, 1800))
      .button(t(player, "ui.admin.meta"));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    await openMetaAdmin(player);
  });
};

const openQueueAdmin = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:admin:queue", async () => {
    const actions = ["release", "don", "back"];
    const form = new ActionFormData()
      .title(t(player, "ui.admin.queue"))
      .body([...queueReport(), ...donorReport()].join("\n").slice(0, 1800))
      .button(t(player, "ui.admin.queue.release"))
      .button(t(player, "ui.admin.don"))
      .button(t(player, "ui.admin.meta"));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    switch (actions[response.selection]) {
      case "release":
        player.sendMessage(t(player, "ui.admin.queue.released", { count: releaseAll() }));
        return;
      case "don":
        await openDonAdmin(player);
        return;
      default:
        await openMetaAdmin(player);
    }
  });
};

export const openMetaAdmin = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:admin:meta", async () => {
    const actions = ["status", "eco", "clans", "market", "cases", "don", "queue", "back"];
    const form = new ActionFormData()
      .title(t(player, "ui.admin.meta"))
      .body(metaAdminLines().join("\n").slice(0, 1800))
      .button(t(player, "admin.meta.status"))
      .button(t(player, "ui.admin.eco"))
      .button(t(player, "ui.admin.clans"))
      .button(t(player, "ui.admin.market"))
      .button(t(player, "ui.admin.cases"))
      .button(t(player, "ui.admin.don"))
      .button(t(player, "ui.admin.queue"))
      .button(t(player, "ui.menu"));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    switch (actions[response.selection]) {
      case "status":
        player.sendMessage(metaStatusLines().join("\n"));
        return;
      case "eco":
        await openEcoAdmin(player);
        return;
      case "clans":
        await openClanAdmin(player);
        return;
      case "market":
        await openMarketAdmin(player);
        return;
      case "cases":
        await openCasesAdmin(player);
        return;
      case "don":
        await openDonAdmin(player);
        return;
      case "queue":
        await openQueueAdmin(player);
        return;
      default:
        await openAdminPanel(player);
    }
  });
};
