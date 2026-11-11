import { MODULE_ID, SETTINGS, VISITOR, log, warn, stampOrigin, fromThisTab } from "./constants.js";
import { setting } from "./settings.js";

/**
 * One character riding on another's back: Rikkit on Arnold (session 9).
 *
 * 1. The rider targets the carrier (T) and posts the action "Climb On" (slug
 *    `climb-on-back`). That only asks: `flags.raccoon-tweaks.carryRequest` on the rider.
 * 2. The carrier's player and the GM get a question; the first answer counts
 *    (Dan, 2026-11-11: "Makak or me has to accept"). Accepting puts
 *    "<rider> (on the back)" in the carrier's inventory, Bulk = the rider's body
 *    by size (Tiny 1, Small 3, Medium 6) plus everything the rider carries,
 *    minus 2, like a backpack; the answer goes on the carrier as `carryAnswer`.
 * 3. The rider's own window sees the answer, marks the rider `carry = { by }`,
 *    and puts the rider's token at half size in the carrier's top-right corner,
 *    drawn above. From then on it moves with the carrier.
 * 4. Climbing down: drag the rider's token anywhere, or post Climb On again with
 *    no target. The weight item goes, the token gets its size back.
 *
 * Each window does what its user owns (Dan: "why can't we do it in the Rikkit
 * view?"): the rider's player handles the rider's token, the carrier's player
 * the carrier's inventory. When the owner is not connected, the active GM's
 * tab (never a visitor tab) stands in. Foundry runs no module code on the
 * server, so somebody's window has to.
 */
const SIZE_BULK = { tiny: 1, sm: 3, med: 6, lg: 12, huge: 24, grg: 48 };
const RIDER_SIZES = new Set(["tiny", "sm"]);
const t = (key, data) => game.i18n.format(`${MODULE_ID}.carry.${key}`, data);
const carrierOf = (rider) => game.actors.get(rider?.getFlag?.(MODULE_ID, "carry")?.by ?? "") ?? null;
const ridersOf = (carrier) => game.actors.filter((a) => a.type === "character" && a.getFlag(MODULE_ID, "carry")?.by === carrier?.id);
const weightItemOf = (carrier, rider) => carrier?.items?.find((i) => i.getFlag(MODULE_ID, "carriedRider") === rider?.id) ?? null;
const activeGm = () => game.user === game.users.activeGM && !VISITOR;

/** Connected players who own this actor, in a fixed order. */
const playerOwners = (actor) => game.users
  .filter((u) => u.active && !u.isGM && actor?.testUserPermission?.(u, "OWNER"))
  .sort((a, b) => a.id.localeCompare(b.id));

/** This window does the work for this actor: its first connected player, or the GM when none is. */
function handles(actor) {
  if (!actor) return false;
  const owners = playerOwners(actor);
  return owners.length ? owners[0] === game.user : activeGm();
}

/** Rider's body plus what the rider carries, minus 2, in Bulk (0.1 = light). */
export function riderBulk(rider) {
  const body = SIZE_BULK[rider?.size ?? rider?.system?.traits?.size?.value] ?? 3;
  const carried = rider?.inventory?.bulk?.value;
  const gear = carried ? (carried.normal ?? 0) + (carried.light ?? 0) / 10 : 0;
  return Math.max(0, Math.round((body + gear - 2) * 10) / 10);
}

const busy = new Set();
async function once(key, fn) {
  if (busy.has(key)) return;
  busy.add(key);
  try { await fn(); } finally { busy.delete(key); }
}

/* ------------------------------------------------- the carrier's side (weight) */

async function putWeight(carrier, rider) {
  const bulk = riderBulk(rider);
  const item = weightItemOf(carrier, rider);
  if (item) {
    if (item.system.bulk.value !== bulk) await item.update({ "system.bulk.value": bulk });
    return;
  }
  await carrier.createEmbeddedDocuments("Item", [{
    name: t("itemName", { name: rider.name }),
    type: "equipment",
    img: rider.prototypeToken?.texture?.src || rider.img,
    system: {
      bulk: { value: bulk },
      quantity: 1,
      equipped: { carryType: "worn", handsHeld: 0 },
      description: { value: `<p>${t("itemDescription", { name: rider.name })}</p>` },
    },
    flags: { [MODULE_ID]: { carriedRider: rider.id } },
  }]);
}

async function takeWeight(carrier, rider) {
  const item = weightItemOf(carrier, rider);
  if (item) await item.delete();
}

const asked = new Set();
async function askCarrier(rider, carrier, request) {
  const key = `${rider.id}:${request.at}`;
  if (asked.has(key)) return;
  asked.add(key);
  const yes = await foundry.applications.api.DialogV2.confirm({
    window: { title: t("askTitle"), icon: "fa-solid fa-person-arrow-up-from-line" },
    content: `<p>${t("askText", { rider: rider.name, carrier: carrier.name, bulk: riderBulk(rider) })}</p>`,
    rejectClose: false,
    modal: false,
  });
  // Somebody else may have answered while the question was open.
  const current = rider.getFlag(MODULE_ID, "carryRequest");
  if (current?.at !== request.at || carrier.getFlag(MODULE_ID, "carryAnswer")?.at === request.at) return;
  if (yes) await putWeight(carrier, rider);
  await carrier.setFlag(MODULE_ID, "carryAnswer", { rider: rider.id, ok: Boolean(yes), at: request.at, who: game.user.name });
  log(`${game.user.name} ${yes ? "lets" : "does not let"} ${rider.name} climb onto ${carrier.name}.`);
}

/* --------------------------------------------------- the rider's side (token) */

async function placeRider(rider, carrier, onlyScene = null, at = null) {
  for (const scene of onlyScene ? [onlyScene] : game.scenes) {
    const carrierToken = scene.tokens.find((tk) => tk.actorId === carrier.id);
    const riderToken = scene.tokens.find((tk) => tk.actorId === rider.id);
    if (!carrierToken || !riderToken) continue;
    const g = scene.grid.size;
    // During a move Foundry 14 still reports the square the carrier left; the
    // move itself has the new one, which put the rider one step behind.
    const cx = at?.x ?? carrierToken.x, cy = at?.y ?? carrierToken.y;
    const size = riderToken.getFlag(MODULE_ID, "carrySize") ?? { width: riderToken.width, height: riderToken.height };
    const w = 0.5;
    const update = {
      _id: riderToken.id,
      width: w, height: w,
      x: cx + Math.max(1, carrierToken.width) * g - w * g,
      y: cy,
      elevation: at?.elevation ?? carrierToken.elevation,
      sort: (carrierToken.sort ?? 0) + 1,
      [`flags.${MODULE_ID}.carrySize`]: size,
    };
    if (riderToken.level !== undefined && carrierToken.level !== undefined) update.level = carrierToken.level;
    await scene.updateEmbeddedDocuments("Token", [update], { raccoonCarry: true, animate: false });
  }
}

async function restoreTokens(rider) {
  for (const scene of game.scenes) {
    const updates = scene.tokens.filter((tk) => tk.actorId === rider.id && tk.getFlag(MODULE_ID, "carrySize"))
      .map((tk) => {
        const size = tk.getFlag(MODULE_ID, "carrySize");
        return { _id: tk.id, width: size.width, height: size.height, [`flags.${MODULE_ID}.-=carrySize`]: null };
      });
    if (updates.length) await scene.updateEmbeddedDocuments("Token", updates, { raccoonCarry: true });
  }
}

async function climbOn(rider, carrier) {
  await rider.update({ [`flags.${MODULE_ID}.carry`]: { by: carrier.id, at: Date.now() }, [`flags.${MODULE_ID}.-=carryRequest`]: null });
  await placeRider(rider, carrier);
  ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: rider }), content: `<p>${t("climbedOn", { rider: rider.name, carrier: carrier.name })}</p>` });
  log(`${rider.name} rides on ${carrier.name}.`);
}

async function climbDown(rider) {
  const carrier = carrierOf(rider);
  await restoreTokens(rider);
  if (rider.getFlag(MODULE_ID, "carry")) await rider.unsetFlag(MODULE_ID, "carry");
  if (carrier) ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: rider }), content: `<p>${t("climbedDown", { rider: rider.name, carrier: carrier.name })}</p>` });
  log(`${rider.name} is off ${carrier?.name ?? "their carrier"}'s back.`);
}

/** The action, in the window that posted it. */
async function climbAction(message) {
  const rider = message.actor;
  if (!rider?.isOfType?.("character") || !rider.isOwner) return;
  const targets = Array.from(game.user.targets ?? []).filter((tk) => tk.actor?.isOfType?.("character") && tk.actor.id !== rider.id);
  if (!targets.length) {
    if (carrierOf(rider)) return climbDown(rider);
    ui.notifications.warn(t("needTarget", { name: rider.name }));
    return;
  }
  if (targets.length > 1) { ui.notifications.warn(t("oneTarget")); return; }
  const carrier = targets[0].actor;
  if (RIDER_SIZES.has(carrier.size)) { ui.notifications.warn(t("tooSmall", { name: carrier.name })); return; }
  if (carrier.getFlag(MODULE_ID, "carry")) { ui.notifications.warn(t("carrierRiding", { name: carrier.name })); return; }
  await rider.setFlag(MODULE_ID, "carryRequest", { by: carrier.id, at: Date.now() });
  ui.notifications.info(t("asked", { carrier: carrier.name }));
}

/* ----------------------------------------------------------------- weight */

const weightTimers = new Map();
function refreshWeightSoon(rider) {
  clearTimeout(weightTimers.get(rider.id));
  weightTimers.set(rider.id, setTimeout(() => {
    const carrier = carrierOf(rider);
    if (carrier && handles(carrier)) putWeight(carrier, rider).catch((e) => warn("Carry weight update failed.", e));
  }, 500));
}

/* --------------------------------------------------------------- register */

export function registerCarry() {
  Hooks.on("preCreateChatMessage", (message, data, options) => stampOrigin(options));
  Hooks.on("createChatMessage", (message, options) => {
    try {
      if (!setting(SETTINGS.CARRY) || !fromThisTab(options) || message.item?.slug !== "climb-on-back") return;
      climbAction(message).catch((e) => warn("Climb On failed.", e));
    } catch (error) {
      warn("Climb action hook failed.", error);
    }
  });

  Hooks.on("updateActor", (actor, changes) => {
    try {
      if (!setting(SETTINGS.CARRY)) return;
      const flags = changes?.flags?.[MODULE_ID];
      if (!flags) return;
      // A rider asks: the carrier's player and the GM are asked, first answer counts.
      if (flags.carryRequest?.by) {
        const carrier = game.actors.get(flags.carryRequest.by);
        const mine = carrier && (playerOwners(carrier).includes(game.user) || activeGm());
        if (mine) askCarrier(actor, carrier, flags.carryRequest).catch((e) => warn("Climb question failed.", e));
      }
      // An answer on the carrier: the rider's window climbs on, or drops the request.
      if (flags.carryAnswer?.rider) {
        const rider = game.actors.get(flags.carryAnswer.rider);
        const request = rider?.getFlag(MODULE_ID, "carryRequest");
        if (rider && handles(rider) && request?.at === flags.carryAnswer.at) {
          if (flags.carryAnswer.ok) once(rider.id, () => climbOn(rider, actor)).catch((e) => warn("Climb on failed.", e));
          else {
            rider.unsetFlag(MODULE_ID, "carryRequest").catch(() => {});
            if (rider.isOwner && !game.user.isGM) ui.notifications.info(t("declined", { carrier: actor.name, who: flags.carryAnswer.who }));
          }
        }
      }
      // The rider got off: the carrier's window takes the weight away.
      if ("-=carry" in flags || flags.carry === null) {
        for (const carrier of game.actors.filter((c) => weightItemOf(c, actor))) {
          if (handles(carrier)) takeWeight(carrier, actor).catch((e) => warn("Taking the weight off failed.", e));
        }
      }
    } catch (error) {
      warn("Carry actor hook failed.", error);
    }
  });

  // The carrier moves: the rider's window takes the rider along. The rider
  // moves on their own: the rider climbs down.
  Hooks.on("updateToken", (token, changes, options) => {
    try {
      if (!setting(SETTINGS.CARRY) || options?.raccoonCarry) return;
      const moved = "x" in changes || "y" in changes;
      if (!moved && !("elevation" in changes || "level" in changes)) return;
      const actor = token.actor;
      if (!actor?.isOfType?.("character")) return;
      if (moved && carrierOf(actor) && token.getFlag(MODULE_ID, "carrySize")) {
        if (handles(actor)) once(actor.id, () => climbDown(actor)).catch((e) => warn("Climb down failed.", e));
        return;
      }
      const at = { x: changes.x ?? token._source.x, y: changes.y ?? token._source.y, elevation: changes.elevation ?? token._source.elevation };
      for (const rider of ridersOf(actor)) {
        if (handles(rider)) placeRider(rider, actor, token.parent, at).catch((e) => warn("Rider follow failed.", e));
      }
    } catch (error) {
      warn("Carry token hook failed.", error);
    }
  });

  // The rider's inventory changes: the weight on the carrier follows.
  for (const hook of ["createItem", "updateItem", "deleteItem"]) {
    Hooks.on(hook, (item) => {
      try {
        const rider = item.actor;
        if (!setting(SETTINGS.CARRY) || !rider || !carrierOf(rider) || !item.isOfType?.("physical")) return;
        if (item.getFlag?.(MODULE_ID, "carriedRider")) return;
        refreshWeightSoon(rider);
      } catch (error) {
        warn("Carry weight hook failed.", error);
      }
    });
  }

  Hooks.once("ready", () => {
    const api = game.modules.get(MODULE_ID).api ?? (game.modules.get(MODULE_ID).api = {});
    const find = (ref) => game.actors.get(ref) ?? game.actors.find((a) => a.name.toLowerCase().includes(String(ref).toLowerCase()));
    api.carry = {
      bulk: (ref) => riderBulk(find(ref)),
      state: () => Object.fromEntries(game.actors.filter((a) => carrierOf(a)).map((a) => [a.name, carrierOf(a).name])),
      /** Off the back by hand: tokens back to size, flag and weight gone (needs rights on both). */
      reset: async (riderRef) => {
        const r = find(riderRef);
        for (const c of game.actors.filter((x) => weightItemOf(x, r))) await takeWeight(c, r);
        await restoreTokens(r);
        await r.update({ [`flags.${MODULE_ID}.-=carry`]: null, [`flags.${MODULE_ID}.-=carryRequest`]: null });
      },
      /** The action item to put on a rider's sheet. */
      actionData: () => ({
        name: t("actionName"),
        type: "action",
        img: "icons/svg/up.svg",
        system: {
          slug: "climb-on-back",
          actionType: { value: "action" },
          actions: { value: 1 },
          traits: { value: ["move"] },
          description: { value: `<p>${t("actionDescription")}</p>` },
        },
      }),
    };
  });
}
