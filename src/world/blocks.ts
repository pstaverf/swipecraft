import { Block, BlockPermutation, ItemStack, Player } from "@minecraft/server";
import { log } from "../kernel/logger";

export const AIR = "minecraft:air";

export const revertPlacement = (player: Player, block: Block): boolean => {
  const typeId = block.typeId;
  if (typeId === AIR) return false;
  try {
    block.setPermutation(BlockPermutation.resolve(AIR));
  } catch (error) {
    log.error("blocks", `не удалось убрать блок ${typeId}: ${String(error)}`);
    return false;
  }
  try {
    const inventory = player.getComponent("minecraft:inventory");
    if (inventory?.container) inventory.container.addItem(new ItemStack(typeId, 1));
  } catch {
    return true;
  }
  return true;
};
