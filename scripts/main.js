import { MODULE_ID, TOKENIZER_ID, log, warn } from "./constants.js";
import { registerSettings } from "./settings.js";
import { installTokenizerPatch, registerTokenizerTweaks } from "./tokenizer-patch.js";
import { registerAiPortrait } from "./ai-portrait.js";

Hooks.once("init", () => {
  registerSettings();
  installTokenizerPatch();
  registerTokenizerTweaks();
  registerAiPortrait();
  log("Initialised.");
});

Hooks.once("ready", () => {
  if (!game.modules.get(TOKENIZER_ID)?.active) {
    warn("Tokenizer is not active, the Tokenizer tweaks will stay dormant.");
  }
  game.modules.get(MODULE_ID).api = {
    version: game.modules.get(MODULE_ID).version,
  };
});
