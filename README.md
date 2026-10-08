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
`PASTE TARGET`. GM only.

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
- a gear button that opens a small dialog to set the OpenAI API key, so each user can set their own
  without opening module settings

The prompt is assembled from these ordered parts, joined with blank lines, with any empty part
skipped:

1. **Subject** — `Subject: <text>. The image shows <text>, exactly as named.`, included when the
   **Include the subject in the prompt** setting is on (the default).
2. **Campaign context** — world setting, describes the shared Otari setting so every image belongs
   to the same place, followed by a fixed line that it only sets mood and materials, not scenery or
   people.
3. **Style** — world setting, editable per generation in the dialog. One style for every subject:
   it frames a creature head and shoulders and an object whole, and never assumes a person.
4. **Extra details** — whatever you typed in the dialog.
5. **Background** and **frame constraints** (below).
6. **Subject again** — the subject repeated, with: an animal, beast or monster keeps its true body
   and is never a human version; an object stands alone with no person or hands; a person only if
   the subject is one.

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
| Item image directory              | world      | empty -> `worlds/<world>/ai-items`  |

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
so it hooks `getItemSheetHeaderButtons`). GM only, behind the same **AI image buttons** setting.

It opens the same dialog with the same prompt; the subject is prefilled from the item name and the
token/sheet name checkbox is not shown. The image is uploaded to **Item image directory** (default
`worlds/<world>/ai-items`, created if missing) and set as the item's `img`. The file is named after
the subject with diacritics stripped.

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
styles/raccoon-tweaks.css
lang/en.json
```
