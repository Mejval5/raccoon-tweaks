import { MODULE_ID, SETTINGS, log, warn, VISITOR } from "./constants.js";
import { setting } from "./settings.js";

/**
 * The world clock follows the table.
 *
 * Foundry already has a world time (`game.time`) and PF2e hangs effect
 * durations on it, but out of combat nothing moves it unless the GM clicks
 * the clock. This counts real time in the active GM's tab and, every ten real
 * minutes, jumps the world time forward by ten minutes in one step (Dan,
 * 2026-11-10). One jump rather than a steady trickle, so PF2e expires effects
 * the same way it does after a manual jump.
 *
 * The counter runs only while it should: the setting is on, the game is not
 * paused, no combat has started (in combat the core already moves time by
 * rounds), and at least one player is connected, so a GM tab left open for
 * prep does not burn the party's torches. Any change of the world time, ours
 * or a manual jump on the clock, clears the counter: ten minutes are counted
 * from the last time the clock moved.
 */
const STEP_SECONDS = 600;
const TICK_MS = 5000;
const MAX_DELTA_MS = 90000;      // a longer gap between ticks is a sleeping laptop, not play

let counted = 0;                 // real seconds since the world time last moved, while running
let last = Date.now();
let jumping = false;

export function registerWorldClock() {
  Hooks.on("updateWorldTime", () => { counted = 0; });
  Hooks.once("ready", () => {
    last = Date.now();
    setInterval(() => tick().catch((e) => warn("World clock tick failed.", e)), TICK_MS);
    const api = game.modules.get(MODULE_ID).api ?? (game.modules.get(MODULE_ID).api = {});
    api.worldClock = {
      /** What the ticker sees right now. */
      state: () => ({ counted: Math.round(counted), step: STEP_SECONDS, running: running(), why: blockers() }),
      /** Testing aid: pretend this many real seconds have passed. */
      nudge: (seconds) => { counted += Number(seconds) || 0; return Math.round(counted); },
    };
  });
}

function blockers() {
  const out = [];
  if (!setting(SETTINGS.WORLD_CLOCK)) out.push("setting off");
  if (game.user !== game.users.activeGM) out.push("not the active GM");
  if (VISITOR) out.push("visitor tab");
  if (game.paused) out.push("paused");
  if (game.combats.some((c) => c.started)) out.push("combat");
  if (!game.users.some((u) => u.active && !u.isGM)) out.push("no player connected");
  return out;
}

const running = () => blockers().length === 0;

async function tick() {
  const now = Date.now();
  const delta = Math.min(now - last, MAX_DELTA_MS);
  last = now;
  if (!running()) return;                                   // paused: the counter keeps what it has
  counted += delta / 1000;
  if (counted < STEP_SECONDS || jumping) return;
  jumping = true;
  try {
    // Two tabs of the same GM user both count. A short random wait lets whichever
    // jumps first clear the other's counter through updateWorldTime.
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 3000));
    if (counted < STEP_SECONDS || !running()) return;
    counted = 0;
    await game.time.advance(STEP_SECONDS);
    log(`World time +${STEP_SECONDS / 60} min after ${STEP_SECONDS / 60} real minutes at the table.`);
  } finally {
    jumping = false;
  }
}
