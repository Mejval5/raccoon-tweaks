import { MODULE_ID, SETTINGS, log, warn } from "./constants.js";
import { setting } from "./settings.js";

/**
 * PF2e Visioner opens a preview dialog (seek, hide, sneak, point out,
 * consequences, cover) after many actions and an override-validation dialog
 * on turn change, each needing a click on "apply all". With this on, that
 * click happens by itself the moment the dialog renders. Hold Shift while the
 * dialog opens to look at it instead. Per browser, default off; a toggle sits
 * in the Token scene controls so the GM can flip it mid-session.
 */
export function registerVisionerAutoAccept() {
  Hooks.on("renderApplicationV2", (app, element) => {
    try {
      onRender(app, element);
    } catch (error) {
      warn("Visioner auto-accept failed.", error);
    }
  });

  Hooks.on("getSceneControlButtons", (controls) => {
    const tokens = controls.tokens ?? controls.find?.((c) => c.name === "token");
    if (!tokens || !game.user.isGM) return;
    const tool = {
      name: "raccoon-visioner-autoaccept",
      title: game.i18n.localize("raccoon-tweaks.visioner.toggle"),
      icon: "fa-solid fa-forward",
      toggle: true,
      active: Boolean(setting(SETTINGS.VISIONER_AUTOACCEPT)),
      onChange: (event, active) => {
        game.settings.set(MODULE_ID, SETTINGS.VISIONER_AUTOACCEPT, active)
          .catch((error) => warn("Could not save the auto-accept toggle.", error));
      },
      // v13+ passes onChange; older builds call onClick with the new state.
      onClick: (active) => {
        game.settings.set(MODULE_ID, SETTINGS.VISIONER_AUTOACCEPT, active)
          .catch((error) => warn("Could not save the auto-accept toggle.", error));
      },
    };
    if (Array.isArray(tokens.tools)) tokens.tools.push(tool);
    else tokens.tools[tool.name] = tool;
  });
}

const VISIONER_CLASS = /pf2e-visioner|visioner/i;
const SHIFT = { held: false };
window.addEventListener("keydown", (e) => { if (e.key === "Shift") SHIFT.held = true; }, true);
window.addEventListener("keyup", (e) => { if (e.key === "Shift") SHIFT.held = false; }, true);

function onRender(app, element) {
  if (!setting(SETTINGS.VISIONER_AUTOACCEPT)) return;
  if (SHIFT.held) return;
  const root = element instanceof HTMLElement ? element : app.element;
  if (!root) return;
  const id = root.id ?? "";
  const classes = root.className ?? "";
  const ctor = app.constructor?.name ?? "";
  const isVisioner = VISIONER_CLASS.test(classes) || VISIONER_CLASS.test(id)
    || /PreviewDialog|OverrideValidationDialog/.test(ctor);
  if (!isVisioner) return;
  if (root.dataset.raccoonAccepted) return;

  const button = root.querySelector('.bulk-action-btn[data-action="applyAll"]')
    ?? root.querySelector(".bulk-action-btn.apply-all")
    ?? root.querySelector('button[data-action="apply"]');
  if (!button) return;

  root.dataset.raccoonAccepted = "1";
  // Let Visioner finish wiring its listeners before the click lands.
  setTimeout(() => {
    try {
      button.click();
      log(`Visioner: auto-accepted ${ctor || id || "dialog"}.`);
    } catch (error) {
      warn("Visioner auto-accept click failed.", error);
    }
  }, 50);
}
