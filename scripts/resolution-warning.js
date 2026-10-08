import { SETTINGS, log, warn } from "./constants.js";
import { setting } from "./settings.js";

const RESOLUTION_KEY = "ERROR.RESOLUTION.";

/**
 * Core's private ClientIssues#validateResolution raises
 * `ui.notifications.error("ERROR.RESOLUTION.<Screen|Scale|Window>", {permanent: true})`
 * whenever the effective window is under 1024x768, with no setting to turn it
 * off. The key is passed unlocalised, so exactly those messages are dropped in
 * notify(). The caller keeps the return value only to remove it later and
 * guards on it, so returning nothing is safe.
 */
export function installResolutionWarningFilter() {
  const Notifications = foundry.applications?.ui?.Notifications;
  if (typeof Notifications?.prototype?.notify !== "function") {
    warn("Notifications.notify not found, the window-size warning stays.");
    return;
  }

  const original = Notifications.prototype.notify;
  Notifications.prototype.notify = function raccoonNotify(message, ...args) {
    if (typeof message === "string" && message.startsWith(RESOLUTION_KEY) && hideEnabled()) {
      log("Window-size warning hidden:", message);
      return undefined;
    }
    return original.call(this, message, ...args);
  };
}

function hideEnabled() {
  try {
    return setting(SETTINGS.HIDE_RESOLUTION_WARNING);
  } catch {
    return true;
  }
}
