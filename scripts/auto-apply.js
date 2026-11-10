import { MODULE_ID, SETTINGS, TAB_ID, log, warn, VISITOR } from "./constants.js";
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
      if (!game.users?.activeGM || game.user !== game.users.activeGM || VISITOR) return;
      handle(message, userId);
    } catch (error) {
      warn("Chat automation hook failed.", error);
    }
  });

  Hooks.once("ready", () => {
    const api = game.modules.get(MODULE_ID).api ?? (game.modules.get(MODULE_ID).api = {});
    /** Runs the automation on one message in this tab, whatever tab it is: for tests and missed cards. */
    api.autoApply = { run: (messageId) => handle(game.messages.get(messageId), game.messages.get(messageId)?.author?.id ?? game.user.id) };
  });
}

const failed = (key) => (error) => {
  warn(`Chat automation (${key}) failed, the card is left for a manual click.`, error);
  ui.notifications.warn(game.i18n.format(`raccoon-tweaks.autoApply.${key}`, { error: error.message }));
};

function handle(message, userId) {
  if (!message) return Promise.resolve();
  const tasks = [];
  const context = message.flags?.pf2e?.context;
  if (message.item?.slug === "drink-of-my-foes" && setting(SETTINGS.AUTO_APPLY_DAMAGE)) {
    tasks.push(drinkOfMyFoes(message).catch(failed("damageFailed")));
  }
  if (context) {
    const treatWounds = Boolean(context.options?.includes?.("action:treat-wounds"));
    // The Treat Wounds macro posts its healing (and Risky Surgery's damage) as a
    // second message carrying a copy of the check's flags: context type
    // "skill-check", plus `origin.messageId`. Until 0.24.0 that roll was never
    // applied, which is most of "healing does not apply itself" (session 7).
    if (treatWounds && message.flags?.pf2e?.origin?.messageId && isDamageRoll(message.rolls?.[0])) {
      if (setting(SETTINGS.AUTO_APPLY_DAMAGE)) tasks.push(applyTreatWoundsResult(message, context, userId).catch(failed("damageFailed")));
    } else if (context.type === "damage-roll") {
      if (setting(SETTINGS.AUTO_APPLY_DAMAGE)) tasks.push(applyDamageToTarget(message, context, userId).catch(failed("damageFailed")));
    } else if (context.type === "skill-check" && treatWounds) {
      if (setting(SETTINGS.AUTO_TREAT_WOUNDS)) tasks.push(applyTreatWoundsImmunity(message, userId).catch(failed("immunityFailed")));
    }
  }
  return Promise.all(tasks);
}

function isDamageRoll(roll) {
  const DamageRoll = CONFIG.Dice.rolls.find((cls) => cls.name === "DamageRoll");
  return Boolean(DamageRoll && roll instanceof DamageRoll);
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
  const patient = patientOf(message, userId)?.actor;
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
  if (fromContext?.actor) return { actor: fromContext.actor, token: fromContext.token ?? tokenOf(fromContext.actor) };
  if (!canvas.ready) return null;
  const author = game.users.get(userId) ?? message.author;
  const targets = Array.from(author?.targets ?? []).filter((t) => t.actor?.isOfType?.("creature"));
  return targets.length === 1 ? { actor: targets[0].actor, token: targets[0].document } : null;
}

// The GM's tab may be looking at another scene than the player, so the canvas
// alone is not enough: the active scene is where the party usually is.
const tokenOf = (actor) => actor?.token ?? actor?.getActiveTokens?.(true, true)?.[0]
  ?? game.scenes.active?.tokens.find((t) => t.actorId === actor?.id) ?? null;

/**
 * The roll that follows a Treat Wounds check: healing on a success, 1d8 damage
 * on a critical failure, Risky Surgery's 1d8 slashing. Applied to the patient
 * the check was made on. A success also ends the patient's Wounded condition,
 * as Player Core says for HP restored by Treat Wounds (Dan, 2026-11-10: RAW).
 */
async function applyTreatWoundsResult(message, context, userId) {
  const roll = message.rolls[0];
  const who = `Treat Wounds by ${message.actor?.name ?? "?"}: ${roll.total} (${message.id})`;
  const patient = patientOf(message, userId);
  if (!patient?.actor || !patient.token) {
    log(`${who}: no single creature targeted, left for a click.`);
    return;
  }
  if (!patient.actor.hitPoints) return;
  if (message.getFlag(MODULE_ID, "applied")) return;
  const healing = !roll.kinds.has("damage");
  if (!(await claim(message, "applied"))) return;
  try {
    await applyLikeTheButton({ message, context, roll, target: patient, item: null, multiplier: healing ? -1 : 1 });
    log(`${who}: ${healing ? "healed" : "damage applied to"} ${patient.actor.name}.`);
  } catch (error) {
    await release(message, "applied");
    throw error;
  }
  if (healing && ["success", "criticalSuccess"].includes(context.outcome) && setting(SETTINGS.AUTO_TREAT_WOUNDS)) {
    await removeWounded(patient.actor, who);
  }
}

async function removeWounded(actor, who) {
  const wounded = actor.itemTypes?.condition?.find((c) => c.slug === "wounded");
  if (!wounded) return;
  await actor.decreaseCondition("wounded", { forceRemove: true });
  log(`${who}: Wounded removed from ${actor.name}.`);
}

/* ------------------------------------------------------------------ */
/* 2. Damage and healing to the roll's target                           */
/* ------------------------------------------------------------------ */

async function applyDamageToTarget(message, context, userId) {
  const roll = message.rolls[0];
  if (!isDamageRoll(roll)) return;
  if (message.getFlag(MODULE_ID, "applied")) return;

  const who = `${message.actor?.name ?? "?"}: ${roll.total} (${message.id})`;
  const kinds = roll.kinds;
  const healingOnly = !kinds.has("damage");                    // the card's own healingOnly test
  let target = message.target;
  // Healing often comes without a target: a potion drunk, a heal cast on
  // whoever is standing there. Damage never guesses.
  if ((!target?.actor || !target.token) && healingOnly) target = healingTarget(message, context, userId);
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

  let healing = healingOnly;
  if (healingOnly && vitalityOnVoidHealer(roll, item, target.actor)) {
    log(`Damage ${who}: vitality healing on ${target.actor.name}, who has void healing; left for a click.`);
    return;
  }
  if (!healingOnly && kinds.has("healing")) {
    // Heal, Harm and the like: vitality heals the living and hurts void healers, void the other way round.
    const heals = healsTarget(roll, target.actor);
    if (heals === null) {
      log(`Damage ${who}: heal-or-harm roll of mixed energy, left for a click.`);
      return;
    }
    healing = heals;
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

const energyOf = (roll) => new Set((roll.instances ?? []).map((i) => i.type));
const voidHealer = (actor) => Boolean(actor?.attributes?.hp?.negativeHealing);

function vitalityOnVoidHealer(roll, item, actor) {
  if (!voidHealer(actor)) return false;
  return energyOf(roll).has("vitality") || Boolean(item?.system?.traits?.value?.includes?.("vitality"));
}

/** true = heal, false = harm, null = cannot tell */
function healsTarget(roll, actor) {
  const types = energyOf(roll);
  if (types.has("vitality") && !types.has("void")) return !voidHealer(actor);
  if (types.has("void") && !types.has("vitality")) return voidHealer(actor);
  return null;
}

/**
 * Who an untargeted healing roll is for. Something drunk or eaten heals the one
 * who used it (a stale target on an enemy must not get the potion). Otherwise
 * the roller's one targeted creature, if exactly one.
 */
function healingTarget(message, context, userId) {
  const consumable = message.item?.isOfType?.("consumable")
    || context.options?.includes?.("item:type:consumable")
    || message.flags?.pf2e?.origin?.type === "consumable";
  if (consumable && message.actor) {
    const token = message.token ?? tokenOf(message.actor);
    return token ? { actor: message.actor, token: token.document ?? token } : null;
  }
  if (!canvas.ready) return null;
  const author = game.users.get(userId) ?? message.author;
  const targets = Array.from(author?.targets ?? []).filter((t) => t.actor?.isOfType?.("creature"));
  return targets.length === 1 ? { actor: targets[0].actor, token: targets[0].document } : null;
}

/* ------------------------------------------------------------------ */
/* 3. Drink of my Foes (Ezekiel's house rule, Dan 2026-11-03)           */
/* ------------------------------------------------------------------ */

const DRINK_WINDOW_MS = 10 * 60 * 1000;
const isIkon = (item) => Boolean(item && ((item.system?.traits?.otherTags ?? []).some((t) => String(t).startsWith("physical-ikon"))
  || /žebro/i.test(item.name ?? "")));

/**
 * Barrow's Edge's transcendence heals as vitality, and Ezekiel has void
 * healing, so RAW it does nothing for him. House rule: temporary HP equal to
 * half the damage dealt. Posting the action is the trigger: the last damage
 * roll this actor made with its ikon in the last ten minutes is halved, the
 * result replaces the temporary HP if it is higher (they do not stack), and the
 * spark leaves the ikon, as a transcendence ends the immanence.
 */
async function drinkOfMyFoes(message) {
  const actor = message.actor;
  if (!actor?.isOfType?.("character", "npc") || message.getFlag(MODULE_ID, "drink")) return;
  const since = Date.now() - DRINK_WINDOW_MS;
  const strike = game.messages.contents.slice(-80).reverse().find((m) => m.id !== message.id && m.timestamp >= since
    && m.actor?.id === actor.id && m.flags?.pf2e?.context?.type === "damage-roll"
    && isIkon(m.item) && isDamageRoll(m.rolls?.[0]) && m.rolls[0].kinds.has("damage"));
  const t = (key, data) => game.i18n.format(`raccoon-tweaks.autoApply.${key}`, data);
  if (!strike) {
    ui.notifications.warn(t("drinkNoStrike", { name: actor.name }));
    return;
  }
  if (!(await claim(message, "drink"))) return;
  const dealt = strike.rolls[0].total;
  const temp = Math.floor(dealt / 2);
  const before = actor.attributes.hp?.temp ?? 0;
  if (temp > before) await actor.update({ "system.attributes.hp.temp": temp });
  const sparkItem = actor.items.find((i) => (i.system?.rules ?? []).some((r) => r.key === "RollOption" && r.option === "divine-spark" && r.toggleable));
  const sparked = Object.keys(actor.rollOptions?.all ?? {}).some((o) => o.startsWith("divine-spark"));
  if (sparkItem && sparked) await actor.toggleRollOption("all", "divine-spark", sparkItem.id, false);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<p>${t(temp > before ? "drinkDone" : "drinkNoGain", { name: actor.name, temp, dealt, before })}${sparkItem && sparked ? ` ${t("drinkSpark")}` : ""}</p>`,
  });
  log(`Drink of my Foes: ${actor.name}, half of ${dealt} = ${temp} temp HP (had ${before}).`);
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
