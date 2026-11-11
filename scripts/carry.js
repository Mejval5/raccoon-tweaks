import { MODULE_ID, SETTINGS, VISITOR, log, warn } from "./constants.js";
import { setting } from "./settings.js";

/**
 * One character riding on another's back: Rikkit on Arnold (session 9).
 *
 * Done by moving tokens (Dan, 2026-11-11: "when we move Rikkit on the token, he
 * climbs on, and when we move him off, he climbs off"):
 *
 * - A Small or Tiny character's token dropped onto a bigger party character's
 *   token climbs on: it shrinks to half size, sits in the carrier's top-right
 *   corner drawn above the carrier's token, and from then on moves with it.
 * - Dragged off the carrier's token, it climbs down and gets its size back.
 * - While riding, the carrier's inventory holds "<rider> (on the back)", whose
 *   Bulk is the rider's body by size (Tiny 1, Small 3, Medium 6) plus everything
 *   the rider carries, minus 2, like a backpack (Dan, 2026-11-11). It follows
 *   the rider's inventory and goes when the rider climbs down.
 *
 * No buttons and no bar on the sheet (Dan: "remove it from inventory"): the
 * tokens are the interface.
 *
 * The two characters belong to different players, so everything is done by the
 * active GM's tab (never a visitor tab), off the token and item hooks every
 * client receives. The state is `flags.raccoon-tweaks.carry = { by }` on the
 * rider and `flags.raccoon-tweaks.carrySize` on the shrunk token.
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

/** A bigger party character's token under the centre of this one, on the same scene. */
function hostUnder(token, at = null) {
  const scene = token.parent, g = scene.grid.size;
  const cx = (at?.x ?? token.x) + (token.width * g) / 2, cy = (at?.y ?? token.y) + (token.height * g) / 2;
  return scene.tokens.find((other) => {
    if (other.id === token.id || !other.actor?.isOfType?.("character") || RIDER_SIZES.has(other.actor.size)) return false;
    if (other.getFlag(MODULE_ID, "carrySize")) return false;
    return cx >= other.x && cx < other.x + other.width * g && cy >= other.y && cy < other.y + other.height * g;
  }) ?? null;
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
  // A small character dropped onto a bigger one climbs on, dragged off climbs
  // down; a carrier's move takes the rider along.
  Hooks.on("updateToken", (token, changes, options) => {
    try {
      if (!isServer() || !setting(SETTINGS.CARRY) || options?.raccoonCarry) return;
      const moved = "x" in changes || "y" in changes;
      if (!moved && !("elevation" in changes || "level" in changes)) return;
      const actor = token.actor;
      if (!actor?.isOfType?.("character")) return;
      const at = { x: changes.x ?? token._source.x, y: changes.y ?? token._source.y, elevation: changes.elevation ?? token._source.elevation };
      if (RIDER_SIZES.has(actor.size) && moved) {
        const host = hostUnder(token, at)?.actor ?? null;
        const current = carrierOf(actor);
        once(actor.id, () => (host ? mount(actor, host) : current ? dismount(actor, current) : null))
          .catch((e) => warn("Climbing on or off failed.", e));
        return;
      }
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
    const api = game.modules.get(MODULE_ID).api ?? (game.modules.get(MODULE_ID).api = {});
    const find = (ref) => game.actors.get(ref) ?? game.actors.find((a) => a.name.toLowerCase().includes(String(ref).toLowerCase()));
    api.carry = {
      bulk: (ref) => riderBulk(find(ref)),
      state: () => Object.fromEntries(game.actors.filter((a) => carrierOf(a)).map((a) => [a.name, carrierOf(a).name])),
      /** Run the GM side directly, in any tab: for tests and repairs. */
      mount: (riderRef, carrierRef) => mount(find(riderRef), find(carrierRef)),
      dismount: (riderRef) => { const r = find(riderRef); return dismount(r, carrierOf(r)); },
    };
  });
}
