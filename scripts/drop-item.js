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
  Hooks.once("setup", installTransferWrapper);

  // Dragging an item from a sheet onto the map drops it on that square. Only
  // on empty ground: a drop onto a token is PF2e's own "give it to them".
  // Players may drop within one square of their token, the GM anywhere.
  Hooks.on("dropCanvasData", (canvasRef, data) => {
    try {
      if (data?.type !== "Item" || !data.uuid || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return true;
      const item = fromUuidSync(data.uuid);
      if (!item?.isOfType?.("physical") || !item.actor || !["character", "npc"].includes(item.actor.type)) return true;
      if (!item.actor.isOwner || item.actor.getFlag("raccoon-tweaks", "groundPile")) return true;
      if (item.system?.equipped?.carryType === "dropped") return true;
      const g = canvas.grid.size;
      const underToken = canvas.scene.tokens.some((t) => !t.getFlag("raccoon-tweaks", "groundPile")
        && data.x >= t.x && data.x < t.x + Math.max(1, t.width) * g && data.y >= t.y && data.y < t.y + Math.max(1, t.height) * g);
      if (underToken) return true;
      const owner = item.actor.getActiveTokens(true, true)[0];
      if (!owner) return true;
      const square = canvas.grid.getTopLeftPoint({ x: data.x, y: data.y });
      if (!game.user.isGM) {
        const w = Math.max(1, Math.round(owner.width ?? 1)), h = Math.max(1, Math.round(owner.height ?? 1));
        const dx = square.x < owner.x ? owner.x - square.x : Math.max(0, square.x - (owner.x + (w - 1) * g));
        const dy = square.y < owner.y ? owner.y - square.y : Math.max(0, square.y - (owner.y + (h - 1) * g));
        if (dx > g || dy > g) { ui.notifications.warn(game.i18n.localize("raccoon-tweaks.drop.tooFar")); return false; }
      }
      item.update({ "system.equipped.carryType": "dropped", "system.equipped.handsHeld": 0 }, { raccoonSquare: { x: square.x, y: square.y } })
        .catch((e) => warn("Drop onto the map failed.", e));
      return false;
    } catch (error) {
      warn("Canvas drop hook failed.", error);
      return true;
    }
  });

  // Fired by stack-split.js once an arriving item has settled (merged or not).
  // A torch that was burning on the ground lights up again in the new owner's
  // hands, through the Torch module, without costing a torch.
  Hooks.on("raccoonItemArrived", (actor, survivor, info) => {
    if (!info?.wasLit) return;
    relightFromGround(actor, survivor, info.name).catch((e) => warn("Relight on pick-up failed.", e));
  });

  // When the last item leaves a pile, the pile goes: its tokens on every scene
  // and the loot actor itself. (Before 0.15 only the light was cleared and the
  // empty token stayed, hidden from players but in the GM's way.)
  Hooks.on("preDeleteItem", (item, options) => stampOrigin(options));
  Hooks.on("deleteItem", (item, options, userId) => {
    try {
      if (!fromThisTab(options)) return;
      const actor = item.actor;
      if (!actor?.getFlag("raccoon-tweaks", "groundPile")) return;
      if (actor.items.size > 0) return;
      removeEmptyPile(actor).catch((e) => warn("Could not remove the empty pile.", e));
    } catch (error) {
      warn("Pile cleanup failed.", error);
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
      options.raccoonPrevHands = item._source?.system?.equipped?.handsHeld ?? 0;
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
      // One drop at a time. Workbench drops every held item of a downed
      // character in the same tick; run in parallel, each drop looked for a
      // pile before the others had created theirs, and three items made three
      // piles on one square.
      dropQueue = dropQueue
        .then(() => dropItem(actor, item, options.raccoonDropLight ?? null, options.raccoonPrevCarry ?? "worn", options.raccoonPrevHands ?? 0, options.raccoonSquare ?? null))
        .catch((error) => {
          warn("Drop on ground failed.", error);
          ui.notifications.error(game.i18n.format("raccoon-tweaks.drop.failed", { error: error.message }));
        });
    } catch (error) {
      warn("Drop hook failed.", error);
    }
  });
}

let dropQueue = Promise.resolve();

async function dropItem(actor, item, light, prevCarry, prevHands, square = null) {
  const token = actor.getActiveTokens(true, true)[0];
  if (!token || !canvas.scene) {
    ui.notifications.warn(game.i18n.localize("raccoon-tweaks.drop.noToken"));
    return;
  }
  if (!actor.items.get(item.id)) return;                       // already gone (a merged twin, a second tab)

  // How it was carried travels with it, so picking it up puts it back in the
  // same hands (stack-split.js, restoreCarry). Written before the transfer:
  // PF2e copies the item's flags onto the ground copy.
  const prev = { carryType: prevCarry, handsHeld: prevCarry === "held" ? Math.max(1, prevHands) : 0 };
  await item.update({ "flags.raccoon-tweaks.prevCarry": prev }, { raccoonStack: true });

  // The Torch module (game.Torch) lights tokens from its own table and writes
  // the light into the token; PF2e's rule toggle knows nothing about it. If the
  // dropped item is the module's current, lit source, that light goes to the
  // ground and the owner is extinguished through the module so its state stays
  // consistent.
  const torch = await torchModuleState(item, token);
  if (torch) light = torch.light;

  const pile = await groundPileAt(token, { img: item.img, light, square });

  if (torch) {
    await game.Torch.extinguish(torch.sceneId, torch.tokenId);
    if (torch.consumedAtLight) {
      // The module already took one torch when it was lit: that burning torch
      // is what lands on the ground. The stack in the pack is left as it was.
      const copy = item.toObject();
      delete copy._id;
      copy.system.quantity = 1;
      copy.system.equipped = { carryType: "worn", handsHeld: 0, invested: null };
      foundry.utils.setProperty(copy, "flags.raccoon-tweaks.litOnGround", true);
      foundry.utils.setProperty(copy, "flags.raccoon-tweaks.prevCarry", prev);
      await pile.actor.createEmbeddedDocuments("Item", [copy], { raccoonStack: true });
      await item.update({ "system.equipped.carryType": prevCarry, "system.equipped.handsHeld": prevCarry === "held" ? 1 : 0, "flags.raccoon-tweaks.-=prevCarry": null }, { raccoonStack: true });
    } else {
      // Nothing was consumed: the lit torch is one unit of the dropped stack.
      // PF2e marked the whole stack dropped; whatever stays in the pack goes
      // back to how it was carried.
      await actor.transferItemToActor(pile.actor, item, 1);
      const onGround = pile.actor.items.find((i) => i.name === item.name && i.isOfType?.("physical"));
      if (onGround) await onGround.setFlag("raccoon-tweaks", "litOnGround", true);
      const rest = actor.items.get(item.id);
      if (rest) await rest.update({ "system.equipped.carryType": prevCarry, "system.equipped.handsHeld": prevCarry === "held" ? 1 : 0, "flags.raccoon-tweaks.-=prevCarry": null }, { raccoonStack: true });
    }
  } else {
    // PF2e's own transfer keeps identity and stacks; the whole stack goes, as "I drop it" means.
    await actor.transferItemToActor(pile.actor, item, item.quantity);
  }

  // An existing pile gets the light only if it had none.
  if (!pile.created && light && !(pile.token.light.bright || pile.token.light.dim)) {
    await pile.token.update({ light, "flags.raccoon-tweaks.lightFrom": item.slug ?? item.name });
  }

  log(`Dropped ${item.name} at ${pile.token.x},${pile.token.y}${pile.token.x === token.x && pile.token.y === token.y ? " (under the token)" : ""}.`);
  ui.notifications.info(game.i18n.format("raccoon-tweaks.drop.done", { item: item.name }));
}

/** Tokens of an emptied pile on every scene, then the actor. */
async function removeEmptyPile(actor) {
  for (const scene of game.scenes) {
    const ids = scene.tokens.filter((t) => t.actorId === actor.id).map((t) => t.id);
    if (ids.length) await scene.deleteEmbeddedDocuments("Token", ids);
  }
  await actor.delete();
  log(`Removed the empty pile ${actor.name}.`);
}

/**
 * PF2e's own stacking on pick-up updates the existing stack instead of
 * creating an item, so no createItem fires and the ground copy's flag is
 * discarded. The transfer itself is the reliable moment: wrap
 * transferItemToActor and relight the receiver after a marked torch leaves a
 * pile. libWrapper when present, a plain prototype patch otherwise.
 */
function installTransferWrapper() {
  const proto = CONFIG.Actor.documentClass?.prototype;
  if (typeof proto?.transferItemToActor !== "function") {
    warn("transferItemToActor not found, relight on pick-up stays off.");
    return;
  }
  const after = async (source, target, item, result) => {
    try {
      if (!source?.getFlag?.("raccoon-tweaks", "groundPile")) return;
      if (!item?.getFlag?.("raccoon-tweaks", "litOnGround")) return;
      if (!target || !["character", "npc"].includes(target.type)) return;
      await relightFromGround(target, null, item.name);
    } catch (error) {
      warn("Relight after transfer failed.", error);
    }
  };
  const path = "CONFIG.Actor.documentClass.prototype.transferItemToActor";
  if (globalThis.libWrapper?.register) {
    libWrapper.register("raccoon-tweaks", path, async function (wrapped, target, item, ...rest) {
      // Read the flag before the original runs: the ground copy may be deleted by it.
      const lit = Boolean(item?.getFlag?.("raccoon-tweaks", "litOnGround"));
      const result = await wrapped(target, item, ...rest);
      if (lit) await after(this, target, { name: item?.name, getFlag: () => lit }, result);
      return result;
    }, "WRAPPER");
    log("transferItemToActor wrapped (libWrapper).");
  } else {
    const original = proto.transferItemToActor;
    proto.transferItemToActor = async function (target, item, ...rest) {
      const lit = Boolean(item?.getFlag?.("raccoon-tweaks", "litOnGround"));
      const result = await original.call(this, target, item, ...rest);
      if (lit) await after(this, target, { name: item?.name, getFlag: () => lit }, result);
      return result;
    };
    log("transferItemToActor wrapped (direct).");
  }
}

async function relightFromGround(actor, survivor, name) {
  if (survivor?.getFlag?.("raccoon-tweaks", "litOnGround")) await survivor.unsetFlag("raccoon-tweaks", "litOnGround");
  const T = game.Torch;
  const token = actor.getActiveTokens(true, true)[0];
  if (!T || !token?.parent) return;
  const sceneId = token.parent.id, tokenId = token.id;
  const state = await T.currentState(sceneId, tokenId);
  if (state && state !== "off") return;                       // already carrying a light
  const sources = await T.equippedSources(sceneId, tokenId);
  if (!sources.includes(name)) return;
  await T.selectSource(sceneId, tokenId, name);

  // The module consumes a unit when it lights (players by default). Snapshot,
  // light, then give back whatever it took: this torch was already paid for.
  const before = new Map(actor.items.filter((i) => i.name === name).map((i) => [i.id, i.quantity]));
  const template = actor.items.find((i) => i.name === name)?.toObject();
  await T.toggle(sceneId, tokenId);
  const after = new Map(actor.items.filter((i) => i.name === name).map((i) => [i.id, i.quantity]));
  for (const [id, qty] of before) {
    const now = after.get(id);
    if (now === undefined) {
      // consumed to zero and deleted: put one back
      if (template) { delete template._id; template.system.quantity = 1; await actor.createEmbeddedDocuments("Item", [template], { raccoonStack: true }); }
    } else if (now < qty) {
      await actor.items.get(id).update({ "system.quantity": now + (qty - now) }, { raccoonStack: true });
    }
  }
  log(`Relit ${name} on pick-up for ${actor.name}.`);
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

/**
 * Where a drop lands. A pile that already lies under or next to the owner is
 * reused. Otherwise the nearest free square around the owner, so a downed
 * character's weapons are visible beside the token instead of under it;
 * under the token only when every neighbour is taken or walled off.
 */
function dropSquare(token) {
  const scene = canvas.scene, g = scene.grid.size;
  const isPile = (t) => t.actor?.type === "loot" && t.getFlag("raccoon-tweaks", "groundPile");
  const pileAt = (x, y) => scene.tokens.find((t) => isPile(t) && t.x === x && t.y === y);
  const w = Math.max(1, Math.round(token.width ?? 1)), h = Math.max(1, Math.round(token.height ?? 1));
  const centre = { x: token.x + (w * g) / 2, y: token.y + (h * g) / 2 };
  // Squares around the token's footprint, nearest first; for a 1x1 token: S, E, W, N, then the diagonals.
  const ring = [];
  for (let dy = -1; dy <= h; dy++) for (let dx = -1; dx <= w; dx++) {
    if (dx >= 0 && dx < w && dy >= 0 && dy < h) continue;
    ring.push({ x: token.x + dx * g, y: token.y + dy * g, d: Math.hypot(dx - (w - 1) / 2, dy - (h - 1) / 2), tie: dy > 0 ? 0 : dx > 0 ? 1 : dx < 0 ? 2 : 3 });
  }
  ring.sort((a, b) => a.d - b.d || a.tie - b.tie);

  const under = pileAt(token.x, token.y);
  if (under) return { x: under.x, y: under.y, pile: under };
  for (const s of ring) { const p = pileAt(s.x, s.y); if (p && reachable(centre, s, g)) return { x: s.x, y: s.y, pile: p }; }
  for (const s of ring) {
    if (s.x < 0 || s.y < 0 || s.x + g > scene.dimensions.width || s.y + g > scene.dimensions.height) continue;
    if (occupied(scene, s.x, s.y, g)) continue;
    if (!reachable(centre, s, g)) continue;
    return { x: s.x, y: s.y, pile: null };
  }
  return { x: token.x, y: token.y, pile: null };
}

/** Any non-pile token whose footprint covers this square. */
function occupied(scene, x, y, g) {
  return scene.tokens.some((t) => {
    if (t.actor?.type === "loot" && t.getFlag("raccoon-tweaks", "groundPile")) return false;
    const tw = Math.max(1, Math.round(t.width ?? 1)) * g, th = Math.max(1, Math.round(t.height ?? 1)) * g;
    return x < t.x + tw && x + g > t.x && y < t.y + th && y + g > t.y;
  });
}

/** No movement-blocking wall between the owner's centre and the square's centre. */
function reachable(from, square, g) {
  try {
    const to = { x: square.x + g / 2, y: square.y + g / 2 };
    const backend = CONFIG.Canvas.polygonBackends?.move;
    if (!backend?.testCollision) return true;
    return !backend.testCollision(from, to, { type: "move", mode: "any" });
  } catch { return true; }
}

/** The loot token where this owner's drop lands, or a new one. */
async function groundPileAt(token, { img, light, square } = {}) {
  const name = setting(SETTINGS.DROP_PILE_NAME)?.trim() || "Na zemi";
  const spot = square
    ? { x: square.x, y: square.y, pile: canvas.scene.tokens.find((t) => t.actor?.type === "loot" && t.getFlag("raccoon-tweaks", "groundPile") && t.x === square.x && t.y === square.y) ?? null }
    : dropSquare(token);
  if (spot.pile) return { actor: spot.pile.actor, token: spot.pile, created: false };

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
    x: spot.x, y: spot.y,
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
