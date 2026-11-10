import { MODULE_ID, SETTINGS, log, warn } from "./constants.js";
import { setting } from "./settings.js";

/**
 * Merchants that pay, and merchants that like some customers more.
 *
 * PF2e's merchant (a loot actor in Merchant mode) sells at the listed price and
 * takes whatever a player drops on it for nothing. pf2e-toolbelt's Better
 * Merchant would add buying back, but it was never switched on in this world
 * and has no notion of who the customer is. This does the three things the
 * table asked for (Dan, 2026-11-10), in the one place every such trade passes
 * through, `transferItemToActor` as it runs in a GM's tab:
 *
 * - A player's character gives an item to a merchant -> the character is paid
 *   half its price (the merchant's buy-back rate, 50 % unless set otherwise;
 *   treasure such as gems and art goes at full value, as in the rules).
 * - A character takes an item from a merchant -> pays the full price, minus
 *   that character's discount at that merchant, if the GM gave one.
 * - A merchant marked as having endless stock keeps its quantity.
 *
 * A player's own client never changes anything here: the system relays their
 * drag to a GM tab, and that is where this runs. Stands down while toolbelt's
 * Better Merchant is enabled, so the two never both charge.
 *
 * Per merchant, in `flags.raccoon-tweaks.shop`:
 *   discounts  { <actorId>: percent }    e.g. { "jCx...": 20 }
 *   buyback    percent, default 50
 *   infinite   boolean; `flags.pf2e-toolbelt.infiniteAll` is honoured too
 */
const DEFAULT_BUYBACK = 50;

const isMerchant = (actor) => Boolean(actor?.isOfType?.("loot") && actor.isMerchant);
const isCustomer = (actor) => Boolean(actor?.isOfType?.("character", "npc"));
const shopFlags = (merchant) => merchant?.getFlag?.(MODULE_ID, "shop") ?? {};
const toolbeltMerchantOn = () => { try { return Boolean(game.settings.get("pf2e-toolbelt", "betterMerchant.enabled")); } catch { return false; } };
const clampPercent = (value, fallback = 0) => { const n = Number(value); return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback; };

export const discountFor = (merchant, customer) => clampPercent(shopFlags(merchant).discounts?.[customer?.id]);
export const buybackOf = (merchant) => clampPercent(shopFlags(merchant).buyback ?? DEFAULT_BUYBACK, DEFAULT_BUYBACK);
export const isInfinite = (merchant) => Boolean(shopFlags(merchant).infinite ?? merchant?.flags?.["pf2e-toolbelt"]?.betterMerchant?.infiniteAll ?? merchant?.flags?.["pf2e-toolbelt"]?.infiniteAll);

/**
 * Called from the module's `transferItemToActor` wrapper (drop-item.js) with
 * the original as `wrapped`. Anything that is not a trade with a merchant in a
 * GM's tab goes straight through.
 */
export async function shopTransfer(source, wrapped, target, item, quantity, containerId, newStack = false, isPurchase = null) {
  const pass = () => wrapped(target, item, quantity, containerId, newStack, isPurchase);
  try {
    if (!game.user.isGM || !setting(SETTINGS.SHOP) || toolbeltMerchantOn()) return pass();
    if (!item?.isOfType?.("physical")) return pass();
    if (isMerchant(source) && isCustomer(target) && (isPurchase ?? true)) return await buy(source, wrapped, target, item, quantity, containerId, newStack);
    if (isCustomer(source) && isMerchant(target) && source.hasPlayerOwner) return await sell(source, wrapped, target, item, quantity, containerId, newStack);
  } catch (error) {
    warn("Shop pricing failed, the transfer runs the system's way.", error);
  }
  return pass();
}

async function buy(merchant, wrapped, customer, item, quantity, containerId, newStack) {
  const Coins = game.pf2e.Coins;
  const endless = isInfinite(merchant);
  const qty = Math.max(1, endless ? Number(quantity) || 1 : Math.min(Number(quantity) || 1, item.quantity));
  const name = item.name;
  const full = Coins.fromPrice(item.price, qty);
  const discount = discountFor(merchant, customer);
  const cost = discount ? full.scale((100 - discount) / 100) : full;

  if (cost.copperValue > 0 && !(await customer.inventory.removeCoins(cost))) {
    const text = game.i18n.format("raccoon-tweaks.shop.cannotAfford", { customer: customer.name, quantity: qty, item: name, cost: cost.toString() });
    ui.notifications.warn(text);
    await say(merchant, text);
    return null;
  }
  if (cost.copperValue > 0) await merchant.inventory.addCoins(cost);
  // Endless stock: put back what is about to leave, so the shelf never empties.
  if (endless) await item.update({ "system.quantity": item.quantity + qty });
  const moved = await wrapped(customer, item, qty, containerId, newStack, false);
  if (!moved) {                                                   // the move itself failed: nobody pays for nothing
    if (cost.copperValue > 0) { await merchant.inventory.removeCoins(cost); await customer.inventory.addCoins(cost); }
    return moved;
  }
  log(`${customer.name} buys ${qty}x ${name} from ${merchant.name} for ${cost.toString()}${discount ? ` (${discount}% off ${full.toString()})` : ""}.`);
  await say(merchant, game.i18n.format(discount ? "raccoon-tweaks.shop.boughtDiscount" : "raccoon-tweaks.shop.bought", {
    customer: customer.name, quantity: qty, item: name, cost: cost.toString(), full: full.toString(), discount,
  }));
  return moved;
}

async function sell(customer, wrapped, merchant, item, quantity, containerId, newStack) {
  const Coins = game.pf2e.Coins;
  const qty = Math.max(1, Math.min(Number(quantity) || 1, item.quantity));
  const name = item.name;
  // Coins handed over the counter are not a sale.
  if (item.system?.stackGroup === "coins" || item.isCoinage) return wrapped(merchant, item, qty, containerId, newStack, false);
  const full = Coins.fromPrice(item.price, qty);
  const rate = item.isOfType("treasure") ? 100 : buybackOf(merchant);
  const payout = full.scale(rate / 100);
  const moved = await wrapped(merchant, item, qty, containerId, newStack, false);
  if (!moved) return moved;
  if (payout.copperValue > 0) await customer.inventory.addCoins(payout);
  log(`${customer.name} sells ${qty}x ${name} to ${merchant.name} for ${payout.toString()} (${rate}%).`);
  await say(merchant, game.i18n.format(payout.copperValue > 0 ? "raccoon-tweaks.shop.sold" : "raccoon-tweaks.shop.soldWorthless", {
    customer: customer.name, quantity: qty, item: name, payout: payout.toString(), rate,
  }));
  return moved;
}

const say = (merchant, content) => ChatMessage.create({ speaker: { alias: merchant.name }, content: `<p>${content}</p>` })
  .catch((e) => warn("Could not post the shop line.", e));

/* ------------------------------------------------------------------ */
/* The merchant sheet: what this customer pays, and the GM's settings   */
/* ------------------------------------------------------------------ */

export function registerShop() {
  Hooks.on("renderLootSheetPF2e", (app, html) => {
    try {
      const merchant = app.actor;
      if (!setting(SETTINGS.SHOP) || toolbeltMerchantOn() || !isMerchant(merchant)) return;
      const root = html instanceof HTMLElement ? html : html?.[0];
      if (!root || root.querySelector(".raccoon-shop-note")) return;
      const note = document.createElement("div");
      note.className = "raccoon-shop-note";
      const t = (key, data) => game.i18n.format(`raccoon-tweaks.shop.${key}`, data);
      if (game.user.isGM) {
        const listed = Object.entries(shopFlags(merchant).discounts ?? {}).filter(([, p]) => clampPercent(p) > 0)
          .map(([id, p]) => `${game.actors.get(id)?.name ?? id} ${clampPercent(p)}%`);
        note.textContent = t("gmNote", { buyback: buybackOf(merchant), discounts: listed.length ? listed.join(", ") : t("none"), stock: t(isInfinite(merchant) ? "endless" : "limited") }) + " ";
        const button = document.createElement("a");
        button.textContent = t("edit");
        button.addEventListener("click", () => editShop(merchant).catch((e) => warn("Shop dialog failed.", e)));
        note.append(button);
      } else {
        const me = game.user.character;
        const discount = me ? discountFor(merchant, me) : 0;
        note.textContent = discount ? t("playerNoteDiscount", { discount, buyback: buybackOf(merchant) }) : t("playerNote", { buyback: buybackOf(merchant) });
      }
      (root.querySelector(".sheet-body") ?? root.querySelector(".window-content") ?? root).prepend(note);
    } catch (error) {
      warn("Shop note failed.", error);
    }
  });

  Hooks.once("ready", () => {
    const api = game.modules.get(MODULE_ID).api ?? (game.modules.get(MODULE_ID).api = {});
    const find = (ref, type) => game.actors.get(ref) ?? game.actors.find((a) => (!type || a.type === type) && a.name.toLowerCase().includes(String(ref).toLowerCase()));
    api.shop = {
      /** `setDiscount("Keeleno", "Arnold", 20)`; 0 removes it. */
      setDiscount: async (merchantRef, customerRef, percent) => {
        const merchant = find(merchantRef, "loot"), customer = find(customerRef);
        if (!isMerchant(merchant) || !customer) throw new Error("merchant or customer not found");
        const p = clampPercent(percent);
        await merchant.update({ [`flags.${MODULE_ID}.shop.discounts.${customer.id}`]: p });
        return `${customer.name}: ${p}% at ${merchant.name}`;
      },
      state: (merchantRef) => { const m = find(merchantRef, "loot"); return m ? { merchant: m.name, buyback: buybackOf(m), infinite: isInfinite(m), discounts: Object.fromEntries(Object.entries(shopFlags(m).discounts ?? {}).map(([id, p]) => [game.actors.get(id)?.name ?? id, p])) } : null; },
    };
  });
}

/** GM dialog: one discount per player character, the buy-back rate, endless stock. */
async function editShop(merchant) {
  const t = (key, data) => game.i18n.format(`raccoon-tweaks.shop.${key}`, data);
  const flags = shopFlags(merchant);
  const customers = game.actors.filter((a) => a.type === "character" && a.hasPlayerOwner).sort((a, b) => a.name.localeCompare(b.name));
  const rows = customers.map((a) => `<div class="form-group"><label>${foundry.utils.escapeHTML(a.name)}</label><div class="form-fields"><input type="number" name="d-${a.id}" min="0" max="100" step="5" value="${clampPercent(flags.discounts?.[a.id])}"> %</div></div>`).join("");
  const content = `<p>${t("dialogIntro")}</p>${rows}<hr>
    <div class="form-group"><label>${t("buybackLabel")}</label><div class="form-fields"><input type="number" name="buyback" min="0" max="100" step="5" value="${buybackOf(merchant)}"> %</div></div>
    <div class="form-group"><label>${t("infiniteLabel")}</label><div class="form-fields"><input type="checkbox" name="infinite" ${isInfinite(merchant) ? "checked" : ""}></div></div>`;
  const data = await foundry.applications.api.DialogV2.wait({
    window: { title: t("dialogTitle", { merchant: merchant.name }), icon: "fa-solid fa-coins" },
    content,
    buttons: [{ action: "save", label: t("save"), icon: "fa-solid fa-check", default: true, callback: (event, button) => new foundry.applications.ux.FormDataExtended(button.form).object }],
    rejectClose: false,
    position: { width: 420 },
  });
  if (!data) return;
  const discounts = {};
  for (const a of customers) discounts[a.id] = clampPercent(data[`d-${a.id}`]);
  await merchant.update({ [`flags.${MODULE_ID}.shop`]: { discounts, buyback: clampPercent(data.buyback, DEFAULT_BUYBACK), infinite: Boolean(data.infinite) } });
  merchant.sheet?.render(false);
}
