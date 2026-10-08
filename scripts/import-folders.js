import { SETTINGS, log, warn } from "./constants.js";
import { setting } from "./settings.js";

/**
 * Dragging a creature from a compendium onto the canvas imports it into the
 * world root: core keeps the pack's own folder id, which does not exist in the
 * world. Core does record `_stats.compendiumSource`, so the import is filed
 * into a folder named after the pack ("Bestiary 1"). An existing folder is set
 * before creation; a missing one is created afterwards and the actor moved in.
 * A drop onto a folder in the Actors sidebar keeps that folder.
 */
export function registerImportFolders() {
  Hooks.on("preCreateActor", (actor, data, options, userId) => {
    const label = packLabelFor(actor);
    if (!label) return;
    const folder = findFolder(label);
    if (folder) actor.updateSource({ folder: folder.id });
  });

  Hooks.on("createActor", (actor, options, userId) => {
    if (userId !== game.user.id) return;
    const label = packLabelFor(actor);
    if (!label) return;
    ensureFolder(label)
      .then((folder) => actor.update({ folder: folder.id }))
      .then(() => log(`Filed ${actor.name} into ${label}.`))
      .catch((error) => warn("Could not file the compendium import.", error));
  });
}

/** The pack label when the actor came from a compendium and has no world folder yet. */
function packLabelFor(actor) {
  if (!setting(SETTINGS.IMPORT_FOLDERS)) return null;
  if (actor.pack) return null;
  if (actor.folder && game.folders.get(actor.folder.id ?? actor.folder)) return null;
  const source = actor._stats?.compendiumSource;
  if (!source?.startsWith("Compendium.")) return null;
  try {
    return foundry.utils.parseUuid(source)?.collection?.metadata?.label ?? null;
  } catch {
    return null;
  }
}

function findFolder(name) {
  return game.folders.find((f) => f.type === "Actor" && !f.folder && f.name === name) ?? null;
}

// One creation per name even when several creatures are dropped at once.
const pending = new Map();

function ensureFolder(name) {
  const existing = findFolder(name);
  if (existing) return Promise.resolve(existing);
  if (!pending.has(name)) {
    const created = Folder.implementation.create({ name, type: "Actor" })
      .finally(() => pending.delete(name));
    pending.set(name, created);
  }
  return pending.get(name);
}
