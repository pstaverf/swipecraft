import { world } from "@minecraft/server";
import { log } from "../kernel/logger";
import { registerTask, startTicker } from "../kernel/ticker";
import { forgetPlayer, registerProfileTasks, saveProfile } from "../meta/profiles";
import { initAntiDupe } from "../security/antidupe";
import { initAnticheat, resetState } from "../security/anticheat";
import { flushAudit, initAudit } from "../security/audit";
import { initEvents } from "../events/manager";
import { initMeta } from "../meta/index";
import { initBorder } from "../world/border";
import { initLimits } from "../world/limits";
import { applyWorldRules } from "../world/rules";
import { initSeason } from "../world/season";
import { initSpawn } from "../world/spawn";

let booted = false;

const boot = (): void => {
  if (booted) return;
  booted = true;
  log.info("boot", "инициализация Swipecraft");

  initAudit();
  applyWorldRules();
  initSeason();
  initBorder();
  initSpawn();
  initLimits();
  initAntiDupe();
  initAnticheat();
  initMeta();
  initEvents();

  registerProfileTasks(registerTask);
  registerTask("audit-flush", 600, 10, flushAudit);

  startTicker();
  log.info("boot", "готово");
};

world.afterEvents.worldLoad.subscribe(() => {
  boot();
});

world.beforeEvents.playerLeave.subscribe((event) => {
  try {
    saveProfile(event.player);
  } catch (error) {
    log.error("profiles", `сейв при выходе: ${String(error)}`);
  }
});

world.afterEvents.playerLeave.subscribe((event) => {
  forgetPlayer(event.playerId);
  resetState(event.playerId);
  flushAudit();
});

world.afterEvents.playerJoin.subscribe(() => {
  if (!booted) boot();
});
