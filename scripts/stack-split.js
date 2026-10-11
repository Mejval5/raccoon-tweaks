import { log, warn } from "./constants.js";

/**
 * A held item is one object; a stack is many. PF2e keeps "4 torches" as one
 * item, so setting it to held holds all four and dropping it drops all four.
 * This splits one off when a stack becomes held, and merges a single held item
 * back into a matching stack when it stops being held. Dropping a held single
 * then drops just that one (see drop-item.js). Weapons with runes, invested or
 * identified-differently items and containers are left alone.
 */
export function registerStackSplit() {
  Hooks.on("updateItem", (item, changes, options, userId) => {
    try {
      if (userId !== game.user.id) return;
      if (options?.raccoonStack) return;                       // our own writes
      if (!item.isOfType?.("physical")) return;
      const actor = item.actor;
      if (!actor || !["character", "npc"].includes(actor.type)) return;
      const carry = changes?.system?.equipped?.carryType;
      if (!carry) return;
      if (carry === "held") splitOffOne(actor, item).catch((e) => warn("Stack split failed.", e));
      else if (carry === "worn" || carry === "stowed") mergeBack(actor, item, carry).catch((e) => warn("Stack merge failed.", e));
    } catch (error) {
      warn("Stack hook failed.", error);
    }
  });
}

function splittable(item) {
  if (!item.isOfType?.("consumable", "equipment", "weapon", "treasure")) return false;
  if (item.isOfType?.("backpack")) return false;
  if (item.system?.equipped?.invested) return false;
  if (item.isOfType?.("weapon") && (item.system?.runes?.potency || item.system?.runes?.property?.length)) return false;
  return true;
}

async function splitOffOne(actor, item) {
  if (item.quantity <= 1 || !splittable(item)) return;
  const held = item.toObject();
  delete held._id;
  held.system.quantity = 1;
  // The rest keep their previous carry state (what the stack was before being picked up).
  const previous = item._source?.system?.equipped?.carryType;
  const restCarry = previous && previous !== "held" ? previous : "worn";
  await item.update({ "system.quantity": item.quantity - 1, "system.equipped.carryType": restCarry, "system.equipped.handsHeld": 0 }, { raccoonStack: true });
  const [created] = await actor.createEmbeddedDocuments("Item", [held], { raccoonStack: true });
  log(`Split one ${item.name} off the stack to hold (${created?.id}).`);
}

async function mergeBack(actor, item, carry) {
  if (item.quantity !== 1 || !splittable(item)) return;
  const twin = actor.items.find((other) =>
    other.id !== item.id
    && other.type === item.type
    && other.slug === item.slug
    && other.name === item.name
    && other.system?.equipped?.carryType === carry
    && !other.system?.equipped?.invested
    && (other.system?.identification?.status ?? "identified") === (item.system?.identification?.status ?? "identified")
    && (other.system?.containerId ?? null) === (item.system?.containerId ?? null));
  if (!twin) return;
  await twin.update({ "system.quantity": twin.quantity + 1 }, { raccoonStack: true });
  await item.delete({ raccoonStack: true });
  log(`Merged ${item.name} back into its stack (${twin.id}).`);
}
