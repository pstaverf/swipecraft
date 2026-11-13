import { Player, world } from "@minecraft/server";
import { ActionFormData, FormCancelationReason } from "@minecraft/server-ui";
import { t } from "../kernel/i18n";

export interface UiResult {
  ok: boolean;
  key: string;
  params?: Record<string, string | number>;
}

export interface UiBody {
  title: string;
  body: string[];
  buttons: string[];
}

export const report = (player: Player, result: UiResult): void => {
  player.sendMessage(`${result.ok ? "§a✓" : "§c✗"} ${t(player, result.key, result.params)}`);
};

export const note = (player: Player, lines: string[]): void => {
  if (lines.length === 0) {
    player.sendMessage(t(player, "ui.pick.none"));
    return;
  }
  for (const line of lines) player.sendMessage(line);
};

export const onlinePlayers = (excludeId?: string): Player[] =>
  world.getAllPlayers().filter((candidate) => candidate.id !== excludeId);

export const byName = (name: string): Player | undefined =>
  onlinePlayers().find((candidate) => candidate.name.toLowerCase() === name.trim().toLowerCase());

export const busyNote = (
  player: Player,
  response: { canceled?: boolean; cancelationReason?: FormCancelationReason },
): void => {
  if (response.canceled && response.cancelationReason === FormCancelationReason.UserBusy) {
    player.sendMessage(t(player, "ui.busy"));
  }
};

export const numOf = (value: unknown, fallback = 0): number => {
  if (typeof value === "number") return Number.isFinite(value) ? Math.floor(value) : fallback;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[^\d.-]/g, "");
  if (cleaned.length === 0) return fallback;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
};

export const labelIndex = (labels: readonly string[], value: unknown, fallback = 0): number => {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value < labels.length ? value : fallback;
  if (typeof value !== "string" || value.length === 0) return fallback;
  const exact = labels.findIndex((label) => label === value);
  if (exact >= 0) return exact;
  const partial = labels.findIndex((label) => label.includes(value));
  return partial >= 0 ? partial : fallback;
};

export const listOf = (values: readonly string[], index: unknown): string | undefined => {
  const position = typeof index === "number" ? index : Number(index);
  if (!Number.isInteger(position) || position < 0 || position >= values.length) return undefined;
  return values[position];
};

export const playerNames = (): string[] => onlinePlayers().map((candidate) => candidate.name);

export const pickPlayer = async (player: Player, excludeSelf = true): Promise<Player | undefined> => {
  const list = onlinePlayers(excludeSelf ? player.id : undefined);
  if (list.length === 0) {
    player.sendMessage(t(player, "ui.err.noPlayer"));
    return undefined;
  }
  const form = new ActionFormData().title(t(player, "ui.pick.player")).body(`${list.length}`);
  for (const candidate of list) form.button(candidate.name);
  form.button(t(player, "ui.close"));
  const response = await form.show(player);
  if (response.canceled || response.selection === undefined) {
    busyNote(player, response);
    return undefined;
  }
  if (response.selection >= list.length) return undefined;
  return list[response.selection];
};

export const listMenu = async (input: UiBody, player: Player): Promise<number | undefined> => {
  const form = new ActionFormData().title(input.title).body(input.body.join("\n").slice(0, 1800));
  for (const label of input.buttons) form.button(label);
  const response = await form.show(player);
  if (response.canceled || response.selection === undefined) {
    busyNote(player, response);
    return undefined;
  }
  return response.selection;
};
