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
};

// Single-line on purpose: these are stored as `type: String` settings, which
// Foundry renders as a single-line input that strips newlines on save.
export const DEFAULT_CAMPAIGN = [
  "Pathfinder RPG setting. Set in Otari, a small timber and fishing port on a rugged, rain-washed coast of wet cliffs, boats and weathered wood.",
  "A grounded, fantasy world, yet still vivid and full of life rather than grey or lifeless.",
].join(" ");

export const DEFAULT_STYLE = [
  "Painterly digital fantasy illustration with visible brushwork, rich and vivid yet naturalistic, like a high-quality character painting rather than a photo, clean vector art, or anime.",
  "Head-and-shoulders portrait, three-quarter view, centred and facing the viewer, filling the frame with a small even margin on all sides.",
  "Soft directional light from the upper left with a gentle warm bounce from the lower right, giving clear depth and form.",
  "Colour is saturated and characterful but believable, with real hue variety and both cool and warm accents; never washed out, monochrome, or muddy brown, and no neon, candy colours, or glow effects.",
  "Detailed, grounded and realistic in anatomy and texture, not cartoonish, glamorous, or airbrushed.",
  "Render the subject as exactly what it is: if it is an animal or beast, show its true natural body with fur, hide or scales and no clothing, armour, jewellery or props unless the details explicitly ask for them.",
].join(" ");

export const PROMPT_BACKGROUND_TRANSPARENT = [
  "Background must be fully empty and transparent, with the subject cleanly cut out.",
  "No environment, no scenery, no gradient, no vignette, no shadow cast onto a backdrop.",
].join(" ");

export const PROMPT_BACKGROUND_FILLED = [
  "Fill the entire square frame edge to edge, fully opaque, with no transparency and no cut-out.",
  "Place the subject against a simple, plain, softly out-of-focus background: a single muted colour or gentle gradient that suits the setting, with no detailed scenery, objects, or props.",
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
