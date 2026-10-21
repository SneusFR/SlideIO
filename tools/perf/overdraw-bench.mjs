// OVERDRAW of the Givre world pass — how many times each pixel is shaded, per view and per draw.
//
// Boots the real game (DEV build: `window.__game`), enters solo play with no bot, freezes the
// simulation, then from each camera pose counts per pixel the fragments the GPU RASTERISES (no
// depth test), SHADES (pass the depth test in the real draw order and index order: ideal early-Z)
// and KEEPS (the visible surface) — see tools/perf/overdraw-probe.js — and what a depth prepass,
// re-ordered triangles or single-sided faces would leave. Prints a table per pose, writes the
// raw numbers (JSON) and one heat map per pose (PNG: 1 = blue, 2 = green, 3 = yellow, 4 = orange,
// 5 = red, 6 = magenta, 7+ = white shaded fragments; sky = black).
//
//   BASE=http://127.0.0.1:5173 OUT=/tmp/overdraw node tools/perf/overdraw-bench.mjs
//   env: BASE        page URL of a DEV build (npm run dev, or an esbuild bench build)
//        OUT         output folder (default ./overdraw-out): result-<Q>.json, heat-<Q>-<pose>.png
//        Q           LOW | HIGH (legacy preset key, default LOW)
//        W, H        viewport (default 960 × 540)
//        POSES       JSON list [{name,x,y,z,yaw,pitch}] (degrees) — default: the 8 spawns
//                    (shared/map/GivreSpawns.ts, eye 0.6 m above the capsule centre), the village
//                    centre (0, 1.6, 0) facing N/E/S/W, the north gallery, an elevated view
//        ONLY        comma list of pose names to run (subset of POSES)
//        ORDERS      index-order variants of the map batches (default "view,dir8,cell20"):
//                    view = per-view front-to-back (ideal), viewBack = back-to-front, dirN = static
//                    sort along the nearest of N horizontal directions, cellN = N-metre cells drawn
//                    front-to-back (≈ a finer grid split)
//        PREPASS     1 (default) = also count with a depth prepass of the map batches
//        PREPASSLITE comma list of areas (m², default none): also count with a prepass of only the
//                    map triangles of at least that area (big occluders: fewer prepass vertices)
//        FRONTSIDE   1 (default) = also count with every double-sided map batch FrontSide (and the
//                    number of pixels that changes)
//        SCENARIOS   comma list (default "base"): base = the game as is; near = batches sorted by
//                    the NEAREST point of their bounding sphere (z − r) instead of its centre;
//                    double = the double-sided map batches (walls, floors) before the single-
//                    sided solid batches, front to back inside each class;
//                    splitAxB = every map batch cut into A × B sub-batches (finer grid: more
//                    draws, culled and sorted by three like real batches); "+" combines
//                    (split2x2+near). The variants (PREPASS, ORDERS, FRONTSIDE) run in "base" only.
//        DIAG        value of `?diag=` for the page (compare the game's own switches)
//        PLAYWRIGHT  path of the playwright module (default "playwright"); FONTS: module exporting
//                    routeStandinFonts(page) (machines without Google Fonts)
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { installOverdrawProbe } from "./overdraw-probe.js";
import { selectPoses } from "./givre-poses.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:5173";
const OUT = resolve(process.env.OUT ?? "overdraw-out");
const Q = process.env.Q ?? "LOW";
const W = Number(process.env.W ?? 960);
const H = Number(process.env.H ?? 540);
const ORDERS = (process.env.ORDERS ?? "view,dir8,cell20").split(",").map((s) => s.trim()).filter(Boolean);
const PREPASS = (process.env.PREPASS ?? "1") === "1";
const PREPASSLITE = (process.env.PREPASSLITE ?? "").split(",").map(Number).filter((a) => a > 0);
const FRONTSIDE = (process.env.FRONTSIDE ?? "1") === "1";
const DIAG = process.env.DIAG ?? "";
const SCENARIOS = (process.env.SCENARIOS ?? "base").split(",").map((s) => s.trim()).filter(Boolean);
mkdirSync(OUT, { recursive: true });
const routeFonts = process.env.FONTS ? (await import(process.env.FONTS)).routeStandinFonts : null;

const POSES = selectPoses();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0)}s]`, ...a);

const browser = await chromium.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--disable-gpu-compositing", "--js-flags=--expose-gc"],
});
const result = { q: Q, w: W, h: H, diag: DIAG, orders: ORDERS, scenarios: {} };
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.setDefaultTimeout(0);
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 240));
  });
  page.on("pageerror", (e) => errors.push("pageerror " + e.message.slice(0, 240)));
  await page.addInitScript(() => {
    // Deterministic session (same décor animation phase, same everything).
    let s = 0x2f6b9a1d;
    Math.random = () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 4294967296;
    };
    // The probe restores the game's opaque sort after its own: remember what the game installs
    // (three keeps it in a closure, without a getter).
    Object.defineProperty(Object.prototype, "setOpaqueSort", {
      configurable: true,
      get() {
        return undefined;
      },
      set(fn) {
        const self = this;
        Object.defineProperty(self, "setOpaqueSort", {
          configurable: true,
          writable: true,
          value(method) {
            self.__odpOpaqueSort = method;
            return fn.call(self, method);
          },
        });
      },
    });
  });
  if (routeFonts) await routeFonts(page);
  await page.goto(`${BASE}/__out/blank.html`).catch(() => page.goto(`${BASE}/favicon.ico`));
  await page.evaluate((q) => {
    localStorage.clear();
    localStorage.setItem("slideio.mapId", "GIVRE");
    localStorage.setItem("beanzo.graphicsQuality", q);
    localStorage.setItem("beanzo.fpsCap", "OFF");
    localStorage.setItem("slideio.loadout.v1", JSON.stringify({ melee: "HAMMER", primary: "PAINTBALL_RIFLE" }));
  }, Q);
  await page.goto(`${BASE}/?hud=inline${DIAG ? `&diag=${DIAG}` : ""}`);
  await page.waitForFunction(() => document.getElementById("menu-loading")?.classList.contains("hidden"), null, { timeout: 900000, polling: 1000 });
  log(`${Q}: menu`);
  await page.evaluate(() => document.getElementById("menu-cta")?.click());
  await page.waitForFunction(() => !document.documentElement.classList.contains("hud-menu-active"), null, { timeout: 300000, polling: 500 });
  await page.evaluate(() => {
    const g = window.__game;
    g.input.pointerLocked = true;
    g.playerCombatant.health.protectionTimer = 1e9;
    g.botManager.setBotCount(0);
    g.rebuildHittables();
  });
  await sleep(2500);
  await page.evaluate(() => window.__game.renderer.setAnimationLoop(null));
  await sleep(500);
  const size = await page.evaluate(installOverdrawProbe);
  log(`${Q}: frozen, probe ${size.join("×")}`);

  for (const scen of SCENARIOS) {
    const setup = await page.evaluate((scen) => {
      const odp = window.__odp;
      const parts = scen.split("+");
      odp.setSort(parts.includes("near") ? "near" : parts.includes("double") ? "double" : "game");
      const split = parts.map((s) => /^split(\d+)x(\d+)$/.exec(s)).find(Boolean);
      return { meshes: odp.splitMap(split ? +split[1] : 0, split ? +split[2] : 0) };
    }, scen);
    log(`scenario ${scen}${setup.meshes ? ` (${setup.meshes} split meshes)` : ""}`);
    const rows = (result.scenarios[scen] = []);
    const full = scen === "base";
    for (const p of POSES) {
      const cap = await page.evaluate((p) => {
        window.__odp.pose(p);
        return window.__odp.capture();
      }, p);
      await page.evaluate(() => new Promise((r) => setTimeout(() => { window.gc?.(); r(); }, 30)));
      const spec = full ? { prepass: PREPASS, prepassLite: PREPASSLITE, orders: ORDERS, frontSide: FRONTSIDE } : {};
      const a = await page.evaluate((spec) => window.__odp.analyze(spec), spec);
      if (full) {
        const png = await page.evaluate(() => window.__odp.heatmap());
        writeFileSync(resolve(OUT, `heat-${Q}-${p.name}.png`), Buffer.from(png.split(",")[1], "base64"));
      }
      const items = cap.opaque.map((it, i) => ({ ...it, ...a.perItem[i] }));
      rows.push({ pose: p, calls: cap.calls, triangles: cap.triangles, sort: cap.sort, transparent: cap.transparent, ...a, perItem: items });
      printPose(p, a, items, `${scen} · ${cap.calls} draws / frame · sort ${cap.sort}`);
    }
    await page.evaluate(() => {
      window.__odp.setSort("game");
      window.__odp.splitMap(0);
    });
  }
  console.log(errors.length ? `console errors: ${errors.slice(0, 5).join(" | ")}` : "no console error");
  result.errors = errors;
} finally {
  await browser.close();
}
writeFileSync(resolve(OUT, `result-${Q}${DIAG ? `-${DIAG}` : ""}.json`), JSON.stringify(result, null, 1));
printSummary(result);

function f2(x) {
  return Number.isFinite(x) ? x.toFixed(2) : "-";
}
function pct(a, b) {
  return b > 0 ? `${((100 * a) / b).toFixed(0)} %` : "-";
}
function printPose(p, a, items, label) {
  const cov = a.pixels - a.skyPixels - a.nonePixels;
  log(
    `${p.name} (${p.x}, ${p.y}, ${p.z}) yaw ${p.yaw.toFixed(0)}° [${label}] — covered ${pct(cov, a.pixels)}, sky ${pct(a.skyPixels, a.pixels)}${a.nonePixels ? `, EMPTY ${a.nonePixels}` : ""}`,
  );
  const line = (label, gr) =>
    `   ${label.padEnd(8)} draws ${String(gr.draws).padStart(3)} · ${String(gr.tris).padStart(7)} tris · raster ${f2(gr.raster / cov)} · shaded ${f2(gr.shaded / cov)} · visible ${f2(gr.visible / cov)} (per covered px) · early-Z rejects ${pct(gr.raster - gr.shaded, gr.raster)} · back faces: shaded ${pct(gr.shadedBack, gr.shaded)}, visible ${gr.visibleBack} px`;
  console.log(line("all", a.all));
  console.log(line("map", a.map));
  if (a.decor.draws) console.log(line("decor", a.decor));
  if (a.backdrop.draws) console.log(line("backdrop", a.backdrop));
  if (a.other.draws) console.log(line("other", a.other));
  if (a.gamePrepass?.draws) {
    console.log(`   game prepass: ${a.gamePrepass.draws} draws · ${a.gamePrepass.tris} tris · ${f2(a.gamePrepass.depthFragments / cov)} depth-only fragments per covered px`);
  }
  console.log(`   shaded per covered px: ${a.histogram.map((n, i) => `${i}${i === 8 ? "+" : ""}:${pct(n, cov)}`).join(" ")}`);
  const v = a.variants;
  const parts = [];
  if (v.prepass) parts.push(`prepass map ${f2(v.prepass.mapShaded / cov)} (depth frags ${f2(v.prepass.prepassDepthFragments / cov)}, ${v.prepass.prepassTris} tris)`);
  for (const area of PREPASSLITE) {
    const l = v[`prepass>=${area}`];
    if (l) parts.push(`prepass ≥${area} m² ${f2(l.mapShaded / cov)} (${l.prepassTris} tris)`);
  }
  for (const o of ORDERS) if (v[`order:${o}`]) parts.push(`${o} ${f2(v[`order:${o}`].mapShaded / cov)}`);
  if (v.frontSideAll) parts.push(`frontSide map ${f2(v.frontSideAll.mapShaded / cov)} (${v.frontSideAll.changedPixels} px change)`);
  console.log(`   map shaded / covered px: now ${f2(a.map.shaded / cov)} → ${parts.join(" · ")}`);
  const top = items
    .filter((it) => it.raster > 0 && it.kind !== "sky")
    .sort((x, y) => y.shaded - y.visible - (x.shaded - x.visible))
    .slice(0, 8);
  for (const it of top) {
    console.log(
      `     #${String(it.rank).padStart(2)} ${it.name.slice(0, 44).padEnd(44)} ${it.side.padEnd(6)} ${String(it.tris).padStart(6)} tris · footprint ${pct(it.footprint, a.pixels).padStart(5)} · self ${f2(it.raster / Math.max(1, it.footprint))} · shaded ${String(it.shaded).padStart(7)} visible ${String(it.visible).padStart(7)} wasted ${pct(it.shaded - it.visible, it.shaded)} (back ${pct(it.shadedBack, it.shaded)}, visible back ${it.visibleBack})`,
    );
  }
}
function printSummary(r) {
  for (const [scen, rows] of Object.entries(r.scenarios)) {
    console.log(`\nSUMMARY ${r.q} ${r.w}×${r.h}${r.diag ? ` diag=${r.diag}` : ""} [${scen}] — MAP batches: fragments per covered pixel`);
    const head = ["pose", "draws", "cov", "raster", "shaded", "rej", "allShd", "prepass", ...r.orders, "1-sided", "Δpx"];
    console.log(head.map((h, i) => (i === 0 ? h.padEnd(10) : h.padStart(9))).join(""));
    const tot = { cov: 0, raster: 0, shaded: 0, all: 0, pre: 0, fs: 0, orders: r.orders.map(() => 0) };
    for (const p of rows) {
      const cov = p.pixels - p.skyPixels - p.nonePixels;
      const v = p.variants;
      tot.cov += cov;
      tot.raster += p.map.raster;
      tot.shaded += p.map.shaded;
      tot.all += p.all.shaded;
      if (v.prepass) tot.pre += v.prepass.mapShaded;
      if (v.frontSideAll) tot.fs += v.frontSideAll.mapShaded;
      r.orders.forEach((o, i) => (tot.orders[i] += v[`order:${o}`]?.mapShaded ?? 0));
      const cells = [
        p.pose.name.padEnd(10),
        String(p.calls).padStart(9),
        pct(cov, p.pixels).padStart(9),
        f2(p.map.raster / cov).padStart(9),
        f2(p.map.shaded / cov).padStart(9),
        pct(p.map.raster - p.map.shaded, p.map.raster).padStart(9),
        f2(p.all.shaded / cov).padStart(9),
        (v.prepass ? f2(v.prepass.mapShaded / cov) : "-").padStart(9),
        ...r.orders.map((o) => (v[`order:${o}`] ? f2(v[`order:${o}`].mapShaded / cov) : "-").padStart(9)),
        (v.frontSideAll ? f2(v.frontSideAll.mapShaded / cov) : "-").padStart(9),
        (v.frontSideAll ? String(v.frontSideAll.changedPixels) : "-").padStart(9),
      ];
      console.log(cells.join(""));
    }
    const has = rows.length > 0 && rows[0].variants;
    console.log(
      [
        "ALL".padEnd(10),
        "".padStart(9),
        "".padStart(9),
        f2(tot.raster / tot.cov).padStart(9),
        f2(tot.shaded / tot.cov).padStart(9),
        pct(tot.raster - tot.shaded, tot.raster).padStart(9),
        f2(tot.all / tot.cov).padStart(9),
        (has?.prepass ? f2(tot.pre / tot.cov) : "-").padStart(9),
        ...r.orders.map((o, i) => (has?.[`order:${o}`] ? f2(tot.orders[i] / tot.cov) : "-").padStart(9)),
        (has?.frontSideAll ? f2(tot.fs / tot.cov) : "-").padStart(9),
      ].join(""),
    );
  }
}
