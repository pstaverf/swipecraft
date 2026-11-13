import { system } from "@minecraft/server";
import { registerCommands } from "../commands/registry";
import { log } from "../kernel/logger";
import * as i18nProbe from "../kernel/i18n";
import * as uiMessagesProbe from "../ui/messages";
import * as metaMessagesProbe from "../meta/messages";

declare const globalThis: { __swipecraftProbe?: Record<string, unknown> };

globalThis.__swipecraftProbe = {
  i18n: i18nProbe,
  uiMessages: uiMessagesProbe,
  metaMessages: metaMessagesProbe,
};

system.beforeEvents.startup.subscribe((event) => {
  try {
    registerCommands(event);
  } catch (error) {
    log.error("startup", `не удалось зарегистрировать команды: ${String(error)}`);
  }
});
