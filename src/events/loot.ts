import { Container, ItemStack, Player } from "@minecraft/server";
import { log } from "../kernel/logger";
import type { LootEntry, LootTable } from "./types";

const randomInt = (min: number, max: number): number => min + Math.floor(Math.random() * (max - min + 1));

export const totalWeight = (pool: LootEntry[]): number =>
  pool.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);

export const rollTable = (table: LootTable): ItemStack[] => {
  const stacks: ItemStack[] = [];
  for (const entry of table.guaranteed) {
    try {
      stacks.push(new ItemStack(entry.item, entry.amount));
    } catch (error) {
      log.error("loot", `${entry.item}: ${String(error)}`);
    }
  }
  const total = totalWeight(table.pool);
  if (total <= 0 || table.rolls <= 0) return stacks;
  for (let roll = 0; roll < table.rolls; roll += 1) {
    let ticket = Math.random() * total;
    for (const entry of table.pool) {
      ticket -= Math.max(0, entry.weight);
      if (ticket > 0) continue;
      try {
        stacks.push(new ItemStack(entry.item, randomInt(entry.min, entry.max)));
      } catch (error) {
        log.error("loot", `${entry.item}: ${String(error)}`);
      }
      break;
    }
  }
  return stacks;
};

export const giveStacks = (player: Player, stacks: ItemStack[]): void => {
  const inventory = player.getComponent("minecraft:inventory");
  const container: Container | undefined = inventory?.container;
  for (const stack of stacks) {
    try {
      if (container) {
        container.addItem(stack);
      } else {
        player.dimension.spawnItem(stack, player.location);
      }
    } catch {
      try {
        player.dimension.spawnItem(stack, player.location);
      } catch (error) {
        log.error("loot", `не удалось выдать ${stack.typeId}: ${String(error)}`);
      }
    }
  }
};

export const fillContainer = (container: Container, table: LootTable): number => {
  const stacks = rollTable(table);
  let slot = 0;
  for (const stack of stacks) {
    if (slot >= container.size) break;
    try {
      container.setItem(slot, stack);
      slot += 1;
    } catch {
      continue;
    }
  }
  return slot;
};

export const announceLoot = (player: Player, stacks: ItemStack[]): void => {
  const names = stacks.map((stack) => `${stack.typeId.replace("minecraft:", "")} x${stack.amount}`).join(", ");
  try {
    player.sendMessage(`+ ${names}`);
  } catch {
    return;
  }
};
