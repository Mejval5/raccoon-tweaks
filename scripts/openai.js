import { SETTINGS, log } from "./constants.js";
import { setting } from "./settings.js";

const ENDPOINT = "https://api.openai.com/v1/images/generations";

/**
 * @param {string} prompt
 * @param {object} [overrides]
 * @returns {Promise<string>} base64 PNG payload, no data-url prefix
 */
export async function generateImage(prompt, overrides = {}) {
  const apiKey = setting(SETTINGS.AI_KEY)?.trim();
  if (!apiKey) throw new Error(game.i18n.localize("raccoon-tweaks.ai.noKey"));

  const model = overrides.model ?? setting(SETTINGS.AI_MODEL)?.trim() ?? "gpt-image-1-mini";
  const size = overrides.size ?? setting(SETTINGS.AI_SIZE);
  const quality = overrides.quality ?? setting(SETTINGS.AI_QUALITY);
  const transparent = overrides.transparent ?? setting(SETTINGS.AI_TRANSPARENT);

  const body = { model, prompt, n: 1, size };

  const isGptImage = model.startsWith("gpt-image");
  if (isGptImage) {
    // output_format / background are GPT-image only; response_format is DALL-E only.
    body.output_format = "png";
    body.background = transparent ? "transparent" : "opaque";
    if (quality && quality !== "auto") body.quality = quality;
  } else {
    body.response_format = "b64_json";
  }

  log("Requesting image", { model, size, quality, transparent });

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`Could not reach the OpenAI API: ${error.message}`);
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      detail = payload?.error?.message ?? detail;
    } catch {
      /* body was not json */
    }
    throw new Error(`OpenAI rejected the request: ${detail}`);
  }

  const payload = await response.json();
  const entry = payload?.data?.[0];
  if (!entry) throw new Error("OpenAI returned no image data.");

  if (entry.b64_json) return entry.b64_json;

  // Some models can still hand back a URL. Fetch it and re-encode locally so the
  // canvas never gets tainted by a cross-origin image.
  if (entry.url) {
    const imageResponse = await fetch(entry.url);
    if (!imageResponse.ok) throw new Error("Could not download the generated image.");
    const buffer = await imageResponse.arrayBuffer();
    return arrayBufferToBase64(buffer);
  }

  throw new Error("OpenAI returned an unrecognised image payload.");
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBlob(base64, mimeType = "image/png") {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

/**
 * Tokenizer's own Utils.download appends a cache-busting query string, which
 * corrupts a data url. So we load it ourselves.
 */
export function loadImageElement(source) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "";
    img.onload = () => resolve(img);
    img.onerror = (event) => reject(new Error(`Could not decode the generated image: ${event?.type ?? "error"}`));
    img.src = source;
  });
}
