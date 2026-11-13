import { system } from "@minecraft/server";
import { registerCommands } from "../commands/registry";
import { log } from "../kernel/logger";

system.beforeEvents.startup.subscribe((event) => {
  try {
    registerCommands(event);
  } catch (error) {
    log.error("startup", `не удалось зарегистрировать команды: ${String(error)}`);
  }
});
