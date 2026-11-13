import { Player, world } from "@minecraft/server";
import { CONFIG, STORE_KEYS } from "../config";
import { loadWorldJson, saveWorldJson } from "../kernel/store";
import type { AuditEntry } from "../types/domain";

let entries: AuditEntry[] = [];
let dirty = false;

export const initAudit = (): void => {
  entries = loadWorldJson<AuditEntry[]>(STORE_KEYS.audit, []);
};

export const audit = (actor: string, action: string, target: string, detail: string): void => {
  entries.push({ t: Date.now(), actor, action, target, detail });
  if (entries.length > CONFIG.profiles.maxAuditEntries) {
    entries = entries.slice(-CONFIG.profiles.maxAuditEntries);
  }
  dirty = true;
};

export const flushAudit = (): void => {
  if (!dirty) return;
  saveWorldJson(STORE_KEYS.audit, entries);
  dirty = false;
};

export const recentAudit = (count: number): AuditEntry[] => entries.slice(-count);

export const adminPlayers = (): Player[] =>
  world.getAllPlayers().filter((player) => player.hasTag("admin"));

export const notifyAdmins = (message: string): void => {
  const admins = adminPlayers();
  if (admins.length === 0) return;
  for (const admin of admins) {
    try {
      admin.sendMessage(message);
    } catch {
      continue;
    }
  }
};

export const auditReport = (count: number): string[] =>
  recentAudit(count).map((entry) => {
    const time = new Date(entry.t).toISOString().slice(11, 19);
    return `${time} ${entry.actor} -> ${entry.action} ${entry.target} ${entry.detail}`.trim();
  });
