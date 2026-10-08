import { MODULE_ID, SETTINGS, log, warn } from "./constants.js";
import { setting } from "./settings.js";

/**
 * The server launches every world paused and core has no setting for it.
 * The pause state the GM last set is remembered (pauseGame hook), and when the
 * active GM opens a paused world whose last remembered state was running, it is
 * resumed. A pause the GM set on purpose survives a relaunch and a tab reload.
 */
export function registerLaunchPause() {
  Hooks.on("pauseGame", (paused) => {
    if (!isActiveGM()) return;
    if (setting(SETTINGS.LAST_PAUSED) === paused) return;
    game.settings.set(MODULE_ID, SETTINGS.LAST_PAUSED, paused)
      .catch((error) => warn("Could not remember the pause state.", error));
  });

  Hooks.once("ready", () => {
    if (!setting(SETTINGS.RESUME_ON_LAUNCH) || !isActiveGM()) return;
    if (!game.paused || setting(SETTINGS.LAST_PAUSED)) return;
    log("World opened paused by the launch, resuming.");
    game.togglePause(false, { broadcast: true });
  });
}

function isActiveGM() {
  return game.user.isGM && game.users.activeGM?.id === game.user.id;
}
