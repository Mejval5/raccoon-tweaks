import { MODULE_ID, SETTINGS, DEFAULT_CAMPAIGN, DEFAULT_STYLE } from "./constants.js";

export function registerSettings() {
  const t = (key) => `${MODULE_ID}.settings.${key}`;

  game.settings.register(MODULE_ID, SETTINGS.SEED_FROM_AVATAR, {
    name: t("seedFromAvatar.name"),
    hint: t("seedFromAvatar.hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, SETTINGS.HIDE_RESOLUTION_WARNING, {
    name: t("hideResolutionWarning.name"),
    hint: t("hideResolutionWarning.hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, SETTINGS.RESUME_ON_LAUNCH, {
    name: t("resumeOnLaunch.name"),
    hint: t("resumeOnLaunch.hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, SETTINGS.IMPORT_FOLDERS, {
    name: t("importFolders.name"),
    hint: t("importFolders.hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // Written by the pauseGame hook, not shown in the settings sheet.
  game.settings.register(MODULE_ID, SETTINGS.LAST_PAUSED, {
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, SETTINGS.AI_ENABLED, {
    name: t("aiEnabled.name"),
    hint: t("aiEnabled.hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // Client scope: the key lives in this browser's localStorage only and is never
  // synced to other connected users. World scope would ship it to every player.
  game.settings.register(MODULE_ID, SETTINGS.AI_KEY, {
    name: t("aiKey.name"),
    hint: t("aiKey.hint"),
    scope: "client",
    config: true,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, SETTINGS.AI_MODEL, {
    name: t("aiModel.name"),
    hint: t("aiModel.hint"),
    scope: "world",
    config: true,
    type: String,
    default: "gpt-image-1-mini",
  });

  game.settings.register(MODULE_ID, SETTINGS.AI_SIZE, {
    name: t("aiSize.name"),
    hint: t("aiSize.hint"),
    scope: "world",
    config: true,
    type: String,
    default: "1024x1024",
    choices: {
      "1024x1024": "1024 x 1024 (square)",
      "1024x1536": "1024 x 1536 (portrait)",
      "1536x1024": "1536 x 1024 (landscape)",
      auto: "auto",
    },
  });

  game.settings.register(MODULE_ID, SETTINGS.AI_QUALITY, {
    name: t("aiQuality.name"),
    hint: t("aiQuality.hint"),
    scope: "world",
    config: true,
    type: String,
    default: "medium",
    choices: {
      low: "low (cheapest)",
      medium: "medium",
      high: "high",
      auto: "auto",
    },
  });

  game.settings.register(MODULE_ID, SETTINGS.AI_CAMPAIGN, {
    name: t("aiCampaign.name"),
    hint: t("aiCampaign.hint"),
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_CAMPAIGN,
  });

  game.settings.register(MODULE_ID, SETTINGS.AI_STYLE, {
    name: t("aiStyle.name"),
    hint: t("aiStyle.hint"),
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_STYLE,
  });

  game.settings.register(MODULE_ID, SETTINGS.AI_INCLUDE_NAME, {
    name: t("aiIncludeName.name"),
    hint: t("aiIncludeName.hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  // Controlled from the generate dialog's checkbox, not the settings sheet.
  game.settings.register(MODULE_ID, SETTINGS.AI_SUBJECT_FROM_TOKEN, {
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
  });

  // Per-user, controlled from the generate dialog's checkbox.
  game.settings.register(MODULE_ID, SETTINGS.AI_TRANSPARENT, {
    scope: "client",
    config: false,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, SETTINGS.AI_SAVE_SOURCE, {
    name: t("aiSaveSource.name"),
    hint: t("aiSaveSource.hint"),
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, SETTINGS.AI_SAVE_DIRECTORY, {
    name: t("aiSaveDirectory.name"),
    hint: t("aiSaveDirectory.hint"),
    scope: "world",
    config: true,
    type: String,
    default: "",
  });

  // Per user, like PF2e's roll dialogs. Also flipped from the dialog's own checkbox.
  for (const [key, label] of [[SETTINGS.AI_SKIP_DIALOG_TOKEN, "aiSkipDialogToken"], [SETTINGS.AI_SKIP_DIALOG_ITEM, "aiSkipDialogItem"]]) {
    game.settings.register(MODULE_ID, key, {
      name: t(`${label}.name`),
      hint: t(`${label}.hint`),
      scope: "client",
      config: true,
      type: Boolean,
      default: false,
    });
  }

  game.settings.register(MODULE_ID, SETTINGS.AI_ITEM_DIRECTORY, {
    name: t("aiItemDirectory.name"),
    hint: t("aiItemDirectory.hint"),
    scope: "world",
    config: true,
    type: String,
    default: "",
  });
}

export function setting(key) {
  return game.settings.get(MODULE_ID, key);
}
