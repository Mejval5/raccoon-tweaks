import { MODULE_ID, SETTINGS, log, warn } from "./constants.js";
import { setting } from "./settings.js";

/**
 * A merchant the GM can step into.
 *
 * A PF2e merchant is a loot actor: a shelf with prices and no statistics, so
 * the person behind the counter cannot notice a thief, resist a lie or be
 * talked round with a roll. This gives each merchant an NPC of its own, made
 * on first use from a default stat block and linked both ways (Dan,
 * 2026-11-10):
 *
 * - the merchant's sheet gets a link under the picture, "NPC sheet", which
 *   opens that NPC, creating it the first time;
 * - the NPC's sheet gets a link back to the shop;
 * - the liking meter (liking.js) of the two is one and the same.
 *
 * The NPC is a copy of the actor named in the world setting, by default
 * "Merchant" from NPC Core, renamed to the part of the merchant's name before
 * " · " ("Keeleno Lathenar · Otari Market" -> "Keeleno Lathenar"), with the
 * merchant's picture and token, in the merchant's folder, token linked. From
 * then on it is an ordinary NPC: change its numbers as the person deserves.
 *
 * Linked by `flags.raccoon-tweaks.persona` (on the merchant, the NPC's id) and
 * `flags.raccoon-tweaks.personaOf` (on the NPC, the merchant's id). GM only.
 */
export const DEFAULT_PERSONA_SOURCE = "Compendium.pf2e.pathfinder-npc-core.Actor.qCKNT6U8O0su578A";

const isMerchant = (actor) => Boolean(actor?.isOfType?.("loot") && actor.isMerchant);
const t = (key, data) => game.i18n.format(`${MODULE_ID}.persona.${key}`, data);

/** The NPC that stands for this merchant, if it has been made and still exists. */
export function personaOf(merchant) {
  const id = merchant?.getFlag?.(MODULE_ID, "persona");
  const npc = id ? game.actors.get(id) : null;
  return npc?.isOfType?.("npc") ? npc : null;
}

/** The merchant this NPC stands for, if any. */
export function shopOf(npc) {
  if (!npc?.isOfType?.("npc")) return null;
  const id = npc.getFlag?.(MODULE_ID, "personaOf");
  const shop = id ? game.actors.get(id) : null;
  return shop?.isOfType?.("loot") ? shop : null;
}

async function sourceData() {
  const uuid = String(setting(SETTINGS.PERSONA_SOURCE) ?? "").trim() || DEFAULT_PERSONA_SOURCE;
  try {
    const source = await fromUuid(uuid);
    if (source?.documentName === "Actor" && source.type === "npc") {
      const data = source.pack ? game.actors.fromCompendium(source) : source.toObject();
      delete data._id;
      delete data.folder;
      delete data.ownership;
      return { data, from: source.name };
    }
    warn(`Merchant NPC source ${uuid} is not an NPC; a blank NPC is made instead.`);
  } catch (error) {
    warn(`Merchant NPC source ${uuid} could not be read; a blank NPC is made instead.`, error);
  }
  return { data: { type: "npc" }, from: null };
}

export async function createPersona(merchant) {
  if (!game.user.isGM) throw new Error("only the GM can do this");
  if (!merchant?.isOfType?.("loot")) throw new Error("not a merchant");
  const existing = personaOf(merchant);
  if (existing) return existing;

  const name = merchant.name.split(" · ")[0].trim() || merchant.name;
  const { data, from } = await sourceData();
  const tokenImage = merchant.prototypeToken?.texture?.src;
  foundry.utils.mergeObject(data, {
    name,
    img: merchant.img,
    folder: merchant.folder?.id ?? null,
    prototypeToken: { name, actorLink: true, ...(tokenImage ? { texture: { src: tokenImage } } : {}) },
    flags: { [MODULE_ID]: { personaOf: merchant.id } },
  });
  const npc = await Actor.create(data);
  if (!npc) throw new Error("the NPC was not created");
  await merchant.update({ [`flags.${MODULE_ID}.persona`]: npc.id });
  log(`Made NPC ${npc.name} (${npc.id}) for merchant ${merchant.name}${from ? ` from ${from}` : ""}.`);
  ui.notifications.info(t(from ? "created" : "createdBlank", { name: npc.name, from }));
  return npc;
}

function link(label, icon, onClick, tooltip) {
  const a = document.createElement("a");
  a.className = "raccoon-persona";
  if (tooltip) a.dataset.tooltip = tooltip;
  const i = document.createElement("i");
  i.className = icon;
  a.append(i, document.createTextNode(` ${label}`));
  a.addEventListener("click", (event) => {
    event.preventDefault();
    Promise.resolve(onClick()).catch((error) => { warn("Merchant NPC link failed.", error); ui.notifications.warn(t("failed", { error: error?.message ?? String(error) })); });
  });
  return a;
}

function onRender(app, html) {
  try {
    const actor = app.actor ?? app.document;
    if (!game.user.isGM || !actor) return;
    const shop = isMerchant(actor) ? actor : null;
    const behind = shop ? null : shopOf(actor);
    if (!shop && !behind) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    const sidebar = root?.querySelector?.("section.sidebar, .sheet-sidebar") ?? app.element?.[0]?.querySelector?.("section.sidebar, .sheet-sidebar");
    if (!sidebar || sidebar.querySelector(".raccoon-persona")) return;

    let element;
    if (shop) {
      const npc = personaOf(shop);
      element = npc
        ? link(t("open"), "fa-solid fa-masks-theater", () => npc.sheet.render(true), t("openHint", { name: npc.name }))
        : link(t("create"), "fa-solid fa-masks-theater", async () => { const made = await createPersona(shop); made.sheet.render(true); shop.sheet.render(false); }, t("createHint"));
    } else {
      element = link(t("shop"), "fa-solid fa-store", () => behind.sheet.render(true), t("shopHint", { name: behind.name }));
    }
    const picture = sidebar.querySelector(":scope > .image-container");
    if (picture) picture.after(element);
    else sidebar.prepend(element);
  } catch (error) {
    warn("Merchant NPC link failed to render.", error);
  }
}

export function registerPersona() {
  Hooks.on("renderActorSheet", onRender);
  Hooks.on("renderActorSheetV2", onRender);

  Hooks.once("ready", () => {
    const api = game.modules.get(MODULE_ID).api ?? (game.modules.get(MODULE_ID).api = {});
    const find = (ref) => game.actors.get(ref) ?? game.actors.find((a) => a.type === "loot" && a.name.toLowerCase().includes(String(ref).toLowerCase()));
    api.persona = {
      /** The merchant's NPC, or null: `of("Keeleno")`. */
      of: (merchantRef) => personaOf(find(merchantRef)),
      /** Opens the merchant's NPC sheet, making the NPC first if there is none. */
      open: async (merchantRef) => { const npc = await createPersona(find(merchantRef)); npc.sheet.render(true); return npc; },
    };
  });
}
