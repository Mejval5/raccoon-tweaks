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
      dropItem(actor, item, options.raccoonDropLight ?? null).catch((error) => {
        warn("Drop on ground failed.", error);
        ui.notifications.error(game.i18n.format("raccoon-tweaks.drop.failed", { error: error.message }));
      });
    } catch (error) {
      warn("Drop hook failed.", error);
    }
  });
}

async function dropItem(actor, item, light) {
  const token = actor.getActiveTokens(true, true)[0];
  if (!token || !canvas.scene) {
    ui.notifications.warn(game.i18n.localize("raccoon-tweaks.drop.noToken"));
    return;
  }

  const pile = await groundPileAt(token, { img: item.img, light });

  // PF2e's own transfer keeps identity and stacks; the whole stack goes, as "I drop it" means.
  await actor.transferItemToActor(pile.actor, item, item.quantity);

  // An existing pile gets the light only if it had none.
  if (!pile.created && light && !(pile.token.light.bright || pile.token.light.dim)) {
    await pile.token.update({ light, "flags.raccoon-tweaks.lightFrom": item.slug ?? item.name });
  }

  // PF2e can leave the item's light written into the owner's token when the
  // lit item leaves by transfer rather than by toggle. If the token's stored
  // light is exactly the dropped light and no light rule remains active, it is
  // that leftover: clear it.
  if (light) await clearLeftoverLight(actor, token, light);

  log(`Dropped ${item.name} x${item.quantity} at ${token.x},${token.y}.`);
  ui.notifications.info(game.i18n.format("raccoon-tweaks.drop.done", { item: item.name }));
}

async function clearLeftoverLight(actor, token, light) {
  const stillLit = actor.rules?.some((r) => r.key === "TokenLight" && !r.ignored);
  if (stillLit) return;
  const stored = token._source?.light ?? token.light;
  if (!stored || (stored.bright !== light.bright || stored.dim !== light.dim)) return;
  if (!(stored.bright || stored.dim)) return;
  const proto = actor.prototypeToken?.light ?? { bright: 0, dim: 0 };
  await token.update({ light: { bright: proto.bright ?? 0, dim: proto.dim ?? 0 } });
  log(`Cleared leftover light on ${token.name}.`);
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
