import { MODULE_ID, SETTINGS, parseDirectory, log, warn } from "./constants.js";
import { loadImageElement } from "./openai.js";

const PATCH_FLAG = Symbol.for("raccoon-tweaks.tokenizer.patched");
const QUICK_BUTTON_ID = "raccoon-quick-token-avatar";

/**
 * Tokenizer never exports its Application class, and `renderTokenizer` fires
 * *after* `_onRender()` has already kicked off the async image load, so hooking
 * that is a race. ApplicationV2#render() is not overridden by Tokenizer, so
 * wrapping it gives us a guaranteed pre-render foothold. We use it once to grab
 * the prototype, patch it, then restore the original render.
 */
export function installTokenizerPatch() {
  const ApplicationV2 = foundry?.applications?.api?.ApplicationV2;
  if (!ApplicationV2) {
    warn("ApplicationV2 not found, Tokenizer patch not installed.");
    return;
  }

  const originalRender = ApplicationV2.prototype.render;

  function raccoonRender(...args) {
    try {
      if (this?.constructor?.name === "Tokenizer") {
        const proto = Object.getPrototypeOf(this);
        if (patchTokenizerPrototype(proto)) {
          ApplicationV2.prototype.render = originalRender;
        }
      }
    } catch (error) {
      warn("Failed while patching Tokenizer", error);
      ApplicationV2.prototype.render = originalRender;
    }
    return originalRender.apply(this, args);
  }

  ApplicationV2.prototype.render = raccoonRender;
  log("Tokenizer patch armed.");
}

/**
 * @returns {boolean} true once the prototype is patched (or was already)
 */
function patchTokenizerPrototype(proto) {
  if (!proto) return false;
  if (proto[PATCH_FLAG]) return true;
  if (typeof proto._loadTokenImageToTokenView !== "function"
    || typeof proto._initToken !== "function") {
    warn("Tokenizer internals not as expected, skipping seed patch.");
    return false;
  }

  const original = proto._loadTokenImageToTokenView;

  proto._loadTokenImageToTokenView = function raccoonLoadTokenImageToTokenView() {
    let useAvatar = true;
    try {
      useAvatar = game.settings.get(MODULE_ID, SETTINGS.SEED_FROM_AVATAR);
    } catch {
      useAvatar = true;
    }

    if (!useAvatar) return original.call(this);
    if (this.tokenOptions?.isWildCard) return original.call(this);

    // The saved token PNG already has the frame/mask baked into it. Re-loading it
    // and then re-applying the frame is what stacks a second ring every time the
    // window opens. Seed from the avatar instead, which is always unframed.
    const source = this.tokenOptions?.avatarFilename || this.tokenOptions?.tokenFilename;
    log("Seeding token view from avatar:", source);
    return this._initToken(source);
  };

  proto[PATCH_FLAG] = true;
  log("Tokenizer prototype patched.");
  return true;
}

/**
 * Rebuild the token view from a fresh image, so frame/mask/texture land exactly once.
 * Mirrors Tokenizer's own `_initToken` ordering.
 */
export async function rebuildTokenView(app, img) {
  if (!app?.Token) return;
  try {
    app.Token.removeAllLayers();
  } catch (error) {
    warn("Could not clear token layers, adding on top instead.", error);
    app.Token.addImageLayer(img, { type: "original" });
    return;
  }

  await app._addBaseTokenLayers();
  const offset = app.addFrame || app.addMask ? app.tokenOffset : {};
  app.Token.addImageLayer(img, { ...offset, type: "original" });
  await app._addHigherTokenLayers();
}

/**
 * On-render tweaks to Tokenizer's own UI: retarget the Foundry image pickers to
 * Tokenizer's upload directory, and add a quick-token button that seeds the
 * token from the current avatar.
 */
export function registerTokenizerTweaks() {
  Hooks.on("renderTokenizer", (app) => {
    try {
      retargetFilePickers(app);
      injectQuickAvatarButton(app);
    } catch (error) {
      warn("Could not apply Tokenizer UI tweaks.", error);
    }
  });
}

/**
 * Tokenizer's "Use a Foundry hosted image" button opens the picker at the
 * actor's current image, which for a fresh PF2e actor is the system default
 * icons folder. Start it at Tokenizer's own upload directory instead.
 */
function retargetFilePickers(app) {
  const root = app.element;
  if (!root) return;

  const buttons = root.querySelectorAll("button.file-picker[data-action='chooseImage']");
  for (const button of buttons) {
    if (button.dataset.raccoonPicker) continue;
    button.dataset.raccoonPicker = "1";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      openTokenizerFilePicker(app, button.dataset.target).catch((error) => warn("File picker failed.", error));
    }, true);
  }
}

async function openTokenizerFilePicker(app, targetName) {
  const isAvatar = targetName === "foundryAvatar";
  const view = isAvatar ? app.Avatar : app.Token;
  if (!view) return;

  const directory = (isAvatar ? app.avatarUploadDirectory : app.tokenUploadDirectory)
    || app.avatarUploadDirectory
    || app.tokenUploadDirectory
    || "";
  const target = parseDirectory(directory);

  const FPClass = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
  const picker = new FPClass({
    type: "image",
    source: target.activeSource,
    current: target.current,
    options: { bucket: target.bucket },
    callback: (path) => {
      loadImageElement(path)
        .then((img) => view.addImageLayer(img, { type: "image" }))
        .catch((error) => ui.notifications.error(error.message));
    },
  });
  picker.render(true);
}

/**
 * Add a button to the QUICK TOKEN menu that runs the initial token flow on the
 * current avatar: clear the token, drop the avatar into the middle layer and
 * apply the frame/mask on top.
 */
function injectQuickAvatarButton(app) {
  const root = app.element;
  if (!root) return;

  const menu = root.querySelector("#quick-token-menu");
  if (!menu || menu.querySelector(`#${QUICK_BUTTON_ID}`)) return;

  const separator = document.createElement("hr");
  separator.className = "tokenizer-hr";

  const wrapper = document.createElement("div");
  wrapper.className = "basic-quick-token-control";

  const button = document.createElement("button");
  button.id = QUICK_BUTTON_ID;
  button.type = "button";
  button.className = "box-button";
  button.textContent = game.i18n.localize("raccoon-tweaks.quickToken.avatarFrame");
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onQuickAvatarFrame(app).catch((error) => warn("Quick avatar-to-token failed.", error));
  });

  wrapper.append(button);
  menu.append(separator, wrapper);
}

async function onQuickAvatarFrame(app) {
  app.closeQuickLayerSelector?.("token");

  const img = await app.Avatar?.get("img");
  if (!img) {
    ui.notifications.warn(game.i18n.localize("raccoon-tweaks.quickToken.noAvatar"));
    return;
  }

  await rebuildTokenView(app, img);
}

