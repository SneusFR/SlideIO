// MAP SHADER — headless check of the specialised Givre map shader (world/GivreMapMaterial.ts) on the
// real game page: the same pixels (RGBA, canvas output) with three's stock shader and with the
// default specialisation (exact: must be 0 pixel of difference), and the size of the difference of the
// near-exact part (`?diag=mapshaderfast`), at many camera poses (the map's viewpoints, the spawn, the
// low sun, the black ice), on Givre LOW (FXAA) and HIGH (MSAA 4×). Optional interleaved timings
// (render + 1-pixel readback, SwiftShader: the ALU / texture savings show up, bandwidth does not).
//
//   BASE=http://127.0.0.1:5173 node tools/perf/map-shader-check.mjs
//   env: BASE        page URL of a DEV build (npm run dev, or an esbuild bench build): it needs
//                    `window.givreMapShader` (GivreMap, DEV only) and the game (`window.__game`
//                    or `window.__settings.game`)
//        Q           qualities (default LOW,HIGH)          POSES   pose ids (default: all)
//        TIMING      samples per variant and pose (default 0 = no timing)
//        OUT         folder of the diff images (default: ./map-shader-check)
//        PLAYWRIGHT  path of the playwright module (default: "playwright")
//        FONTS       path of a module exporting routeStandinFonts(page) (no Google Fonts)
//        W, H        viewport (default 960 × 540 — software renderers are slow)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:5173";
const OUT = resolve(process.env.OUT ?? "map-shader-check");
const W = Number(process.env.W ?? 960);
const H = Number(process.env.H ?? 540);
const QS = (process.env.Q ?? "LOW,HIGH").split(",");
const TIMING = Number(process.env.TIMING ?? 0);
mkdirSync(OUT, { recursive: true });
const routeFonts = process.env.FONTS ? (await import(process.env.FONTS)).routeStandinFonts : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0)}s]`, ...a);
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

const EXACT = { noIbl: true, dielectric: true, sharedUv: true, sunSkip: true, noDirectMs: false, pcfRotate: false };
const FAST = { noIbl: true, dielectric: true, sharedUv: true, sunSkip: true, noDirectMs: true, pcfRotate: true };
const viewpoints = JSON.parse(readFileSync(new URL("../../src/assets/MAP/Givre/givre_01.physics.json", import.meta.url), "utf8")).viewpoints;
const POSES = [
  { id: "spawn" },
  ...viewpoints.map((v) => ({ id: v.id.replace(/^(CAM_\d+|CAM_Vue_Aerienne).*$/, "$1"), position: v.position, lookAt: v.lookAt })),
  { id: "SUN", position: [10, 1.7, -10], lookAt: [10 - 81.1, 1.7 + 12, -10 + 50.7] }, // toward the low sun
  { id: "ICE", position: [-68, 1.7, -36], lookAt: [-77, 0, -30] }, // black ice, roughness 0.06
].filter((p) => !process.env.POSES || process.env.POSES.split(",").includes(p.id));

const browser = await chromium.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--disable-gpu-compositing", "--js-flags=--expose-gc"],
});

async function open(quality) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.setDefaultTimeout(0);
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 240));
  });
  page.on("pageerror", (e) => errors.push("pageerror " + e.message.slice(0, 240)));
  await page.addInitScript(() => {
    let s = 0x2f6b9a1d; // deterministic snow / bots
    Math.random = () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 4294967296;
    };
  });
  if (routeFonts) await routeFonts(page);
  await page.goto(`${BASE}/__out/blank.html`).catch(() => page.goto(`${BASE}/favicon.ico`));
  await page.evaluate((q) => {
    localStorage.clear();
    localStorage.setItem("slideio.mapId", "GIVRE");
    localStorage.setItem("beanzo.graphicsQuality", q);
    localStorage.setItem("beanzo.fpsCap", "OFF");
    localStorage.setItem("slideio.loadout.v1", JSON.stringify({ melee: "HAMMER", primary: "PAINTBALL_RIFLE" }));
  }, quality);
  await page.goto(`${BASE}/?hud=inline`);
  await page.waitForFunction(() => document.getElementById("menu-loading")?.classList.contains("hidden"), null, { timeout: 900000, polling: 1000 });
  await page.evaluate(() => document.getElementById("menu-cta")?.click());
  await page.waitForFunction(() => !document.documentElement.classList.contains("hud-menu-active"), null, { timeout: 300000, polling: 500 });
  await page.evaluate(() => {
    const g = window.__game ?? window.__settings.game;
    g.input.pointerLocked = true;
    g.playerCombatant.health.protectionTimer = 1e9;
    g.botManager.setBotCount(0);
    g.rebuildHittables();
  });
  await sleep(3000);
  // Frozen simulation: every render of a pose is the same image.
  await page.evaluate(() => (window.__game ?? window.__settings.game).renderer.setAnimationLoop(null));
  await sleep(800);
  await page.evaluate(({ EXACT, FAST }) => {
    const g = window.__game ?? window.__settings.game;
    const gl = g.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const ms = window.givreMapShader;
    const grab = () => {
      g.renderComposer();
      window.gc?.(); // software rendering leaves native garbage per frame
      const px = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const cmp = (a, b) => {
      let n = 0;
      let max = 0;
      let ones = 0;
      const mask = new Uint8Array(a.length / 4);
      for (let i = 0, p = 0; i < a.length; i += 4, p++) {
        const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
        if (!d) continue;
        n++;
        if (d === 1) ones++;
        if (d > max) max = d;
        mask[p] = 1;
      }
      return { n, ones, max, pct: +((100 * n) / (a.length / 4)).toFixed(4), mask };
    };
    const png = (ref, mask) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const s = ((h - 1 - y) * w + x) * 4;
          const d = (y * w + x) * 4;
          const m = mask[(h - 1 - y) * w + x];
          img.data[d] = m ? 255 : ref[s] >> 1;
          img.data[d + 1] = m ? 0 : ref[s + 1] >> 1;
          img.data[d + 2] = m ? 255 : ref[s + 2] >> 1;
          img.data[d + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return c.toDataURL("image/png");
    };
    const set = { stock: () => ms.set(null), exact: () => ms.set(EXACT), fast: () => ms.set(FAST) };
    window.__msc = { g, gl, grab, cmp, png, set, cam: g.fpsCamera.camera, size: [w, h], fxaa: g.fxaaPass };
  }, { EXACT, FAST });
  return { page, errors };
}

try {
  for (const quality of QS) {
    const { page, errors } = await open(quality);
    const head = await page.evaluate(() => ({ size: window.__msc.size, session: window.givreMapShader.session, targets: window.givreMapShader.list() }));
    log(`GIVRE ${quality}: ${head.size.join(" × ")}, ${head.targets.length} map meshes, session ${JSON.stringify(head.session)}`);
    check(head.session && head.session.noIbl && !head.session.noDirectMs, `${quality}: the exact specialisation is the default`);
    let fastMax = 0;
    for (const pose of POSES) {
      const r = await page.evaluate(async (pose) => {
        const { g, gl, grab, cmp, png, set, cam } = window.__msc;
        const tick = () => new Promise((res) => setTimeout(res, 30));
        if (pose.position) {
          cam.position.set(...pose.position);
          cam.lookAt(...pose.lookAt);
        } else if (window.__mscSpawn) {
          cam.position.copy(window.__mscSpawn.p);
          cam.quaternion.copy(window.__mscSpawn.q);
        } else window.__mscSpawn = { p: cam.position.clone(), q: cam.quaternion.clone() };
        cam.updateMatrixWorld(true);
        g.viewmodelSystem.syncCamera(cam);
        set.stock();
        const ref = grab();
        await tick();
        const repeat = cmp(ref, grab()).n;
        await tick();
        set.exact();
        const exact = cmp(ref, grab());
        await tick();
        set.fast();
        const fast = cmp(ref, grab());
        await tick();
        set.exact(); // the session default
        const out = { repeat, exact: { ...exact, mask: undefined }, fast: { ...fast, mask: undefined }, glError: gl.getError() };
        if (exact.n) out.exactPng = png(ref, exact.mask);
        if (fast.n) out.fastPng = png(ref, fast.mask);
        return out;
      }, pose);
      for (const k of ["exactPng", "fastPng"]) {
        if (r[k]) writeFileSync(resolve(OUT, `${quality}-${pose.id}-${k.replace("Png", "")}.png`), Buffer.from(r[k].split(",")[1], "base64"));
      }
      fastMax = Math.max(fastMax, r.fast.max);
      check(
        r.repeat === 0 && r.glError === 0 && r.exact.n === 0,
        `${quality} ${pose.id}: stock = specialised (${r.exact.n} pixels differ) · stable (${r.repeat}) · GL error ${r.glError}` +
          ` · near-exact: ${r.fast.n} px (${r.fast.pct} %, ${r.fast.ones} of 1 level, max ${r.fast.max})`,
      );
    }
    log(`${quality}: near-exact part, largest difference ${fastMax} level(s) (FXAA can widen a 1-level change on an edge)`);
    if (TIMING > 0) {
      const variants = ["stock", "exact", "fast"];
      for (const pose of POSES.slice(0, 3)) {
        const t = Object.fromEntries(variants.map((v) => [v, []]));
        for (let s = 0; s < TIMING; s++) {
          for (const v of s % 2 ? [...variants].reverse() : variants) {
            t[v].push(
              await page.evaluate(async ({ pose, v }) => {
                const { g, gl, set, cam } = window.__msc;
                if (pose.position) {
                  cam.position.set(...pose.position);
                  cam.lookAt(...pose.lookAt);
                } else {
                  cam.position.copy(window.__mscSpawn.p);
                  cam.quaternion.copy(window.__mscSpawn.q);
                }
                cam.updateMatrixWorld(true);
                g.viewmodelSystem.syncCamera(cam);
                set[v]();
                const px = new Uint8Array(4);
                g.renderComposer(); // first use compiles: not timed
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
                window.gc?.();
                await new Promise((res) => setTimeout(res, 30));
                const t0 = performance.now();
                g.renderComposer();
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
                return performance.now() - t0;
              }, { pose, v }),
            );
          }
        }
        const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
        log(`${quality} ${pose.id} frame (render + readback, median of ${TIMING}): ` + variants.map((v) => `${v} ${med(t[v]).toFixed(1)} ms`).join(" · "));
      }
      await page.evaluate(() => window.__msc.set.exact());
    }
    check(errors.length === 0, `${quality}: no console error (${errors.slice(0, 3).join(" | ")})`);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(failures ? `${failures} FAILED` : "ALL OK");
process.exit(failures ? 1 : 0);
