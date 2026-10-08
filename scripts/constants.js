export const MODULE_ID = "raccoon-tweaks";
export const TOKENIZER_ID = "vtta-tokenizer";

// Bundled textured backdrop that replaces Tokenizer's plain white base colour layer.
export const TOKEN_BACKGROUND_IMAGE = `modules/${MODULE_ID}/assets/token-background.jpg`;

export const SETTINGS = {
  SEED_FROM_AVATAR: "tokenizer-seed-from-avatar",
  AI_ENABLED: "ai-enabled",
  AI_KEY: "openai-api-key",
  AI_MODEL: "openai-model",
  AI_SIZE: "openai-size",
  AI_QUALITY: "openai-quality",
  AI_CAMPAIGN: "ai-campaign-context",
  AI_STYLE: "ai-style-prompt",
  AI_INCLUDE_NAME: "ai-include-name",
  AI_SUBJECT_FROM_TOKEN: "ai-subject-from-token",
  AI_TRANSPARENT: "ai-transparent",
  AI_SAVE_SOURCE: "ai-save-source",
  AI_SAVE_DIRECTORY: "ai-save-directory",
  AI_ITEM_DIRECTORY: "ai-item-directory",
  AI_SKIP_DIALOG_TOKEN: "ai-skip-dialog-token",
  AI_SKIP_DIALOG_ITEM: "ai-skip-dialog-item",
  HIDE_RESOLUTION_WARNING: "hide-resolution-warning",
  RESUME_ON_LAUNCH: "resume-on-launch",
  LAST_PAUSED: "last-paused",
  IMPORT_FOLDERS: "import-folders",
};

// Single-line on purpose: these are stored as `type: String` settings, which
// Foundry renders as a single-line input that strips newlines on save.
// No palette words here ("timber", "weathered wood", "wet cliffs"): the model
// took them as the colour scheme and every image came out brown.
export const DEFAULT_CAMPAIGN = [
  "Pathfinder RPG setting, around Otari, a small fishing port town on a rugged coast.",
  "A grounded fantasy world, yet vivid, colourful and full of life.",
].join(" ");

// One style for every subject: a creature on a token, an item, or a mimic that is
// both. Nothing in here may assume the subject is a person.
export const DEFAULT_STYLE = [
  "Painterly digital fantasy illustration with visible brushwork, rich and vivid yet naturalistic, like a high-quality character/item painting rather than a photo, clean vector art, or anime.",
  "Three-quarter view, centred, filling the frame with a small even margin on all sides: a creature shown head and shoulders facing the viewer, an object shown whole.",
  "Soft directional light from the upper left with a cool, neutral fill from the lower right and a clean neutral white balance, giving clear depth and form.",
  "Colour is saturated and characterful but believable, with real hue variety: every material in its own true colour, cool and warm accents side by side, no overall colour cast or tint, and no neon, candy colours, or glow effects.",
  "Detailed, grounded and realistic in anatomy, material and texture, not cartoonish, glamorous, or airbrushed.",
  "Render the subject as exactly what it is.",
].join(" ");

// The campaign text talks about a port full of people, which pulls the model
// towards drawing a person. It also must not lend its colours: "informs
// materials" turned brass, stone and steel into the setting's wood tones.
export const PROMPT_SETTING_SCOPE =
  "The setting only sets the mood; the subject's colours and materials come from the subject itself, not from the setting. Do not depict the setting, scenery or any of its people.";

// Said at the start and again at the end: in the middle of a long prompt a
// short subject ("wolf", "coins") gets outweighed and the model draws a human.
// Names are often Czech, and the model draws what a foreign word sounds like:
// "Lupa" (magnifying glass) came out as a wolf, from lupus. So it translates first.
// `hint` is what the caller knows about the subject ("an item"), never a framing.
export const promptSubjectLead = (subject, hint) => [
  `Subject: ${subject}${hint ? ` (${hint})` : ""}.`,
  "If the name is not in English, translate it first and draw what it means, not what it sounds like.",
  `The image shows exactly that, as named.`,
].join(" ");

// Names no category on purpose: listing "animal, beast" here made the model
// reach for an animal whenever it was unsure what the subject was.
export const promptSubjectClose = (subject, hint) => [
  `Again, the subject is ${subject}${hint ? ` (${hint})` : ""}. Draw exactly that, true to what it is, and nothing else.`,
  "Do not turn it into a person, an animal or anything it is not, and add no figure, hands or creature that the subject does not include.",
].join(" ");

export const PROMPT_BACKGROUND_TRANSPARENT = [
  "Background must be fully empty and transparent, with the subject cleanly cut out.",
  "No environment, no scenery, no gradient, no vignette, no shadow cast onto a backdrop.",
].join(" ");

export const PROMPT_BACKGROUND_FILLED = [
  "Fill the entire square frame edge to edge, fully opaque, with no transparency and no cut-out.",
  "Place the subject against a simple, plain, softly out-of-focus background: a single neutral or cool muted colour or gentle gradient that contrasts with the subject, with no detailed scenery, objects, or props.",
].join(" ");

export const PROMPT_CONSTRAINTS = [
  "Absolutely no circular frame, no ring, no border, no medallion edge, no portrait cartouche.",
  "No text, no lettering, no signature, no watermark, no UI elements, no name plate.",
].join(" ");

export function log(...args) {
  console.log(`${MODULE_ID} |`, ...args);
}

export function warn(...args) {
  console.warn(`${MODULE_ID} |`, ...args);
}

/** Mirrors Tokenizer's DirectoryPicker.parse, which is not exported. */
export function parseDirectory(inStr) {
  const str = inStr ?? "";
  const matches = str.match(/\[(.+)\]\s*(.+)?/u);
  if (!matches) return { activeSource: "data", bucket: null, current: str.trim() };

  const [, source, current = ""] = matches;
  const [scheme, bucket] = source.split(":");
  return {
    activeSource: scheme,
    bucket: bucket ?? null,
    current: current.trim(),
  };
}
