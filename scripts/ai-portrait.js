import { MODULE_ID, SETTINGS, DEFAULT_CAMPAIGN, DEFAULT_STYLE, PROMPT_BACKGROUND_TRANSPARENT, PROMPT_BACKGROUND_FILLED, PROMPT_CONSTRAINTS, parseDirectory, log, warn } from "./constants.js";
import { setting } from "./settings.js";
import { generateImage, base64ToBlob, loadImageElement } from "./openai.js";
import { rebuildTokenView } from "./tokenizer-patch.js";

const BUTTON_ID = "raccoon-ai-avatar";

export function registerAiPortrait() {
  Hooks.on("renderTokenizer", (app) => {
    try {
      injectButton(app);
    } catch (error) {
      warn("Could not inject the AI button.", error);
    }
  });
}

function injectButton(app) {
  if (!game.user.isGM) return;
  if (!setting(SETTINGS.AI_ENABLED)) return;

  const root = app.element;
  if (!root || root.querySelector(`#${BUTTON_ID}`)) return;

  // Sit next to PRESETS / MODIFY / PASTE TARGET in the Avatar column header.
  const anchor = root.querySelector("#paste-avatar")?.parentElement
    ?? root.querySelector(".avatar .title .title-element:last-of-type");
  if (!anchor) return;

  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.className = "box-button raccoon-ai-button";
  button.innerHTML = `${game.i18n.localize("raccoon-tweaks.ai.button")}&nbsp;&nbsp;<i class="fas fa-wand-magic-sparkles button-fas"></i>`;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onGenerateClick(app, button);
  });

  anchor.append(button);
}

async function onGenerateClick(app, button) {
  const tokenName = app.tokenOptions?.name || "";
  const sheetName = app.tokenOptions?.actor?.name || "";
  const fromToken = setting(SETTINGS.AI_SUBJECT_FROM_TOKEN);
  const defaults = {
    tokenName,
    sheetName,
    fromToken,
    // The toggle picks the source; each side falls back to the other when empty.
    subject: fromToken ? (tokenName || sheetName) : (sheetName || tokenName),
    campaign: setting(SETTINGS.AI_CAMPAIGN) || DEFAULT_CAMPAIGN,
    style: setting(SETTINGS.AI_STYLE) || DEFAULT_STYLE,
  };

  const answers = await promptForDetails(defaults);
  if (!answers) return;

  // Guarded here, not on open, so the dialog's gear can set the key first.
  if (!setting(SETTINGS.AI_KEY)?.trim()) {
    ui.notifications.error(game.i18n.localize("raccoon-tweaks.ai.noKey"));
    return;
  }

  const prompt = buildPrompt({ ...answers, campaign: defaults.campaign });
  log("Prompt:", prompt);

  button.disabled = true;
  button.classList.add("raccoon-ai-busy");
  const notification = ui.notifications.info(
    game.i18n.localize("raccoon-tweaks.ai.generating"),
    { permanent: true },
  );

  try {
    const base64 = await generateImage(prompt);
    const img = await loadImageElement(`data:image/png;base64,${base64}`);

    if (setting(SETTINGS.AI_SAVE_SOURCE)) {
      await saveSource(app, base64, answers.subject).catch((error) => {
        warn("Source image not saved.", error);
        ui.notifications.warn(game.i18n.format("raccoon-tweaks.ai.saveFailed", { error: error.message }));
      });
    }

    if (setting(SETTINGS.AI_TRANSPARENT)) removeDefaultAvatarLayers(app);
    app.Avatar?.addImageLayer(img, { activate: true });
    await rebuildTokenView(app, img);

    ui.notifications.info(game.i18n.localize("raccoon-tweaks.ai.done"));
  } catch (error) {
    warn(error);
    ui.notifications.error(game.i18n.format("raccoon-tweaks.ai.failed", { error: error.message }), { permanent: true });
  } finally {
    dismissNotification(notification);
    button.disabled = false;
    button.classList.remove("raccoon-ai-busy");
  }
}

/**
 * Drop the placeholder avatar Tokenizer seeded from the actor's default artwork,
 * so a transparent portrait does not visibly overlap the mystery-man behind it.
 * Only default images are removed; a real portrait the user already picked stays.
 */
function removeDefaultAvatarLayers(app) {
  const view = app.Avatar;
  if (!view?.layers?.length) return;

  const defaults = new Set([...defaultAvatarPaths(app)].map(normalizeImagePath));
  for (const layer of [...view.layers]) {
    if (defaults.has(normalizeImagePath(layer.sourceImg))) view.removeImageLayer(layer.id);
  }
}

function defaultAvatarPaths(app) {
  const paths = new Set([CONST.DEFAULT_TOKEN]);
  const actor = app.tokenOptions?.actor;
  try {
    const artwork = actor?.constructor?.getDefaultArtwork?.(actor.toObject());
    if (artwork?.img) paths.add(artwork.img);
    if (artwork?.texture?.src) paths.add(artwork.texture.src);
  } catch (error) {
    warn("Could not resolve the actor's default artwork.", error);
  }
  return paths;
}

/** Strip the origin and cache-busting query so URLs and stored paths compare equal. */
function normalizeImagePath(source) {
  if (!source) return "";
  try {
    return decodeURIComponent(new URL(source, window.location.origin).pathname).replace(/^\/+/, "");
  } catch {
    return source.split("?")[0].replace(/^\/+/, "");
  }
}

function escapeHTML(value) {
  const text = String(value ?? "");
  if (typeof foundry?.utils?.escapeHTML === "function") return foundry.utils.escapeHTML(text);
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function buildPrompt({ subject, campaign, details, style }) {
  const parts = [];
  // Subject leads so an explicit non-human subject (e.g. a cave bear) is not
  // drowned out by the human-heavy campaign and style text that follows.
  if (setting(SETTINGS.AI_INCLUDE_NAME) && subject?.trim()) parts.push(`Subject: ${subject.trim()}.`);
  if (campaign?.trim()) parts.push(campaign.trim());
  if (style?.trim()) parts.push(style.trim());
  if (details?.trim()) parts.push(details.trim());
  parts.push(setting(SETTINGS.AI_TRANSPARENT) ? PROMPT_BACKGROUND_TRANSPARENT : PROMPT_BACKGROUND_FILLED);
  parts.push(PROMPT_CONSTRAINTS);
  return parts.join("\n\n");
}

async function promptForDetails(defaults) {
  const { DialogV2 } = foundry.applications.api;

  const content = `
    <div class="raccoon-ai-form">
      <div class="raccoon-ai-toolbar">
        <button type="button" class="raccoon-ai-key-button" data-raccoon-action="configure-key" title="${game.i18n.localize("raccoon-tweaks.ai.apiKeyConfigure")}"><i class="fas fa-gear"></i></button>
      </div>
      <div class="form-group">
        <label for="raccoon-ai-subject">${game.i18n.localize("raccoon-tweaks.ai.fieldSubject")}</label>
        <input id="raccoon-ai-subject" name="charSubject" type="text" value="${escapeHTML(defaults.subject)}" placeholder="${game.i18n.localize("raccoon-tweaks.ai.subjectPlaceholder")}" autofocus />
      </div>
      <label class="raccoon-ai-checkbox">
        <input type="checkbox" name="subjectFromToken" data-raccoon-action="subject-source" data-token-name="${escapeHTML(defaults.tokenName)}" data-sheet-name="${escapeHTML(defaults.sheetName)}" ${defaults.fromToken ? "checked" : ""} />
        ${game.i18n.localize("raccoon-tweaks.ai.subjectFromToken")}
      </label>
      <div class="form-group">
        <label for="raccoon-ai-details">${game.i18n.localize("raccoon-tweaks.ai.fieldDetails")}</label>
        <textarea id="raccoon-ai-details" name="charDetails" rows="3" placeholder="${game.i18n.localize("raccoon-tweaks.ai.detailsPlaceholder")}"></textarea>
      </div>
      <div class="form-group">
        <label for="raccoon-ai-style">${game.i18n.localize("raccoon-tweaks.ai.fieldStyle")}</label>
        <textarea id="raccoon-ai-style" name="charStyle" rows="4">${escapeHTML(defaults.style)}</textarea>
      </div>
      <label class="raccoon-ai-checkbox">
        <input type="checkbox" name="transparentBg" data-raccoon-action="transparent-bg" ${setting(SETTINGS.AI_TRANSPARENT) ? "checked" : ""} />
        ${game.i18n.localize("raccoon-tweaks.ai.transparentBg")}
      </label>
      <label class="raccoon-ai-checkbox">
        <input type="checkbox" name="saveStyle" />
        ${game.i18n.localize("raccoon-tweaks.ai.saveStyle")}
      </label>
    </div>`;

  const result = await DialogV2.wait({
    window: { title: game.i18n.localize("raccoon-tweaks.ai.dialogTitle") },
    classes: ["raccoon-ai-dialog"],
    position: { width: 520 },
    content,
    render: (event, dialog) => {
      const root = dialog instanceof HTMLElement ? dialog : dialog?.element;
      wireKeyButton(root);
      wireSubjectToggle(root);
      wireTransparentToggle(root);
    },
    buttons: [
      {
        action: "generate",
        label: game.i18n.localize("raccoon-tweaks.ai.generate"),
        icon: "fas fa-wand-magic-sparkles",
        default: true,
        callback: (event, target) => readForm(target),
      },
      {
        action: "cancel",
        label: game.i18n.localize("raccoon-tweaks.ai.cancel"),
        icon: "fas fa-xmark",
      },
    ],
    rejectClose: false,
  });

  if (!result || result === "cancel") return null;

  if (result.saveStyle && game.user.isGM) {
    await game.settings.set(MODULE_ID, SETTINGS.AI_STYLE, result.style);
  }

  return result;
}

function readForm(target) {
  const root = target?.closest("dialog") ?? target?.form ?? document;
  const value = (name) => root.querySelector(`[name="${name}"]`)?.value ?? "";
  return {
    subject: value("charSubject"),
    details: value("charDetails"),
    style: value("charStyle"),
    saveStyle: root.querySelector('[name="saveStyle"]')?.checked ?? false,
  };
}

function wireKeyButton(root) {
  const cog = root?.querySelector('[data-raccoon-action="configure-key"]');
  if (!cog || cog.dataset.raccoonWired) return;
  cog.dataset.raccoonWired = "1";
  cog.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onConfigureKey().catch((error) => warn("Could not set the API key.", error));
  });
}

function wireSubjectToggle(root) {
  const toggle = root?.querySelector('[data-raccoon-action="subject-source"]');
  const subject = root?.querySelector('[name="charSubject"]');
  if (!toggle || !subject || toggle.dataset.raccoonWired) return;
  toggle.dataset.raccoonWired = "1";
  toggle.addEventListener("change", () => {
    const tokenName = toggle.dataset.tokenName ?? "";
    const sheetName = toggle.dataset.sheetName ?? "";
    subject.value = toggle.checked ? (tokenName || sheetName) : (sheetName || tokenName);
    game.settings.set(MODULE_ID, SETTINGS.AI_SUBJECT_FROM_TOKEN, toggle.checked)
      .catch((error) => warn("Could not save the subject source.", error));
  });
}

function wireTransparentToggle(root) {
  const toggle = root?.querySelector('[data-raccoon-action="transparent-bg"]');
  if (!toggle || toggle.dataset.raccoonWired) return;
  toggle.dataset.raccoonWired = "1";
  toggle.addEventListener("change", () => {
    game.settings.set(MODULE_ID, SETTINGS.AI_TRANSPARENT, toggle.checked)
      .catch((error) => warn("Could not save the background option.", error));
  });
}

async function onConfigureKey() {
  const { DialogV2 } = foundry.applications.api;
  const current = setting(SETTINGS.AI_KEY) ?? "";

  const content = `
    <div class="raccoon-ai-form">
      <div class="form-group">
        <label for="raccoon-ai-key">${game.i18n.localize("raccoon-tweaks.ai.apiKeyLabel")}</label>
        <input id="raccoon-ai-key" name="apiKey" type="password" value="${escapeHTML(current)}" autofocus />
        <p class="notes">${game.i18n.localize("raccoon-tweaks.ai.apiKeyHint")}</p>
      </div>
    </div>`;

  const result = await DialogV2.wait({
    window: { title: game.i18n.localize("raccoon-tweaks.ai.apiKeyPrompt") },
    classes: ["raccoon-ai-dialog"],
    position: { width: 480 },
    content,
    buttons: [
      {
        action: "save",
        label: game.i18n.localize("raccoon-tweaks.ai.apiKeySave"),
        icon: "fas fa-floppy-disk",
        default: true,
        callback: (event, target) => {
          const root = target?.closest("dialog") ?? target?.form ?? document;
          return { key: root.querySelector('[name="apiKey"]')?.value ?? "" };
        },
      },
      {
        action: "cancel",
        label: game.i18n.localize("raccoon-tweaks.ai.cancel"),
        icon: "fas fa-xmark",
      },
    ],
    rejectClose: false,
  });

  if (!result || typeof result !== "object") return;
  await game.settings.set(MODULE_ID, SETTINGS.AI_KEY, result.key.trim());
  ui.notifications.info(game.i18n.localize("raccoon-tweaks.ai.apiKeySaved"));
}

async function saveSource(app, base64, name) {
  const directory = setting(SETTINGS.AI_SAVE_DIRECTORY)?.trim()
    || app.avatarUploadDirectory
    || game.settings.get("vtta-tokenizer", "image-upload-directory");

  const target = parseDirectory(directory);
  if (!target?.current) throw new Error("No upload directory configured.");

  const slug = (name || "portrait").replace(/[^\w\-. ]/gu, "").trim().replace(/\s+/gu, "_") || "portrait";
  const fileName = `${slug}.AI.${Date.now()}.png`;
  const file = new File([base64ToBlob(base64)], fileName, { type: "image/png" });

  const FPClass = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
  const result = await FPClass.upload(
    target.activeSource,
    target.current,
    file,
    { bucket: target.bucket },
    { notify: false },
  );

  log("Saved source image to", result?.path);
  return result?.path;
}

function dismissNotification(notification) {
  if (!notification) return;
  try {
    if (typeof notification.remove === "function") notification.remove();
    else if (typeof ui.notifications.remove === "function") ui.notifications.remove(notification);
  } catch {
    /* notification already gone */
  }
}
