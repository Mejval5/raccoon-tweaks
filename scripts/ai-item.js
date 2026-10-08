import { SETTINGS, DEFAULT_CAMPAIGN, DEFAULT_STYLE, warn, log } from "./constants.js";
import { setting } from "./settings.js";
import { generateImage } from "./openai.js";
import { buildPrompt, getAnswers, uploadPng, dismissNotification } from "./ai-portrait.js";

/**
 * An "AI" header button on item sheets. Same dialog and the same prompt as the
 * Tokenizer portrait; the result is uploaded and set as the item's image.
 * PF2e item sheets are still ApplicationV1, so the V1 header hook is the one.
 */
export function registerAiItemImage() {
  Hooks.on("getItemSheetHeaderButtons", (sheet, buttons) => {
    // Anyone who owns the item; each user brings their own key (client setting).
    if (!setting(SETTINGS.AI_ENABLED)) return;
    const item = sheet.document ?? sheet.item;
    if (!item?.isOwner) return;

    buttons.unshift({
      label: game.i18n.localize("raccoon-tweaks.ai.button"),
      class: "raccoon-ai-item",
      icon: "fas fa-wand-magic-sparkles",
      onclick: (event) => onGenerateClick(item, event).catch((error) => warn("Item image failed.", error)),
    });
  });
}

let busy = false;

async function onGenerateClick(item, event) {
  if (busy) return;

  const answers = await getAnswers({
    subject: item.name,
    style: setting(SETTINGS.AI_STYLE) || DEFAULT_STYLE,
    skipKey: SETTINGS.AI_SKIP_DIALOG_ITEM,
  }, event);
  if (!answers) return;
  await generateItemImage(item, answers).catch(() => { /* already reported */ });
}

/**
 * Generate an image for an item and set it as the item's img, without the
 * dialog. Also the module API (`game.modules.get("raccoon-tweaks").api`), so a
 * macro or a script can give an exact English description in `details` when
 * the name alone would be drawn wrong.
 * @param {Item} item
 * @param {object} [options]
 * @param {string} [options.subject]  defaults to the item name
 * @param {string} [options.details]  what it looks like, as precisely as needed
 * @param {string} [options.style]    defaults to the style setting
 * @param {boolean} [options.dryRun]  return the prompt without calling OpenAI
 * @returns {Promise<string>} the stored image path, or the prompt on a dry run
 */
export async function generateItemImage(item, { subject, details = "", style, dryRun = false } = {}) {
  const campaign = setting(SETTINGS.AI_CAMPAIGN) || DEFAULT_CAMPAIGN;
  const answers = {
    subject: subject?.trim() || item.name,
    details,
    style: style ?? (setting(SETTINGS.AI_STYLE) || DEFAULT_STYLE),
  };
  // A fact about the subject, not a framing: this is an item.
  const prompt = buildPrompt({ ...answers, hint: "an item", campaign });
  if (dryRun) return prompt;

  if (busy) throw new Error("An item image is already being generated.");
  // Checked before the paid request: without it the image is generated and then lost.
  if (!game.user.can("FILES_UPLOAD")) {
    ui.notifications.error(game.i18n.localize("raccoon-tweaks.ai.noUpload"));
    throw new Error("No permission to upload files.");
  }
  if (!setting(SETTINGS.AI_KEY)?.trim()) {
    ui.notifications.error(game.i18n.localize("raccoon-tweaks.ai.noKey"));
    throw new Error("No OpenAI API key set.");
  }
  log("Prompt:", prompt);

  busy = true;
  const notification = ui.notifications.info(
    game.i18n.localize("raccoon-tweaks.ai.generating"),
    { permanent: true },
  );

  try {
    const base64 = await generateImage(prompt);
    const path = await uploadPng(base64, answers.subject, itemDirectory(), { create: true });
    await item.update({ img: path });
    ui.notifications.info(game.i18n.format("raccoon-tweaks.ai.itemDone", { name: item.name }));
    return path;
  } catch (error) {
    warn(error);
    ui.notifications.error(game.i18n.format("raccoon-tweaks.ai.failed", { error: error.message }), { permanent: true });
    throw error;
  } finally {
    dismissNotification(notification);
    busy = false;
  }
}

function itemDirectory() {
  return setting(SETTINGS.AI_ITEM_DIRECTORY)?.trim() || "assets/ai-items";
}
