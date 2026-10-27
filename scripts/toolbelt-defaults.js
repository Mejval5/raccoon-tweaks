import { MODULE_ID, log, warn } from "./constants.js";

/**
 * pf2e-toolbelt keeps a few of its inventory options per user, so the GM
 * turning one on reaches nobody else. The table wants stack splitting for
 * everyone (Dan and Makak, 2026-10-26), so each user's browser switches it on
 * once, the first time it sees it off. A user who then turns it off again is
 * left alone: the marker in localStorage remembers that this tab already did
 * its one switch.
 */
const DEFAULTS = [
  ["pf2e-toolbelt", "betterInventory.splitItem", true],
];

export function applyToolbeltDefaults() {
  Hooks.once("ready", async () => {
    if (!game.modules.get("pf2e-toolbelt")?.active) return;
    for (const [ns, key, value] of DEFAULTS) {
      const marker = `${MODULE_ID}.default.${ns}.${key}.${game.user.id}`;
      try {
        if (localStorage.getItem(marker)) continue;
        if (!game.settings.settings.has(`${ns}.${key}`)) continue;
        if (game.settings.get(ns, key) !== value) {
          await game.settings.set(ns, key, value);
          log(`${ns} ${key} switched to ${value} for ${game.user.name} (once).`);
        }
        localStorage.setItem(marker, "1");
      } catch (error) {
        warn(`Could not set the default for ${ns}.${key}.`, error);
      }
    }
  });
}
