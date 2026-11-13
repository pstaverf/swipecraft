import { Entity, Player, Vector3 } from "@minecraft/server";

export type EventId =
  | "airdrop"
  | "bloodmoon"
  | "koth"
  | "bossraid"
  | "doubleloot"
  | "bountyhunt"
  | "lifesteal";

export type FinishReason = "timeout" | "manual" | "recover" | "empty" | "completed" | "crash";

export interface ActiveEvent {
  id: EventId;
  startedAt: number;
  endsAt: number;
  manual: boolean;
  data: Record<string, unknown>;
}

export interface EventHandler {
  id: EventId;
  minPlayers: number;
  defaultDurationMs: number;
  start(active: ActiveEvent): void;
  resume?(active: ActiveEvent): void;
  tick(active: ActiveEvent, now: number): void;
  finish(active: ActiveEvent, reason: FinishReason): void;
  onPlayerKill?(active: ActiveEvent, killer: Player, victim: Player): void;
  onEntityDie?(active: ActiveEvent, entity: Entity, killer: Player | undefined): void;
  onEntityHurt?(active: ActiveEvent, entity: Entity, attacker: Player, damage: number): void;
  onPlayerBreakBlock?(active: ActiveEvent, player: Player, blockTypeId: string, location: Vector3): void;
}

export interface PendingReward {
  playerId: string;
  playerName: string;
  event: EventId;
  reason: string;
  at: number;
}

export interface PersistentEvents {
  history: EventId[];
  nextAt: number;
  planned: EventId;
  postponed: number;
  active?: ActiveEvent;
  announced5: number;
  announced1: number;
  emptySince: number;
  lastFinishedAt: number;
  pending: PendingReward[];
}

export interface LootEntry {
  item: string;
  min: number;
  max: number;
  weight: number;
}

export interface LootTable {
  guaranteed: { item: string; amount: number }[];
  rolls: number;
  pool: LootEntry[];
}
