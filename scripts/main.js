import { MODULE_ID, TOKENIZER_ID, VISITOR, log, warn } from "./constants.js";
import { registerSettings } from "./settings.js";
import { installTokenizerPatch, registerTokenizerTweaks } from "./tokenizer-patch.js";
import { registerAiPortrait } from "./ai-portrait.js";
import { registerAiItemImage, generateItemImage } from "./ai-item.js";
import { installResolutionWarningFilter } from "./resolution-warning.js";
import { registerLaunchPause } from "./launch-pause.js";
import { registerImportFolders } from "./import-folders.js";
import { registerVisionerAutoAccept } from "./visioner-autoaccept.js";
import { registerDropItem } from "./drop-item.js";
import { registerStackSplit } from "./stack-split.js";
import { installPerfMeter } from "./perf-meter.js";
import { installBootTimeline } from "./boot-timeline.js";
import { registerAutoApply } from "./auto-apply.js";
import { registerTransfer } from "./transfer.js";
import { applyToolbeltDefaults } from "./toolbelt-defaults.js";
import { registerChronoskimmer } from "./chronoskimmer.js";
import { registerWorldClock } from "./world-clock.js";
import { registerShop } from "./shop.js";
import { registerLiking } from "./liking.js";
import { registerPersona } from "./persona.js";
import { registerSortRepair } from "./sort-repair.js";
import { registerFirearms } from "./firearms.js";
import { registerCarry } from "./carry.js";

// First thing, before any hook: the timeline measures everything after this line.
installBootTimeline();

Hooks.once("init", () => {
  registerSettings();
  installResolutionWarningFilter();
  registerLaunchPause();
  registerImportFolders();
  registerVisionerAutoAccept();
  registerDropItem();
  registerStackSplit();
  registerAutoApply();
  registerTransfer();
  applyToolbeltDefaults();
  registerChronoskimmer();
  registerWorldClock();
  registerShop();
  registerLiking();
  registerPersona();
  registerSortRepair();
  registerFirearms();
  registerCarry();
  installPerfMeter();
  installTokenizerPatch();
  registerTokenizerTweaks();
  registerAiPortrait();
  registerAiItemImage();
  log("Initialised.");
});

Hooks.once("ready", () => {
  if (!game.modules.get(TOKENIZER_ID)?.active) {
    warn("Tokenizer is not active, the Tokenizer tweaks will stay dormant.");
  }
  if (VISITOR) {
    // The system registered its listener in its own ready hook, which ran before this one.
    game.socket.off("system.pf2e");
    log("Visitor tab: this tab will not carry out players' requests.");
    ui.notifications.info(game.i18n.localize(`${MODULE_ID}.visitor.notice`));
  }
  game.modules.get(MODULE_ID).api = {
    ...(game.modules.get(MODULE_ID).api ?? {}),
    version: game.modules.get(MODULE_ID).version,
    visitor: VISITOR,
    generateItemImage,
  };
});
