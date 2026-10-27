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
 * Onto an actor the user does not own, the active GM's tab does the transfer
 * on a socket request from this module, after checking that the requester owns
 * the source and the two are allies, and posts a short chat line. With Shift
 * held, or with no GM online for the relayed case, PF2e's own flow runs.
 * Loot actors and merchants are never touched: buying stays buying.
 */
export function registerTransfer() {
  // At `ready`, not `setup`: in v14 the registered sheet classes are not all in
  // CONFIG.Actor.sheetClasses before then, and the actors' own sheets are the
  // surest place to find the system's base class.
  Hooks.once("ready", installMoveWrapper);
  Hooks.once("ready", () => {
    game.socket.on(`module.${MODULE_ID}`, (payload, userId) => {
      if (payload?.type !== "transfer") return;
      if (game.user !== game.users.activeGM) return;
      enactTransfer(payload, userId).catch((e) => warn("Relayed hand-over failed.", e));
    });
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
  game.socket.emit(`module.${MODULE_ID}`, {
    type: "transfer",
    source: source.uuid, target: target.uuid, itemId: item.id, quantity: item.quantity,
  });
  ui.notifications.info(game.i18n.format("raccoon-tweaks.transfer.requested", { item: item.name, target: target.name }));
  return true;
}

async function enactTransfer({ source: sourceUuid, target: targetUuid, itemId, quantity }, userId) {
  const user = game.users.get(userId);
  const source = await fromUuid(sourceUuid);
  const target = await fromUuid(targetUuid);
  const sourceActor = source?.actor ?? source;   // a token uuid resolves to its document
  const targetActor = target?.actor ?? target;
  if (!user || !sourceActor || !targetActor) return;
  if (!sourceActor.testUserPermission(user, "OWNER")) { warn(`${user.name} asked to move an item out of ${sourceActor.name} without owning it; refused.`); return; }
  if (!targetActor.isOfType?.("character", "npc") || targetActor.isOfType("loot")) return;
  if (!(sourceActor.isAllyOf?.(targetActor) || targetActor.alliance === null)) return;
  const item = sourceActor.items.get(itemId);
  if (!item?.isOfType?.("physical")) return;
  const qty = Math.min(Math.max(1, Number(quantity) || 1), item.quantity);
  await sourceActor.transferItemToActor(targetActor, item, qty);
  log(`Relayed hand-over for ${user.name}: ${qty}x ${item.name}, ${sourceActor.name} -> ${targetActor.name}.`);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: sourceActor }),
    content: game.i18n.format("raccoon-tweaks.transfer.message", { source: sourceActor.name, target: targetActor.name, quantity: qty, item: item.name }),
  });
}
