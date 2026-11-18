import {
  CommandPermissionLevel,
  CustomCommandOrigin,
  CustomCommandParamType,
  CustomCommandResult,
  CustomCommandStatus,
  Player,
  StartupEvent,
} from "@minecraft/server";
import { t } from "../kernel/i18n";
import { CONFIG } from "../config";
import { log } from "../kernel/logger";
import { acRuntimeSummary, changeAcParam, resetAcConfig } from "../security/anticheat";
import { audit } from "../security/audit";
import { randomTeleport } from "../world/rtp";
import {
  canPlaceQuarry,
  closeQuarry,
  collectQuarry,
  createQuarry,
  listQuarries,
  quarryAdminLines,
  quarryLines,
  quarrySummary,
  releaseQuarry,
  teleportToQuarry,
} from "../world/quarry";
import { checkSpawnIntegrity, spawnBlueprint, spawnPreviewLines, spawnStatus, spawnStatusLines, startSpawnBuild, setSpawnPoint } from "../world/spawnbuild";
import { openAdminPanel } from "../ui/admin";
import { openQuarry, openTotems } from "../ui/world";
import { TOTEM_TIER_IDS, forgeTotem, revokeTotem, totemHowLines, totemLines, totemRows, totemSummary } from "../world/totems";
import type { TotemTierId } from "../types/domain";
import { isAdmin, openMenu } from "../ui/menu";
import { openWallet } from "../ui/economy";
import { openMarket } from "../ui/market";
import { openCases } from "../ui/cases";
import { openClan } from "../ui/clans";
import { openProgress } from "../ui/progress";
import { openDonate } from "../ui/donations";
import { openCosmetics, openReferral } from "../ui/referrals";
import { hudProbe, hudSidebarRows, hudStatusLines, refreshHudSidebar, setHudBar } from "../ui/hud";
import { grantRank, rankLines, rankProbe, rankStatus, rollRanks } from "../meta/ranks";
import { metaAdminLines, metaChangeParam, metaFlush, metaResetConfig, metaStatusLines, metaTxLines } from "../meta/index";
import { EVENT_IDS, eventName, eventsStatus, isEventId, nextEvent, startEvent, stopEvent } from "../events/manager";
import { formatDuration } from "../kernel/util";

type Handler = (player: Player, args: string[]) => Promise<string> | string;

const originPlayer = (origin: CustomCommandOrigin): Player | undefined => {
  const entity = origin.sourceEntity;
  return entity instanceof Player ? entity : undefined;
};

const toArgs = (rest: unknown[]): string[] =>
  rest
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value))
    .join(" ")
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);

const register = (
  event: StartupEvent,
  name: string,
  description: string,
  level: CommandPermissionLevel,
  handler: Handler,
): void => {
  event.customCommandRegistry.registerCommand(
    {
      name,
      description,
      permissionLevel: level,
      cheatsRequired: false,
      optionalParameters: [
        { name: "first", type: CustomCommandParamType.String },
        { name: "second", type: CustomCommandParamType.String },
        { name: "third", type: CustomCommandParamType.String },
      ],
    },
    (origin, ...rest): CustomCommandResult => {
      const player = originPlayer(origin);
      if (!player) return { status: CustomCommandStatus.Failure, message: "только для игрока" };
      const args = toArgs(rest);
      try {
        const result = handler(player, args);
        if (typeof result === "string") {
          return { status: CustomCommandStatus.Success, message: result.slice(0, 900) };
        }
        // CustomCommandResult нельзя вернуть промисом (typings: callback возвращает
        // CustomCommandResult | undefined синхронно), поэтому текст асинхронного обработчика
        // уходит в чат: иначе «Недостаточно прав» от /sw:admin до игрока не доезжал.
        void result
          .then((message: string) => {
            if (message.length > 0) player.sendMessage(message.slice(0, 900));
          })
          .catch((error: unknown) => log.error(`command:${name}`, String(error)));
        return { status: CustomCommandStatus.Success, message: "" };
      } catch (error) {
        log.error(`command:${name}`, String(error));
        return { status: CustomCommandStatus.Failure, message: "ошибка выполнения" };
      }
    },
  );
};

export const registerCommands = (event: StartupEvent): void => {
  register(event, "sw:menu", "Открыть меню Swipecraft", CommandPermissionLevel.Any, async (player) => {
    await openMenu(player);
    return "";
  });

  register(event, "sw:rtp", "Случайная телепортация", CommandPermissionLevel.Any, (player) => {
    const result = randomTeleport(player);
    return result.message;
  });

  register(event, "sw:quarry", "Авто-шахта: ui | status | start | collect | close | go | list | release <id>", CommandPermissionLevel.Any, (player, args) => {
    const sub = args[0] ?? "status";
    if (sub === "ui") {
      // форму открываем out-of-band: синхронный ответ команды остаётся текстом CustomCommandResult
      void openQuarry(player);
      return t(player, "quarry.title");
    }
    const say = (value: { ok: boolean; key: string; params?: Record<string, string | number> }): string =>
      `${value.ok ? "✓" : "✗"} ${t(player, value.key, value.params)}`;
    if (sub === "start") return say(createQuarry(player));
    if (sub === "collect") return say(collectQuarry(player));
    if (sub === "close") return say(closeQuarry(player));
    if (sub === "go") return say(teleportToQuarry(player));
    if (sub === "list" || sub === "release") {
      if (!isAdmin(player)) return t(player, "admin.noPermission");
      if (sub === "list") return (quarryAdminLines().join("\n") || t(player, "admin.quarry.none")).slice(0, 900);
      const id = args[1];
      if (!id) return `${t(player, "quarry.err.id", { id: "—" })}\n${listQuarries().map((claim) => claim.id).join(", ")}`;
      return say(releaseQuarry(player.name, id));
    }
    const lines = quarryLines(player);
    const check = canPlaceQuarry(player);
    const summary = quarrySummary();
    return [...lines, check.ok ? t(player, "quarry.ready", check.params) : `✗ ${t(player, check.key, check.params)}`, `карьеров на сервере: ${summary.claims}/${CONFIG.quarry.maxClaims}, ${summary.enabled ? "копают" : "стоп-кран"}`]
      .join("\n")
      .slice(0, 900);
  });

  register(event, "sw:totem", "Зачарованные тотемы: ui | status | forge <tier> | info | revoke <серия>", CommandPermissionLevel.Any, (player, args) => {
    const sub = args[0] ?? "status";
    if (sub === "ui") {
      // как и в sw:quarry: форму открываем out-of-band, ответ команды остаётся строкой
      void openTotems(player);
      return t(player, "totem.title");
    }
    const say = (value: { ok: boolean; key: string; params?: Record<string, string | number> }): string =>
      `${value.ok ? "✓" : "✗"} ${t(player, value.key, value.params)}`;
    if (sub === "forge") {
      const tier = String(args[1] ?? "whisper") as TotemTierId;
      if (!TOTEM_TIER_IDS.includes(tier)) return `✗ ${t(player, "totem.err.tier")} (${TOTEM_TIER_IDS.join(" | ")})`;
      return say(forgeTotem(player, tier));
    }
    if (sub === "info") return totemHowLines(player).join("\n").slice(0, 900);
    if (sub === "revoke") {
      if (!isAdmin(player)) return t(player, "admin.noPermission");
      const serial = args[1];
      if (!serial) return `${t(player, "totem.err.serial", { serial: "—" })}\n${totemRows().map((row) => row.serial).join(", ")}`;
      return say(revokeTotem(player.name, serial));
    }
    const summary = totemSummary();
    return [...totemLines(player), `тотемов в реестре: ${summary.rows} (живых ${summary.live}), ${summary.enabled ? "включены" : "стоп-кран"}`]
      .join("\n")
      .slice(0, 900);
  });

  register(event, "sw:hud", "Таблица статуса: on | off | status", CommandPermissionLevel.Any, (player, args) => {
    const sub = args[0] ?? "status";
    if (sub === "on" || sub === "off") {
      const state = setHudBar(player, sub === "on");
      return `${state.key === "hud.bar.gated" ? "⚠ " : ""}${t(player, state.key, state.params)}`;
    }
    if (sub === "rows") return hudSidebarRows().map((row) => `${row.label} — ${row.score}`).join("\n").slice(0, 900);
    if (sub === "sidebar") {
      refreshHudSidebar();
      const probe = hudProbe();
      return `сайдбар: ${probe.sidebarWrites} перерисовок, битость: ${probe.broken.length > 0 ? probe.broken : "нет"}`;
    }
    return [...hudStatusLines(player), t(player, "hud.tip")].join("\n").slice(0, 900);
  });

  register(event, "sw:rank", "Ранги: info | roll | give <id> (админ)", CommandPermissionLevel.Any, (player, args) => {
    const sub = args[0] ?? "info";
    if (sub === "roll") {
      const count = Number(args[1] ?? "1");
      const result = rollRanks(player, Number.isFinite(count) ? count : 1);
      const lines = [t(player, result.key, result.params), ...(result.lines ?? [])];
      return lines.join("\n").slice(0, 900);
    }
    if (sub === "give") {
      if (!isAdmin(player)) return t(player, "admin.noPermission");
      const id = args[1] ?? "";
      const result = grantRank(player, id, { actor: `команда/${player.name}` });
      return `${result.ok ? "✓" : "✗"} ${t(player, result.key, result.params)}`;
    }
    const probe = rankProbe(player);
    return [...rankStatus(player), ...rankLines(player), `id: ${probe.best || "—"}, tag: ${probe.tag.length > 0 ? probe.tag.trim() : "—"}`]
      .join("\n")
      .slice(0, 900);
  });

  register(event, "sw:spawn", "Спавн: status | preview | build | repair | check | point", CommandPermissionLevel.GameDirectors, (player, args) => {
    if (!isAdmin(player)) return t(player, "admin.noPermission");
    const sub = args[0] ?? "status";
    if (sub === "preview") return spawnPreviewLines().join("\n").slice(0, 900);
    if (sub === "build" || sub === "repair") {
      const value = startSpawnBuild(player.name, sub === "build" ? "build" : "repair");
      return `${value.ok ? "✓" : "✗"} ${t(player, value.key, value.params)}`;
    }
    if (sub === "check") {
      const check = checkSpawnIntegrity(true);
      return [...spawnStatusLines(player), `проверено ячеек: ${check.checked}, расхождений: ${check.missing}`].join("\n").slice(0, 900);
    }
    if (sub === "point") {
      setSpawnPoint();
      return t(player, "spawn.point.set", { x: CONFIG.lobby.x, y: CONFIG.lobby.y, z: CONFIG.lobby.z });
    }
    return [...spawnStatusLines(player), `ячеек в blueprint: ${spawnBlueprint().length}, за проход ≤ ${CONFIG.spawn.blocksPerRun}`, t(player, "spawn.altar")].join("\n").slice(0, 900);
  });

  register(event, "sw:admin", "Админ-панель", CommandPermissionLevel.GameDirectors, async (player) => {
    if (!isAdmin(player)) return t(player, "admin.noPermission");
    await openAdminPanel(player);
    return "";
  });

  register(event, "sw:eco", "Кошелёк, переводы, квесты", CommandPermissionLevel.Any, async (player) => {
    await openWallet(player);
    return "";
  });

  register(event, "sw:market", "Рынок игроков", CommandPermissionLevel.Any, async (player) => {
    await openMarket(player);
    return "";
  });

  register(event, "sw:case", "Кейсы и шансы", CommandPermissionLevel.Any, async (player) => {
    await openCases(player);
    return "";
  });

  register(event, "sw:clan", "Клан: состав, казна, войны", CommandPermissionLevel.Any, async (player) => {
    await openClan(player);
    return "";
  });

  register(event, "sw:quest", "Ежедневки и квесты", CommandPermissionLevel.Any, async (player) => {
    await openProgress(player);
    return "";
  });

  register(event, "sw:don", "Донат: каталог и заявка", CommandPermissionLevel.Any, async (player) => {
    await openDonate(player);
    return "";
  });

  register(event, "sw:shop", "Косметика: каталог, покупка за ₡, экипировка", CommandPermissionLevel.Any, async (player) => {
    await openCosmetics(player);
    return "";
  });

  register(event, "sw:ref", "Приглашения: мой код и ввод кода", CommandPermissionLevel.Any, async (player) => {
    await openReferral(player);
    return "";
  });

  register(event, "sw:meta", "Мета-слой: status | flush | tx | set <параметр> <число> | reset", CommandPermissionLevel.GameDirectors, (player, args) => {
    if (!isAdmin(player)) return t(player, "admin.noPermission");
    const sub = args[0] ?? "status";
    if (sub === "status") return metaStatusLines().join("\n").slice(0, 900);
    if (sub === "flush") {
      metaFlush();
      audit(player.name, "meta-flush", "meta", "принудительное сохранение");
      return "сохранено";
    }
    if (sub === "tx") return metaTxLines(12).join("\n").slice(0, 900);
    if (sub === "info") return metaAdminLines().join("\n").slice(0, 900);
    if (sub === "reset") {
      audit(player.name, "meta-reset", "eco", "сброс конфига экономики");
      return metaResetConfig();
    }
    if (sub === "set") {
      const path = args[1];
      const value = args[2];
      if (!path || value === undefined) return "использование: /sw:meta set transferFeePercent 5";
      const result = metaChangeParam(path, value);
      return result.message;
    }
    return "подкоманды: status, info, tx, flush, set, reset";
  });

  register(event, "sw:ac", "Античит: show | set <путь> <значение> | reset", CommandPermissionLevel.GameDirectors, (player, args) => {
    if (!isAdmin(player)) return t(player, "admin.noPermission");
    const sub = args[0] ?? "show";
    if (sub === "show") return acRuntimeSummary().join("\n").slice(0, 900);
    if (sub === "reset") {
      resetAcConfig();
      audit(player.name, "ac-reset", "config", "сброс к дефолту");
      return "конфиг античита сброшен";
    }
    if (sub === "set") {
      const path = args[1];
      const value = args[2];
      if (!path || value === undefined) return "использование: /sw:ac set detectors.reach.weight 15";
      return changeAcParam(path, value).message;
    }
    return "подкоманды: show, set, reset";
  });

  register(event, "sw:event", "Ивенты: status | next | list | start <id> | stop", CommandPermissionLevel.GameDirectors, (player, args) => {
    if (!isAdmin(player)) return t(player, "admin.noPermission");
    const sub = args[0] ?? "status";
    if (sub === "status") return eventsStatus().join("\n").slice(0, 900);
    if (sub === "next") {
      const next = nextEvent();
      return `Следующий: ${eventName(next.id)} через ${formatDuration(next.at - Date.now())}`;
    }
    if (sub === "list") return EVENT_IDS.map((id) => `${id} — ${eventName(id)}`).join("\n");
    if (sub === "stop") return stopEvent(player.name);
    if (sub === "start") {
      const id = args[1];
      if (!id || !isEventId(id)) return `укажи id: ${EVENT_IDS.join(", ")}`;
      return startEvent(id, true, player.name);
    }
    return "подкоманды: status, next, list, start <id>, stop";
  });

  log.info(
    "commands",
    "зарегистрированы sw:menu, sw:rtp, sw:admin, sw:ac, sw:event, sw:eco, sw:market, sw:case, sw:clan, sw:quest, sw:don, sw:shop, sw:ref, sw:meta",
  );
};
