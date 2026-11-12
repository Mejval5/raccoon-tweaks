import { MODULE_ID, SETTINGS, VISITOR, log, warn, stampOrigin, fromThisTab } from "./constants.js";
import { setting } from "./settings.js";

/**
 * One character riding on another's back, and towers of them (Rikkit on Arnold,
 * session 9; anyone on anyone, Dan 2026-11-12: "make them ride in a pyramid").
 *
 * - Climbing on: the rider targets the carrier (T) and posts the action
 *   "Climb On" (slug `climb-on-back`). The rider's token jumps onto the
 *   carrier's at 70 % of the carrier's size (never below 0.3 of a square), sits
 *   centred on its top half sticking up (a second rider left, a third right, a
 *   fourth below), drawn above it, and from then on moves with it.
 * - Towers: a rider can carry riders of their own; moving the bottom one moves
 *   the whole tower, each storey 70 % of the one below.
 * - Loops are refused: nobody climbs onto someone who is (directly or further
 *   down a tower) riding on them. Four riders per back at most.
 * - Climbing down: drag the rider's token anywhere, or post Climb On with no
 *   target. The token gets its size back where it stands, and anyone riding on
 *   it stays on it.
 * - Weight: the carrier's inventory holds "<rider> (on the back)", Bulk = the
 *   rider's body by size (Tiny 1, Small 3, Medium 6, Large 12) plus everything
 *   the rider carries, minus 2, like a backpack (Dan, 2026-11-11). A rider's
 *   own riders are items in the rider's inventory, so a tower's weight passes
 *   down to the bottom by itself.
 *
 * The characters belong to different players, so the work is done by the active
 * GM's tab (never a visitor tab), off the token and item hooks every client
 * receives. The rider's own tab only writes `flags.raccoon-tweaks.carry = { by }`
 * on the rider (or removes it). `flags.raccoon-tweaks.carrySize` keeps a shrunk
 * token's own size.
 */
const SIZE_BULK = { tiny: 1, sm: 3, med: 6, lg: 12, huge: 24, grg: 48 };
const MAX_RIDERS = 4;
const t = (key, data) => game.i18n.format(`${MODULE_ID}.carry.${key}`, data);
const isServer = () => game.user === game.users.activeGM && !VISITOR;
const carrierOf = (rider) => game.actors.get(rider?.getFlag?.(MODULE_ID, "carry")?.by ?? "") ?? null;
const ridersOf = (carrier) => game.actors
  .filter((a) => a.type === "character" && a.getFlag(MODULE_ID, "carry")?.by === carrier?.id)
  .sort((a, b) => (a.getFlag(MODULE_ID, "carry")?.at ?? 0) - (b.getFlag(MODULE_ID, "carry")?.at ?? 0));
const weightItemOf = (carrier, rider) => carrier?.items?.find((i) => i.getFlag(MODULE_ID, "carriedRider") === rider?.id) ?? null;

/** True when `carrier` is `rider`, or rides on `rider` somewhere down the tower. */
function wouldLoop(rider, carrier) {
  const seen = new Set();
  for (let c = carrier; c; c = carrierOf(c)) {
    if (c.id === rider.id || seen.has(c.id)) return true;
    seen.add(c.id);
  }
  return false;
}

/** Rider's body plus what the rider carries (their own riders included), minus 2, in Bulk (0.1 = light). */
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

/* ------------------------------------------------------------- weight */

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

const weightTimers = new Map();
function refreshWeightSoon(rider) {
  clearTimeout(weightTimers.get(rider.id));
  weightTimers.set(rider.id, setTimeout(() => {
    weightTimers.delete(rider.id);
    const carrier = carrierOf(rider);
    if (carrier && weightItemOf(carrier, rider)) putWeight(carrier, rider).catch((e) => warn("Carry weight update failed.", e));
  }, 500));
}

/* ------------------------------------------------------------- tokens */

// Where a rider sits on the one below, as [x, y] in rider widths from the
// carrier's top-centre: centred on top sticking up, then left, right, below.
// Each storey is 70 % of the one below (never under 0.3 of a square), so a
// tower of four stays readable: 1, 0.7, 0.49, 0.34 (Dan, 2026-11-12: at half
// size the fourth hit the floor and covered the third).
const SLOTS = [[0, -0.45], [-0.6, -0.2], [0.6, -0.2], [0, 0.55]];
const SCALE = 0.7, MIN_SIZE = 0.3;

/**
 * Put everyone riding on `base` (and on them, and so on) onto `base`'s token on
 * this scene. `geo` is where base's token is or is about to be: during a move
 * Foundry 14 still reports the square it left, so the caller passes the new one.
 */
async function placeTower(base, scene, geo = null, depth = 0, animate = false) {
  if (depth > 8) return;
  const baseToken = scene.tokens.find((tk) => tk.actorId === base.id);
  if (!baseToken) return;
  const g = scene.grid.size;
  const b = {
    x: geo?.x ?? baseToken.x, y: geo?.y ?? baseToken.y,
    w: geo?.w ?? baseToken.width,
    sort: geo?.sort ?? baseToken.sort ?? 0,
    elevation: geo?.elevation ?? baseToken.elevation,
    level: geo?.level ?? baseToken.level,
  };
  const riders = ridersOf(base).slice(0, MAX_RIDERS);
  for (const [i, rider] of riders.entries()) {
    const riderToken = scene.tokens.find((tk) => tk.actorId === rider.id);
    if (!riderToken) continue;
    const own = riderToken.getFlag(MODULE_ID, "carrySize") ?? { width: riderToken.width, height: riderToken.height };
    const w = Math.max(MIN_SIZE, b.w * SCALE);
    const [sx, sy] = SLOTS[i];
    const r = {
      x: b.x + ((b.w - w) / 2 + sx * w) * g,
      y: b.y + sy * w * g,
      w, sort: b.sort + 1 + i, elevation: b.elevation, level: b.level,
    };
    const update = {
      _id: riderToken.id, width: w, height: w, x: r.x, y: r.y, elevation: r.elevation, sort: r.sort,
      [`flags.${MODULE_ID}.carrySize`]: own,
    };
    if (riderToken.level !== undefined && r.level !== undefined) update.level = r.level;
    // Following a moving carrier the riders glide along at the same pace (and
    // their vision with them, Dan 2026-11-12); climbing on and off just jumps.
    // Not awaited when animated, so the storeys start together.
    const done = scene.updateEmbeddedDocuments("Token", [update], { raccoonCarry: true, animate });
    if (!animate) await done;
    await placeTower(rider, scene, r, depth + 1, animate);
  }
}

/** The tower above `base` on every scene where base has a token. */
async function placeTowerEverywhere(base) {
  for (const scene of game.scenes) if (scene.tokens.some((tk) => tk.actorId === base.id)) await placeTower(base, scene);
}

/* -------------------------------------------------------- on and off */

async function mount(rider, carrier) {
  if (wouldLoop(rider, carrier)) {
    warn(`${rider.name} cannot ride ${carrier.name}: they would ride each other.`);
    return dismount(rider, carrierOf(rider));
  }
  const previous = carrierOf(rider);
  if (previous && previous.id !== carrier.id) await weightItemOf(previous, rider)?.delete();
  if (rider.getFlag(MODULE_ID, "carry")?.by !== carrier.id) await rider.setFlag(MODULE_ID, "carry", { by: carrier.id, at: Date.now() });
  await putWeight(carrier, rider);
  await placeTowerEverywhere(carrier);
  log(`${rider.name} rides on ${carrier.name} (Bulk ${riderBulk(rider)}).`);
}

/** Off the back: the weight goes, the flag goes, the token gets its size back where it stands; its own riders stay on it. */
async function dismount(rider, carrier, onlyScene = null, at = null) {
  for (const a of carrier ? [carrier] : game.actors.filter((x) => weightItemOf(x, rider))) {
    const item = weightItemOf(a, rider);
    if (item) await item.delete();
  }
  if (rider.getFlag(MODULE_ID, "carry")) await rider.unsetFlag(MODULE_ID, "carry");
  for (const scene of game.scenes) {
    const tk = scene.tokens.find((x) => x.actorId === rider.id && x.getFlag(MODULE_ID, "carrySize"));
    if (!tk) continue;
    const size = tk.getFlag(MODULE_ID, "carrySize");
    const g = scene.grid.size;
    // The full-size token lands on the square under the small token's centre
    // (by its corner it came out off-centre, Dan 2026-11-12).
    const x = scene === onlyScene && at ? at.x : tk.x, y = scene === onlyScene && at ? at.y : tk.y;
    const cx = x + (tk.width * g) / 2, cy = y + (tk.height * g) / 2;
    const snapped = {
      x: Math.floor(cx / g - size.width / 2 + 0.5) * g,
      y: Math.floor(cy / g - size.height / 2 + 0.5) * g,
    };
    await scene.updateEmbeddedDocuments("Token", [{ _id: tk.id, width: size.width, height: size.height, ...snapped, [`flags.${MODULE_ID}.-=carrySize`]: null }], { raccoonCarry: true });
    await placeTower(rider, scene, { ...snapped, w: size.width });
  }
  log(`${rider.name} is off ${carrier?.name ?? "their carrier"}'s back.`);
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
  if (!rider?.isOfType?.("character", "npc") || !rider.isOwner) return;
  const targets = Array.from(game.user.targets ?? []).filter((tk) => tk.actor?.isOfType?.("character", "npc") && tk.actor.id !== rider.id);
  if (!targets.length) {
    if (carrierOf(rider)) return rider.unsetFlag(MODULE_ID, "carry");
    ui.notifications.warn(t("needTarget", { name: rider.name }));
    return;
  }
  if (targets.length > 1) { ui.notifications.warn(t("oneTarget")); return; }
  const carrier = targets[0].actor;
  if (wouldLoop(rider, carrier)) { ui.notifications.warn(t("loop", { rider: rider.name, carrier: carrier.name })); return; }
  if (ridersOf(carrier).filter((r) => r.id !== rider.id).length >= MAX_RIDERS) { ui.notifications.warn(t("noRoom", { name: carrier.name })); return; }
  await rider.setFlag(MODULE_ID, "carry", { by: carrier.id, at: Date.now() });
}

/* ----------------------------------------------------------- register */

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

  // Where tokens are going, for a moment: when a whole selection moves, the
  // carrier's document still shows the square it left (Foundry 14), and every
  // rider looked dropped away (Dan, 2026-11-12).
  const goingTo = new Map();

  // A carrier's move takes the tower along; a rider dropped off its carrier climbs down.
  Hooks.on("updateToken", (token, changes, options) => {
    try {
      if (!isServer() || !setting(SETTINGS.CARRY) || options?.raccoonCarry) return;
      const moved = "x" in changes || "y" in changes;
      if (!moved && !("elevation" in changes || "level" in changes)) return;
      const actor = token.actor;
      if (!actor?.isOfType?.("character", "npc")) return;
      const at = { x: changes.x ?? token._source.x, y: changes.y ?? token._source.y, elevation: changes.elevation ?? token._source.elevation };
      if (moved) goingTo.set(token.id, { ...at, t: Date.now() });
      if (moved && carrierOf(actor) && token.getFlag(MODULE_ID, "carrySize")) {
        // Decided a moment later, once the rest of a selection has moved too.
        // A rider whose centre is still on the carrier's square (where the
        // carrier is going) stays and the tower is put back in shape; anywhere
        // else climbs down. Half a square of slack let a drop right beside the
        // carrier count as "on" it, so climbing down sometimes failed.
        const scene = token.parent;
        setTimeout(() => {
          try {
            const carrier = carrierOf(actor);
            if (!carrier) return;
            const ct = scene.tokens.find((tk) => tk.actorId === carrier.id);
            const g = scene.grid.size;
            const fresh = ct && goingTo.get(ct.id);
            const cpos = fresh && Date.now() - fresh.t < 2000 ? fresh : (ct ? { x: ct.x, y: ct.y, elevation: ct.elevation } : null);
            const cx = at.x + (token.width * g) / 2, cy = at.y + (token.height * g) / 2;
            const slack = 0.1 * g;
            const onCarrier = ct && cpos && cx >= cpos.x - slack && cx <= cpos.x + ct.width * g + slack
              && cy >= cpos.y - slack && cy <= cpos.y + ct.height * g + slack;
            if (onCarrier) placeTower(carrier, scene, ct.getFlag(MODULE_ID, "carrySize") ? null : { ...cpos, w: ct.width }).catch((e) => warn("Rider re-place failed.", e));
            else once(actor.id, () => dismount(actor, carrier, scene, at)).catch((e) => warn("Climb down failed.", e));
          } catch (error) {
            warn("Rider move check failed.", error);
          }
        }, 300);
        return;
      }
      if (ridersOf(actor).length) placeTower(actor, token.parent, at, 0, true).catch((e) => warn("Rider follow failed.", e));
    } catch (error) {
      warn("Carry token hook failed.", error);
    }
  });

  // A rider's inventory changes (their own riders included): the weight below follows.
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
        const riders = game.actors.filter((a) => carrierOf(a)
          || game.actors.some((c) => weightItemOf(c, a))
          || game.scenes.some((sc) => sc.tokens.some((tk) => tk.actorId === a.id && tk.getFlag(MODULE_ID, "carrySize"))));
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
      /** The action item to put on a sheet. */
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
