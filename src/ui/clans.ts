import { Player } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { safeRunAsync } from "../kernel/guard";
import { t } from "../kernel/i18n";
import { CURRENCY, CLANS } from "../meta/config";
import type { ClanRole } from "../types/domain";
import { busyNote, labelIndex, numOf, report } from "./common";
import {
  acceptWar,
  clanLeaderboard,
  clanMembers,
  clanOf,
  clanStatus,
  createClan,
  declareWar,
  depositBank,
  disbandClan,
  invitesFor,
  invitePlayer,
  joinClan,
  kickMember,
  leaveClan,
  setBoard,
  setHome,
  setRole,
  teleportHome,
  warInfo,
  withdrawBank,
} from "../meta/clans";
import { getTunables } from "../meta/economy";
import { openMenu } from "./menu";

const money = (player: Player, amount: number): string => `${amount} ${CURRENCY.symbol}`;

const openCreate = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:clan:create", async () => {
    const form = new ModalFormData()
      .title(`${t(player, "ui.clan.create")} · ${money(player, CLANS.createCost)}`)
      .textField(`${t(player, "clan.name.invalid")}`, "Night_Watch", { defaultValue: "" })
      .textField(`${t(player, "clan.tag.invalid")}`, "NWT", { defaultValue: "" })
      .submitButton(t(player, "ui.confirm"));
    const response = await form.show(player);
    if (response.canceled || !response.formValues) {
      busyNote(player, response);
      return;
    }
    report(player, createClan(player, String(response.formValues[0] ?? ""), String(response.formValues[1] ?? ""), CLANS.createCost));
  });
};

const openMemberActions = async (player: Player, targetName: string): Promise<void> => {
  await safeRunAsync("ui:clan:member", async () => {
    const actions = ["officer", "member", "kick", "back"];
    const form = new ActionFormData()
      .title(targetName)
      .body(clanMembers(player).join("\n").slice(0, 1200))
      .button(t(player, "ui.clan.role.officer"))
      .button(t(player, "ui.clan.role.member"))
      .button(t(player, "ui.clan.kick"))
      .button(t(player, "ui.clan"));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    switch (actions[response.selection]) {
      case "officer":
        report(player, setRole(player, targetName, "officer" as ClanRole));
        return;
      case "member":
        report(player, setRole(player, targetName, "member" as ClanRole));
        return;
      case "kick":
        report(player, kickMember(player, targetName));
        return;
      default:
        await openMembers(player);
    }
  });
};

const openMembers = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:clan:members", async () => {
    const lines = clanMembers(player);
    if (lines.length === 0) {
      player.sendMessage(t(player, "clan.notIn"));
      return;
    }
    const doc = clanOf(player.id);
    const names = doc ? doc.members.slice().sort((left, right) => right.points - left.points).map((member) => member.name) : [];
    const actions = [...names, "back"];
    const form = new ActionFormData().title(t(player, "ui.clan.members")).body(lines.join("\n").slice(0, 1800));
    for (const name of names) form.button(name);
    form.button(t(player, "ui.clan"));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    const action = actions[response.selection];
    if (action === "back" || action === undefined) {
      await openClan(player);
      return;
    }
    await openMemberActions(player, action);
  });
};

const openBank = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:clan:bank", async () => {
    const actions = ["deposit", "withdraw", "back"];
    const form = new ActionFormData()
      .title(t(player, "ui.clan.bank"))
      .body(clanStatus(player).join("\n").slice(0, 1200))
      .button(t(player, "ui.clan.bank.deposit"))
      .button(t(player, "ui.clan.bank.withdraw"))
      .button(t(player, "ui.clan"));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    const action = actions[response.selection];
    if (action === "back" || action === undefined) {
      await openClan(player);
      return;
    }
    const modal = new ModalFormData()
      .title(action === "deposit" ? t(player, "ui.clan.bank.deposit") : t(player, "ui.clan.bank.withdraw"))
      .textField(`${t(player, "ui.amount")} ${CURRENCY.symbol}`, "1000", { defaultValue: "1000" })
      .submitButton(t(player, "ui.confirm"));
    const modalResponse = await modal.show(player);
    if (modalResponse.canceled || !modalResponse.formValues) {
      busyNote(player, modalResponse);
      return;
    }
    const amount = numOf(modalResponse.formValues[0], 0);
    report(player, action === "deposit" ? depositBank(player, amount) : withdrawBank(player, amount));
  });
};

const openHome = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:clan:home", async () => {
    const actions = ["set", "tp", "back"];
    const form = new ActionFormData()
      .title(t(player, "ui.clan.home"))
      .body(clanStatus(player).join("\n").slice(0, 1200))
      .button(`${t(player, "ui.clan.home.set")} · ${money(player, CLANS.homeCost)}`)
      .button(`${t(player, "ui.clan.home.tp")} · ${money(player, CLANS.homeTeleportCost)}`)
      .button(t(player, "ui.clan"));
    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    const action = actions[response.selection];
    if (action === "set") {
      report(player, setHome(player, CLANS.homeCost));
      return;
    }
    if (action === "tp") {
      report(player, teleportHome(player, CLANS.homeTeleportCost));
      return;
    }
    await openClan(player);
  });
};

const openWars = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:clan:war", async () => {
    const doc = clanOf(player.id);
    const pending = doc ? doc.wars.filter((war) => !war.matched && war.endsAt > Date.now()) : [];
    const enemies = warInfo().filter((row) => row.id !== (doc ? doc.id : ""));
    const enemyNames = enemies.map((row) => `${row.name} · ${row.members} ${t(player, "clan.war.members")}`);
    const actions = ["declare", "accept", "board", "back"];
    const form = new ActionFormData()
      .title(t(player, "ui.clan.war"))
      .body(
        [
          clanStatus(player).join("\n"),
          `${t(player, "ui.clan.war.range")}: ${money(player, CLANS.war.stakeMin)}…${money(player, CLANS.war.stakeMax)}, ${t(player, "ui.clan.war.minMembers")}: ${CLANS.war.minMembers}`,
        ]
          .join("\n")
          .slice(0, 1600),
      )
      .button(t(player, "ui.clan.war.declare"))
      .button(`${t(player, "ui.clan.war.accept")}${pending.length > 0 ? ` (${pending.length})` : ""}`)
      .button(t(player, "ui.clan.board"))
      .button(t(player, "ui.clan"));

    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    switch (actions[response.selection]) {
      case "declare": {
        if (enemyNames.length === 0) {
          player.sendMessage(t(player, "clan.enemyNotFound"));
          return;
        }
        const modal = new ModalFormData()
          .title(t(player, "ui.clan.war.declare"))
          .dropdown(t(player, "ui.clan.war.enemy"), enemyNames, { defaultValueIndex: 0 })
          .textField(`${t(player, "ui.clan.war.range")}: ${CLANS.war.stakeMin}…${CLANS.war.stakeMax}`, String(CLANS.war.stakeMin), {
            defaultValue: String(CLANS.war.stakeMin),
          })
          .submitButton(t(player, "ui.confirm"));
        const modalResponse = await modal.show(player);
        if (modalResponse.canceled || !modalResponse.formValues) {
          busyNote(player, modalResponse);
          return;
        }
        const chosen = enemies[labelIndex(enemyNames, modalResponse.formValues[0])];
        if (!chosen) {
          player.sendMessage(t(player, "ui.errInput"));
          return;
        }
        report(player, declareWar(player, chosen.name, numOf(modalResponse.formValues[1], CLANS.war.stakeMin)));
        return;
      }
      case "accept": {
        const first = pending[0];
        if (!first) {
          player.sendMessage(t(player, "clan.warNotFound"));
          return;
        }
        const enemy = warInfo().find((row) => row.id === first.clanId);
        if (!enemy) {
          player.sendMessage(t(player, "clan.warNotFound"));
          return;
        }
        report(player, acceptWar(player, enemy.name));
        return;
      }
      case "board": {
        await openBoard(player);
        return;
      }
      default:
        await openClan(player);
    }
  });
};

const openBoard = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:clan:board", async () => {
    const doc = clanOf(player.id);
    const form = new ModalFormData()
      .title(t(player, "ui.clan.board"))
      .textField(`${t(player, "ui.clan.board.limit")} · ${CLANS.boardChars}`, "gg wp", { defaultValue: doc?.board ?? "" })
      .submitButton(t(player, "ui.confirm"));
    const response = await form.show(player);
    if (response.canceled || !response.formValues) {
      busyNote(player, response);
      return;
    }
    report(player, setBoard(player, String(response.formValues[0] ?? "")));
  });
};

const confirmDisband = async (player: Player): Promise<void> => {
  const doc = clanOf(player.id);
  const actions = ["yes", "no"];
  const form = new ActionFormData()
    .title(t(player, "ui.clan.disband"))
    .body(`${t(player, "clan.disbanded", { name: doc?.name ?? "-", fee: 0 }).split(",")[0]}\n${t(player, "ui.clan.disband.warn")}`)
    .button(t(player, "common.yes"))
    .button(t(player, "common.no"));
  const response = await form.show(player);
  if (response.canceled || response.selection === undefined) {
    busyNote(player, response);
    return;
  }
  if (actions[response.selection] === "yes") report(player, disbandClan(player, false));
};

const openInvite = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:clan:invite", async () => {
    const form = new ModalFormData()
      .title(t(player, "ui.clan.invite"))
      .textField(t(player, "ui.clan.invite.name"), "Steve", { defaultValue: "" })
      .submitButton(t(player, "ui.confirm"));
    const response = await form.show(player);
    if (response.canceled || !response.formValues) {
      busyNote(player, response);
      return;
    }
    report(player, invitePlayer(player, String(response.formValues[0] ?? "")));
  });
};

export const openClan = async (player: Player): Promise<void> => {
  await safeRunAsync("ui:clan", async () => {
    const doc = clanOf(player.id);
    const tunables = getTunables();
    if (!doc) {
      const invites = invitesFor(player);
      const actions = ["create", invites.length > 0 ? "join" : "leader", "menu"];
      const form = new ActionFormData()
        .title(t(player, "ui.clan"))
        .body([...clanStatus(player), `${t(player, "ui.clan.max")}: ${tunables.clanMaxMembers}`].join("\n").slice(0, 1600));
      form.button(`${t(player, "ui.clan.create")} · ${money(player, CLANS.createCost)}`);
      if (invites.length > 0) {
        form.button(`${t(player, "ui.clan.invites")} (${invites.length})`);
      } else {
        form.button(t(player, "ui.clan.leaderboard"));
      }
      form.button(t(player, "ui.menu"));

      const response = await form.show(player);
      if (response.canceled || response.selection === undefined) {
        busyNote(player, response);
        return;
      }
      const action = actions[response.selection];
      if (action === "create") {
        await openCreate(player);
        return;
      }
      if (action === "join") {
        report(player, joinClan(player));
        return;
      }
      if (action === "leader") {
        player.sendMessage(clanLeaderboard(player, 10).join("\n"));
        return;
      }
      await openMenu(player);
      return;
    }

    const actions = ["members", "invite", "board", "home", "bank", "war", "leader", "leave", "disband", "menu"];
    const form = new ActionFormData().title(t(player, "ui.clan")).body(clanStatus(player).join("\n").slice(0, 1800));
    for (const label of [
      t(player, "ui.clan.members"),
      t(player, "ui.clan.invite"),
      t(player, "ui.clan.board"),
      t(player, "ui.clan.home"),
      t(player, "ui.clan.bank"),
      t(player, "ui.clan.war"),
      t(player, "ui.clan.leaderboard"),
      t(player, "ui.clan.leave"),
      t(player, "ui.clan.disband"),
      t(player, "ui.menu"),
    ]) {
      form.button(label);
    }

    const response = await form.show(player);
    if (response.canceled || response.selection === undefined) {
      busyNote(player, response);
      return;
    }
    switch (actions[response.selection]) {
      case "members":
        await openMembers(player);
        return;
      case "invite":
        await openInvite(player);
        return;
      case "board":
        await openBoard(player);
        return;
      case "home":
        await openHome(player);
        return;
      case "bank":
        await openBank(player);
        return;
      case "war":
        await openWars(player);
        return;
      case "leader":
        player.sendMessage(clanLeaderboard(player, 10).join("\n"));
        return;
      case "leave":
        report(player, leaveClan(player));
        return;
      case "disband":
        await confirmDisband(player);
        return;
      default:
        await openMenu(player);
    }
  });
};
