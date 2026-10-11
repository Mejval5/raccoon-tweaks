import { SETTINGS, log, warn, stampOrigin, fromThisTab } from "./constants.js";
import { setting } from "./settings.js";

/**
 * PF2e's "Dropped" carry state (the grip-lines entry in the inventory's carry
 * menu) means "not on the body": the item's rule elements stop applying, so a
 * dropped light goes dark in hand. This makes the state physical. Any physical
 * item that becomes `dropped` on a character or NPC moves into a loot actor
 * (name from the setting, default "Na zemi"), one per square, whose token sits
 * at the owner's feet with the item's image. An item with a TokenLight rule
 * element whose predicate holds (an everlight crystal always, a torch only
 * while lit) puts that light on the ground token, so the room stays lit.
 *
 * Workbench's "drop held items when unconscious" writes the same field, so a
 * downed character's torch rolls onto the floor by itself. Picking up is the
 * normal drag from the loot sheet; the pile hides itself when empty.
 */
export function registerDropItem() {
  // A pile's light came from an item; when the last item leaves, the light goes too.
  Hooks.on("preDeleteItem", (item, options) => stampOrigin(options));
  Hooks.on("deleteItem", (item, options, userId) => {
    try {
      if (!fromThisTab(options)) return;
      const actor = item.actor;
      if (!actor?.getFlag("raccoon-tweaks", "groundPile")) return;
      if (actor.items.size > 0) return;
      for (const t of actor.getActiveTokens(true, true)) {
        if (t.light.bright || t.light.dim) {
          t.update({ light: { bright: 0, dim: 0 }, "flags.raccoon-tweaks.-=lightFrom": null })
            .catch((e) => warn("Could not clear the pile light.", e));
        }
      }
    } catch (error) {
      warn("Pile light cleanup failed.", error);
    }
  });

  // The light is read before the change lands: once PF2e marks the item
  // dropped its rule elements are suppressed, so "lit-torch" is already gone
  // from the actor's roll options by the time updateItem fires.
  Hooks.on("preUpdateItem", (item, changes, options, userId) => {
    try {
      stampOrigin(options);
      if (changes?.system?.equipped?.carryType !== "dropped") return;
      if (!item.isOfType?.("physical") || !item.actor) return;
      options.raccoonDropLight = lightFor(item);
      options.raccoonPrevCarry = item._source?.system?.equipped?.carryType ?? "worn";
    } catch (error) {
      warn("Drop pre-hook failed.", error);
    }
  });

  Hooks.on("updateItem", (item, changes, options, userId) => {
    try {
      if (!fromThisTab(options)) return;                         // only the tab that made the change acts
      if (options?.raccoonStack) return;                         // a split/merge of ours, not a drop
      if (!item.isOfType?.("physical")) return;
      if (changes?.system?.equipped?.carryType !== "dropped") return;
      const actor = item.actor;
      if (!actor || !["character", "npc"].includes(actor.type)) return;
      if (actor.getFlag("raccoon-tweaks", "groundPile")) return;  // never re-drop out of a pile
      dropItem(actor, item, options.raccoonDropLight ?? null, options.raccoonPrevCarry ?? "worn").catch((error) => {
        warn("Drop on ground failed.", error);
        ui.notifications.error(game.i18n.format("raccoon-tweaks.drop.failed", { error: error.message }));
      });
    } catch (error) {
      warn("Drop hook failed.", error);
    }
  });
}

async function dropItem(actor, item, light, prevCarry) {
  const token = actor.getActiveTokens(true, true)[0];
  if (!token || !canvas.scene) {
    ui.notifications.warn(game.i18n.localize("raccoon-tweaks.drop.noToken"));
    return;
  }

  // The Torch module (game.Torch) lights tokens from its own table and writes
  // the light into the token; PF2e's rule toggle knows nothing about it. If the
  // dropped item is the module's current, lit source, that light goes to the
  // ground and the owner is extinguished through the module so its state stays
  // consistent.
  const torch = await torchModuleState(item, token);
  if (torch) light = torch.light;

  const pile = await groundPileAt(token, { img: item.img, light });

  if (torch) {
    await game.Torch.extinguish(torch.sceneId, torch.tokenId);
    if (torch.consumedAtLight) {
      // The module already took one torch when it was lit: that burning torch
      // is what lands on the ground. The stack in the pack is left as it was.
      const copy = item.toObject();
      delete copy._id;
      copy.system.quantity = 1;
      copy.system.equipped = { carryType: "worn", handsHeld: 0, invested: null };
      await pile.actor.createEmbeddedDocuments("Item", [copy], { raccoonStack: true });
      await item.update({ "system.equipped.carryType": prevCarry, "system.equipped.handsHeld": prevCarry === "held" ? 1 : 0 }, { raccoonStack: true });
    } else {
      // Nothing was consumed: the lit torch is one unit of the dropped stack.
      // PF2e marked the whole stack dropped; whatever stays in the pack goes
      // back to how it was carried.
      await actor.transferItemToActor(pile.actor, item, 1);
      const rest = actor.items.get(item.id);
      if (rest) await rest.update({ "system.equipped.carryType": prevCarry, "system.equipped.handsHeld": prevCarry === "held" ? 1 : 0 }, { raccoonStack: true });
    }
  } else {
    // PF2e's own transfer keeps identity and stacks; the whole stack goes, as "I drop it" means.
    await actor.transferItemToActor(pile.actor, item, item.quantity);
  }

  // An existing pile gets the light only if it had none.
  if (!pile.created && light && !(pile.token.light.bright || pile.token.light.dim)) {
    await pile.token.update({ light, "flags.raccoon-tweaks.lightFrom": item.slug ?? item.name });
  }

  log(`Dropped ${item.name} x${item.quantity} at ${token.x},${token.y}.`);
  ui.notifications.info(game.i18n.format("raccoon-tweaks.drop.done", { item: item.name }));
}

/**
 * The Torch module's view of this drop, or null: the dropped item must be the
 * token's current source and lit. Returns the light the module wrote into the
 * token (its full config, colour and animation included), the ids its API
 * wants, and whether the module already consumed a unit when it was lit.
 */
async function torchModuleState(item, token) {
  const T = game.Torch;
  if (!T || !token?.parent) return null;
  try {
    const sceneId = token.parent.id;
    const tokenId = token.id;
    const [state, source] = await Promise.all([T.currentState(sceneId, tokenId), T.currentSource(sceneId, tokenId)]);
    if (!state || state === "off" || !source || source !== item.name) return null;
    const stored = foundry.utils.deepClone(token._source?.light ?? {});
    if (!(stored.bright || stored.dim)) return null;
    const key = game.user.isGM ? "gmUsesInventory" : "playerUsesInventory";
    let consumedAtLight = false;
    try { consumedAtLight = Boolean(game.settings.get("torch", key)); } catch { /* setting absent */ }
    return { light: stored, sceneId, tokenId, consumedAtLight };
  } catch (error) {
    warn("Torch module state unavailable.", error);
    return null;
  }
}

/** The loot token in this square, or a new one. */
async function groundPileAt(token, { img, light } = {}) {
  const name = setting(SETTINGS.DROP_PILE_NAME)?.trim() || "Na zemi";
  const existing = canvas.scene.tokens.find((t) =>
    t.actor?.type === "loot" && t.getFlag("raccoon-tweaks", "groundPile")
    && t.x === token.x && t.y === token.y);
  if (existing) return { actor: existing.actor, token: existing, created: false };

  const folder = game.folders.find((f) => f.type === "Actor" && f.name === "Treasure") ?? null;
  const actor = await Actor.implementation.create({
    name,
    type: "loot",
    folder: folder?.id ?? null,
    system: { lootSheetType: "Loot", hiddenWhenEmpty: true },
    flags: { "raccoon-tweaks": { groundPile: true } },
  });
  // PF2e sets Limited on create; players need at least that to pick things up.
  if ((actor.ownership?.default ?? 0) < CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED) {
    await actor.update({ "ownership.default": CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED });
  }

  const data = await actor.getTokenDocument({
    x: token.x, y: token.y,
    width: 0.5, height: 0.5,
    hidden: false,
    texture: { src: img ?? actor.img },
    ...(light ? { light } : {}),
    displayName: CONST.TOKEN_DISPLAY_MODES.HOVER,
    disposition: CONST.TOKEN_DISPOSITIONS.NEUTRAL,
    flags: { "raccoon-tweaks": { groundPile: true, ...(light ? { lightFrom: true } : {}) } },
  });
  const [created] = await canvas.scene.createEmbeddedDocuments("Token", [data.toObject()]);
  return { actor: created.actor, token: created, created: true };
}

/** The light an item would shed, from its TokenLight rule element, or null. */
function lightFor(item) {
  const rules = item.system?.rules ?? [];
  const rule = rules.find((r) => r.key === "TokenLight" && !r.ignored);
  if (!rule?.value) return null;
  const predicate = rule.predicate ?? [];
  if (predicate.length) {
    // A torch's "lit-torch" predicate: honour it only if the owner currently has that option.
    const options = new Set(item.actor?.getRollOptions?.() ?? []);
    if (!predicate.every((p) => typeof p === "string" ? options.has(p) : true)) return null;
  }
  const v = foundry.utils.deepClone(rule.value);
  return {
    alpha: v.alpha, angle: v.angle ?? 360, bright: v.bright ?? 0, dim: v.dim ?? 0,
    color: v.color ?? null, coloration: v.coloration ?? 1, attenuation: v.attenuation ?? 0.5,
    luminosity: v.luminosity ?? 0.5, saturation: v.saturation ?? 0, contrast: v.contrast ?? 0,
    shadows: v.shadows ?? 0, animation: v.animation ?? {}, darkness: v.darkness ?? { min: 0, max: 1 },
    negative: Boolean(v.negative), priority: v.priority ?? 0,
  };
}
