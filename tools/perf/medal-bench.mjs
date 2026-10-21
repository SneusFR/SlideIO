// Medal render bench: the REAL HUD markup + stylesheets of index.html and the
// REAL MedalHUD / MedalManager (bundled with esbuild, real-time rAF) in
// headless Chrome with GPU rasterization (Skia on ANGLE / SwiftShader). Fires
// KILLS kill medals (the plain KILL every time — the most frequent medal of a
// match), traces the browser's rendering work during each medal's life and
// reports it per kill: style, paint, layerization, raster, composite.
//
//   node tools/perf/medal-bench.mjs [width=2560] [height=1440]
//   env: KILLS=8 (medals per window) · DUMP_ANIM=1 (raw trace "Animation" events)
//
// Headless + SwiftShader: absolute times are a CPU emulation of the GPU
// process — compare BEFORE / AFTER on the same machine, not with the game's
// HUD lines. Counts (paints, raster tasks, layer tree updates) are portable.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { launch } from "../hud-preview/cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const { buildSync } = createRequire(resolve(root, "package.json"))("esbuild");

const W = Number(process.argv[2]) || 2560;
const H = Number(process.argv[3]) || 1440;
const KILLS = Number(process.env.KILLS ?? 8);
/** One medal's life: enter 0.16 + hold 0.95 + exit 0.25 + gap (MedalConfig) ≈ 1.4 s. */
const KILL_SPACING_MS = 1700;

// ---- Page: real HUD markup + real stylesheets + bundled entry ----
const js = buildSync({
  entryPoints: [resolve(here, "medal-entry.ts")],
  bundle: true,
  write: false,
  format: "iife",
  target: "es2022",
  logLevel: "error",
}).outputFiles[0].text.replaceAll("</script", "<\\/script");
const html = read("index.html");
// The HUD markup (src/hud/hudMarkup.html, injected by the HUD runtime); its stylesheets are still index.html's.
let hud = read("src/hud/hudMarkup.html");
hud = hud.replace('class="menu-active"', "");
const sheets = [...html.matchAll(/<link rel="stylesheet" href="\/(src\/[^"]+\.css)"/g)].map((m) => m[1]);
const styles = sheets.map((s) => `<style>${read(s)}</style>`).join("");
const page = `<!doctype html><html><head><meta charset="utf-8">${styles}
<style>html,body{margin:0;height:100%;overflow:hidden;background:#7a8fb0}
#hud>*:not(#medal-display){display:none!important}</style></head>
<body>${hud}<script>${js}</script></body></html>`;
const outDir = resolve(tmpdir(), "slideio-medal-bench");
mkdirSync(outDir, { recursive: true });
const file = resolve(outDir, "medal.html");
writeFileSync(file, page);

// ---- Browser ----
const b = await launch({
  width: W,
  height: H,
  url: pathToFileURL(file).href,
  args: ["--enable-gpu-rasterization", "--force-gpu-rasterization"],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
b.on("Tracing.dataCollected", (p) => events.push(...p.value));
let traceDone;
b.on("Tracing.tracingComplete", () => traceDone());

try {
  await sleep(500);
  // Warm medal: the first pop compiles the rasterizer's shaders (the game
  // pays it during the loading screen — HudWarmup), never measured.
  await b.eval("medalBench.kill(1); true");
  await sleep(KILL_SPACING_MS);

  /** Trace one window (kills = 0 → the HUD at rest, same duration). */
  const traceWindow = async (kills) => {
    events.length = 0;
    await b.send("Tracing.start", {
      transferMode: "ReportEvents",
      traceConfig: {
        includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "cc", "gpu", "viz"],
      },
    });
    await b.eval("medalBench.frames(); true");
    for (let k = 0; k < KILLS; k++) {
      if (kills) await b.eval("medalBench.kill(1); true");
      await sleep(KILL_SPACING_MS);
    }
    const frames = await b.eval("medalBench.frames()");
    const done = new Promise((r) => (traceDone = r));
    await b.send("Tracing.end");
    await done;
    return { events: events.slice(), frames };
  };
  const idle = await traceWindow(false);
  const idleSums = aggregate(idle.events);
  const { frames } = await traceWindow(true);

  const sums = aggregate(events);
  if (process.env.DUMP_ANIM) {
    for (const e of events.filter((x) => x.name === "Animation").slice(0, 60)) console.log(JSON.stringify({ ph: e.ph, id: e.id ?? e.id2, args: e.args }));
  }
  // Animations Chrome could NOT hand to the compositor (they then run on the
  // main thread: style + paint every frame). Trace "Animation" events carry
  // the reason bitmask (compositeFailed) and the unsupported properties.
  // The async "Animation" events of one animation share an id: its start
  // event carries the name / target, a later one the composite result.
  const animInfo = new Map();
  for (const e of events) {
    if (e.name !== "Animation") continue;
    const d = e.args?.data ?? {};
    const info = animInfo.get(e.id ?? e.id2?.local) ?? {};
    if (d.name) info.name = d.name;
    if (d.nodeName) info.node = d.nodeName;
    if (d.compositeFailed) {
      info.fail = d.compositeFailed;
      info.props = d.unsupportedProperties;
    }
    animInfo.set(e.id ?? e.id2?.local, info);
  }
  const failed = new Map();
  for (const info of animInfo.values()) {
    if (!info.fail) continue;
    const key = `${info.name ?? "?"} (${info.node ?? "?"}) → ${failureNames(info.fail)}${info.props?.length ? ` [${info.props.join(",")}]` : ""}`;
    failed.set(key, (failed.get(key) ?? 0) + 1);
  }

  frames.sort((a, c) => a - c);
  const pct = (p) => frames[Math.min(frames.length - 1, Math.floor(frames.length * p))] ?? 0;
  console.log(`medal bench · ${W}x${H} · ${KILLS} KILL medals, ${KILL_SPACING_MS} ms apart (minus the same window at rest)`);
  console.log(`  frames: ${frames.length} · median ${pct(0.5).toFixed(1)} ms · p95 ${pct(0.95).toFixed(1)} · max ${pct(1).toFixed(1)}`);
  for (const [k, v] of Object.entries(sums)) {
    const ms = (v.ms - idleSums[k].ms) / KILLS;
    const n = (v.n - idleSums[k].n) / KILLS;
    console.log(`  ${k.padEnd(14)} ${ms.toFixed(2).padStart(8)} ms/kill   ${n.toFixed(0).padStart(5)} events/kill`);
  }
  if (failed.size) {
    console.log("  NOT composited (main-thread animations):");
    for (const [k, n] of [...failed].sort((a, c) => c[1] - a[1])) console.log(`    ${String(n).padStart(4)}×  ${k}`);
  } else console.log("  every animation composited");
  const errs = b.logs.filter((l) => /EXC|error/.test(l));
  if (errs.length) console.log("page errors:", errs.slice(0, 6));
} finally {
  b.close();
}
process.exit(0);

/** Rendering work of a trace (complete events "X" + begin/end pairs "B"/"E"). */
function aggregate(list) {
  const WATCH = {
    "Recalc style": ["UpdateLayoutTree", "RecalculateStyles"],
    Layout: ["Layout"],
    "Pre-paint": ["PrePaint"],
    "Paint (main)": ["Paint"],
    Layerize: ["Layerize", "UpdateLayer", "UpdateLayerTree"],
    Commit: ["Commit", "ProxyMain::BeginMainFrame::commit"],
    "Raster tasks": ["RasterTask"],
  };
  const sums = Object.fromEntries(Object.keys(WATCH).map((k) => [k, { ms: 0, n: 0 }]));
  const open = new Map();
  for (const e of list) {
    const key = Object.keys(WATCH).find((k) => WATCH[k].includes(e.name));
    if (!key) continue;
    if (e.ph === "X") {
      sums[key].ms += (e.dur ?? 0) / 1000;
      sums[key].n++;
    } else if (e.ph === "B") open.set(`${e.tid}:${e.name}`, e.ts);
    else if (e.ph === "E") {
      const ts = open.get(`${e.tid}:${e.name}`);
      if (ts !== undefined) {
        sums[key].ms += (e.ts - ts) / 1000;
        sums[key].n++;
        open.delete(`${e.tid}:${e.name}`);
      }
    }
  }
  return sums;
}

/**
 * Blink CompositorAnimations::FailureReason bits → names (compositor_animations.h;
 * bits 11-13 as Lighthouse's non-composited-animations audit reads them).
 */
function failureNames(mask) {
  const NAMES = [
    "AcceleratedAnimationsDisabled", "EffectSuppressedByDevtools", "InvalidAnimationOrEffect",
    "UnsupportedTimingParameters", "NonReplaceCompositeMode", "TargetHasInvalidCompositingState",
    "TargetHasIncompatibleAnimations", "TargetHasCSSOffset", "(obsolete) MultipleTransformProperties",
    "AffectsNonCSSProperties", "TransformCannotBeAcceleratedOnTarget", "TransformDependsOnBoxSize",
    "FilterMayMovePixels", "UnsupportedCSSProperty", "(obsolete) MultipleTransformAnimations",
    "MixedKeyframeValueTypes", "TimelineSourceInvalidCompositingState", "NoVisibleChange",
    "AffectsImportantProperty", "SVGTargetHasIndependentTransformProperty",
  ];
  const out = [];
  for (let i = 0; i < 31; i++) if (mask & (1 << i)) out.push(NAMES[i] ?? `bit${i}`);
  return out.join("+");
}
