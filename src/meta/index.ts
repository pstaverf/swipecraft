import { Entity, Player, world } from "@minecraft/server";
import { log } from "../kernel/logger";
import { registerTask } from "../kernel/ticker";
import { audit, notifyAdmins } from "../security/audit";
import { grantGrace } from "../security/anticheat";
import { flushBalances, loadBalances, metaCount, balancesReport, pruneBalances } from "./balances";
import { CASES, DONATIONS, LEADERBOARD, MARKET, META_TASKS } from "./config";
import { changeEcoParam, ecoSummary, flushEconomy, initEconomy, resetEcoConfig, txReport, unlockSweep } from "./economy";
import { claimExpiredFor, flushMarket, loadMarket, marketStats, sweepMarket } from "./market";
import { caseStatsLines, flushCases, loadCases, recentCaseLog } from "./cases";
import { clanCacheStats, flushClans, loadClans, onPvpKill, pruneClans, settleWars, storageReport, syncMembers, clanOf } from "./clans";
import { autoGrantGift, flushDonations, loadDonations, queueOnSpawn, queueTick, refreshNameTag, trailSweep, unqueue } from "./donations";
import { flushProgress, isOre, loadProgress, recordDeath, recordKill, recordMobKill, recordOre, setClanTag, streakDecay, updateTopRow } from "./progress";
import { flushCosmetics, announceJoin, loadCosmetics } from "./cosmetics";
import { codeOf, flushReferrals, loadReferrals, referralReport, rewardSweep } from "./referrals";
import { disputeLines, goalReport } from "./donations";
import "./messages";

let initialized = false;

const safeStep = (scope: string, fn: () => void): void => {
  try {
    fn();
  } catch (error) {
    log.error(scope, String(error));
  }
};

const onSpawn = (player: Player): void => {
  safeStep("meta:spawn", () => {
    autoGrantGift(player);
    codeOf(player);
    refreshNameTag(player);
    announceJoin(player);
    updateTopRow(player);
    const doc = clanOf(player.id);
    if (doc) setClanTag(player.id, doc.name);
    const returned = claimExpiredFor(player);
    if (returned > 0) player.sendMessage(`рынок: вернули просроченные объявления (${returned})`);
  });
  safeStep("meta:queue", () => {
    queueTick();
  });
};

const onDeath = (dead: Entity, killer: Player | undefined): void => {
  if (dead instanceof Player) {
    recordDeath(dead);
    if (killer && killer.id !== dead.id) {
      recordKill(killer, dead);
      safeStep("clans:war", async () => {
        const { onPvpKill } = await import("./clans");
        onPvpKill(killer, dead);
      });
    }
    return;
  }
  if (killer) recordMobKill(killer);
};

const flushAll = (): void => {
  flushBalances();
  flushEconomy();
  flushMarket();
  flushCases();
  flushClans();
  flushProgress();
  flushDonations();
  flushCosmetics();
  flushReferrals();
};

export const initMeta = (): void => {
  if (initialized) return;
  initialized = true;
  const records = loadBalances();
  initEconomy();
  const marketRows = loadMarket();
  loadCases();
  loadDonations();
  loadCosmetics();
  const refCodes = loadReferrals();
  const clans = loadClans();
  loadProgress();
  log.info(
    "meta",
    `записей игроков: ${records}, объявлений: ${marketRows}, кланов: ${clans}, кейсов: ${Object.keys(CASES).length}, кодов приглашений: ${refCodes}`,
  );

  world.afterEvents.playerSpawn.subscribe((event) => {
    if (!event.initialSpawn) return;
    onSpawn(event.player);
    safeStep("meta:queue-enter", () => {
      if (queueOnSpawn(event.player)) grantGrace(event.player.id, 15_000);
    });
  });

  world.afterEvents.playerLeave.subscribe((event) => {
    safeStep("meta:leave", () => {
      unqueue(event.playerId);
      flushBalances();
    });
  });

  world.afterEvents.entityDie.subscribe((event) => {
    const killer = event.damageSource.damagingEntity;
    onDeath(event.deadEntity, killer instanceof Player ? killer : undefined);
  });

  world.afterEvents.playerBreakBlock.subscribe((event) => {
    const typeId = event.brokenBlockPermutation.type.id;
    if (!isOre(typeId)) return;
    safeStep("meta:break", () => recordOre(event.player, typeId, 1));
  });

  registerTask("meta-unlock", 200, 4, () => {
    unlockSweep();
    for (const player of world.getAllPlayers()) autoGrantGift(player);
  });

  registerTask("meta-flush", META_TASKS.economyFlushTicks, 20, () => {
    flushAll();
  });

  registerTask("meta-market", MARKET.refreshTicks, 6, () => {
    const expired = sweepMarket();
    if (expired === 0) return;
    for (const player of world.getAllPlayers()) {
      const returned = claimExpiredFor(player);
      if (returned > 0) player.sendMessage(`рынок: просроченные объявления закрыты, предметы возвращены (${returned})`);
    }
  });

  registerTask("meta-clans", META_TASKS.warSettleTicks, 14, () => {
    syncMembers();
    settleWars();
    if (metaCount() > 0 && Math.random() < 0.05) pruneClans();
  });

  registerTask("meta-prune", META_TASKS.balancesPruneTicks, 6, () => {
    const removed = pruneBalances(META_TASKS.balancesPruneInactiveDays);
    if (removed > 0) log.info("meta", `кошельков убрано за неактивность: ${removed}`);
  });

  registerTask("meta-donor", DONATIONS.trailEveryTicks, 3, () => {
    trailSweep();
  });

  registerTask("meta-queue", META_TASKS.queueTicks, 3, () => {
    queueTick();
  });

  registerTask("meta-streaks", 600, 3, () => {
    streakDecay();
  });

  registerTask("meta-ref", 600, 4, () => {
    rewardSweep();
  });

  registerTask("meta-leaderboard", LEADERBOARD.flushTicks, 6, () => {
    for (const player of world.getAllPlayers()) {
      const doc = clanOf(player.id);
      setClanTag(player.id, doc?.name ?? "");
      updateTopRow(player);
    }
    flushProgress();
    const report = balancesReport();
    if (report.some((line) => line.includes("заблокирована"))) notifyAdmins(`[eco] ${report[3]}`);
  });
};

export const metaFlush = (): void => {
  flushAll();
};

export const metaStatusLines = (): string[] => [
  ...ecoSummary(),
  ...marketStats(),
  ...balancesReport(),
  ...storageReport(),
  ...goalReport(),
  ...referralReport().slice(0, 2),
];

export const metaAdminLines = (): string[] => [
  "эконом:",
  ...ecoSummary().slice(0, 4),
  "рынок:",
  ...marketStats(),
  "кейсы:",
  ...caseStatsLines().slice(0, 4),
  "кланы:",
  ...storageReport().slice(0, 4),
  `кэш документов: ${clanCacheStats().docs}, грязных ${clanCacheStats().dirty}`,
  "донат:",
  ...goalReport(),
  ...disputeLines().slice(0, 3),
  "приглашения:",
  ...referralReport().slice(0, 5),
];

export const metaTxLines = (count: number): string[] => txReport(count);

export const metaCaseLines = (count: number): string[] => recentCaseLog(count);

export const metaChangeParam = (path: string, value: string): { ok: boolean; message: string } => {
  const result = changeEcoParam(path, value);
  audit("admin", "eco-set", path, result.message);
  return result;
};

export const metaResetConfig = (): string => {
  resetEcoConfig();
  audit("admin", "eco-reset", "config", "значения по умолчанию");
  return "конфиг экономики сброшен";
};
