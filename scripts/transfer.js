import { MODULE_ID, SETTINGS, log, warn } from "./constants.js";
import { setting } from "./settings.js";

/**
 * Handing an item to another character without the dialogs.
 *
 * PF2e's drop of an item onto another actor's sheet does one of three things:
 * a quantity popup (own actor or loot), a GM-supervised transfer (loot the
 * player cannot edit), or, for another player's character, a trade dialog that
 * both players have to accept. At the table that last one was the "second
 * confirmation" nobody wanted (Makak, 2026-10-26; Dan: plain drag hands it
 * over, Shift keeps the old behaviour).
 *
 * So: a plain drag of a physical item onto a character or NPC moves the whole
 * stack at once. Between two actors the user owns it is a direct transfer.
 * Onto an actor the user does not own, the giver cannot write, so the request
 * is left as a flag on the giver's own actor; the active GM's tab sees that
 * update, checks that the requester owns the source and that the two are
 * allies, moves the item, posts a short chat line and writes the outcome back,
 * and the giver is told whether it happened. With Shift held, or with no GM
 * online, PF2e's own flow runs. Loot actors and merchants are never touched:
 * buying stays buying.
 *
 * Why a flag and not a module socket: 0.17 and 0.18 emitted on
 * `module.raccoon-tweaks`, but the manifest had no `"socket": true`, so
 * Foundry dropped every request without an error and the giver was still told
 * it had worked (session 7). A socket also needs a server restart to switch
 * on; a document update needs nothing and is delivered to every client.
 */
const REQUEST = "handOver";
const RESULT = "handOverResult";
const ANSWER_TIMEOUT_MS = 8000;
const STALE_MS = 30000;
const pending = new Map();                                             // request id -> { timer, item, target }

export function registerTransfer() {
  // At `ready`, not `setup`: in v14 the registered sheet classes are not all in
  // CONFIG.Actor.sheetClasses before then, and the actors' own sheets are the
  // surest place to find the system's base class.
  Hooks.once("ready", installMoveWrapper);

  Hooks.on("updateActor", (actor, changes, options, userId) => {
    try {
      const flags = changes?.flags?.[MODULE_ID];
      if (!flags) return;
      if (flags[REQUEST] && game.user === game.users.activeGM) {
        serve(actor, flags[REQUEST], userId).catch((e) => warn("Relayed hand-over failed.", e));
      }
      if (flags[RESULT]) settle(flags[RESULT]);
    } catch (error) {
      warn("Hand-over hook failed.", error);
    }
  });
}

function installMoveWrapper() {
  const registered = Object.values(CONFIG.Actor.sheetClasses ?? {}).flatMap((byId) => Object.values(byId).map((s) => s?.cls));
  const inUse = game.actors.contents.filter((a) => ["character", "npc", "loot"].includes(a.type)).slice(0, 40).map((a) => { try { return a.sheet?.constructor; } catch { return null; } });
  let proto = null;
  for (const cls of [...registered, ...inUse]) {
    let p = cls?.prototype;
    while (p && !Object.prototype.hasOwnProperty.call(p, "moveItemBetweenActors")) p = Object.getPrototypeOf(p);
    if (p) { proto = p; break; }
  }
  if (proto && proto.moveItemBetweenActors?.raccoonWrapped) return;
  if (!proto) { warn("moveItemBetweenActors not found on any actor sheet; hand-over without dialogs stays off."); return; }
  const original = proto.moveItemBetweenActors;
  proto.moveItemBetweenActors = async function (event, item, targetActor) {
    try {
      if (await quickHandOver(event, item, targetActor)) return;
    } catch (error) {
      warn("Quick hand-over failed, falling back to the system's flow.", error);
    }
    return original.call(this, event, item, targetActor);
  };
  proto.moveItemBetweenActors.raccoonWrapped = true;
  log(`moveItemBetweenActors wrapped on ${proto.constructor?.name ?? "the actor sheet"}: plain drag hands the stack over, Shift keeps the dialogs.`);
}

/** @returns true when the hand-over was done (or requested) here */
async function quickHandOver(event, item, target) {
  if (!setting(SETTINGS.QUICK_TRANSFER)) return false;
  if (event?.shiftKey) return false;                                   // the old menus, on purpose
  const source = item?.actor;
  if (!source || !target || source === target) return false;
  if (!item.isOfType?.("physical") || item.quantity < 1) return false;
  if (!source.isOwner) return false;
  if (!target.isOfType?.("character", "npc")) return false;           // loot and merchants: PF2e
  if (source.isOfType("loot")) return false;
  if (item.isOfType("backpack") && item.contents?.size) return false;  // a full container: let PF2e ask

  if (target.isOwner) {
    await source.transferItemToActor(target, item, item.quantity);
    log(`${source.name} hands ${item.quantity}x ${item.name} to ${target.name}.`);
    return true;
  }
  // Not ours: the GM's tab does it. Without a GM the system's trade is the only way.
  if (!game.users.activeGM) return false;
  if (!(source.isAllyOf?.(target) || target.alliance === null)) return false;
  const id = foundry.utils.randomID();
  const timer = setTimeout(() => {
    if (!pending.delete(id)) return;
    ui.notifications.warn(game.i18n.format("raccoon-tweaks.transfer.noAnswer", { item: item.name, target: target.name }));
    source.unsetFlag(MODULE_ID, REQUEST).catch(() => {});              // do not leave it for a GM tab that opens later
  }, ANSWER_TIMEOUT_MS);
  pending.set(id, { timer, item: item.name, target: target.name });
  await source.setFlag(MODULE_ID, REQUEST, { id, target: target.uuid, itemId: item.id, quantity: item.quantity, at: Date.now() });
  log(`Asked the GM's tab to hand ${item.quantity}x ${item.name} to ${target.name} (${id}).`);
  return true;
}

/** The giver's side of the answer. Every client sees the result flag; only the one that asked has the id. */
function settle({ id, ok, reason }) {
  const request = pending.get(id);
  if (!request) return;
  clearTimeout(request.timer);
  pending.delete(id);
  if (ok) ui.notifications.info(game.i18n.format("raccoon-tweaks.transfer.requested", request));
  else ui.notifications.warn(game.i18n.format("raccoon-tweaks.transfer.refused", { ...request, reason: reason ?? "?" }));
}

/** GM side: take the request off the actor, do it, write the outcome back. */
async function serve(sourceActor, request, userId) {
  if (!request?.id || Date.now() - (request.at ?? 0) > STALE_MS) return;
  // Two tabs of the same GM user both get here. Whichever removes the request
  // first serves it; the other finds it gone after a short, uneven wait.
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 400));
  if (sourceActor.getFlag(MODULE_ID, REQUEST)?.id !== request.id) return;
  await sourceActor.unsetFlag(MODULE_ID, REQUEST);
  let result;
  try {
    result = await enactTransfer(sourceActor, request, userId);
  } catch (error) {
    warn("Relayed hand-over threw.", error);
    result = { ok: false, reason: error.message };
  }
  await sourceActor.setFlag(MODULE_ID, RESULT, { id: request.id, ...result, at: Date.now() });
}

/** @returns {{ok: boolean, reason?: string}} */
async function enactTransfer(sourceActor, { target: targetUuid, itemId, quantity }, userId) {
  const user = game.users.get(userId);
  const target = await fromUuid(targetUuid);
  const targetActor = target?.actor ?? target;   // a token uuid resolves to its document
  if (!user || !targetActor) return { ok: false, reason: "actor not found" };
  if (!sourceActor.testUserPermission(user, "OWNER")) {
    warn(`${user.name} asked to move an item out of ${sourceActor.name} without owning it; refused.`);
    return { ok: false, reason: "not your item" };
  }
  if (!targetActor.isOfType?.("character", "npc") || targetActor.isOfType("loot")) return { ok: false, reason: "not a character" };
  if (!(sourceActor.isAllyOf?.(targetActor) || targetActor.alliance === null)) return { ok: false, reason: "not an ally" };
  const item = sourceActor.items.get(itemId);
  if (!item?.isOfType?.("physical")) return { ok: false, reason: "item is gone" };
  const qty = Math.min(Math.max(1, Number(quantity) || 1), item.quantity);
  const name = item.name;
  await sourceActor.transferItemToActor(targetActor, item, qty);
  log(`Relayed hand-over for ${user.name}: ${qty}x ${name}, ${sourceActor.name} -> ${targetActor.name}.`);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: sourceActor }),
    content: game.i18n.format("raccoon-tweaks.transfer.message", { source: sourceActor.name, target: targetActor.name, quantity: qty, item: name }),
  });
  return { ok: true };
}
