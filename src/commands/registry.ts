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
import { log } from "../kernel/logger";
import { acRuntimeSummary, changeAcParam, resetAcConfig } from "../security/anticheat";
import { audit } from "../security/audit";
import { randomTeleport } from "../world/rtp";
import { openAdminPanel } from "../ui/admin";
import { isAdmin, openMenu } from "../ui/menu";
import { openWallet } from "../ui/economy";
import { openMarket } from "../ui/market";
import { openCases } from "../ui/cases";
import { openClan } from "../ui/clans";
import { openProgress } from "../ui/progress";
import { openDonate } from "../ui/donations";
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
        void result.catch((error: unknown) => log.error(`command:${name}`, String(error)));
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
    "зарегистрированы sw:menu, sw:rtp, sw:admin, sw:ac, sw:event, sw:eco, sw:market, sw:case, sw:clan, sw:quest, sw:don, sw:meta",
  );
};
