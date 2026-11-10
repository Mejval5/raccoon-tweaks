import { MODULE_ID, SETTINGS, warn } from "./constants.js";
import { setting } from "./settings.js";

/**
 * A liking meter on merchants and NPCs: how much this one likes each player
 * character, kept by the GM and shown in the sheet's left panel (Dan,
 * 2026-11-10; until then it lived as a hand-typed line in the merchant's
 * description).
 *
 * One bar per character, from -10 to +10, zero in the middle. Click a cell to
 * set it, the minus and plus at the ends to step, double-click the number to
 * go back to zero. The word beside the number is the PF2e attitude the value
 * falls into, so the same meter answers "what is the DC to Request something":
 *
 *   -10..-7 hostile   -6..-3 unfriendly   -2..+2 indifferent
 *    +3..+6 friendly  +7..+10 helpful
 *
 * It only records. Nothing reads it to change a price or a roll; the discount
 * a merchant gives is still set by hand in shop.js. GM only: players never see
 * the block, and the flag is on an actor they usually cannot read anyway.
 *
 * Stored on the merchant or NPC as `flags.raccoon-tweaks.liking = { <actorId>: n }`.
 * The block is built from plain elements, no inputs, so the sheet's own
 * submit-on-change never fires for it; a change is written without a re-render
 * and the block updates itself in place.
 */
const MIN = -10;
const MAX = 10;
const ATTITUDES = [[-7, "hostile"], [-3, "unfriendly"], [2, "indifferent"], [6, "friendly"], [MAX, "helpful"]];

export const clampLiking = (value) => { const n = Math.round(Number(value)); return Number.isFinite(n) ? Math.min(MAX, Math.max(MIN, n)) : 0; };
export const attitudeOf = (n) => ATTITUDES.find(([top]) => clampLiking(n) <= top)[1];
const likingFlags = (actor) => actor?.getFlag?.(MODULE_ID, "liking") ?? {};
export const likingFor = (actor, character) => clampLiking(likingFlags(actor)[character?.id]);
const tracked = (actor) => Boolean(actor?.isOfType?.("npc") || (actor?.isOfType?.("loot") && actor.isMerchant));
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const t = (key, data) => game.i18n.format(`${MODULE_ID}.liking.${key}`, data);

/** The party's characters, plus anyone else this actor already has a value for. */
function characters(flags) {
  const party = game.actors.party?.members?.filter((a) => a?.isOfType?.("character")) ?? [];
  const list = new Map((party.length ? party : game.actors.filter((a) => a.type === "character" && a.hasPlayerOwner)).map((a) => [a.id, a]));
  for (const [id, value] of Object.entries(flags)) {
    const actor = game.actors.get(id);
    if (actor && clampLiking(value) !== 0) list.set(id, actor);
  }
  return [...list.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Whether the block is unfolded, per actor, for this tab only: a re-render of
// the sheet must not fold what the GM just opened.
const openState = new Map();

function build(actor) {
  const flags = likingFlags(actor);
  const list = characters(flags);
  if (!list.length) return null;

  const block = document.createElement("details");
  // An NPC's panel is narrow: the number alone, the attitude as colour and tooltip.
  const compact = !actor.isOfType("loot");
  block.className = compact ? "raccoon-liking rl-compact" : "raccoon-liking";
  // A merchant's panel has the room, so it starts open; an NPC's is full of
  // statistics, so there it starts as one line with the values that are set.
  block.open = openState.get(actor.uuid) ?? actor.isOfType("loot");
  block.addEventListener("toggle", () => openState.set(actor.uuid, block.open));

  const summary = document.createElement("summary");
  summary.dataset.tooltip = t("hint");
  const title = document.createElement("span");
  title.className = "rl-title";
  title.textContent = t("title");
  const chips = document.createElement("span");
  chips.className = "rl-chips";
  summary.append(title, chips);
  block.append(summary);

  const values = new Map(list.map((a) => [a.id, clampLiking(flags[a.id])]));
  const paintChips = () => {
    chips.replaceChildren(...list.filter((a) => values.get(a.id) !== 0).map((a) => {
      const chip = document.createElement("span");
      chip.dataset.att = attitudeOf(values.get(a.id));
      chip.textContent = `${a.name.split(/\s+/)[0]} ${signed(values.get(a.id))}`;
      return chip;
    }));
    if (!chips.childElementCount) chips.textContent = t("allNeutral");
  };

  for (const character of list) {
    const row = document.createElement("div");
    row.className = "rl-row";
    const head = document.createElement("div");
    head.className = "rl-head";
    const name = document.createElement("span");
    name.className = "rl-name";
    name.textContent = character.name;
    name.title = character.name;
    const value = document.createElement("span");
    value.className = "rl-value";
    head.append(name, value);

    const meter = document.createElement("div");
    meter.className = "rl-meter";
    const step = (label, delta) => {
      const a = document.createElement("a");
      a.className = "rl-step";
      a.textContent = label;
      a.addEventListener("click", (event) => { event.preventDefault(); set(values.get(character.id) + delta); });
      return a;
    };
    const bar = document.createElement("div");
    bar.className = "rl-bar";
    const cells = [];
    for (let v = MIN; v <= MAX; v++) {
      const cell = document.createElement("i");
      cell.dataset.v = String(v);
      cell.title = `${signed(v)} · ${t(attitudeOf(v))}`;
      cell.addEventListener("click", () => set(v));
      cells.push(cell);
      bar.append(cell);
    }
    meter.append(step("−", -1), bar, step("+", 1));

    const paint = () => {
      const n = values.get(character.id);
      row.dataset.att = attitudeOf(n);
      value.textContent = compact ? signed(n) : `${signed(n)} · ${t(attitudeOf(n))}`;
      value.title = t(attitudeOf(n));
      for (const cell of cells) {
        const v = Number(cell.dataset.v);
        cell.classList.toggle("on", (n > 0 && v > 0 && v <= n) || (n < 0 && v < 0 && v >= n));
        cell.classList.toggle("zero", v === 0);
      }
    };
    const set = (next) => {
      const n = clampLiking(next);
      if (n === values.get(character.id)) return;
      values.set(character.id, n);
      paint();
      paintChips();
      // No re-render: the block is already showing the new value.
      actor.update({ [`flags.${MODULE_ID}.liking.${character.id}`]: n }, { render: false })
        .catch((error) => { warn("Could not save the liking value.", error); ui.notifications.warn(t("saveFailed", { name: actor.name })); });
    };
    value.addEventListener("dblclick", () => set(0));

    paint();
    row.append(head, meter);
    block.append(row);
  }
  paintChips();
  return block;
}

function onRender(app, html) {
  try {
    const actor = app.actor ?? app.document;
    if (!game.user.isGM || !setting(SETTINGS.LIKING) || !tracked(actor)) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    const sidebar = root?.querySelector?.("section.sidebar, .sheet-sidebar") ?? app.element?.[0]?.querySelector?.("section.sidebar, .sheet-sidebar");
    if (!sidebar || sidebar.querySelector(".raccoon-liking")) return;
    const block = build(actor);
    if (!block) return;
    // Under the picture on both sheets: above the description on a merchant,
    // above the statistics on an NPC (where it is one line until unfolded).
    const picture = sidebar.querySelector(":scope > .image-container");
    if (picture) picture.after(block);
    else sidebar.prepend(block);
  } catch (error) {
    warn("Liking meter failed.", error);
  }
}

export function registerLiking() {
  // PF2e's sheets are first-generation applications, whose render hook fires for
  // every class up the chain; the second name covers a move to the new ones.
  Hooks.on("renderActorSheet", onRender);
  Hooks.on("renderActorSheetV2", onRender);

  Hooks.once("ready", () => {
    const api = game.modules.get(MODULE_ID).api ?? (game.modules.get(MODULE_ID).api = {});
    const find = (ref, types) => game.actors.get(ref) ?? game.actors.find((a) => (!types || types.includes(a.type)) && a.name.toLowerCase().includes(String(ref).toLowerCase()));
    api.liking = {
      /** `set("Keeleno", "Arnold", 4)`: from -10 to +10. */
      set: async (whoRef, characterRef, value) => {
        const who = find(whoRef, ["npc", "loot"]), character = find(characterRef, ["character"]);
        if (!tracked(who) || !character) throw new Error("merchant, NPC or character not found");
        const n = clampLiking(value);
        await who.update({ [`flags.${MODULE_ID}.liking.${character.id}`]: n });
        return `${who.name} -> ${character.name}: ${signed(n)} (${attitudeOf(n)})`;
      },
      /** What one merchant or NPC thinks of everyone it has a value for. */
      state: (whoRef) => {
        const who = find(whoRef, ["npc", "loot"]);
        return who ? Object.fromEntries(Object.entries(likingFlags(who)).map(([id, v]) => [game.actors.get(id)?.name ?? id, `${signed(clampLiking(v))} ${attitudeOf(v)}`])) : null;
      },
      /** Everyone who has a value for this character, strongest feelings first. */
      of: (characterRef) => {
        const character = find(characterRef, ["character"]);
        if (!character) return null;
        return game.actors.filter((a) => tracked(a) && likingFor(a, character) !== 0)
          .map((a) => ({ name: a.name, liking: likingFor(a, character), attitude: attitudeOf(likingFor(a, character)) }))
          .sort((a, b) => Math.abs(b.liking) - Math.abs(a.liking));
      },
    };
  });
}
