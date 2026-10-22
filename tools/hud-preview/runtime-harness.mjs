// HUD runtime harness: the in-match HUD driven by a scripted match
// (runtime-scenario.ts: the commands the game sends, frame by frame) in up to
// three documents, screenshots compared pixel for pixel at each checkpoint:
//   frame   the HUD in its sandboxed iframe (/hud.html), as in production;
//   inline  the same runtime in the page (the game's fallback);
//   old     the pre-change widgets, in the page, driven like Game drove them
//           (`--old <rev>`: a `git archive` of that commit + runtime-old-entry.ts).
// Time is virtual in the HUD document (runtime-vt.js) and every virtual
// frame is drawn (lockstep): every mode draws the same states, in the same
// order. Then the iframe's own checks, in real time: it keeps drawing while
// the page's thread is blocked (its own process), stats, error reports, the
// viewport refusal, CORS / fonts of the iframe.
//
//   node tools/hud-preview/runtime-harness.mjs [options]
//     --old <rev>        add the pre-change baseline (e.g. 2183242)
//     --size WxH --dpr   viewport (default 1280x720 @1; gaming PC: 2844x1600 --dpr 0.9)
//     --modes a,b        subset of frame,inline,old
//     --noise            every mode twice: its own run-to-run noise floor
//     --software         software raster + compositing: exact pixels (GPU raster
//                        anti-aliases edges slightly differently per compositor)
//     --settle N         real frames drawn per virtual frame (default 4)
//     --until <name>     stop the scenario at that checkpoint · --chrome-args "<flags>"
//     --fast             no lockstep drawing · --dump animation states · --no-checks
//     --rest             + each checkpoint AT REST: endless animations at their start
//     --diag <list>      the HUD's `?diag=` (e.g. hudanim: its previous animation CSS)
//     --out <dir>        report.json, screenshots, diff images (default: tmp)
// Chromium is started with --site-per-process (site isolation, as desktop
// Chrome). Needs Playwright (env HARNESS_PLAYWRIGHT: its index.mjs, default
// "playwright") and esbuild (the repo's, Vite's dependency). Env
// HARNESS_FONTS: a module exporting routeStandinFonts(page), when Google
// Fonts is unreachable (bench sandbox).
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
const [W, H] = opt("size", "1280x720").split("x").map(Number);
const DPR = Number(opt("dpr", "1"));
const OLD = opt("old", null);
/** `--diag <list>`: the `?diag=` of the HUD (its document in frame mode, the page in inline mode). */
const DIAG = opt("diag", "");
const MODES = opt("modes", OLD ? "frame,inline,old" : "frame,inline").split(",");
/** Draw every virtual frame (both modes then rasterize the same sequence of states); `--fast` skips it. */
const LOCKSTEP = !flag("fast");
/**
 * Real frames drawn per virtual frame in lockstep (`--settle N`). 4: each
 * state is committed, rasterized and drawn before the next one — with 2, the
 * compositor may skip rasterizing a commit, and a layer whose scale the JS
 * writes (damage numbers, combo rope) then keeps another raster scale from
 * one run to the next.
 */
const SETTLE = Number(opt("settle", "4"));
const out = path.resolve(opt("out", path.join(os.tmpdir(), "hud-runtime-harness")));
fs.mkdirSync(out, { recursive: true });

const asUrl = (spec) => (/[\\/]/.test(spec) ? pathToFileURL(spec).href : spec);
const { chromium } = await import(asUrl(process.env.HARNESS_PLAYWRIGHT ?? "playwright"));
const fonts = process.env.HARNESS_FONTS ? await import(asUrl(process.env.HARNESS_FONTS)) : null;
const esbuild = createRequire(path.join(root, "package.json"))("esbuild");

// ---------------------------------------------------------------------------
// Build: the HUD document's entry, the host entries, the scenario (Node).
// ---------------------------------------------------------------------------
/** Vite's `?raw` import: the file's text. */
const rawPlugin = {
  name: "raw",
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: path.resolve(a.resolveDir, a.path.slice(0, -4)), namespace: "raw" }));
    b.onLoad({ filter: /.*/, namespace: "raw" }, (a) => ({ contents: fs.readFileSync(a.path, "utf8"), loader: "text" }));
  },
};
const common = {
  bundle: true,
  format: "esm",
  target: "es2022",
  logLevel: "error",
  // Production flags: no DEV GPU timers (SwiftShader never answers them).
  define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production" }) },
  plugins: [rawPlugin],
  nodePaths: [path.join(root, "node_modules")],
};
const build = (dir, entry, file, extra = {}) =>
  esbuild.build({ ...common, absWorkingDir: dir, entryPoints: [entry], outfile: path.join(out, file), ...extra });
await build(root, path.join(root, "src/hud/runtime/frameEntry.ts"), "frame.js");
await build(root, path.join(here, "runtime-entry.ts"), "entry.js");
await build(root, path.join(here, "runtime-scenario.ts"), "scenario.mjs", { platform: "node" });

let oldDir = null;
if (OLD) {
  oldDir = path.join(out, "old-tree");
  fs.rmSync(oldDir, { recursive: true, force: true });
  fs.mkdirSync(oldDir, { recursive: true });
  const tar = execFileSync("git", ["-C", root, "archive", "--format=tar", OLD, "src", "shared", "index.html"], { maxBuffer: 1 << 30 });
  execFileSync("tar", ["-x", "-C", oldDir], { input: tar });
  fs.mkdirSync(path.join(oldDir, "tools/hud-preview"), { recursive: true });
  for (const f of ["runtime-host.ts", "runtime-old-entry.ts"]) {
    fs.copyFileSync(path.join(here, f), path.join(oldDir, "tools/hud-preview", f));
  }
  await build(oldDir, path.join(oldDir, "tools/hud-preview/runtime-old-entry.ts"), "old.js");
}

const { buildScenario } = await import(pathToFileURL(path.join(out, "scenario.mjs")).href);
const scenario = buildScenario(W, H);
// `--until <checkpoint>`: the scenario stops there (quick experiments).
const UNTIL = opt("until", null);
if (UNTIL) {
  const last = scenario.frames.findIndex((f) => f.checkpoint === UNTIL);
  if (last < 0) throw new Error(`no checkpoint ${UNTIL}`);
  scenario.frames.length = last + 1;
}
const checkpoints = scenario.frames.filter((f) => f.checkpoint).map((f) => f.checkpoint);

// ---------------------------------------------------------------------------
// Pages + server (every response CORS-open: the sandboxed HUD document has an
// opaque origin; its module script and stylesheets are CORS requests).
// ---------------------------------------------------------------------------
const vtJs = fs.readFileSync(path.join(here, "runtime-vt.js"), "utf8");
const FONTS_LINK =
  '<link href="https://fonts.googleapis.com/css2?family=Luckiest+Guy&family=Baloo+2:wght@400;500;600;700&display=swap" rel="stylesheet" />';
/**
 * The "game canvas" behind the HUD: same in every mode (gradients + stripes,
 * no text), in a composited layer of its own like the game's WebGL canvas —
 * the HUD then draws in layers above it, as in game, not into the page's
 * root layer.
 */
const BACKDROP = `<style>#app{position:fixed;inset:0;will-change:transform;background:
  repeating-linear-gradient(115deg,rgba(255,255,255,.08) 0 18px,rgba(0,0,0,0) 18px 40px),
  radial-gradient(circle at 30% 40%,#5fa8d3 0,#2d6a4f 45%,#1b263b 100%)}</style>`;
const sheetsOf = (html) => [...html.matchAll(/<link rel="stylesheet" href="\/(src\/[^"]+\.css)"\s*\/?>/g)].map((m) => m[1]);

function hostPage(mode, vt) {
  const old = mode === "old";
  const index = fs.readFileSync(path.join(old ? oldDir : root, "index.html"), "utf8");
  const links = sheetsOf(index)
    .map((s) => `<link rel="stylesheet" href="/${old ? "old/" : ""}${s}" />`)
    .join("\n");
  // The game page's gameplay part: the legacy overlay, then the HUD (old: the
  // static markup, debug panel inside; now: the debug panel only).
  const hud = old ? index.slice(index.indexOf('<div id="hud"'), index.indexOf('<script type="module"')) : '<div id="debug"></div>';
  return `<!doctype html>
<html lang="en"${old ? "" : ' class="hud-menu-active"'}>
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
${vt && mode !== "frame" ? `<script>${vtJs}</script>` : ""}
${FONTS_LINK}
${links}
${BACKDROP}
</head>
<body>
<div id="app"></div>
<div id="overlay" class="hidden"></div>
${hud}
<script type="module" src="/__out/${old ? "old" : "entry"}.js"></script>
</body>
</html>`;
}

function hudPage(vt) {
  let html = fs.readFileSync(path.join(root, "hud.html"), "utf8");
  const script = '<script type="module" src="/src/hud/runtime/frameEntry.ts"></script>';
  if (!html.includes(script)) throw new Error("hud.html: frameEntry script tag not found");
  // As Vite builds it: the bundle, module script and stylesheets with `crossorigin`.
  html = html.replace(script, '<script type="module" crossorigin src="/__out/frame.js"></script>');
  html = html.replace(/<link rel="stylesheet" href="\/src\//g, '<link rel="stylesheet" crossorigin href="/src/');
  if (vt) html = html.replace("<head>", `<head>\n<script>${vtJs}</script>`);
  return html;
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".map": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const corsLog = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://harness");
  const send = (code, type, body) => {
    res.writeHead(code, { "content-type": type, "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end(body);
  };
  if (req.headers.origin) corsLog.push(`${req.headers.origin} ${u.pathname}`);
  if (u.pathname === "/") return send(200, MIME[".html"], hostPage(u.searchParams.get("mode") ?? "inline", u.searchParams.get("vt") !== "0"));
  if (u.pathname === "/hud.html") return send(200, MIME[".html"], hudPage(u.searchParams.get("vt") !== "0"));
  const rel = decodeURIComponent(u.pathname);
  const file = rel.startsWith("/__out/")
    ? path.join(out, rel.slice(7))
    : rel.startsWith("/old/") && oldDir
      ? path.join(oldDir, rel.slice(5))
      : path.join(root, rel);
  fs.readFile(file, (err, body) => (err ? send(404, "text/plain", "not found") : send(200, MIME[path.extname(file)] ?? "application/octet-stream", body)));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------
// `--software`: software rasterization and compositing, exact and
// reproducible. With Chrome's GPU rasterizer, a few edge pixels vary from
// run to run, and the iframe's compositor anti-aliases edges a little
// differently from the page's (1-5 levels out of 255, same geometry and
// colors) — a frame-vs-inline comparison then shows those edges.
const SOFTWARE = flag("software");
/**
 * A device pixel ratio ≠ 1 comes from the browser itself, as on a machine
 * (OS scaling, browser zoom: every frame of the page gets it). Playwright's
 * deviceScaleFactor emulation only reaches the page: the out-of-process
 * iframe would see 1 — and refuse to init (viewport guard), rightly.
 */
const BROWSER_DSF = DPR !== 1;
const browser = await chromium.launch({
  headless: true,
  args: [
    ...(BROWSER_DSF ? [`--force-device-scale-factor=${DPR}`, `--window-size=${W},${H}`] : []),
    "--site-per-process",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--ignore-gpu-blocklist",
    ...(SOFTWARE ? ["--disable-gpu-compositing", "--disable-gpu-rasterization"] : []),
    ...(opt("chrome-args", "") || "").split(" ").filter(Boolean),
  ],
});
const report = { size: `${W}x${H}@${DPR}`, raster: SOFTWARE ? "software" : "gpu", old: OLD, modes: {}, pairs: {}, checks: {} };
/** `--dump`: animation states per mode / checkpoint (animations.json). */
const dumps = {};

async function newPage() {
  const context = await browser.newContext(BROWSER_DSF ? { viewport: null } : { viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  const logs = [];
  page.on("pageerror", (e) => logs.push(`pageerror ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()} ${m.text()}`);
  });
  if (fonts) await fonts.routeStandinFonts(page);
  return { context, page, logs };
}

async function runMode(mode, tag = mode) {
  const { context, page, logs } = await newPage();
  const t0 = Date.now();
  await page.goto(`${base}/?mode=${mode}&settle=${SETTLE}${DIAG ? `&diag=${encodeURIComponent(DIAG)}` : ""}`);
  await page.waitForFunction(() => window.hh);
  await page.evaluate(() => window.hh.loaded());
  const ok = await page.evaluate((init) => window.hh.boot(init), scenario.init);
  if (!ok) throw new Error(`${tag}: HUD refused to boot: ${JSON.stringify(await page.evaluate(() => window.hh.errors))}`);
  await page.evaluate(([ms, lockstep]) => window.hh.warmUp(ms, lockstep), [scenario.frameMs, LOCKSTEP]);
  const hudDoc = () => (mode === "frame" ? page.frames().find((f) => f.url().includes("/hud.html")) : page.mainFrame());
  // Stacking-relevant structure: the HUD document's body children in order,
  // and where the debug panel sits (page) — the same order in every mode.
  const describe = () => {
    const name = (e) => (e.id ? `#${e.id}` : e.className ? `.${String(e.className).split(" ")[0]}` : e.tagName.toLowerCase());
    const d = document.getElementById("debug");
    return {
      body: [...document.body.children].filter((e) => e.tagName !== "SCRIPT").map(name),
      debug: d ? `${name(d.parentElement)} after ${d.previousElementSibling ? name(d.previousElementSibling) : "-"}` : null,
    };
  };
  const structure = { hud: await hudDoc().evaluate(describe), page: mode === "frame" ? await page.evaluate(describe) : undefined };
  if (flag("dump")) {
    dumps[`${tag}/after-warmup`] = await hudDoc().evaluate(() => ({
      root: document.documentElement.className,
      hud: document.getElementById("hud")?.className,
      hudDisplay: getComputedStyle(document.getElementById("hud")).display,
      animations: document.getAnimations().length,
      now: window.__vt?.now(),
    }));
  }
  const shots = {};
  let i = 0;
  while (i < scenario.frames.length) {
    let j = i;
    while (j < scenario.frames.length - 1 && !scenario.frames[j].checkpoint) j++;
    const chunk = scenario.frames.slice(i, j + 1).map((f) => ({ cmds: f.cmds }));
    await page.evaluate(([list, ms, lockstep]) => window.hh.frames(list, ms, lockstep), [chunk, scenario.frameMs, LOCKSTEP]);
    const name = scenario.frames[j].checkpoint;
    if (name) {
      await page.evaluate(() => window.hh.sync());
      shots[name] = await page.screenshot();
      fs.writeFileSync(path.join(out, `${tag}-${name}.png`), shots[name]);
      if (flag("rest")) {
        // The same state AT REST: every endless (idle) animation at its start
        // (leaves, blink, chevrons, rays, waves… at 0 %), the one-shot ones where
        // they are; then each back where it was (the next frames unchanged).
        await hudDoc().evaluate(() => {
          window.__restSaved = [];
          for (const a of document.getAnimations()) {
            if (a.effect?.getComputedTiming().endTime !== Infinity) continue;
            window.__restSaved.push([a, a.currentTime]);
            a.currentTime = 0;
          }
        });
        await page.evaluate(() => window.hh.sync());
        shots[`${name}-rest`] = await page.screenshot();
        fs.writeFileSync(path.join(out, `${tag}-${name}-rest.png`), shots[`${name}-rest`]);
        await hudDoc().evaluate(() => {
          for (const [a, t] of window.__restSaved) a.currentTime = t;
          window.__restSaved = null;
        });
        await page.evaluate(() => window.hh.sync());
      }
      if (flag("dump")) {
        // The HUD document's animations (name, target, time, state): what a
        // pixel difference between two modes comes from, timing or drawing.
        dumps[`${tag}/${name}`] = await hudDoc().evaluate(() =>
          document.getAnimations().map((a) => {
            const t = a.effect?.target;
            const id = t ? `${t.tagName.toLowerCase()}${t.id ? "#" + t.id : ""}.${[...t.classList].join(".")}` : "?";
            return `${id} ${a.animationName ?? a.transitionProperty ?? "waapi"} ${a.playState} ${Number(a.currentTime ?? -1).toFixed(3)}`;
          }),
        );
      }
    }
    i = j + 1;
  }
  const state = await page.evaluate(() => ({ errors: window.hh.errors, log: window.hh.log }));
  report.modes[tag] = { ms: Date.now() - t0, ...state, structure, pageLogs: logs.slice(0, 20) };
  await context.close();
  return shots;
}

/** Pixel comparison (in a blank page: no native image library needed). */
async function compare(page, a, b, name) {
  const r = await page.evaluate(
    async ([a64, b64]) => {
      const load = async (s) =>
        createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      const [ia, ib] = await Promise.all([load(a64), load(b64)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return { size: false };
      const w = ia.width;
      const h = ia.height;
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(ia, 0, 0);
      const da = g.getImageData(0, 0, w, h).data;
      g.clearRect(0, 0, w, h);
      g.drawImage(ib, 0, 0);
      const db = g.getImageData(0, 0, w, h).data;
      const diff = g.createImageData(w, h);
      let n = 0;
      let max = 0;
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let p = 0; p < da.length; p += 4) {
        const d = Math.max(Math.abs(da[p] - db[p]), Math.abs(da[p + 1] - db[p + 1]), Math.abs(da[p + 2] - db[p + 2]), Math.abs(da[p + 3] - db[p + 3]));
        const k = p / 4;
        if (d) {
          n++;
          if (d > max) max = d;
          const x = k % w, y = (k / w) | 0;
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
          diff.data[p] = 255;
          diff.data[p + 1] = d > 8 ? 0 : 200;
          diff.data[p + 3] = 255;
        } else {
          const v = (da[p] + da[p + 1] + da[p + 2]) / 9;
          diff.data[p] = diff.data[p + 1] = diff.data[p + 2] = v;
          diff.data[p + 3] = 255;
        }
      }
      let png = null;
      if (n) {
        g.putImageData(diff, 0, 0);
        const blob = await c.convertToBlob({ type: "image/png" });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let s = "";
        for (let q = 0; q < bytes.length; q += 0x8000) s += String.fromCharCode(...bytes.subarray(q, q + 0x8000));
        png = btoa(s);
      }
      return { size: true, pixels: w * h, n, max, bbox: n ? [x0, y0, x1, y1] : null, png };
    },
    [a.toString("base64"), b.toString("base64")],
  );
  if (r.png) fs.writeFileSync(path.join(out, `diff-${name}.png`), Buffer.from(r.png, "base64"));
  delete r.png;
  return r;
}

// ---------------------------------------------------------------------------
// The iframe's own checks (real time, no virtual clock).
// ---------------------------------------------------------------------------
async function frameChecks() {
  const checks = {};
  const { context, page, logs } = await newPage();
  const fontRequests = [];
  page.on("request", (req) => {
    if (/fonts\.(googleapis|gstatic)\.com/.test(req.url())) fontRequests.push(`${req.frame().url().includes("/hud.html") ? "iframe" : "page"} ${req.url().replace(/\?.*/, "")}`);
  });
  await page.goto(`${base}/?mode=frame&vt=0`);
  await page.waitForFunction(() => window.hh);
  await page.evaluate(() => window.hh.loaded());
  const t0 = Date.now();
  checks.ready = await page.evaluate((init) => window.hh.boot(init), scenario.init);
  checks.readyMs = Date.now() - t0;
  // Own process? (The host's own check, then a longer block.)
  checks.isolation80 = await page.evaluate(() => window.hh.isolationCheck(80));
  checks.block250 = await page.evaluate(async () => {
    const n0 = await window.hh.ping();
    const t = performance.now();
    window.hh.block(250);
    const blockedMs = performance.now() - t;
    const n1 = await window.hh.ping();
    return { n0, n1, frames: n1 - n0, blockedMs: Math.round(blockedMs) };
  });
  const cdp = await context.newCDPSession(page);
  const { targetInfos } = await cdp.send("Target.getTargets");
  checks.oopifTargets = targetInfos.filter((t) => t.type === "iframe").map((t) => t.url.replace(base, ""));
  // Stats (the iframe posts them every 500 ms); then a few frames of HUD traffic.
  await page.evaluate(() => window.hh.warmUp(16));
  await page.evaluate(([list, ms]) => window.hh.frames(list, ms), [scenario.frames.slice(0, 90).map((f) => ({ cmds: f.cmds })), 16]);
  await page.waitForTimeout(1200);
  checks.stats = await page.evaluate(() => window.hh.stats.slice(-3));
  // Errors: an unknown command is reported, the batch's other commands and
  // the next batches are still applied.
  await page.evaluate(() => {
    window.hh.send({ t: "batch", cmds: [["clock.set", 41], ["no.such.command"], ["combat.name", "after-error"]] });
    window.hh.send({ t: "batch", cmds: [["clock.set", 42]] });
  });
  await page.evaluate(() => window.hh.ping());
  const hudFrame = page.frames().find((f) => f.url().includes("/hud.html"));
  checks.afterError = await hudFrame.evaluate(() => ({
    clock: document.getElementById("mode-time")?.textContent,
    name: document.getElementById("buddy-name")?.textContent,
    fonts: [...document.fonts].filter((f) => f.status === "loaded").map((f) => `${f.family} ${f.weight}`),
    luckiest: document.fonts.check('16px "Luckiest Guy"'),
    html: document.documentElement.className,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    htmlBg: getComputedStyle(document.documentElement).backgroundColor,
    viewport: [innerWidth, innerHeight, devicePixelRatio],
  }));
  checks.errors = await page.evaluate(() => window.hh.errors);
  checks.fontRequests = [...new Set(fontRequests)];
  checks.pageLogs = logs.slice(0, 20);
  await context.close();
  // Viewport refusal: init with another size → an error instead of ready.
  {
    const { context: c2, page: p2 } = await newPage();
    await p2.goto(`${base}/?mode=frame&vt=0`);
    await p2.waitForFunction(() => window.hh);
    checks.viewportRefused = await p2.evaluate(
      (init) =>
        Promise.race([
          window.hh.boot(init, { width: innerWidth + 50, height: innerHeight, dpr: devicePixelRatio }).then((ok) => ({ ok })),
          new Promise((r) => setTimeout(() => r({ ok: "timeout" }), 6000)),
        ]).then((r) => ({ ...r, errors: window.hh.errors })),
      scenario.init,
    );
    await c2.close();
  }
  checks.cors = [...new Set(corsLog.filter((l) => l.startsWith("null ")))];
  return checks;
}

try {
  const shots = {};
  for (const mode of MODES) shots[mode] = await runMode(mode);
  // `--noise`: every mode twice — the noise floor of each.
  if (flag("noise")) for (const mode of MODES) shots[`${mode}#2`] = await runMode(mode, `${mode}#2`);
  const { context, page } = await newPage();
  await page.goto("about:blank");
  const pairs = [
    ["frame", "inline"],
    ["inline", "old"],
    ["frame", "old"],
    ["frame", "frame#2"],
    ["inline", "inline#2"],
    ["old", "old#2"],
  ].filter(([a, b]) => shots[a] && shots[b]);
  for (const [a, b] of pairs) {
    report.pairs[`${a} vs ${b}`] = {};
    for (const name of checkpoints) {
      report.pairs[`${a} vs ${b}`][name] = await compare(page, shots[a][name], shots[b][name], `${a}-${b}-${name}`.replace("#", ""));
    }
  }
  await context.close();
  if (!flag("no-checks") && MODES.includes("frame")) report.checks = await frameChecks();
} finally {
  await browser.close();
  server.close();
}
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
if (flag("dump")) fs.writeFileSync(path.join(out, "animations.json"), JSON.stringify(dumps, null, 1));
for (const [pair, cps] of Object.entries(report.pairs)) {
  const bad = Object.entries(cps).filter(([, r]) => r.n);
  console.log(`${pair}: ${bad.length === 0 ? "identical" : `${bad.length} differing`} (${Object.keys(cps).length} checkpoints)`);
  for (const [name, r] of bad) console.log(`   ${name}: ${r.n} px (max Δ ${r.max}) in ${JSON.stringify(r.bbox)}`);
}
for (const [mode, m] of Object.entries(report.modes)) console.log(`${mode}: ${m.ms} ms, errors ${JSON.stringify(m.errors)}, ${m.log.join(" · ")}${m.pageLogs.length ? `, logs ${JSON.stringify(m.pageLogs)}` : ""}`);
if (report.checks.block250) console.log("checks:", JSON.stringify(report.checks, null, 1));
console.log(`report: ${path.join(out, "report.json")}`);
