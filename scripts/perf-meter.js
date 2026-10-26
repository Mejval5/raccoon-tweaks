import { MODULE_ID, SETTINGS, log, warn } from "./constants.js";
import { setting } from "./settings.js";

/**
 * A per-client performance meter for anyone at the table: FPS, frame-time p95, long tasks
 * (>50 ms) per minute, which hook was running when each long task began, and what the machine
 * is (GPU, cores, RAM, Foundry performance mode) so a player's copied report explains itself. Hooks are
 * attributed by wrapping Hooks.callAll / Hooks.call at init, which is the one
 * place every module's reaction to the game passes through. Toggle with the
 * Token scene control or the setting; copy the report from the panel.
 */
export function installPerfMeter() {
  wrapHooks();
  Hooks.on("getSceneControlButtons", (controls) => {
    const tokens = controls.tokens ?? controls.find?.((c) => c.name === "token");
    if (!tokens) return;
    const tool = {
      name: "raccoon-perf-meter",
      title: game.i18n.localize("raccoon-tweaks.perf.toggle"),
      icon: "fa-solid fa-gauge-high",
      toggle: true,
      active: Boolean(setting(SETTINGS.PERF_METER)),
      onChange: (event, active) => setEnabled(active),
      onClick: (active) => setEnabled(active),
    };
    if (Array.isArray(tokens.tools)) tokens.tools.push(tool);
    else tokens.tools[tool.name] = tool;
  });
  Hooks.once("ready", () => {
    if (setting(SETTINGS.PERF_METER)) start();
  });
}

function setEnabled(active) {
  game.settings.set(MODULE_ID, SETTINGS.PERF_METER, active).catch((e) => warn(e));
  if (active) start(); else stop();
}

/* ------------------------------ hook attribution ------------------------------ */

const current = { hook: null, since: 0 };
const hookTotals = new Map();  // hook -> {calls, ms}
let wrapped = false;

function wrapHooks() {
  if (wrapped) return;
  wrapped = true;
  for (const name of ["callAll", "call"]) {
    const original = Hooks[name];
    if (typeof original !== "function") continue;
    Hooks[name] = function raccoonHook(hook, ...args) {
      const outer = current.hook;
      current.hook = hook;
      const t0 = performance.now();
      try {
        return original.call(this, hook, ...args);
      } finally {
        const dt = performance.now() - t0;
        const h = hookTotals.get(hook) ?? { calls: 0, ms: 0, max: 0 };
        h.calls += 1; h.ms += dt; if (dt > h.max) h.max = dt;
        hookTotals.set(hook, h);
        current.hook = outer;
      }
    };
  }
}

/* --------------------------------- sampling ---------------------------------- */

let rafId = 0, observer = null, panel = null, timer = 0;
const frames = [];            // last ~600 frame durations (ms)
const longTasks = [];         // {t, dur, hook}
let lastFrame = 0;
let device = null;           // machine facts, read once per start

/* What the machine is. The GPU string is the one that matters: SwiftShader or a Basic Render Driver
   means no hardware acceleration, and no setting on our side fixes that. */
async function readDevice() {
  const d = { gpu: "?", cores: navigator.hardwareConcurrency ?? "?", ram: navigator.deviceMemory ? `${navigator.deviceMemory} GB` : "?",
    perfMode: "?", maxFps: "?", net: "", lights: canvas.scene?.lights.size ?? "?", screen: `${screen.width}x${screen.height}@${devicePixelRatio}`, storage: "" };
  try { const gl = canvas.app.renderer.gl, x = gl.getExtension("WEBGL_debug_renderer_info"); d.gpu = x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch (error) { warn("GPU string not readable.", error); }
  try { d.perfMode = String(game.settings.get("core", "performanceMode")); } catch { /* older core */ }
  try { d.maxFps = String(game.settings.get("core", "maxFPS")); } catch { /* older core */ }
  const c = navigator.connection; if (c) d.net = `${c.effectiveType ?? ""} ${c.downlink ?? "?"} Mb/s rtt ${c.rtt ?? "?"} ms`;
  try { const e = await navigator.storage?.estimate?.(); if (e) d.storage = `${Math.round(e.usage / 1048576)} / ${Math.round(e.quota / 1048576)} MB`; } catch { /* no estimate */ }
  return d;
}

function start() {
  if (panel) return;
  frames.length = 0; longTasks.length = 0; hookTotals.clear();
  device = null; readDevice().then((d) => { device = d; render(); });
  lastFrame = performance.now();
  const tick = (t) => {
    const dt = t - lastFrame; lastFrame = t;
    frames.push(dt); if (frames.length > 600) frames.shift();
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  if ("PerformanceObserver" in window) {
    try {
      observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          longTasks.push({ t: e.startTime, dur: e.duration, hook: current.hook });
          if (longTasks.length > 500) longTasks.shift();
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch (error) {
      warn("Long-task observer not available.", error);
    }
  }

  panel = buildPanel();
  document.body.append(panel);
  timer = setInterval(render, 1000);
  log("Perf meter on.");
}

function stop() {
  cancelAnimationFrame(rafId); rafId = 0;
  observer?.disconnect(); observer = null;
  clearInterval(timer); timer = 0;
  panel?.remove(); panel = null;
  log("Perf meter off.");
}

function stats() {
  const sorted = [...frames].sort((a, b) => a - b);
  const p = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
  const avg = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
  const now = performance.now();
  const recent = longTasks.filter((l) => now - l.t < 60_000);
  const byHook = new Map();
  for (const l of recent) {
    const k = l.hook ?? "(no hook: canvas/render/idle)";
    const h = byHook.get(k) ?? { n: 0, ms: 0 }; h.n += 1; h.ms += l.dur; byHook.set(k, h);
  }
  const topLong = [...byHook.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 6);
  const topHooks = [...hookTotals.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8);
  return { fps: avg ? 1000 / avg : 0, p50: p(0.5), p95: p(0.95), max: sorted.at(-1) ?? 0,
    longPerMin: recent.length, longMsPerMin: recent.reduce((a, l) => a + l.dur, 0), topLong, topHooks,
    heap: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null };
}

function render() {
  if (!panel) return;
  const s = stats();
  const row = (k, v) => `<div><span>${k}</span><b>${v}</b></div>`;
  const ms = (x) => `${x.toFixed(x < 10 ? 1 : 0)} ms`;
  // Chrome stops animation frames in a hidden tab, which would read as 0 FPS.
  const hidden = document.visibilityState === "hidden";
  panel.querySelector(".rt-perf-body").innerHTML = [
    hidden ? row("FPS", "tab in background, no frames") : row("FPS", s.fps.toFixed(0)),
    row("frame p50 / p95 / max", `${ms(s.p50)} / ${ms(s.p95)} / ${ms(s.max)}`),
    row("long tasks / min", `${s.longPerMin} (${ms(s.longMsPerMin)})`),
    s.heap != null ? row("JS heap", `${s.heap.toFixed(0)} MB`) : "",
    `<div class="rt-perf-h">long tasks by hook (last minute)</div>`,
    ...s.topLong.map(([k, v]) => row(esc(k), `${v.n}× ${ms(v.ms)}`)),
    `<div class="rt-perf-h">hook time since start</div>`,
    ...s.topHooks.map(([k, v]) => row(esc(k), `${ms(v.ms)} / ${v.calls} (max ${ms(v.max)})`)),
    `<div class="rt-perf-h">machine</div>`,
    ...deviceRows().map(([k, v]) => row(k, esc(v))),
  ].join("");
}

function deviceRows() {
  if (!device) return [["reading", "…"]];
  const d = device;
  return [["gpu", d.gpu], ["cores / ram", `${d.cores} / ${d.ram}`], ["perf mode / max fps", `${d.perfMode} / ${d.maxFps}`], ["scene lights", d.lights],
    ["screen", d.screen], d.net ? ["network", d.net] : null, d.storage ? ["browser storage", d.storage] : null].filter(Boolean);
}

function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

function buildPanel() {
  const el = document.createElement("div");
  el.id = "raccoon-perf-meter";
  el.innerHTML = `<div class="rt-perf-head"><span>perf</span>
      <button type="button" data-a="reset" title="reset">⟲</button>
      <button type="button" data-a="copy" title="copy report">⧉</button>
      <button type="button" data-a="close" title="close">✕</button></div>
    <div class="rt-perf-body"></div>`;
  el.addEventListener("click", (e) => {
    const a = e.target?.dataset?.a;
    if (a === "close") setEnabled(false);
    if (a === "reset") { frames.length = 0; longTasks.length = 0; hookTotals.clear(); render(); }
    if (a === "copy") copyReport();
  });
  return el;
}

async function copyReport() {
  const s = stats();
  const lines = [
    `raccoon perf report ${new Date().toISOString()} scene=${canvas.scene?.name} tokens=${canvas.scene?.tokens.size} modules=${game.modules.filter((m) => m.active).length}`,
    `fps=${s.fps.toFixed(1)} p50=${s.p50.toFixed(1)} p95=${s.p95.toFixed(1)} max=${s.max.toFixed(0)} longTasks/min=${s.longPerMin} (${s.longMsPerMin.toFixed(0)} ms) heapMB=${s.heap?.toFixed(0)}`,
    `user=${game.user.name} ${game.user.isGM ? "(GM)" : ""}`,
    ...deviceRows().map(([k, v]) => `  ${k}: ${v}`),
    "long tasks by hook (last minute):",
    ...s.topLong.map(([k, v]) => `  ${k}: ${v.n}x ${v.ms.toFixed(0)} ms`),
    "hook time since start:",
    ...s.topHooks.map(([k, v]) => `  ${k}: ${v.ms.toFixed(0)} ms over ${v.calls} calls, max ${v.max.toFixed(0)} ms`),
  ];
  const text = lines.join("\n");
  try { await navigator.clipboard.writeText(text); ui.notifications.info("Perf report copied."); }
  catch { console.log(text); ui.notifications.info("Perf report printed to console."); }
}
