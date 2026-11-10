import { MODULE_ID, SETTINGS, log, warn, stampOrigin, fromThisTab } from "./constants.js";
import { setting } from "./settings.js";

/**
 * Firearms want cleaning (Dan, 2026-11-10, after session 9).
 *
 * A character who carries a firearm (weapon group "firearm") has them clean or
 * dirty for the current day of the world calendar. Cleaning is one hour of
 * work and lasts until the date changes, so it resets by itself the next day.
 * Two ways to clean: the "Clean" button in the firearm bar at the top of the
 * inventory, or posting the action "Clean Firearms" from the sheet (any action
 * item carrying the flag `raccoon-tweaks.cleanFirearms`).
 *
 * The cost of skipping it (Makak's version from the session, the chance is a
 * world setting, 5 % by default): every attack with a firearm while dirty rolls
 * a d100, and at or under the chance the gun jams. A chat line says so and the
 * character gets the effect "Jammed firearm"; an Interact clears the jam, then
 * the effect is removed by hand.
 *
 * Everything runs in the tab that made the roll or pressed the button, which is
 * the owner's: no GM tab is involved, and a second GM tab never doubles it.
 * Stored on the character as `flags.raccoon-tweaks.firearms.cleanedOn` = the
 * calendar date (yyyy-mm-dd).
 */
const JAM_SLUG = "raccoon-jammed-firearm";
const t = (key, data) => game.i18n.format(`${MODULE_ID}.firearms.${key}`, data);

export const firearmsOf = (actor) => (actor?.itemTypes?.weapon ?? []).filter((w) => w.group === "firearm" || w.system?.group === "firearm");
const today = () => {
  try { return game.pf2e.worldClock.worldTime.toISODate(); } catch { return String(Math.floor(game.time.worldTime / 86400)); }
};
export const cleanedToday = (actor) => actor?.getFlag?.(MODULE_ID, "firearms")?.cleanedOn === today();

export async function cleanFirearms(actor, { announce = true } = {}) {
  if (!actor?.isOwner) return;
  const guns = firearmsOf(actor);
  if (!guns.length) { ui.notifications.warn(t("noFirearm", { name: actor.name })); return; }
  await actor.setFlag(MODULE_ID, "firearms", { cleanedOn: today() });
  if (announce) {
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<p>${t("cleaned", { name: actor.name, guns: guns.map((g) => g.name).join(", ") })}</p>` });
  }
  log(`${actor.name} cleaned ${guns.length} firearm(s) for ${today()}.`);
}

async function jamCheck(message) {
  const actor = message.actor;
  const weapon = message.item;
  if (!actor?.isOfType?.("character") || !weapon?.isOfType?.("weapon")) return;
  if (!(weapon.group === "firearm" || weapon.system?.group === "firearm")) return;
  if (cleanedToday(actor)) return;
  const chance = Math.max(0, Math.min(100, Number(setting(SETTINGS.FIREARM_JAM)) || 0));
  if (!chance) return;
  const roll = await new Roll("1d100").evaluate();
  if (roll.total > chance) return;
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: t("jammed", { name: actor.name, weapon: weapon.name, total: roll.total, chance }),
  });
  if (!actor.items.some((i) => i.slug === JAM_SLUG)) {
    await actor.createEmbeddedDocuments("Item", [{
      name: t("jamEffect"),
      type: "effect",
      img: "icons/svg/hazard.svg",
      system: {
        slug: JAM_SLUG,
        description: { value: `<p>${t("jamDescription", { weapon: weapon.name })}</p>` },
        duration: { value: -1, unit: "unlimited", expiry: null, sustained: false },
        tokenIcon: { show: true },
        level: { value: 0 },
      },
    }]);
  }
  log(`${weapon.name} jammed for ${actor.name} (${roll.total} <= ${chance}).`);
}

function bar(actor) {
  const guns = firearmsOf(actor);
  if (!guns.length) return null;
  const clean = cleanedToday(actor);
  const el = document.createElement("div");
  el.className = `raccoon-firearms ${clean ? "clean" : "dirty"}`;
  const text = document.createElement("span");
  text.innerHTML = `<i class="fa-solid ${clean ? "fa-circle-check" : "fa-triangle-exclamation"}"></i> ${t(clean ? "barClean" : "barDirty", { chance: setting(SETTINGS.FIREARM_JAM) })}`;
  el.append(text);
  if (!clean && actor.isOwner) {
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `<i class="fa-solid fa-broom"></i> ${t("button")}`;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      button.disabled = true;
      cleanFirearms(actor).catch((e) => warn("Cleaning failed.", e));
    });
    el.append(button);
  }
  return el;
}

export function registerFirearms() {
  Hooks.on("preCreateChatMessage", (message, data, options) => stampOrigin(options));
  Hooks.on("createChatMessage", (message, options) => {
    try {
      if (!setting(SETTINGS.FIREARMS) || !fromThisTab(options)) return;
      if (message.item?.getFlag?.(MODULE_ID, "cleanFirearms") || message.item?.slug === "clean-firearms") {
        cleanFirearms(message.actor, { announce: false }).catch((e) => warn("Cleaning failed.", e));
        return;
      }
      if (message.flags?.pf2e?.context?.type === "attack-roll") jamCheck(message).catch((e) => warn("Jam check failed.", e));
    } catch (error) {
      warn("Firearm hook failed.", error);
    }
  });

  const onRender = (app, html) => {
    try {
      const actor = app.actor ?? app.document;
      if (!setting(SETTINGS.FIREARMS) || !actor?.isOfType?.("character")) return;
      const root = html instanceof HTMLElement ? html : html?.[0];
      const tab = root?.querySelector?.('.tab[data-tab="inventory"]');
      if (!tab || tab.querySelector(".raccoon-firearms")) return;
      const el = bar(actor);
      if (el) tab.prepend(el);
    } catch (error) {
      warn("Firearm bar failed.", error);
    }
  };
  Hooks.on("renderActorSheet", onRender);
  Hooks.on("renderActorSheetV2", onRender);
  // A new day: open sheets show "dirty" again without a reload.
  Hooks.on("updateWorldTime", () => {
    for (const app of foundry.applications.instances?.values?.() ?? []) if (app.actor && firearmsOf(app.actor).length && app.rendered) app.render(false);
    for (const app of Object.values(ui.windows ?? {})) if (app.actor && firearmsOf(app.actor).length && app.rendered) app.render(false);
  });

  Hooks.once("ready", () => {
    const api = game.modules.get(MODULE_ID).api ?? (game.modules.get(MODULE_ID).api = {});
    api.firearms = {
      clean: (ref) => cleanFirearms(game.actors.get(ref) ?? game.actors.getName(ref)),
      state: () => Object.fromEntries(game.actors.filter((a) => a.type === "character" && firearmsOf(a).length).map((a) => [a.name, cleanedToday(a) ? "clean" : "dirty"])),
      today,
      /** The action item to put on a sheet: `api.firearms.actionData()`. */
      actionData: () => ({
        name: t("actionName"),
        type: "action",
        img: "icons/svg/clockwork.svg",
        system: {
          slug: "clean-firearms",
          actionType: { value: "passive" },
          traits: { value: ["exploration", "manipulate"] },
          description: { value: `<p>${t("actionDescription")}</p>` },
        },
        flags: { [MODULE_ID]: { cleanFirearms: true } },
      }),
    };
  });
}
