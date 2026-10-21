// HUD frame bench — what the in-match HUD costs its renderer process, frame
// by frame, at rest and through events. The REAL HUD document (hud.html, its
// runtime, markup and stylesheets) in its sandboxed iframe — its own process,
// as in production — driven at the display rate by a scripted match
// (hud-frame-scenario.ts: the batches the game posts, one per frame, with the
// game's per-frame HUD block), while Chrome traces every process. Per phase
// (rest, continuous fire with hits, headshot kill, its tail, damage taken,
// reload, rest again), for the HUD document's process:
//   main frames · style recalcs · layouts · pre-paints · paints · layerize ·
//   commits · raster tasks (tiles, and per layer) · compositor frames ·
//   main-thread busy and its longest task · the display compositor's render
//   passes per frame (1 = the root alone; each mask / filter / group opacity
//   over composited content adds an offscreen one), the HUD's own "rendu"
//   stat (DebugHUD's HUD line), the composited layers (LayerTree: count,
//   drawing area, repaints per layer), the invalidations
//   behind the style / layout / paint work (--invalidations), and the
//   animations Chrome could not hand to the compositor.
//
//   node tools/perf/hud-frame-bench.mjs [options]
//     --base <rev>       also measure that commit's HUD (git archive), alternated with this tree
//     --runs N           runs per tree (default 1), alternated
//     --size WxH         viewport (default 960x540, DPR 1)
//     --primary <plate>  paintball (default) | popcorn | famas | frisbee
//     --spear            the spear's ability chip shows (melee = spear)
//     --set events|states  events (default): rest + one kind of event per phase; states: every lasting
//                        HUD state held in turn (moods, death, knockdown, dash refill, hurry, chip, combo
//                        rope, each plate at rest / low / reloading) — --primary is then ignored
//     --phases a,b       subset of the set's phases (events: rest,fire,kill,afterKill,hurt,reload,late)
//     --rest N           frames of the rest phases (default 240)
//     --diag <list>      `?diag=` of the HUD document (this tree only; e.g. nohudidle)
//     --invalidations    + invalidation tracking (heavier trace)
//     --layers           + the composited layers, their repaints and raster tasks per layer
//                        (DevTools LayerTree agent). The agent itself makes the HUD's process
//                        run a main frame — style, pre-paint, layerize, commit — at EVERY frame:
//                        with it, read the paints / tiles / layouts, not the main frames.
//     --css <rules>      extra CSS injected into the HUD document after its warm-up
//                        (what-if: e.g. "*{animation:none!important}")
//     --restart <sel>    at the start of each traced phase, the elements matching <sel> are
//                        taken out of the layout for 2 frames: their animations start again
//                        inside the trace, which then says which ones Chrome could not
//                        hand to the compositor, and why ("NOT composited")
//     --gpu-raster       GPU rasterization + compositing (default: software, as the other benches)
//     --paint-draws      keep the plate paint's raymarch draws (skipped by default: CPU-emulated GPU)
//     --out <dir>        report.json (default: tmp)
// Needs Playwright (env HARNESS_PLAYWRIGHT: its index.mjs, default
// "playwright") and esbuild (env HARNESS_ESBUILD, default the repo's). Env
// HARNESS_FONTS: a module exporting routeStandinFonts(page), when Google Fonts
// is unreachable (bench sandbox). Headless + SwiftShader: compare counts and
// times between trees on the same machine, not with a real GPU.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);
const [W, H] = opt("size", "960x540").split("x").map(Number);
const BASE = opt("base", null);
const RUNS = Number(opt("runs", "1"));
const PRIMARY = opt("primary", "paintball");
const SPEAR = flag("spear");
const PHASES = opt("phases", null)?.split(",") ?? undefined;
const REST = Number(opt("rest", "240"));
const DIAG = opt("diag", "");
const LAYERTREE = flag("layers");
const EXTRA_CSS = opt("css", "");
const RESTART = opt("restart", "");
const INVALIDATIONS = flag("invalidations");
const GPU_RASTER = flag("gpu-raster");
/**
 * The plates' paint raymarch (its own WebGL context) runs on the bench's
 * CPU-emulated GPU, shared with the compositor: seconds per frame at the
 * plate's size. Its draws are skipped unless `--paint-draws` (the canvas is
 * still cleared and presented at the same cadence: same compositing work).
 */
const PAINT_DRAWS = flag("paint-draws");
const out = path.resolve(opt("out", path.join(os.tmpdir(), "hud-frame-bench")));
fs.mkdirSync(out, { recursive: true });

const asUrl = (spec) => (/[\\/]/.test(spec) ? pathToFileURL(spec).href : spec);
const { chromium } = await import(asUrl(process.env.HARNESS_PLAYWRIGHT ?? "playwright"));
const fonts = process.env.HARNESS_FONTS ? await import(asUrl(process.env.HARNESS_FONTS)) : null;
const esbuild = process.env.HARNESS_ESBUILD
  ? await import(asUrl(process.env.HARNESS_ESBUILD))
  : createRequire(path.join(root, "package.json"))("esbuild");

// ---------------------------------------------------------------------------
// Trees + builds: the HUD document of each tree; the host + scenario of this one.
// ---------------------------------------------------------------------------
const rawPlugin = {
  name: "raw",
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: path.resolve(a.resolveDir, a.path.slice(0, -4)), namespace: "raw" }));
    b.onLoad({ filter: /.*/, namespace: "raw" }, (a) => ({ contents: fs.readFileSync(a.path, "utf8"), loader: "text" }));
  },
};
const build = (dir, entry, file, extra = {}) =>
  esbuild.build({
    bundle: true,
    format: "esm",
    target: "es2022",
    logLevel: "error",
    define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production" }) },
    plugins: [rawPlugin],
    nodePaths: [path.join(root, "node_modules")],
    absWorkingDir: dir,
    entryPoints: [entry],
    outfile: path.join(out, file),
    ...extra,
  });

const trees = [{ name: "cur", dir: root, diag: DIAG }];
if (BASE) {
  const dir = path.join(out, `base-${BASE}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const tar = execFileSync("git", ["-C", root, "archive", "--format=tar", BASE, "--", "src", "shared", "hud.html", "index.html", ":!src/assets"], { maxBuffer: 1 << 30 });
  execFileSync("tar", ["-x", "-C", dir], { input: tar });
  // Binary assets and packages: this tree's.
  fs.symlinkSync(path.join(root, "src/assets"), path.join(dir, "src/assets"));
  for (const entry of ["node_modules", "public"]) {
    if (fs.existsSync(path.join(root, entry))) fs.symlinkSync(path.join(root, entry), path.join(dir, entry));
  }
  trees.unshift({ name: "base", dir, diag: "" });
}
for (const t of trees) await build(t.dir, path.join(t.dir, "src/hud/runtime/frameEntry.ts"), `${t.name}/frame.js`);
await build(root, path.join(root, "tools/hud-preview/runtime-entry.ts"), "entry.js");
await build(root, path.join(here, "hud-frame-scenario.ts"), "scenario.mjs", { platform: "node" });
const { buildBench } = await import(pathToFileURL(path.join(out, "scenario.mjs")).href);
const SET = opt("set", "events");
const bench = buildBench(W, H, { set: SET, primary: PRIMARY, spear: SPEAR, rest: REST, phases: PHASES });

// ---------------------------------------------------------------------------
// One server per tree (the HUD document's stylesheets are absolute /src/ paths).
// ---------------------------------------------------------------------------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".map": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp" };
const FONTS_LINK =
  '<link href="https://fonts.googleapis.com/css2?family=Luckiest+Guy&family=Baloo+2:wght@400;500;600;700&display=swap" rel="stylesheet" />';
const BACKDROP = `<style>#app{position:fixed;inset:0;will-change:transform;background:
  repeating-linear-gradient(115deg,rgba(255,255,255,.08) 0 18px,rgba(0,0,0,0) 18px 40px),
  radial-gradient(circle at 30% 40%,#5fa8d3 0,#2d6a4f 45%,#1b263b 100%)}</style>`;
async function serve(tree) {
  const index = fs.readFileSync(path.join(tree.dir, "index.html"), "utf8");
  const links = [...index.matchAll(/<link rel="stylesheet" href="\/(src\/[^"]+\.css)"\s*\/?>/g)].map((m) => `<link rel="stylesheet" href="/${m[1]}" />`).join("\n");
  const host = `<!doctype html><html lang="en" class="hud-menu-active"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />${FONTS_LINK}${links}${BACKDROP}</head>
<body><div id="app"></div><div id="debug"></div><script type="module" src="/__out/entry.js"></script></body></html>`;
  let hud = fs.readFileSync(path.join(tree.dir, "hud.html"), "utf8");
  const script = '<script type="module" src="/src/hud/runtime/frameEntry.ts"></script>';
  if (!hud.includes(script)) throw new Error(`${tree.name}: hud.html: frameEntry script tag not found`);
  hud = hud.replace(script, `<script type="module" crossorigin src="/__out/${tree.name}/frame.js"></script>`);
  hud = hud.replace(/<link rel="stylesheet" href="\/src\//g, '<link rel="stylesheet" crossorigin href="/src/');
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://bench");
    const send = (code, type, body) => {
      res.writeHead(code, { "content-type": type, "access-control-allow-origin": "*", "cache-control": "no-store" });
      res.end(body);
    };
    if (u.pathname === "/") return send(200, MIME[".html"], host);
    if (u.pathname === "/hud.html") return send(200, MIME[".html"], hud);
    const rel = decodeURIComponent(u.pathname);
    const file = rel.startsWith("/__out/") ? path.join(out, rel.slice(7)) : path.join(tree.dir, rel);
    fs.readFile(file, (err, body) => (err ? send(404, "text/plain", "not found") : send(200, MIME[path.extname(file)] ?? "application/octet-stream", body)));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
for (const t of trees) Object.assign(t, await serve(t));

// ---------------------------------------------------------------------------
// Browser + tracing
// ---------------------------------------------------------------------------
const browser = await chromium.launch({
  headless: true,
  args: [
    "--site-per-process",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--ignore-gpu-blocklist",
    ...(GPU_RASTER ? ["--enable-gpu-rasterization"] : ["--disable-gpu-compositing"]),
    ...(opt("chrome-args", "") || "").split(" ").filter(Boolean),
  ],
});
const CATS = [
  "toplevel",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "viz",
  ...(INVALIDATIONS ? ["disabled-by-default-devtools.timeline.invalidationTracking"] : []),
];
const bcdp = await browser.newBrowserCDPSession();
let events = [];
let traceDone = null;
bcdp.on("Tracing.dataCollected", (e) => {
  for (const ev of e.value) events.push(ev);
});
bcdp.on("Tracing.tracingComplete", () => traceDone?.());
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0)}s]`, ...a);

async function runTree(tree, run) {
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(180_000);
  const logs = [];
  page.on("pageerror", (e) => logs.push(`pageerror ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()} ${m.text()}`);
    if (process.env.BENCH_DEBUG) console.log(`  [console ${m.type()}] ${m.text().slice(0, 300)}`);
  });
  if (fonts) await fonts.routeStandinFonts(page);
  await context.addInitScript(() => {
    if (!location.pathname.endsWith("/hud.html") || !location.search.includes("bench_nodraw")) return;
    for (const P of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype]) {
      for (const name of ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced", "drawRangeElements"]) {
        if (P[name]) P[name] = function () {};
      }
    }
  });
  const hudSrc = `/hud.html?vt=0${PAINT_DRAWS ? "" : "&bench_nodraw=1"}${tree.diag ? `&diag=${encodeURIComponent(tree.diag)}` : ""}`;
  await page.goto(`${tree.base}/?mode=frame&vt=0&hud=${encodeURIComponent(hudSrc)}`);
  await page.waitForFunction(() => window.hh);
  await page.evaluate(() => window.hh.loaded());
  const ok = await Promise.race([
    page.evaluate((init) => window.hh.boot(init), bench.init),
    new Promise((r) => setTimeout(() => r("timeout"), 60_000)),
  ]);
  if (ok !== true) {
    const state = await page.evaluate(() => ({ errors: window.hh.errors, log: window.hh.log })).catch((e) => String(e));
    throw new Error(`${tree.name}: HUD did not boot (${ok}): ${JSON.stringify(state)} · page logs ${JSON.stringify(logs.slice(0, 10))}`);
  }
  const warmed = await Promise.race([page.evaluate(() => window.hh.warmUp(16)).then(() => true), new Promise((r) => setTimeout(() => r(false), 120_000))]);
  if (!warmed) throw new Error(`${tree.name}: HUD warm-up did not finish: ${JSON.stringify(await page.evaluate(() => ({ errors: window.hh.errors, log: window.hh.log })))}`);
  // The game's frame loop: one batch per display frame.
  await page.evaluate(() => {
    window.__play = (frames) =>
      new Promise((resolve) => {
        let i = 0;
        const step = () => {
          if (i >= frames.length) return resolve(performance.now());
          window.hh.send({ t: "batch", cmds: frames[i++] });
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
  });
  const play = (frames) => page.evaluate((f) => window.__play(f), frames);
  await play(bench.start);
  const hudFrame = page.frames().find((f) => f.url().includes("/hud.html"));
  const lt = { layers: new Map(), last: [], paints: [], phase: "start" };
  if (EXTRA_CSS && hudFrame) {
    await hudFrame.evaluate((css) => {
      const style = document.createElement("style");
      style.textContent = css;
      document.head.appendChild(style);
    }, EXTRA_CSS);
  }
  const cdp = hudFrame && LAYERTREE ? await context.newCDPSession(hudFrame) : null;
  if (cdp) {
    cdp.on("LayerTree.layerTreeDidChange", (e) => {
      if (e.layers) {
        lt.last = e.layers;
        for (const l of e.layers) lt.layers.set(l.layerId, l);
      }
    });
    cdp.on("LayerTree.layerPainted", (e) => lt.paints.push({ phase: lt.phase, id: e.layerId, w: e.clip.width, h: e.clip.height }));
    await cdp.send("LayerTree.enable");
  }
  // (Enabling the layer agent repaints every layer once: not counted.)
  await play(bench.start.slice(-60));
  const result = { tree: tree.name, run, phases: {}, logs };
  for (const phase of bench.phases) {
    if (phase.lead.length) await play(phase.lead);
    lt.phase = phase.name;
    const statsFrom = await page.evaluate(() => window.hh.stats.length);
    events = [];
    await bcdp.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: CATS, recordMode: "recordAsMuchAsPossible" } });
    // Marks the HUD document's process in the trace.
    await hudFrame?.evaluate(() => console.timeStamp("hud-frame-bench"));
    if (RESTART && hudFrame) {
      await hudFrame.evaluate(
        (sel) =>
          new Promise((resolve) => {
            const els = [...document.querySelectorAll(sel)];
            for (const el of els) el.style.display = "none";
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                for (const el of els) el.style.display = "";
                resolve();
              }),
            );
          }),
        RESTART,
      );
    }
    const t0 = await page.evaluate(() => performance.now());
    const t1 = await play(phase.frames);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const done = new Promise((r) => (traceDone = r));
    await bcdp.send("Tracing.end");
    await done;
    const stats = await page.evaluate((from) => window.hh.stats.slice(from), statsFrom);
    const s = analyse(events, phase.frames.length);
    s.wallMs = Math.round(t1 - t0);
    s.hudStats = summarizeStats(stats);
    const drawing = lt.last.filter((l) => l.drawsContent && !l.invisible);
    s.layers = { count: lt.last.length, drawing: drawing.length, areaKpx: Math.round(drawing.reduce((a, l) => a + l.width * l.height, 0) / 1e3) };
    result.phases[phase.name] = s;
    log(`${tree.name}#${run} ${phase.name}: ${line(s)}`);
    events = [];
  }
  // Repaints per layer and phase.
  if (cdp) {
    await cdp.send("DOM.getDocument", { depth: 0 }).catch(() => {});
    const describe = async (l) => {
      if (!l?.backendNodeId) return "?";
      try {
        const { nodeIds } = await cdp.send("DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: [l.backendNodeId] });
        if (!nodeIds[0]) return "?";
        const { node } = await cdp.send("DOM.describeNode", { nodeId: nodeIds[0] });
        const at = {};
        for (let k = 0; k < (node.attributes ?? []).length; k += 2) at[node.attributes[k]] = node.attributes[k + 1];
        return `<${node.localName || node.nodeName}${at.id ? "#" + at.id : ""}${at.class ? "." + at.class.split(" ").slice(0, 3).join(".") : ""}>`;
      } catch {
        return "?";
      }
    };
    const agg = new Map();
    for (const p of lt.paints) {
      if (p.phase === "start") continue;
      const a = agg.get(p.id) ?? {};
      const k = (a[p.phase] ??= { n: 0, px: 0 });
      k.n++;
      k.px += p.w * p.h;
      agg.set(p.id, a);
    }
    const rows = [];
    for (const l of [...lt.last].sort((a, b) => b.width * b.height - a.width * a.height)) {
      let reasons = "";
      try {
        const r = await cdp.send("LayerTree.compositingReasons", { layerId: l.layerId });
        reasons = (r.compositingReasonIds ?? r.compositingReasons ?? []).join(",");
      } catch {
        reasons = "(gone)";
      }
      const rasters = {};
      for (const [name, ph] of Object.entries(result.phases)) if (ph.rasterByLayer[l.layerId]) rasters[name] = ph.rasterByLayer[l.layerId];
      rows.push({ layer: await describe(l), size: `${Math.round(l.width)}x${Math.round(l.height)}`, draws: !!l.drawsContent, repaints: agg.get(l.layerId) ?? {}, rasters, reasons });
    }
    // Raster of layers no longer in the tree (transient layers).
    const known = new Set(lt.last.map((l) => String(l.layerId)));
    const goneRaster = {};
    for (const [name, ph] of Object.entries(result.phases)) {
      for (const [id, n] of Object.entries(ph.rasterByLayer)) if (!known.has(String(id))) goneRaster[`${id}`] = { ...(goneRaster[id] ?? {}), [name]: n };
    }
    for (const [id, rasters] of Object.entries(goneRaster)) {
      const l = lt.layers.get(id) ?? lt.layers.get(Number(id));
      rows.push({ layer: `(gone) ${l ? await describe(l) : "layer " + id}`, size: l ? `${Math.round(l.width)}x${Math.round(l.height)}` : "?", draws: true, repaints: {}, rasters, reasons: "" });
    }
    for (const [id, a] of agg) {
      if (lt.last.some((l) => l.layerId === id)) continue;
      const l = lt.layers.get(id);
      rows.push({ layer: `(gone) ${await describe(l)}`, size: l ? `${Math.round(l.width)}x${Math.round(l.height)}` : "?", draws: true, repaints: a, reasons: "" });
    }
    result.layerRows = rows;
  }
  result.errors = await page.evaluate(() => window.hh.errors);
  await context.close();
  return result;
}

const report = { size: `${W}x${H}`, set: SET, primary: PRIMARY, spear: SPEAR, raster: GPU_RASTER ? "gpu" : "software", base: BASE, diag: DIAG, runs: [] };
try {
  for (let run = 0; run < RUNS; run++) {
    for (const t of trees) report.runs.push(await runTree(t, run));
  }
} finally {
  await browser.close();
  for (const t of trees) t.server.close();
}
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 1));

// ---------------------------------------------------------------------------
// Summary: per phase, per tree (mean over runs) — per FRAME of the scenario.
// ---------------------------------------------------------------------------
const phaseNames = bench.phases.map((p) => p.name);
console.log(`\nHUD frame bench · ${W}x${H} · ${PRIMARY}${SPEAR ? " + spear" : ""} · ${report.raster} raster · per scenario frame (HUD document's process)`);
console.log(`${"phase".padEnd(10)} ${"tree".padEnd(5)} ${["mainFr", "style", "layout", "prePnt", "paint", "layrz", "commit", "tiles", "tileMs", "drawFr", "busyMs", "worst", "rendu", "dispMs", "passes"].map((s) => s.padStart(7)).join("")}`);
for (const name of phaseNames) {
  for (const t of trees) {
    const runs = report.runs.filter((r) => r.tree === t.name).map((r) => r.phases[name]).filter(Boolean);
    if (!runs.length) continue;
    const avg = (f) => runs.reduce((a, s) => a + f(s), 0) / runs.length;
    const n = runs[0].frames;
    const cols = [
      avg((s) => s.main.mainFrame.n) / n,
      avg((s) => s.main.style.n) / n,
      avg((s) => s.main.layout.n) / n,
      avg((s) => s.main.prePaint.n) / n,
      avg((s) => s.main.paint.n) / n,
      avg((s) => s.main.layerize.n) / n,
      avg((s) => s.main.commit.n) / n,
      avg((s) => s.tiles.n) / n,
      avg((s) => s.tiles.ms) / n,
      avg((s) => s.drawFrames) / n,
      avg((s) => s.busyMs) / n,
      avg((s) => s.worstMs ?? 0),
      avg((s) => s.hudStats.renderMs ?? 0),
      avg((s) => (s.display.n ? s.display.ms / s.display.n : 0)),
      avg((s) => (s.display.n ? (s.display.passes ?? 0) / s.display.n : 0)),
    ];
    console.log(`${name.padEnd(10)} ${t.name.padEnd(5)} ${cols.map((v) => v.toFixed(2).padStart(7)).join("")}`);
  }
}
for (const r of report.runs) {
  for (const [name, s] of Object.entries(r.phases)) {
    const inv = Object.entries(s.inv).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const af = Object.entries(s.animFailed);
    if (!inv.length && !af.length) continue;
    console.log(`\n${r.tree}#${r.run} ${name}:`);
    for (const [k, n] of inv) console.log(`   inv ${String(n).padStart(5)}× ${k.slice(0, 140)}`);
    for (const [k, n] of af) console.log(`   NOT composited ${n}× ${k.slice(0, 150)}`);
  }
}
for (const r of report.runs.filter((x) => x.run === 0)) {
  console.log(`\n${r.tree}: layers (${r.layerRows?.length ?? 0}) — per phase: repaints | raster tasks (layers with neither omitted)`);
  for (const row of r.layerRows ?? []) {
    const reps = phaseNames.map((n) => `${row.repaints[n] ? row.repaints[n].n : "-"}|${row.rasters?.[n] ?? "-"}`.padStart(9)).join(" ");
    if (!Object.keys(row.repaints).length && !Object.keys(row.rasters ?? {}).length) continue;
    console.log(`   ${row.layer.slice(0, 46).padEnd(46)} ${row.size.padStart(9)} ${reps}  ${row.reasons.slice(0, 60)}`);
  }
  if (r.errors?.length || r.logs?.length) console.log(`   errors ${JSON.stringify(r.errors)} logs ${JSON.stringify(r.logs.slice(0, 5))}`);
}
console.log(`\nreport: ${path.join(out, "report.json")}`);
process.exit(0);

// ---------------------------------------------------------------------------
function summarizeStats(list) {
  const s = list.filter((m) => m.t === "stats");
  if (!s.length) return {};
  const avg = (k) => s.reduce((a, m) => a + (m[k] ?? 0), 0) / s.length;
  return { n: s.length, fps: +avg("fps").toFixed(1), applyMs: +avg("applyMs").toFixed(3), renderMs: +avg("renderMs").toFixed(3) };
}

function line(s) {
  const m = s.main;
  const f = (k) => `${m[k].n}`;
  return `mainFr ${f("mainFrame")} · style ${f("style")} · layout ${f("layout")} · prePaint ${f("prePaint")} · paint ${f("paint")} · layerize ${f("layerize")} · commit ${f("commit")} · tiles ${s.tiles.n} (${s.tiles.ms.toFixed(1)} ms) · drawFr ${s.drawFrames} · display ${s.display.n} (${s.display.ms} ms, ${s.display.passes ?? "?"} passes) · busy ${s.busyMs.toFixed(0)} ms (worst task ${s.worstMs ?? "?"} ms) · rendu ${s.hudStats.renderMs ?? "?"} ms · fps ${s.hudStats.fps ?? "?"} · layers ${s.layers?.count ?? "?"}`;
}

function analyse(list, frames) {
  const threads = new Map();
  let framesInfo = [];
  for (const e of list) {
    if (e.ph === "M" && e.name === "thread_name") threads.set(`${e.pid}:${e.tid}`, e.args.name);
    if (e.name === "TracingStartedInBrowser" && e.args?.data?.frames) framesInfo = e.args.data.frames;
  }
  // The HUD document's process: its console.timeStamp mark.
  let hudPid = null;
  for (const e of list) if (e.name === "TimeStamp" && e.args?.data?.message === "hud-frame-bench") hudPid = e.pid;
  if (hudPid === null) hudPid = framesInfo.find((f) => /\/hud\.html/.test(f.url ?? ""))?.processId ?? null;
  const KEYS = {
    style: ["UpdateLayoutTree"],
    layout: ["Layout"],
    prePaint: ["PrePaint"],
    paint: ["Paint"],
    layerize: ["Layerize"],
    commit: ["Commit"],
    mainFrame: ["BeginMainThreadFrame"],
    raf: ["FireAnimationFrame"],
  };
  const main = Object.fromEntries(Object.keys(KEYS).map((k) => [k, { n: 0, ms: 0 }]));
  const tiles = { n: 0, ms: 0 };
  /** Raster tasks per cc layer id (= the LayerTree domain's layerId). */
  const rasterByLayer = {};
  let busyMs = 0;
  /** The longest main-thread task of the phase (the worst frame's work, ms). */
  let worstMs = 0;
  let drawFrames = 0;
  const inv = {};
  const anim = new Map();
  const open = new Map();
  // The display compositor (GPU process): what drawing the whole screen costs per display frame.
  let gpuPid = null;
  for (const e of list) if (e.ph === "M" && e.name === "process_name" && e.args?.name === "GPU Process") gpuPid = e.pid;
  const display = { n: 0, ms: 0, passes: 0 };
  for (const e of list) {
    if (e.pid === gpuPid && e.name === "Display::DrawAndSwap" && e.ph === "X") {
      display.n++;
      display.ms += (e.dur ?? 0) / 1000;
    }
    // Render passes drawn by the display compositor: the root one + every
    // offscreen pass (mask, filter, group opacity of composited content…).
    if (e.pid === gpuPid && /DrawRenderPass$/.test(e.name) && (e.ph === "X" || e.ph === "B")) display.passes++;
    if (e.pid !== hudPid) continue;
    const th = threads.get(`${e.pid}:${e.tid}`) ?? "?";
    let dur = null;
    if (e.ph === "X") dur = (e.dur ?? 0) / 1000;
    else if (e.ph === "B") {
      open.set(`${e.tid}:${e.name}`, e.ts);
      continue;
    } else if (e.ph === "E") {
      const ts = open.get(`${e.tid}:${e.name}`);
      if (ts === undefined) continue;
      open.delete(`${e.tid}:${e.name}`);
      dur = (e.ts - ts) / 1000;
    }
    if (th === "CrRendererMain") {
      for (const [k, names] of Object.entries(KEYS)) {
        if (!names.includes(e.name)) continue;
        main[k].n++;
        main[k].ms += dur ?? 0;
      }
      if ((e.name === "ThreadControllerImpl::RunTask" || e.name === "RunTask") && dur !== null) {
        busyMs += dur;
        if (dur > worstMs) worstMs = dur;
      }
    }
    if (e.name === "RasterTask" && dur !== null) {
      tiles.n++;
      tiles.ms += dur;
      const id = e.args?.tileData?.layerId;
      if (id !== undefined) rasterByLayer[id] = (rasterByLayer[id] ?? 0) + 1;
    }
    if (e.name === "DrawFrame") drawFrames++;
    if (/InvalidationTracking/.test(e.name)) {
      const d = e.args?.data ?? {};
      const what = d.reason ?? d.changedClass ?? d.changedAttribute ?? d.changedId ?? d.changedPseudo ?? d.invalidationSet?.[0]?.classes?.join?.(".") ?? "";
      const key = `${e.name.replace("InvalidationTracking", "")} · ${d.nodeName ?? "?"} · ${what}`;
      inv[key] = (inv[key] ?? 0) + 1;
    }
    if (e.name === "Animation") {
      const d = e.args?.data ?? {};
      const id = e.id ?? e.id2?.local;
      const info = anim.get(id) ?? {};
      if (d.name) info.name = d.name;
      if (d.nodeName) info.node = d.nodeName;
      if (d.compositeFailed) {
        info.fail = d.compositeFailed;
        info.props = d.unsupportedProperties;
      }
      anim.set(id, info);
    }
  }
  const animFailed = {};
  for (const info of anim.values()) {
    if (!info.fail) continue;
    const key = `${info.name ?? "?"} (${info.node ?? "?"}) → 0x${info.fail.toString(16)} ${failureNames(info.fail)}${info.props?.length ? ` [${info.props.join(",")}]` : ""}`;
    animFailed[key] = (animFailed[key] ?? 0) + 1;
  }
  for (const v of Object.values(main)) v.ms = +v.ms.toFixed(2);
  return { hudPid, frames, main, tiles: { n: tiles.n, ms: +tiles.ms.toFixed(2) }, rasterByLayer, busyMs: +busyMs.toFixed(1), worstMs: +worstMs.toFixed(2), drawFrames, display: { n: display.n, ms: +display.ms.toFixed(1), passes: display.passes }, inv, animFailed };
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
  const o = [];
  for (let i = 0; i < 31; i++) if (mask & (1 << i)) o.push(NAMES[i] ?? `bit${i}`);
  return o.join("+");
}
