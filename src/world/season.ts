import { Player, world } from "@minecraft/server";
import { CONFIG, STORE_KEYS } from "../config";
import { t } from "../kernel/i18n";
import { log } from "../kernel/logger";
import { loadWorldJson, saveWorldJson } from "../kernel/store";
import { registerTask } from "../kernel/ticker";
import { formatDuration, randomInt } from "../kernel/util";
import { audit, notifyAdmins } from "../security/audit";
import type { SeasonState } from "../types/domain";

const ARM_TIMEOUT_MS = 10 * 60 * 1000;

let state: SeasonState = {
  index: 1,
  startedAt: Date.now(),
  wipeArmed: false,
  armedBy: "",
  armedAt: 0,
  lastWarnAt: 0,
  code: "",
};

export const getSeason = (): SeasonState => state;

export const seasonStartedAt = (): number => state.startedAt;

export const plannedWipeAt = (): number => state.startedAt + CONFIG.season.lengthMs;

const persist = (): void => {
  try {
    saveWorldJson(STORE_KEYS.season, state);
  } catch (error) {
    log.error("season", `не удалось сохранить состояние: ${String(error)}`);
  }
};

const broadcast = (key: string, params: Record<string, string | number>): void => {
  for (const player of world.getAllPlayers()) {
    try {
      player.sendMessage(t(player, key, params));
    } catch {
      continue;
    }
  }
};

export const seasonStatus = (): string => {
  const left = plannedWipeAt() - Date.now();
  return `сезон ${state.index}, начат ${new Date(state.startedAt).toISOString().slice(0, 16).replace("T", " ")}, до планового вайпа ${formatDuration(left)}, вайп взведён: ${state.wipeArmed ? "да" : "нет"}`;
};

export const armWipe = (admin: Player, confirmation: string): { ok: boolean; code: string; message: string } => {
  if (confirmation.trim().toUpperCase() !== "WIPE") {
    return { ok: false, code: "", message: "подтверждение должно быть словом WIPE" };
  }
  state.wipeArmed = true;
  state.armedBy = admin.name;
  state.armedAt = Date.now();
  state.code = String(randomInt(100000, 999999));
  persist();
  audit(admin.name, "season-arm", "world", `код ${state.code}`);
  notifyAdmins(`[season] вайп взведён ${admin.name}, код ${state.code}, окно 10 минут`);
  broadcast("season.armed", { actor: admin.name, code: state.code });
  log.warn("season", `вайп взведён ${admin.name}`);
  return { ok: true, code: state.code, message: `взведено, код ${state.code}` };
};

export const disarmWipe = (admin: Player, reason: string): void => {
  state.wipeArmed = false;
  state.armedBy = "";
  state.armedAt = 0;
  state.code = "";
  persist();
  audit(admin.name, "season-disarm", "world", reason);
  broadcast("season.disarmed", {});
};

export const markSeasonStart = (admin: string): void => {
  state.index += 1;
  state.startedAt = Date.now();
  state.wipeArmed = false;
  state.armedBy = "";
  state.armedAt = 0;
  state.lastWarnAt = 0;
  state.code = "";
  persist();
  audit(admin, "season-start", "world", `сезон ${state.index}`);
};

let initialized = false;

export const initSeason = (): void => {
  if (initialized) return;
  initialized = true;

  const stored = loadWorldJson<SeasonState | undefined>(STORE_KEYS.season, undefined);
  if (stored) {
    state = stored;
  } else {
    state = { ...state, startedAt: Date.now() };
    persist();
  }

  registerTask("season-tick", 100, 3, () => {
    const now = Date.now();

    if (state.wipeArmed && now - state.armedAt > ARM_TIMEOUT_MS) {
      state.wipeArmed = false;
      state.code = "";
      persist();
      audit("season", "auto-disarm", "world", "истекло окно подтверждения");
      notifyAdmins("[season] окно подтверждения вайпа истекло, вайп снят");
    }

    const left = plannedWipeAt() - now;
    if (left <= 0) {
      if (now - state.lastWarnAt > CONFIG.season.announceEveryMs) {
        state.lastWarnAt = now;
        persist();
        notifyAdmins("[season] плановый вайп наступил: выполни deploy/season-wipe.sh --confirm");
      }
      return;
    }

    if (left <= CONFIG.season.warnBeforeMs && now - state.lastWarnAt > CONFIG.season.announceEveryMs) {
      state.lastWarnAt = now;
      persist();
      broadcast("season.announce", { time: formatDuration(left) });
      audit("season", "announce", "world", `до вайпа ${formatDuration(left)}`);
    }

    if (left <= 10 * 60 * 1000 && now - state.lastWarnAt > 2 * 60 * 1000) {
      state.lastWarnAt = now;
      persist();
      broadcast("season.final", { time: formatDuration(left) });
    }
  });
};
