/**
 * Boot timeline: one console line per load phase with the time since the page opened and the
 * delta from the previous phase, and a summary table once the canvas is up (scripts, documents,
 * phases). Always on; it costs a few console lines. The marks also show up as "raccoon:" measures
 * in the DevTools Performance panel. Turn on "Show timestamps" in the DevTools console settings
 * to see wall-clock times next to every other module's lines too.
 */
const PHASES = ["init", "i18nInit", "setup", "ready", "canvasConfig", "canvasInit", "canvasDraw", "canvasReady"];
const STYLE = "color:#8fe7b8;font-weight:600";
let last = 0;
const stamps = {};

export function installBootTimeline() {
  performance.mark("raccoon:module-eval");
  line("module-eval");
  for (const hook of PHASES) Hooks.once(hook, () => { line(hook); if (hook === "canvasReady") summary(); });
  Hooks.once("pf2e.systemReady", () => line("pf2e.systemReady"));
}

function line(name) {
  const now = performance.now();
  stamps[name] = now;
  performance.mark(`raccoon:${name}`);
  if (last) performance.measure(`raccoon:→${name}`, { start: last, end: now });
  console.log(`%c[boot] ${name.padEnd(16)} ${Math.round(now).toString().padStart(6)} ms  (+${Math.round(now - last)})`, STYLE);
  last = now;
}

function summary() {
  try {
    const res = performance.getEntriesByType("resource");
    const scripts = res.filter((r) => r.initiatorType === "script" || /\.m?js(\?|$)/.test(r.name));
    const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);
    const nav = performance.getEntriesByType("navigation")[0];
    const slow = [...scripts].sort((a, b) => b.duration - a.duration).slice(0, 8)
      .map((r) => `${Math.round(r.duration)} ms  ${Math.round((r.encodedBodySize || 0) / 1024)} kB  ${r.name.replace(location.origin + "/", "")}`);
    const itemsOnActors = game.actors.reduce((s, a) => s + a.items.size, 0);
    console.groupCollapsed(`%c[boot] summary: canvas ready at ${Math.round(stamps.canvasReady)} ms, ${scripts.length} scripts / ${Math.round(sum(scripts, (r) => r.encodedBodySize) / 1048576)} MB, ` +
      `${game.actors.size} actors (${itemsOnActors} items), ${game.scenes.size} scenes, ${game.journal.size} journals, ${game.modules.filter((m) => m.active).length} modules`, STYLE);
    console.table({
      "page interactive": ms(nav?.domInteractive),
      "last script received": ms(Math.max(...scripts.map((r) => r.responseEnd))),
      ...Object.fromEntries(Object.entries(stamps).map(([k, v]) => [k, ms(v)])),
      "scripts, transfer time summed": ms(sum(scripts, (r) => r.duration)),
      "JS heap MB": performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : "n/a",
      "user": `${game.user.name}${game.user.isGM ? " (GM)" : ""}`,
    });
    console.log("slowest scripts:\n  " + slow.join("\n  "));
    console.groupEnd();
  } catch (error) {
    console.warn("[boot] summary failed", error);
  }
}

const ms = (v) => (Number.isFinite(v) ? `${Math.round(v)} ms` : "n/a");
