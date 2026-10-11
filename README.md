# Raccoon Tweaks

Personal Foundry VTT world tweaks. One module instead of a community module per annoyance.

Foundry v13 / v14, system agnostic. Most of it targets **Tokenizer** (`vtta-tokenizer`) and stays dormant if that module is not active; the item sheet AI button (section 5) works without it.

---

## 1. Token stack is seeded from the avatar

### The bug

Tokenizer's `loadImages()` does this:

```js
this._initToken(this.tokenOptions.tokenFilename);   // the PREVIOUSLY SAVED token png
...
await this._addHigherTokenLayers();                 // frame + mask, again
```

`tokenFilename` is the token you saved last time, which already has the frame baked into the
pixels. Tokenizer then adds the frame on top of it. Open the window three times, get three
concentric rings.

### The fix

`Tokenizer.prototype._loadTokenImageToTokenView` is replaced so the token stack is seeded from
`avatarFilename` instead. The avatar is never framed, so the frame, mask and texture land exactly
once, every time.

Wildcard tokens keep the original behaviour, since there is no single avatar to seed from.

Toggle: **Tokenizer: seed the token from the avatar** (world setting, default on).

### How the patch attaches

Tokenizer does not export its Application class, and `renderTokenizer` fires _after_ `_onRender()`
has already started the async image load, so hooking it is a race. `ApplicationV2#render()` is not
overridden by Tokenizer, so it is wrapped once, used to grab the prototype the first time a
Tokenizer instance renders, and then restored. Zero ongoing overhead.

If MrPrimate renames `_loadTokenImageToTokenView` or `_initToken`, the patch logs a warning and
does nothing. It will not break Tokenizer.

---

## 2. AI portrait generation

An **AI** button appears in Tokenizer's Avatar column header, next to `PRESETS` / `MODIFY` /
`PASTE TARGET`. Shown to anyone who owns the actor; each user sets their own OpenAI key, kept in
their browser only. Saving needs Foundry's Upload New Files permission (Trusted Player and up).

It opens a dialog with:

- **Subject**, what to draw. Prefilled from a name source (see below) and editable per generation.
  This is the field that drives the image, and it also names the saved raw upload.
- **Name the subject from the token**, a checkbox that picks the source of the prefilled subject. On
  uses the token name; off (default) uses the character sheet (actor) name. Flipping it immediately
  overwrites the Subject field from the chosen source, and the choice is remembered for next time.
- **Extra details**, free text
- **Style**, prefilled from a world setting and editable per generation, with a tickbox to make the
  edit the new default
- **Transparent background**, a per-user checkbox (remembered per browser). On gives a transparent
  cut-out; off gives a full opaque square with a plain backdrop.
- **Skip this dialog next time**, the same idea as PF2e's roll dialogs: with it on, a click on the
  AI button generates straight away from the defaults (subject from the name, no extra details,
  the default style) and Shift-click opens the dialog; with it off, Shift-click skips it. Separate
  per-user settings for Tokenizer and for item sheets, also in module settings. A right-click on
  the AI button always opens the dialog, whatever the setting and Shift say.
- a gear button that opens a small dialog to set the OpenAI API key, so each user can set their own
  without opening module settings

The prompt is assembled from these ordered parts, joined with blank lines, with any empty part
skipped:

1. **Subject** — `Subject: <text>.`, then an instruction to translate a non-English name and draw
   what it means rather than what it sounds like ("Lupa", a magnifying glass, came out as a wolf from
   *lupus*). Included when the **Include the subject in the prompt** setting is on (the default). The
   item sheet adds `(an item)` after the name; Tokenizer adds nothing, so a mimic stays possible.
2. **Campaign context** — world setting, describes the shared Otari setting so every image belongs
   to the same place, followed by a fixed line that it only sets mood and materials, not scenery or
   people.
3. **Style** — world setting, editable per generation in the dialog. One style for every subject:
   it frames a creature head and shoulders and an object whole, and never assumes a person.
4. **Extra details** — whatever you typed in the dialog.
5. **Background** and **frame constraints** (below).
6. **Subject again** — the subject repeated: draw exactly that, do not turn it into a person, an
   animal or anything it is not. It names no category to draw, because listing "animal, beast" made
   the model pick an animal whenever it was unsure.

The subject opens and closes the prompt because a short subject ("wolf", "coins") in the middle of a
long prompt gets outweighed by the campaign and style text, and the model draws a human instead.

The **background** instruction and the hardcoded **frame constraints** block come after the details. The
background line follows the **Transparent background** setting: on asks for a transparent cut-out, off
asks for a full opaque square with a plain generic backdrop (and the request is sent with
`background: opaque`). The frame constraints are not editable: Tokenizer composites its own frame ring
on top of the image, so any ring the model paints produces a double ring, plus no text, border, or
name plate.

The raw upload is named after the subject, so a monster keeps its descriptive name ("cave bear") and
a PC keeps the character name. For a PC with an invented proper name you can replace the subject with
a description so the model does not guess gender or ethnicity from phonetics or paint the name as
stray lettering; the file is then named from that text.

The image comes back from `POST https://api.openai.com/v1/images/generations` as base64, is decoded
locally into an `Image`, and then:

- added to the **Avatar** stack as a new active layer
- the **Token** stack is cleared and rebuilt around it, base layers -> image at the configured
  offset -> frame / mask / texture

So the generated portrait is framed exactly once and is ready to save.

### Settings

| Setting                           | Scope      | Default                             |
| --------------------------------- | ---------- | ----------------------------------- |
| OpenAI API key                    | **client** | empty                               |
| Image model                       | world      | `gpt-image-1-mini`                  |
| Image size                        | world      | `1024x1024`                         |
| Image quality                     | world      | `medium`                            |
| Campaign context                  | world      | Otari setting preset                |
| Default style prompt              | world      | painterly preset, tokens and items  |
| Include the subject in the prompt | world      | on                                  |
| Save the raw generation           | world      | on                                  |
| Raw generation directory          | world      | empty -> Tokenizer's own upload dir |
| Item image directory              | world      | empty -> `assets/ai-items`          |
| Tokenizer AI: skip the dialog     | **client** | off                                 |
| Item AI: skip the dialog          | **client** | off                                 |

The key is **client scoped on purpose**. Foundry ships world settings to every connected client, so
a world-scoped key would be readable by every player at the table. Client scope keeps it in the GM
browser's localStorage and it never leaves that machine except in the request to OpenAI.

### Notes

- `background: transparent` and `output_format: png` are only sent for `gpt-image-*` models.
  A `dall-e-*` model gets `response_format: b64_json` instead.
- Base64 is requested rather than a URL so the canvas is never tainted by a cross-origin image.
- Tokenizer's own `Utils.download` appends a cache-busting query string, which corrupts a data URL,
  so the module loads the image itself.
- The raw generation is uploaded separately from the composed avatar Tokenizer writes on submit, so
  you keep an unedited source to re-crop later. If the upload fails, generation still succeeds and
  you get a warning.

---

## 3. File picker opens in Tokenizer's upload folder

Tokenizer's **Use a Foundry hosted image** button (the server icon in each column) opens the file
picker at the actor's current image path. For a fresh PF2e actor that is `systems/pf2e/icons/
default-icons`, which is never where you keep portraits.

The click is intercepted for both the Avatar and Token pickers and re-opened at Tokenizer's own
upload directory for that column (`image-upload-directory` / `npc-image-upload-directory`, or the
per-actor override). The chosen image is loaded and added as a new layer exactly as before.

---

## 4. Quick token from the current avatar

An **AVATAR + FRAME** button is added to Tokenizer's **QUICK TOKEN** menu. It runs the initial token
flow on whatever is currently in the Avatar column: the token stack is cleared, the base layers are
added, the avatar image is dropped into the middle layer at the configured offset, and the frame and
mask are applied on top. One click to reframe the token after changing the avatar, instead of
resetting and re-picking.

---

## 5. AI image on item sheets

The same **AI** button sits in the header of every item sheet (PF2e item sheets are ApplicationV1,
so it hooks `getItemSheetHeaderButtons`). Shown to anyone who owns the item, behind the same **AI
image buttons** setting; the upload permission is checked before the paid request.

It opens the same dialog with the same prompt; the subject is prefilled from the item name and the
token/sheet name checkbox is not shown. The image is uploaded to **Item image directory** (default
`assets/ai-items`, created if missing) and set as the item's `img`. The file is named after
the subject with diacritics stripped.

The same generation is callable without the dialog, from a macro or the console:

```js
const item = game.items.getName("Lupa s monogramem M. na rukojeti");
await game.modules.get("raccoon-tweaks").api.generateItemImage(item, {
  details: "A magnifying glass with a round lens in a carved bone rim; the letter M engraved on the handle.",
});
// options: subject (default item name), details, style (default setting), dryRun (returns the prompt)
```

Use `details` for an exact English description when the name alone would be drawn wrong.

---

## 6. No window-size warning

Foundry shows a permanent red banner when the effective window is under 1024 x 768, which OS display
scaling or browser zoom triggers on an ordinary laptop. It comes from the private
`ClientIssues#validateResolution` and has no setting. Core passes the unlocalised key
(`ERROR.RESOLUTION.Screen` / `Scale` / `Window`) to `ui.notifications.error`, so
`Notifications.prototype.notify` is wrapped at init and drops exactly those three messages. Every
other notification passes through untouched.

Toggle: **Hide the window-size warning** (world setting, default on).

---

## 7. The world does not start paused

The server launches every world paused, and core has no setting for it. The module remembers the
pause state the GM last set (`pauseGame` hook, stored in a hidden world setting) and, when the active
GM opens a world that is paused but was last left running, resumes it for everyone. A pause the GM
set on purpose survives a relaunch and a reload.

Toggle: **Don't start the world paused** (world setting, default on).

---

## 8. Compendium imports go into a folder per pack

Dragging a creature from a compendium onto the map imports it into the world, and core puts it in
the Actors root: it keeps the pack's own folder id, which does not exist in the world. Core does
record where it came from (`_stats.compendiumSource`), so the import is filed into a top-level
Actors folder named after the pack, e.g. **Bestiary 1**. An existing folder is set before the actor
is created; a missing one is created first and the actor moved in. Several creatures dropped at once
share one new folder. A drop onto a folder in the Actors sidebar keeps that folder.

Toggle: **Compendium imports go into a folder per pack** (world setting, default on).

---

## 9. Visioner: auto-accept its dialogs

PF2e Visioner opens a preview dialog after seek, hide, sneak, point out, consequences and cover,
and an override-validation dialog on turn change; each wants a click on Apply All. With this on,
that click happens the moment the dialog renders. Hold Shift while it opens to look at it. Per
browser, default off. A toggle sits in the Token scene controls (fast-forward icon) so the GM can
flip it mid-session.

## 10. Dropped means on the ground

PF2e's inventory carry menu has a **Dropped** state (grip-lines icon) that already means "not on
the body": the item's rule elements stop applying, so a dropped light goes dark in hand. This
makes the state physical. Any physical item on a character or NPC that becomes `dropped` moves
into a loot actor (name from **Dropped items: pile name**, default "Na zemi"), one per square,
placed at the owner's feet as a half-size token with the item's image. An item with a
`TokenLight` rule element whose predicate holds (an everlight crystal always, a torch only while
lit) puts that light on the ground token, so the room stays lit. The whole stack goes.

Because the hook watches the carry state and not a button, every path works: the menu, a macro,
and Workbench's **drop held items when unconscious**, so a downed character's torch rolls onto
the floor by itself. Picking up is the normal drag from the loot sheet; the pile hides itself when
empty. Players need at least Limited on the pile, which PF2e sets on create.

## 10a. One in the hand, the rest in the pack

PF2e keeps "4 torches" as one item, so holding it holds all four and dropping it drops all four.
When a stack with quantity > 1 becomes **held**, one is split off as its own held item and the
rest keep their previous state (worn or stowed). When a held single item goes back to worn or
stowed and an identical stack in that state exists, it merges back in. Dropping a held single
then drops just that one. An item arriving in the pack (picked up from a pile, handed over) joins
an identical stack; a torch picked up lit arrives extinguished, because the lit toggle baked into
its rules is what stops PF2e from stacking it. Weapons with runes, invested items, containers and
items identified differently are left alone.

**Torch module.** If the Torch module (`game.Torch`) lit the token, its light is written into the
token document and PF2e's rule toggle knows nothing about it. When the dropped item is the module's
current, lit source, that written light (colour and animation included) goes onto the pile and the
owner is extinguished through the module's API so its state stays consistent. Accounting follows
the module's own model: the GM (who does not consume torches) drops one unit of the stack; a player
already burned one when lighting, so the burning torch is created on the ground and the stack in
the pack is left as it was. Re-lighting after pick-up is the module's HUD button again.

Hooks act only in the browser tab where the change was made (pre-hooks stamp a per-tab id), so
the same user open in two tabs does not run a drop twice. When a pile empties its light is
cleared, since a hidden token still lights the map for the GM.

## 11. Performance meter (GM)

A small panel (toggle in the Token controls, gauge icon, or the **Performance meter** setting):
FPS, frame p50/p95/max, long tasks (>50 ms) per minute, JS heap, long tasks grouped by the hook
that was running when they started, and cumulative time per hook since start. Hook attribution
wraps `Hooks.callAll` / `Hooks.call` at init, so every module's reaction to the game is counted
under the hook that triggered it. ⧉ copies a plain-text report; ⟲ resets. In a background tab
Chrome stops animation frames, so the FPS row says so instead of reading 0.

Per-player animations: Automated Animations already has a **client** setting
(`autoanimations.killAllAnim`, "Automated Animations: on/off" in each player's own settings).
Players on weak machines turn it off themselves; nothing to build here.

---

## Install

Self-hosted, container launched with `--noupdate`, so drop it in by hand:

```bash
cd /path/to/foundry/Data/modules
git clone https://github.com/Mejval5/raccoon-tweaks.git
```

Then restart the world and enable **Raccoon Tweaks** in Manage Modules.

To update: `git pull` in that directory and reload the world.

No build step. Plain ESM, loaded directly by Foundry.

## Layout

```
module.json
scripts/
  main.js             hooks, wiring
  constants.js        ids, setting keys, prompt texts, directory parsing
  settings.js         setting registration
  tokenizer-patch.js  prototype patch, token view rebuild, UI tweaks
  openai.js           images API client, base64 helpers
  ai-portrait.js      Tokenizer button, shared dialog, prompt and upload
  ai-item.js          item sheet header button
  resolution-warning.js  drops the window-size banner
  launch-pause.js     resumes a world the launch paused
  import-folders.js   files compendium imports into a folder per pack
  visioner-autoaccept.js  clicks Apply All on Visioner dialogs
  drop-item.js        Dropped carry state -> loot pile at the owner's feet, with its light
  stack-split.js      held splits one off a stack, worn/stowed merges it back
  perf-meter.js       GM performance panel with hook attribution
styles/raccoon-tweaks.css
lang/en.json
```
