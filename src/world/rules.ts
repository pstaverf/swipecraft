import { world } from "@minecraft/server";
import { log } from "../kernel/logger";

export const applyWorldRules = (): void => {
  const rules = world.gameRules;
  rules.keepInventory = false;
  rules.doDayLightCycle = true;
  rules.doWeatherCycle = true;
  rules.doFireTick = true;
  rules.doMobSpawning = true;
  rules.doMobLoot = true;
  rules.doEntityDrops = true;
  rules.doInsomnia = true;
  rules.naturalRegeneration = true;
  rules.mobGriefing = true;
  rules.fallDamage = true;
  rules.fireDamage = true;
  rules.drowningDamage = true;
  rules.freezeDamage = true;
  rules.maxCommandChainLength = 10_000;
  rules.randomTickSpeed = 1;
  rules.commandBlockOutput = false;
  rules.sendCommandFeedback = false;
  rules.showCoordinates = true;
  rules.showDeathMessages = true;
  rules.spawnRadius = 0;
  log.info("rules", "геймрулы применены");
};
