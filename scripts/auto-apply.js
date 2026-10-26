import { MODULE_ID, SETTINGS, TAB_ID, log, warn } from "./constants.js";
import { setting } from "./settings.js";

/**
 * Two chat cards the table had to click or drag every time, done by the module
 * in the active GM's tab as the message arrives:
 *
 * 1. A Treat Wounds check puts "Effect: Treat Wounds Immunity" on the patient.
 * 2. A damage roll aimed at one target (a Strike, an attack spell, a blast) is
 *    applied to that target through PF2e's own `applyDamage`, so weaknesses,
 *    resistances, immunities, hardness and the "X takes N damage" card come out
 *    as if the GM had clicked the button.
 *
 * Everything runs off `createChatMessage`, which fires in every tab; the guard
 * is "this tab is the active GM" plus a claim flag on the message. The claim
 * is settled before acting: two tabs of the same GM user both pass the
 * active-GM test, both write the flag, and after a short wait only the one
 * whose write landed last acts. The other logs and stands down.
 */
export function registerAutoApply() {
  Hooks.on("createChatMessage", (message, options, userId) => {
    try {
      if (!game.users?.activeGM || game.user !== game.users.activeGM) return;
      const context = message.flags?.pf2e?.context;
      if (!context) return;

      if (context.type === "damage-roll") {
        if (!setting(SETTINGS.AUTO_APPLY_DAMAGE)) return;
        applyDamageToTarget(message, context).catch((error) => {
          warn("Auto-apply damage failed, the card is left for a manual click.", error);
          ui.notifications.warn(game.i18n.format("raccoon-tweaks.autoApply.damageFailed", { error: error.message }));
        });
      } else if (context.type === "skill-check" && context.options?.includes("action:treat-wounds")) {
        if (!setting(SETTINGS.AUTO_TREAT_WOUNDS)) return;
        applyTreatWoundsImmunity(message, userId).catch((error) => {
          warn("Treat Wounds immunity not applied.", error);
          ui.notifications.warn(game.i18n.format("raccoon-tweaks.autoApply.immunityFailed", { error: error.message }));
        });
      }
    } catch (error) {
      warn("Chat automation hook failed.", error);
    }
  });
}

const TREAT_WOUNDS_IMMUNITY_UUID = "Compendium.pf2e.feat-effects.Item.Lb4q2bBAgxamtix5";
const TREAT_WOUNDS_IMMUNITY_SLUG = "effect-treat-wounds-immunity";
const CLAIM_SETTLE_MS = 400;

/**
 * Marks the message as handled by this tab and waits for the write to settle.
 * @returns true when this tab's claim is the one that stuck
 */
async function claim(message, key) {
  if (message.getFlag(MODULE_ID, key)) return false;
  await message.setFlag(MODULE_ID, key, { tab: TAB_ID, at: Date.now() });
  await new Promise((resolve) => setTimeout(resolve, CLAIM_SETTLE_MS));
  const current = game.messages.get(message.id) ?? message;
  const mine = current.getFlag(MODULE_ID, key)?.tab === TAB_ID;
  if (!mine) log(`Another GM tab claimed message ${message.id}, standing down.`);
  return mine;
}

async function release(message, key) {
  try { await message.unsetFlag(MODULE_ID, key); } catch { /* the card stays marked; nothing re-fires anyway */ }
}

/* ------------------------------------------------------------------ */
/* 1. Treat Wounds immunity                                             */
/* ------------------------------------------------------------------ */

async function applyTreatWoundsImmunity(message, userId) {
  const healer = message.actor?.name ?? "someone";
  const patient = patientOf(message, userId);
  if (!patient) {
    log(`Treat Wounds by ${healer}: no single creature targeted, immunity not applied.`);
    return;
  }
  if (patient.items.some((item) => item.type === "effect" && item.slug === TREAT_WOUNDS_IMMUNITY_SLUG)) {
    log(`Treat Wounds by ${healer}: ${patient.name} is already immune, nothing to add.`);
    return;
  }
  if (!(await claim(message, "treatWounds"))) return;
  try {
    const effect = await fromUuid(TREAT_WOUNDS_IMMUNITY_UUID);
    if (!effect) throw new Error(`${TREAT_WOUNDS_IMMUNITY_UUID} is not in this world's compendia.`);
    await patient.createEmbeddedDocuments("Item", [effect.toObject()]);
    log(`Treat Wounds by ${healer}: ${effect.name} applied to ${patient.name}.`);
  } catch (error) {
    await release(message, "treatWounds");
    throw error;
  }
}

/**
 * Who was treated. The check's own context is preferred, but the system's
 * Treat Wounds macro (the one Workbench's Basic Action Macros call too) rolls
 * with a bare `dc: { value }`, and a skill check only records its target when
 * the DC names a slug or statistic. So for the macro the context has no
 * target, and the roller's targeting, which Foundry syncs to every client, is
 * read from the user who posted the message instead. Exactly one creature
 * token or nothing: guessing between two is worse than a drag.
 */
function patientOf(message, userId) {
  const fromContext = message.target;                          // PF2e getter: { actor, token } from context.target.token
  if (fromContext?.actor) return fromContext.actor;            // a token's actor, synthetic when unlinked
  if (!canvas.ready) return null;
  const author = game.users.get(userId) ?? message.author;
  const targets = Array.from(author?.targets ?? []).filter((t) => t.actor?.isOfType?.("creature"));
  return targets.length === 1 ? targets[0].actor : null;
}

/* ------------------------------------------------------------------ */
/* 2. Damage and healing to the roll's target                           */
/* ------------------------------------------------------------------ */

async function applyDamageToTarget(message, context) {
  const roll = message.rolls[0];
  const DamageRoll = CONFIG.Dice.rolls.find((cls) => cls.name === "DamageRoll");
  if (!DamageRoll || !(roll instanceof DamageRoll)) return;
  if (message.getFlag(MODULE_ID, "applied")) return;

  const who = `${message.actor?.name ?? "?"}: ${roll.total} (${message.id})`;
  const target = message.target;
  if (!target?.actor || !target.token) {
    log(`Damage ${who}: no single target in the roll, left for a click.`);
    return;
  }
  const item = message.item;
  if (context.sourceType === "save" || item?.system?.defense?.save) {
    log(`Damage ${who}: the target saves first, left for a click.`);
    return;
  }
  if (!target.actor.hitPoints) return;                          // applyDamage would do nothing either

  const kinds = roll.kinds;
  const healing = !kinds.has("damage");                        // the card's own healingOnly test
  if (!healing && kinds.has("healing")) {
    log(`Damage ${who}: heal-or-harm roll, the card decides which, left for a click.`);
    return;
  }
  if (!healing) {
    // Applying at once would take the Shield Block reaction away. A raised,
    // usable shield means the player may want it: the card stays.
    const shield = target.actor.isOfType("character", "npc") ? target.actor.attributes.shield : null;
    if (shield?.raised && !shield.broken && !shield.destroyed) {
      log(`Damage ${who}: ${target.actor.name} has a shield raised, left for a Shield Block decision.`);
      return;
    }
  }

  if (!(await claim(message, "applied"))) return;
  try {
    await applyLikeTheButton({ message, context, roll, target, item, multiplier: healing ? -1 : 1 });
    log(`Damage ${who}: ${healing ? "healed" : "applied to"} ${target.actor.name}.`);
  } catch (error) {
    await release(message, "applied");
    throw error;
  }
}

/**
 * What PF2e's applyDamageFromMessage does for one token, with the roll's
 * target in place of the GM's selection. The function itself is not exported
 * and reads `game.user.getActiveTokens()`, so it cannot be pointed at the
 * target; its body is public actor API and is followed line for line here:
 * a healing-only roll goes in as a negative number with IWR skipped (the -1
 * button), damage goes in as the DamageRoll (the x1 button) so IWR, hardness
 * and persistent damage are PF2e's.
 */
async function applyLikeTheButton({ message, context, roll, target, item, multiplier }) {
  const damage = multiplier < 0 ? multiplier * roll.total : roll.alter(multiplier, 0);
  const options = [...(context.options ?? [])];
  const originOptions = options.filter((o) => o.startsWith("self:")).map((o) => o.replace(/^self\b/, "origin"));
  const itemOptions = item?.isOfType("affliction", "condition", "effect") ? item.getRollOptions("item") : [];
  const origin = message.actor;
  const actor = target.actor;

  if (actor.alliance && origin) options.push(`origin:${actor.alliance === origin.alliance ? "ally" : "enemy"}`);
  if (!options.some((o) => o.startsWith("target"))) options.push(...actor.getSelfRollOptions("target"));

  const domain = multiplier > 0 ? "damage-received" : "healing-received";
  const effects = multiplier > 0 ? await ephemeralEffects({ origin, target: actor, item, domain, options }) : [];
  const clone = actor.getContextualClone(originOptions, effects);
  const rollOptions = new Set([
    ...options.filter((o) => !/^(?:self|target)(?::|$)/.test(o)),
    ...itemOptions,
    ...originOptions,
    ...clone.getSelfRollOptions(),
  ]);
  await clone.applyDamage({
    damage,
    token: target.token,
    item,
    skipIWR: multiplier <= 0,
    rollOptions,
    shieldBlockRequest: false,
    outcome: context.outcome ?? null,
  });
}

/**
 * PF2e's extractEphemeralEffects for `affects: "target"`, which is not
 * exported either: effects a rule element on the attacker grants the target
 * for the duration of the damage application (a weakness it inflicts, say).
 * Rare, but the GM click honours them, so this does too.
 */
async function ephemeralEffects({ origin, target, item, domain, options }) {
  if (!origin || !target) return [];
  try {
    const test = [...options, ...origin.getRollOptions([domain]), ...target.getSelfRollOptions("target")];
    const resolvables = item ? (item.isOfType("spell") ? { spell: item } : { weapon: item }) : {};
    const makers = origin.synthetics?.ephemeralEffects?.[domain]?.target ?? [];
    const effects = (await Promise.all(makers.map((make) => make({ test, resolvables })))).filter((e) => !!e);
    for (const effect of effects) {
      if (effect.type !== "effect") continue;
      effect.system.context = {
        origin: { actor: origin.uuid, token: null, item: null, spellcasting: null, rollOptions: [] },
        target: { actor: target.uuid, token: null },
        roll: null,
      };
      effect.system.duration = { value: -1, unit: "unlimited", expiry: null, sustained: false };
    }
    return effects;
  } catch (error) {
    warn("Ephemeral effects skipped for this application.", error);
    return [];
  }
}
