import { SETTINGS, log, warn } from "./constants.js";
import { setting } from "./settings.js";

/**
 * "Drop on ground" in the inventory context menu. The item moves into a loot
 * actor named after the setting (default "Na zemi"), one per square, whose
 * token is placed at the character's feet with the item's image. An item that
 * carries a TokenLight rule element whose predicate holds (an everlight
 * crystal always, a torch only while lit) puts that light on the ground token,
 * so a dropped light keeps lighting the room. Picking it back up is the
 * normal drag from the loot sheet.
 */
export function registerDropItem() {
  Hooks.on("getActorSheetEntryContext", (sheet, entries) => {
    const actor = sheet.actor ?? sheet.document;
    if (!actor || !["character", "npc"].includes(actor.type)) return;
    if (!actor.isOwner) return;
    entries.push({
      name: game.i18n.localize("raccoon-tweaks.drop.menu"),
      icon: '<i class="fa-solid fa-arrow-down-to-line"></i>',
      condition: (li) => {
        const item = itemFromEntry(actor, li);
        return Boolean(item?.isOfType?.("physical"));
      },
      callback: (li) => {
        const item = itemFromEntry(actor, li);
        if (item) dropItem(actor, item).catch((error) => {
          warn("Drop on ground failed.", error);
          ui.notifications.error(game.i18n.format("raccoon-tweaks.drop.failed", { error: error.message }));
        });
      },
    });
  });
}

function itemFromEntry(actor, li) {
  const el = li instanceof HTMLElement ? li : li?.[0];
  const id = el?.dataset?.itemId ?? el?.closest?.("[data-item-id]")?.dataset?.itemId;
  return id ? actor.items.get(id) : null;
}

async function dropItem(actor, item) {
  const token = actor.getActiveTokens(true, true)[0] ?? canvas.tokens.controlled.find((t) => t.actor === actor)?.document;
  if (!token || !canvas.scene) {
    ui.notifications.warn(game.i18n.localize("raccoon-tweaks.drop.noToken"));
    return;
  }

  const quantity = item.quantity > 1 ? await askQuantity(item) : 1;
  if (!quantity) return;

  const light = lightFor(item);
  // Token art and light go into the creation payload for a new pile, so there
  // is no second update racing the placement.
  const pile = await groundPileAt(token, { img: item.img, light });

  // PF2e's own transfer keeps the item's identity and splits stacks correctly.
  await actor.transferItemToActor(pile.actor, item, quantity);

  // An existing pile gets the light only if it had none; its art stays the first item's.
  if (!pile.created && light && !(pile.token.light.bright || pile.token.light.dim)) {
    await pile.token.update({ light, "flags.raccoon-tweaks.lightFrom": item.slug ?? item.name });
  }

  log(`Dropped ${item.name} x${quantity} at ${token.x},${token.y}.`);
  ui.notifications.info(game.i18n.format("raccoon-tweaks.drop.done", { item: item.name }));
}

async function askQuantity(item) {
  const { DialogV2 } = foundry.applications.api;
  const result = await DialogV2.prompt({
    window: { title: game.i18n.localize("raccoon-tweaks.drop.menu") },
    content: `<div class="form-group"><label>${game.i18n.format("raccoon-tweaks.drop.howMany", { item: item.name, max: item.quantity })}</label>
      <input type="number" name="qty" min="1" max="${item.quantity}" value="${item.quantity}" autofocus /></div>`,
    ok: { label: game.i18n.localize("raccoon-tweaks.drop.menu"), callback: (event, button) => Number(button.form.elements.qty.value) },
    rejectClose: false,
  });
  if (!result) return 0;
  return Math.max(1, Math.min(item.quantity, Math.floor(result)));
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
    // A torch's "lit-torch" style predicate: honour it only if the actor currently has that option.
    const options = new Set(item.actor?.getRollOptions?.() ?? []);
    const ok = predicate.every((p) => typeof p === "string" ? options.has(p) : true);
    if (!ok) return null;
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
