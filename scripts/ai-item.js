import { SETTINGS, DEFAULT_CAMPAIGN, DEFAULT_STYLE, warn, log } from "./constants.js";
import { setting } from "./settings.js";
import { generateImage } from "./openai.js";
import { buildPrompt, promptForDetails, uploadPng, dismissNotification } from "./ai-portrait.js";

/**
 * An "AI" header button on item sheets. Same dialog and the same prompt as the
 * Tokenizer portrait; the result is uploaded and set as the item's image.
 * PF2e item sheets are still ApplicationV1, so the V1 header hook is the one.
 */
export function registerAiItemImage() {
  Hooks.on("getItemSheetHeaderButtons", (sheet, buttons) => {
    if (!game.user.isGM || !setting(SETTINGS.AI_ENABLED)) return;
    const item = sheet.document ?? sheet.item;
    if (!item?.isOwner) return;

    buttons.unshift({
      label: game.i18n.localize("raccoon-tweaks.ai.button"),
      class: "raccoon-ai-item",
      icon: "fas fa-wand-magic-sparkles",
      onclick: () => onGenerateClick(item).catch((error) => warn("Item image failed.", error)),
    });
  });
}

let busy = false;

async function onGenerateClick(item) {
  if (busy) return;

  const answers = await promptForDetails({
    subject: item.name,
    style: setting(SETTINGS.AI_STYLE) || DEFAULT_STYLE,
  });
  if (!answers) return;

  if (!setting(SETTINGS.AI_KEY)?.trim()) {
    ui.notifications.error(game.i18n.localize("raccoon-tweaks.ai.noKey"));
    return;
  }

  const campaign = setting(SETTINGS.AI_CAMPAIGN) || DEFAULT_CAMPAIGN;
  const prompt = buildPrompt({ ...answers, campaign });
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
  } catch (error) {
    warn(error);
    ui.notifications.error(game.i18n.format("raccoon-tweaks.ai.failed", { error: error.message }), { permanent: true });
  } finally {
    dismissNotification(notification);
    busy = false;
  }
}

function itemDirectory() {
  return setting(SETTINGS.AI_ITEM_DIRECTORY)?.trim() || `worlds/${game.world.id}/ai-items`;
}
