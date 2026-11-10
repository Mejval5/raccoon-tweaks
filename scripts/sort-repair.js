import { MODULE_ID, SETTINGS, VISITOR, log, warn } from "./constants.js";
import { setting } from "./settings.js";

/**
 * Keeps inventory order numbers apart, so one drag cannot stow a whole section.
 *
 * The bug it works around is in PF2e's own sheet (8.5.0, `#onDropInventoryItem`).
 * Dropping an item onto a container re-sorts the item among the list it came
 * from; Foundry's `performIntegerSort` returns just that item when its
 * neighbours' `sort` values leave room, and every sibling when they do not (two
 * items on the same number is enough). PF2e then writes the container's id on
 * everything that came back, not only on the dragged item. Result, seen on
 * 2026-11-10: Vojta dragged one thing into Ezekiel's backpack and the whole
 * Equipment section, ten items, went in with it.
 *
 * Items made by an import, a script or the MCP arrive with `sort: 0`, so the
 * clashes build up on their own. Two measures:
 *
 * - When someone who owns an actor opens its sheet, items that share a
 *   container and a `sort` value are renumbered (one update, the order on
 *   screen stays as it was). A drag needs an open sheet, so by then the
 *   numbers are clean.
 * - A new physical item whose `sort` is already taken in its container gets
 *   the next free number as it is created.
 *
 * The numbering is the same whichever client computes it (by current `sort`,
 * ties by the actor's own item order), so two people opening the same sheet
 * write the same thing. A visitor tab (constants.js) does not repair on its
 * own; the api below still works there.
 */
const density = () => CONST.SORT_INTEGER_DENSITY ?? 100000;
const containerOf = (item) => item.system?.containerId ?? "";
const physicalItems = (actor) => actor.items.filter((i) => i.isOfType?.("physical"));

/** The `sort` updates that would separate every clash on this actor. Empty when there is none. */
export function sortRepairs(actor) {
  const groups = new Map();
  physicalItems(actor).forEach((item, index) => {
    const key = containerOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ item, index });
  });
  const updates = [];
  for (const members of groups.values()) {
    if (new Set(members.map((m) => m.item.sort)).size === members.length) continue;
    members.sort((a, b) => (a.item.sort - b.item.sort) || (a.index - b.index));
    members.forEach(({ item }, i) => {
      const sort = (i + 1) * density();
      if (item.sort !== sort) updates.push({ _id: item.id, sort });
    });
  }
  return updates;
}

const running = new Set();

export async function repairSort(actor) {
  if (!actor || running.has(actor.uuid)) return 0;
  const updates = sortRepairs(actor);
  if (!updates.length) return 0;
  running.add(actor.uuid);
  try {
    // raccoonStack: the stack-split hooks have nothing to do with a re-numbering.
    await actor.updateEmbeddedDocuments("Item", updates, { raccoonStack: true, raccoonSortRepair: true });
    log(`Inventory order repaired on ${actor.name}: ${updates.length} item(s) renumbered.`);
    return updates.length;
  } finally {
    running.delete(actor.uuid);
  }
}

// Numbers handed out a moment ago, for items created together in one batch:
// each of them sees the same existing items and would pick the same number.
const lastGiven = new Map();

export function registerSortRepair() {
  const onRender = (app) => {
    try {
      const actor = app.actor ?? app.document;
      if (VISITOR || !setting(SETTINGS.SORT_REPAIR)) return;
      if (!actor?.isOwner || actor.pack || actor.isToken || !actor.items) return;
      if (app.isEditable === false || !sortRepairs(actor).length) return;
      // The GM's tab goes first; a player's waits a moment and looks again, so
      // the same repair is not sent twice when both have the sheet open.
      const delay = game.user.isGM ? 0 : 400 + Math.floor(Math.random() * 400);
      setTimeout(() => repairSort(actor).catch((e) => warn("Inventory order repair failed.", e)), delay);
    } catch (error) {
      warn("Inventory order check failed.", error);
    }
  };
  Hooks.on("renderActorSheet", onRender);
  Hooks.on("renderActorSheetV2", onRender);

  Hooks.on("preCreateItem", (item) => {
    try {
      if (!setting(SETTINGS.SORT_REPAIR)) return;
      const actor = item.actor;
      if (!actor || actor.pack || !item.isOfType?.("physical")) return;
      const key = `${actor.uuid}|${containerOf(item)}`;
      const taken = physicalItems(actor).filter((i) => containerOf(i) === containerOf(item)).map((i) => i.sort);
      const recent = lastGiven.get(key);
      if (!taken.includes(item.sort) && recent !== item.sort) return;
      const next = Math.max(0, ...taken, recent ?? 0) + density();
      item.updateSource({ sort: next });
      lastGiven.set(key, next);
      setTimeout(() => { if (lastGiven.get(key) === next) lastGiven.delete(key); }, 3000);
    } catch (error) {
      warn("Could not give the new item its own place in the order.", error);
    }
  });

  Hooks.once("ready", () => {
    const api = game.modules.get(MODULE_ID).api ?? (game.modules.get(MODULE_ID).api = {});
    const find = (ref) => game.actors.get(ref) ?? game.actors.find((a) => a.name.toLowerCase().includes(String(ref).toLowerCase()));
    api.inventoryOrder = {
      /** How many items would be renumbered on this actor: `check("Ezekiel")`. */
      check: (ref) => sortRepairs(find(ref)).length,
      /** Renumber one actor now. */
      repair: (ref) => repairSort(find(ref)),
      /** Renumber every player-owned character now; returns what was done. */
      repairParty: async () => {
        const done = {};
        for (const actor of game.actors.filter((a) => a.type === "character" && a.hasPlayerOwner)) done[actor.name] = await repairSort(actor);
        return done;
      },
    };
  });
}
