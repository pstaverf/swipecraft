import { system } from "@minecraft/server";
import { registerCommands } from "../commands/registry";
import { log } from "../kernel/logger";
import * as i18nProbe from "../kernel/i18n";
import * as uiMessagesProbe from "../ui/messages";
import * as metaMessagesProbe from "../meta/messages";
import * as cosmeticsProbe from "../meta/cosmetics";
import * as quarryProbe from "../world/quarry";
import * as spawnBuildProbe from "../world/spawnbuild";
import * as totemsProbe from "../world/totems";
import * as anticheatProbe from "../security/anticheat";
import * as spawnProbe from "../world/spawn";
import * as ranksProbe from "../meta/ranks";
import * as hudProbe from "../ui/hud";

declare const globalThis: { __swipecraftProbe?: Record<string, unknown> };

globalThis.__swipecraftProbe = {
  i18n: i18nProbe,
  uiMessages: uiMessagesProbe,
  metaMessages: metaMessagesProbe,
  cosmetics: cosmeticsProbe,
  quarry: quarryProbe,
  spawnBuild: spawnBuildProbe,
  totems: totemsProbe,
  anticheat: anticheatProbe,
  spawn: spawnProbe,
  ranks: ranksProbe,
  hud: hudProbe,
};

system.beforeEvents.startup.subscribe((event) => {
  try {
    registerCommands(event);
  } catch (error) {
    log.error("startup", `не удалось зарегистрировать команды: ${String(error)}`);
  }
});
