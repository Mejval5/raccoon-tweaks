import { log, warn, stampOrigin, fromThisTab } from "./constants.js";

/**
 * A held item is one object; a stack is many. PF2e keeps "4 torches" as one
 * item, so setting it to held holds all four and dropping it drops all four.
 * This splits one off when a stack becomes held, and merges a single held item
 * back into a matching stack when it stops being held. Dropping a held single
 * then drops just that one (see drop-item.js). Weapons with runes, invested or
 * identified-differently items and containers are left alone.
 */
export function registerStackSplit() {
  Hooks.on("preUpdateItem", (item, changes, options) => stampOrigin(options));
  Hooks.on("preCreateItem", (item, data, options) => stampOrigin(options));

  // An item arriving in a pack (picked up from the ground, handed over) joins
  // an identical stack. A torch picked up lit comes back extinguished, since a
  // lit toggle baked into its rules is what stops PF2e from stacking it.
  Hooks.on("createItem", (item, options, userId) => {
    try {
      if (!fromThisTab(options)) return;
      if (options?.raccoonStack) return;
      if (!item.isOfType?.("physical")) return;
      const actor = item.actor;
      if (!actor || !["character", "npc"].includes(actor.type)) return;
      const carry = item.system?.equipped?.carryType;
      const info = { wasLit: Boolean(item.getFlag?.("raccoon-tweaks", "litOnGround")), name: item.name };
      if (carry !== "worn" && carry !== "stowed") {
        Hooks.callAll("raccoonItemArrived", actor, item, info);
        return;
      }
      mergeArrival(actor, item, carry)
        .then((survivor) => Hooks.callAll("raccoonItemArrived", actor, survivor ?? item, info))
        .catch((e) => warn("Arrival merge failed.", e));
    } catch (error) {
      warn("Arrival hook failed.", error);
    }
  });
  Hooks.on("updateItem", (item, changes, options, userId) => {
    try {
      if (!fromThisTab(options)) return;
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

/**
 * Toggleable RollOption values (a torch's "lit") are state, not identity. The
 * key is removed, not set to false: an item that was never toggled has no
 * `value` at all, and PF2e's own stacking compares the raw JSON.
 */
function stripToggles(rules) {
  return (rules ?? []).map((r) => {
    if (r.key !== "RollOption" || !r.toggleable) return r;
    const { value, ...rest } = r;
    return rest;
  });
}

function sameKind(a, b) {
  return a.type === b.type && a.slug === b.slug && a.name === b.name
    && !a.system?.equipped?.invested && !b.system?.equipped?.invested
    && (a.system?.identification?.status ?? "identified") === (b.system?.identification?.status ?? "identified")
    && (a.system?.containerId ?? null) === (b.system?.containerId ?? null)
    && JSON.stringify(stripToggles(a.system?.rules)) === JSON.stringify(stripToggles(b.system?.rules));
  // (flags are not compared: our litOnGround marker rides along on the ground copy)
}

/** @returns the item that remains on the actor: the stack it joined, or itself */
async function mergeArrival(actor, item, carry) {
  if (!splittable(item)) return item;
  const twin = actor.items.find((other) =>
    other.id !== item.id && other.system?.equipped?.carryType === carry && sameKind(other, item));
  if (!twin) {
    // No stack to join: at least arrive extinguished.
    const lit = (item.system?.rules ?? []).some((r) => r.key === "RollOption" && r.toggleable && r.value);
    if (lit) await item.update({ "system.rules": stripToggles(item.system.rules) }, { raccoonStack: true });
    return item;
  }
  await twin.update({ "system.quantity": twin.quantity + item.quantity }, { raccoonStack: true });
  await item.delete({ raccoonStack: true });
  log(`Merged arriving ${item.name} x${item.quantity} into its stack (${twin.id}).`);
  return twin;
}

async function mergeBack(actor, item, carry) {
  if (item.quantity !== 1 || !splittable(item)) return;
  const twin = actor.items.find((other) =>
    other.id !== item.id && other.system?.equipped?.carryType === carry && sameKind(other, item));
  if (!twin) return;
  await twin.update({ "system.quantity": twin.quantity + 1 }, { raccoonStack: true });
  await item.delete({ raccoonStack: true });
  log(`Merged ${item.name} back into its stack (${twin.id}).`);
}
