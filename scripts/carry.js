import { MODULE_ID, SETTINGS, VISITOR, log, warn, stampOrigin, fromThisTab } from "./constants.js";
import { setting } from "./settings.js";

/**
 * One character riding on another's back: Rikkit on Arnold (session 9).
 *
 * Climbing on is an action (Dan, 2026-11-11: dropping the token on the carrier
 * was unreliable): the rider targets the carrier (T) and posts the action
 * "Climb On" (slug `climb-on-back`) from their sheet. The rider's token jumps
 * onto the carrier's, shrinks to half size, sits in the top-right corner drawn
 * above, and from then on moves with it.
 *
 * Climbing down: drag the rider's token anywhere, or post the same action again
 * with no target.
 *
 * - While riding, the carrier's inventory holds "<rider> (on the back)", whose
 *   Bulk is the rider's body by size (Tiny 1, Small 3, Medium 6) plus everything
 *   the rider carries, minus 2, like a backpack (Dan, 2026-11-11). It follows
 *   the rider's inventory and goes when the rider climbs down.
 *
 * The two characters belong to different players, so everything is done by the
 * active GM's tab (never a visitor tab), off the token and item hooks every
 * client receives. The rider's own tab only writes `flags.raccoon-tweaks.carry =
 * { by }` on the rider (or removes it); the GM tab brings the tokens and the
 * weight in line with that flag. `flags.raccoon-tweaks.carrySize` marks the shrunk token.
 */
const SIZE_BULK = { tiny: 1, sm: 3, med: 6, lg: 12, huge: 24, grg: 48 };
const RIDER_SIZES = new Set(["tiny", "sm"]);
const t = (key, data) => game.i18n.format(`${MODULE_ID}.carry.${key}`, data);
const isServer = () => game.user === game.users.activeGM && !VISITOR;
const carrierOf = (rider) => game.actors.get(rider?.getFlag?.(MODULE_ID, "carry")?.by ?? "") ?? null;
const ridersOf = (carrier) => game.actors.filter((a) => a.type === "character" && a.getFlag(MODULE_ID, "carry")?.by === carrier?.id);
const weightItemOf = (carrier, rider) => carrier?.items?.find((i) => i.getFlag(MODULE_ID, "carriedRider") === rider?.id) ?? null;

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

async function mount(rider, carrier) {
  if (rider.getFlag(MODULE_ID, "carry")?.by !== carrier.id) {
    const previous = carrierOf(rider);
    if (previous) await weightItemOf(previous, rider)?.delete();
    await rider.setFlag(MODULE_ID, "carry", { by: carrier.id, at: Date.now() });
  }
  const bulk = riderBulk(rider);
  const item = weightItemOf(carrier, rider);
  if (item) {
    if (item.system.bulk.value !== bulk) await item.update({ "system.bulk.value": bulk });
  } else {
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
  await placeRider(rider, carrier);
  log(`${rider.name} rides on ${carrier.name} (Bulk ${bulk}).`);
}

/** Off the back: the weight goes, the flag goes, the tokens get their size back where they stand. */
async function dismount(rider, carrier) {
  for (const a of carrier ? [carrier] : game.actors.filter((x) => weightItemOf(x, rider))) {
    const item = weightItemOf(a, rider);
    if (item) await item.delete();
  }
  if (rider.getFlag(MODULE_ID, "carry")) await rider.unsetFlag(MODULE_ID, "carry");
  for (const scene of game.scenes) {
    const updates = scene.tokens.filter((tk) => tk.actorId === rider.id && tk.getFlag(MODULE_ID, "carrySize"))
      .map((tk) => {
        const size = tk.getFlag(MODULE_ID, "carrySize");
        return { _id: tk.id, width: size.width, height: size.height, [`flags.${MODULE_ID}.-=carrySize`]: null };
      });
    if (updates.length) await scene.updateEmbeddedDocuments("Token", updates, { raccoonCarry: true });
  }
  log(`${rider.name} is off ${carrier?.name ?? "their carrier"}'s back.`);
}

/** The rider's token, half size and drawn above, in the carrier's top-right corner, on every scene with both. */
async function placeRider(rider, carrier, onlyScene = null, at = null) {
  for (const scene of onlyScene ? [onlyScene] : game.scenes) {
    const carrierToken = scene.tokens.find((tk) => tk.actorId === carrier.id);
    const riderToken = scene.tokens.find((tk) => tk.actorId === rider.id);
    if (!carrierToken || !riderToken) continue;
    const g = scene.grid.size;
    // Where the carrier ends up: from the move itself when there is one. In
    // Foundry 14 the document still reads the square it left while the move is
    // being carried out, which put the rider one step behind (Dan, 2026-11-11).
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

/** Make the tokens and the weight match the rider's flag. */
async function reconcile(rider) {
  const carrier = carrierOf(rider);
  if (carrier) return mount(rider, carrier);
  const leftover = game.actors.some((a) => weightItemOf(a, rider))
    || game.scenes.some((sc) => sc.tokens.some((tk) => tk.actorId === rider.id && tk.getFlag(MODULE_ID, "carrySize")));
  if (leftover) return dismount(rider, null);
}

/** The action, in the tab of whoever posted it: climb onto the one target, or climb down. */
async function climbAction(message) {
  const rider = message.actor;
  if (!rider?.isOfType?.("character") || !rider.isOwner) return;
  const targets = Array.from(game.user.targets ?? []).filter((tk) => tk.actor?.isOfType?.("character") && tk.actor.id !== rider.id);
  if (!targets.length) {
    if (carrierOf(rider)) return rider.unsetFlag(MODULE_ID, "carry");
    ui.notifications.warn(t("needTarget", { name: rider.name }));
    return;
  }
  if (targets.length > 1) { ui.notifications.warn(t("oneTarget")); return; }
  const carrier = targets[0].actor;
  if (RIDER_SIZES.has(carrier.size)) { ui.notifications.warn(t("tooSmall", { name: carrier.name })); return; }
  if (carrier.getFlag(MODULE_ID, "carry")) { ui.notifications.warn(t("carrierRiding", { name: carrier.name })); return; }
  await rider.setFlag(MODULE_ID, "carry", { by: carrier.id, at: Date.now() });
}

let weightTimer = null;
function refreshWeightSoon(rider) {
  clearTimeout(weightTimer);
  weightTimer = setTimeout(() => {
    const item = weightItemOf(carrierOf(rider), rider);
    const bulk = riderBulk(rider);
    if (item && item.system.bulk.value !== bulk) item.update({ "system.bulk.value": bulk }).catch((e) => warn("Carry weight update failed.", e));
  }, 500);
}

export function registerCarry() {
  Hooks.on("preCreateChatMessage", (message, data, options) => stampOrigin(options));
  Hooks.on("createChatMessage", (message, options) => {
    try {
      if (!setting(SETTINGS.CARRY) || !fromThisTab(options)) return;
      if (message.item?.slug !== "climb-on-back") return;
      climbAction(message).catch((e) => warn("Climb on failed.", e));
    } catch (error) {
      warn("Climb action hook failed.", error);
    }
  });

  // The rider's flag changed: the GM tab brings tokens and weight in line.
  Hooks.on("updateActor", (actor, changes) => {
    try {
      const flags = changes?.flags?.[MODULE_ID];
      if (!flags || !Object.keys(flags).some((k) => k.endsWith("carry"))) return;
      if (!isServer() || !setting(SETTINGS.CARRY)) return;
      once(actor.id, () => reconcile(actor)).catch((e) => warn("Carry update failed.", e));
    } catch (error) {
      warn("Carry actor hook failed.", error);
    }
  });

  // A carrier's move takes the rider along; a rider dragged anywhere climbs down.
  Hooks.on("updateToken", (token, changes, options) => {
    try {
      if (!isServer() || !setting(SETTINGS.CARRY) || options?.raccoonCarry) return;
      const moved = "x" in changes || "y" in changes;
      if (!moved && !("elevation" in changes || "level" in changes)) return;
      const actor = token.actor;
      if (!actor?.isOfType?.("character")) return;
      if (moved && carrierOf(actor) && token.getFlag(MODULE_ID, "carrySize")) {
        actor.unsetFlag(MODULE_ID, "carry").catch((e) => warn("Climb down failed.", e));
        return;
      }
      // In Foundry 14 the document still reads the square it left while a move
      // is being carried out; the move itself has the new one.
      const at = { x: changes.x ?? token._source.x, y: changes.y ?? token._source.y, elevation: changes.elevation ?? token._source.elevation };
      for (const r of ridersOf(actor)) placeRider(r, actor, token.parent, at).catch((e) => warn("Rider follow failed.", e));
    } catch (error) {
      warn("Carry token hook failed.", error);
    }
  });

  // The rider's inventory changes: the weight on the carrier follows.
  for (const hook of ["createItem", "updateItem", "deleteItem"]) {
    Hooks.on(hook, (item) => {
      try {
        const rider = item.actor;
        if (!isServer() || !setting(SETTINGS.CARRY) || !rider || !carrierOf(rider) || !item.isOfType?.("physical")) return;
        refreshWeightSoon(rider);
      } catch (error) {
        warn("Carry weight hook failed.", error);
      }
    });
  }

  Hooks.once("ready", () => {
    // A GM tab that loads late (or reloads) finishes any climb it missed.
    if (isServer() && setting(SETTINGS.CARRY)) {
      setTimeout(() => {
        const riders = game.actors.filter((a) => a.type === "character" && (carrierOf(a)
          || game.actors.some((c) => weightItemOf(c, a))
          || game.scenes.some((sc) => sc.tokens.some((tk) => tk.actorId === a.id && tk.getFlag(MODULE_ID, "carrySize")))));
        for (const r of riders) once(r.id, () => reconcile(r)).catch((e) => warn("Carry catch-up failed.", e));
      }, 3000);
    }
    const api = game.modules.get(MODULE_ID).api ?? (game.modules.get(MODULE_ID).api = {});
    const find = (ref) => game.actors.get(ref) ?? game.actors.find((a) => a.name.toLowerCase().includes(String(ref).toLowerCase()));
    api.carry = {
      bulk: (ref) => riderBulk(find(ref)),
      state: () => Object.fromEntries(game.actors.filter((a) => carrierOf(a)).map((a) => [a.name, carrierOf(a).name])),
      /** Run the GM side directly, in any tab: for tests and repairs. */
      mount: (riderRef, carrierRef) => mount(find(riderRef), find(carrierRef)),
      dismount: (riderRef) => { const r = find(riderRef); return dismount(r, carrierOf(r)); },
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
