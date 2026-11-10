import { SETTINGS, log, warn } from "./constants.js";
import { setting } from "./settings.js";

/**
 * Chronoskimmer Dedication, asked instead of ticked.
 *
 * PF2e implements the feat as a checkbox with a dropdown on the sheet:
 * tick it, pick "stabilize" or one of two "destabilize" results (after rolling
 * the DC 11 flat check yourself), roll initiative, then remember to untick it.
 * Nobody at the table knew what the checkbox was for (Dan, 2026-11-10).
 *
 * With this on, whoever rolls initiative for an actor that has the feat gets
 * one question first: roll normally, stabilize (the die counts as 10), or
 * destabilize (the module rolls the flat check, posts it, and the die counts
 * as 19 on a success and 1 on a failure). The module sets the system's own
 * toggle for the roll and clears it afterwards, so the result on the chat card
 * is PF2e's substitution, not a number of ours. Closing the question cancels
 * the roll.
 */
const SLUG = "chronoskimmer-dedication";

export function registerChronoskimmer() {
  Hooks.once("ready", () => {
    try {
      const sample = game.actors.find((a) => a.initiative && typeof a.initiative.roll === "function");
      const proto = sample ? Object.getPrototypeOf(sample.initiative) : null;
      if (!proto || proto.roll?.raccoonWrapped) {
        if (!proto) warn("No actor with an initiative statistic found; the Chronoskimmer prompt stays off.");
        return;
      }
      const original = proto.roll;
      proto.roll = async function (args = {}) {
        let feat = null, suboption = null;
        try {
          const actor = this.actor;
          if (setting(SETTINGS.CHRONOSKIMMER_PROMPT) && actor?.isOwner) {
            feat = actor.itemTypes?.feat?.find((f) => f.slug === SLUG) ?? null;
          }
          // "Roll all" in the GM's tab must not answer for a player who is at the
          // table: Arnold's initiative was posted before Makak had chosen
          // (session 9). The player rolls it; the GM only when nobody is there.
          if (feat && game.user.isGM && playerOnline(actor)) {
            ui.notifications.info(game.i18n.format("raccoon-tweaks.chrono.playerRolls", { name: actor.name }));
            return null;
          }
          if (feat) {
            const choice = await ask(actor);
            if (!choice) return null;                                  // closed: no roll
            if (choice === "stabilize") suboption = "stabilize";
            if (choice === "destabilize") suboption = (await flatCheck(actor)) ? "destabilize-success" : "destabilize-failure";
            await actor.toggleRollOption("all", SLUG, feat.id, Boolean(suboption), suboption);
          }
        } catch (error) {
          warn("Chronoskimmer prompt failed, rolling initiative the system's way.", error);
          feat = null;
        }
        try {
          // The toggle re-prepares the actor and builds a new initiative
          // statistic; rolling the one from before the toggle is how the first
          // try in session 9 showed a bare 10 without the +8.
          const statistic = feat ? (this.actor?.initiative ?? this) : this;
          return await original.call(statistic, args);
        } finally {
          // Leave the checkbox clear, so the next roll asks again instead of reusing this answer.
          if (feat) this.actor.toggleRollOption("all", SLUG, feat.id, false).catch((e) => warn("Could not clear the Chronoskimmer toggle.", e));
        }
      };
      proto.roll.raccoonWrapped = true;
      log("Initiative roll wrapped: Chronoskimmer Dedication asks before rolling.");
    } catch (error) {
      warn("Chronoskimmer prompt could not be installed.", error);
    }
  });
}

function playerOnline(actor) {
  const owners = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  return game.users.some((u) => u.active && !u.isGM && actor.testUserPermission(u, owners));
}

async function ask(actor) {
  const t = (key, data) => game.i18n.format(`raccoon-tweaks.chrono.${key}`, data);
  return foundry.applications.api.DialogV2.wait({
    window: { title: t("title", { name: actor.name }), icon: "fa-solid fa-hourglass-half" },
    content: `<p>${t("intro")}</p><ul><li>${t("normalHint")}</li><li>${t("stabilizeHint")}</li><li>${t("destabilizeHint")}</li></ul>`,
    buttons: [
      { action: "normal", label: t("normal"), icon: "fa-solid fa-dice-d20", default: true },
      { action: "stabilize", label: t("stabilize"), icon: "fa-solid fa-anchor" },
      { action: "destabilize", label: t("destabilize"), icon: "fa-solid fa-bolt" },
    ],
    rejectClose: false,
    position: { width: 520 },
  });
}

/** The DC 11 flat check of Destabilize your Timestream, posted to chat. */
async function flatCheck(actor) {
  const roll = await new Roll("1d20").evaluate();
  const success = roll.total >= 11;
  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: game.i18n.format(`raccoon-tweaks.chrono.${success ? "flatSuccess" : "flatFailure"}`, { name: actor.name }),
  });
  return success;
}
