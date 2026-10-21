// GIVRE POST CHAIN — headless pixel A/B of the `?diag=` post chains (src/effects/GivrePostChain.ts)
// against the reference chain, in ONE session: DEV build, simulation frozen, RGBA read back from the
// canvas, several camera poses, Givre LOW (FXAA) then HIGH (MSAA 4×). For each variant: pixels that
// differ, histogram of the differences, where they are (anti-aliased edges of the reference — pixels
// FXAA changed —, within 2 px of a pixel brighter than 1.0 in the world target, elsewhere), alpha.
// Optional: frame cost of each variant on this machine (TIMING), PNG crops (OUT).
//
//   BASE=http://127.0.0.1:5173 node tools/perf/post-chain-check.mjs
//   env: BASE    page URL of a DEV build (npm run dev, or an esbuild bench build): needs
//                `window.givreDebug` and the game (`window.__game`, or `window.__settings.game`)
//        QS      presets, default "LOW,HIGH"
//        VARIANTS  default all of: out8, fused, fused8, worldsrgb, worldsrgbfused, world11, direct
//        POSES   JSON [[yaw, pitch], …] around the spawn (default 3 poses)
//        TIMING  samples per variant (0 = no timing; renderComposer + 1-pixel readback, interleaved)
//        OUT     folder for PNGs of the first pose (reference and each variant), default none
//        PLAYWRIGHT  path of the playwright module (default: "playwright")
//        FONTS   path of a module exporting routeStandinFonts(page) (machines without Google Fonts)
//        W, H    viewport (default 960 × 540 — software renderers are slow)
// Software renderer note (SwiftShader): one render per task and a GC between renders, or the
// renderer is OOM-killed; timings there measure shader ALU, not memory bandwidth.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:5173";
const W = Number(process.env.W ?? 960);
const H = Number(process.env.H ?? 540);
const QS = (process.env.QS ?? "LOW,HIGH").split(",");
const OUT = process.env.OUT ? path.resolve(process.env.OUT) : null;
const TIMING = Number(process.env.TIMING ?? 0);
const POSES = JSON.parse(process.env.POSES ?? "[[0,0],[90,8],[180,25]]");
const routeFonts = process.env.FONTS ? (await import(process.env.FONTS)).routeStandinFonts : null;
if (OUT) fs.mkdirSync(OUT, { recursive: true });

const SETUPS = {
  ref: { world: "rgba16f", output: "half" },
  out8: { world: "rgba16f", output: "rgba8" },
  fused: { world: "rgba16f", output: "fused" },
  fused8: { world: "rgba16f", output: "fused8" },
  worldsrgb: { world: "srgb8", output: "rgba8" },
  worldsrgbfused: { world: "srgb8", output: "fused" },
  world11: { world: "r11g11b10f", output: "rgba8" },
  direct: { world: "direct", output: "none" },
};
const VARIANTS = (process.env.VARIANTS ?? Object.keys(SETUPS).filter((k) => k !== "ref").join(",")).split(",");
// Bench expectations (software renderer, 960 × 540): what each variant may change at most — a
// guard against a broken route, NOT a claim of identity (see PERFORMANCE.md « La chaîne de
// post-traitement »). FXAA (LOW): any change of FXAA's input precision moves some of its
// decisions; MSAA (HIGH): no FXAA, the output pass draws the canvas.
const LIMITS = {
  LOW: { out8: 10, fused: 0.2, fused8: 2, worldsrgb: 10, worldsrgbfused: 10, world11: 95, direct: 15 },
  HIGH: { out8: 0, fused: 0, fused8: 0, worldsrgb: 10, worldsrgbfused: 10, world11: 95, direct: 15 },
};

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function writePng(file, w, h, rgbaTopDown) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgbaTopDown.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0)}s]`, ...a);
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--disable-gpu-compositing", "--js-flags=--expose-gc"],
});
try {
  for (const Q of QS) {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    page.setDefaultTimeout(0);
    const errors = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text().slice(0, 240));
    });
    page.on("pageerror", (e) => errors.push("pageerror " + e.message.slice(0, 240)));
    await page.addInitScript(() => {
      let s = 0x2f6b9a1d;
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
    }, Q);
    await page.goto(`${BASE}/?hud=inline`);
    await page.waitForFunction(() => document.getElementById("menu-loading")?.classList.contains("hidden"), null, { timeout: 900000, polling: 1000 });
    await page.evaluate(() => document.getElementById("menu-cta")?.click());
    await page.waitForFunction(() => !document.documentElement.classList.contains("hud-menu-active"), null, { timeout: 300000, polling: 500 });
    await page.evaluate(() => {
      const g = window.__game ?? window.__settings?.game;
      window.__g = g;
      g.input.pointerLocked = true;
      g.playerCombatant.health.protectionTimer = 1e9;
      g.botManager.setBotCount(3);
      g.rebuildHittables();
    });
    await sleep(3000);
    await page.evaluate(() => window.__g.renderer.setAnimationLoop(null));
    await sleep(800);
    const info = await page.evaluate((SETUPS) => {
      const g = window.__g;
      const gl = g.renderer.getContext();
      const state = g.renderer.state;
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const cam = g.fpsCamera.camera;
      const home = cam.position.clone();
      const P = { g, gl, w, h, worldRT: null, outRT: null };
      const wr = g.worldRenderPass.render.bind(g.worldRenderPass);
      g.worldRenderPass.render = (r, wb, rb, ...a) => {
        P.worldRT = rb;
        return wr(r, wb, rb, ...a);
      };
      const orr = g.outputPass.render.bind(g.outputPass);
      g.outputPass.render = (r, wb, rb, ...a) => {
        P.outRT = wb;
        return orr(r, wb, rb, ...a);
      };
      P.set = (name) => window.givreDebug.perf.post(SETUPS[name]);
      P.pose = ([yaw, pitch]) => {
        cam.position.copy(home);
        cam.rotation.set((pitch * Math.PI) / 180, (yaw * Math.PI) / 180, 0, "YXZ");
        cam.updateMatrixWorld(true);
        g.viewmodelSystem.syncCamera(cam);
      };
      P.render = () => {
        g.renderComposer();
        const px = new Uint8Array(w * h * 4);
        state.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      const readFloat = (rt) => {
        state.bindFramebuffer(gl.FRAMEBUFFER, g.renderer.properties.get(rt).__webglFramebuffer);
        const buf = new Float32Array(rt.width * rt.height * 4);
        gl.readPixels(0, 0, rt.width, rt.height, gl.RGBA, gl.FLOAT, buf);
        state.bindFramebuffer(gl.FRAMEBUFFER, null);
        return buf;
      };
      // Reference masks: FXAA-touched pixels (canvas ≠ the output image rounded), near-HDR pixels.
      P.masks = (canvas) => {
        const n = w * h;
        const edge = new Uint8Array(n);
        const hdr = new Uint8Array(n);
        const out = g.fxaaPass.enabled && P.outRT && P.outRT !== P.worldRT ? readFloat(P.outRT) : null;
        const world = readFloat(P.worldRT);
        let hdrN = 0;
        let maxV = 0;
        for (let i = 0; i < n; i++) {
          if (out) {
            for (let c = 0; c < 4; c++) {
              if (Math.round(Math.min(1, Math.max(0, out[i * 4 + c])) * 255) !== canvas[i * 4 + c]) {
                edge[i] = 1;
                break;
              }
            }
          }
          const m = Math.max(world[i * 4], world[i * 4 + 1], world[i * 4 + 2]);
          if (m > maxV) maxV = m;
          if (m > 1.0001) {
            hdr[i] = 1;
            hdrN++;
          }
        }
        const near = new Uint8Array(n);
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            if (!hdr[y * w + x]) continue;
            for (let dy = -2; dy <= 2; dy++)
              for (let dx = -2; dx <= 2; dx++) {
                const xx = x + dx;
                const yy = y + dy;
                if (xx >= 0 && yy >= 0 && xx < w && yy < h) near[yy * w + xx] = 1;
              }
          }
        let edgeN = 0;
        for (let i = 0; i < n; i++) edgeN += edge[i];
        P.edge = edge;
        P.near = near;
        return { edgePct: +((100 * edgeN) / n).toFixed(2), hdrPct: +((100 * hdrN) / n).toFixed(3), maxLinear: +maxV.toFixed(2) };
      };
      P.cmp = (a, b) => {
        const BINS = [1, 2, 4, 8, 16, 32, 64, 255];
        const hist = BINS.map(() => 0);
        const r = { n: 0, max: 0, alpha: 0, edge: 0, edgeMax: 0, near: 0, nearMax: 0, other: 0, otherMax: 0 };
        for (let i = 0, p = 0; i < a.length; i += 4, p++) {
          const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
          if (!d) continue;
          r.n++;
          if (d > r.max) r.max = d;
          if (a[i + 3] !== b[i + 3]) r.alpha++;
          hist[BINS.findIndex((t) => d <= t)]++;
          const where = P.near?.[p] ? "near" : P.edge?.[p] ? "edge" : "other";
          r[where]++;
          if (d > r[`${where}Max`]) r[`${where}Max`] = d;
        }
        r.pct = +((100 * r.n) / (a.length / 4)).toFixed(3);
        r.hist = hist;
        return r;
      };
      P.png = (px) => {
        const out = new Uint8Array(px.length);
        for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
        let s = "";
        for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
        return btoa(s);
      };
      window.__P = P;
      return { w, h, fxaa: g.fxaaPass.enabled, samples: g.composer.renderTarget1.samples, post: window.givreDebug.perf.post() };
    }, SETUPS);
    log(`${Q}: frozen — ${info.w}×${info.h}, FXAA ${info.fxaa}, MSAA ${info.samples}, ${info.post}`);
    const tick = () =>
      page.evaluate(async () => {
        await new Promise((r) => setTimeout(r, 30));
        window.gc?.();
      });
    for (const [k, pose] of POSES.entries()) {
      await page.evaluate((pose) => {
        const P = window.__P;
        P.set("ref");
        P.pose(pose);
        P.ref = P.render();
      }, pose);
      await tick();
      const base = await page.evaluate(() => {
        const P = window.__P;
        const again = P.render();
        let opaque = true;
        for (let i = 3; i < P.ref.length; i += 4) if (P.ref[i] !== 255) opaque = false;
        return { repeat: P.cmp(P.ref, again).n, opaque, glError: P.gl.getError(), ...P.masks(P.ref) };
      });
      await tick();
      log(`${Q} pose ${pose}: FXAA edges ${base.edgePct} % · linear > 1: ${base.hdrPct} % (max ${base.maxLinear})`);
      check(base.repeat === 0 && base.opaque && base.glError === 0, `${Q} ${pose}: reference stable, opaque, no GL error`);
      if (OUT && k === 0) {
        const b64 = await page.evaluate(() => window.__P.png(window.__P.ref));
        writePng(path.join(OUT, `${Q}-ref.png`), info.w, info.h, Buffer.from(b64, "base64"));
      }
      for (const v of VARIANTS) {
        await page.evaluate((v) => {
          window.__P.set(v);
          window.__P.render(); // first frame: new targets (programs for `direct`)
        }, v);
        await tick();
        const r = await page.evaluate(() => {
          const P = window.__P;
          P.cur = P.render();
          return { ...P.cmp(P.ref, P.cur), glError: P.gl.getError() };
        });
        await tick();
        console.log(
          `     ${v.padEnd(15)} ${String(r.n).padStart(7)} px (${r.pct} %) max ${r.max} · hist ≤1,2,4,8,16,32,64,255: ${r.hist.join(",")} · AA edges ${r.edge} (≤ ${r.edgeMax}) · near > 1 ${r.near} (≤ ${r.nearMax}) · elsewhere ${r.other} (≤ ${r.otherMax})`,
        );
        const limit = LIMITS[Q]?.[v] ?? 100;
        check(r.pct <= limit && r.alpha === 0 && r.glError === 0, `${Q} ${pose} ${v}: ${r.pct} % ≤ ${limit} %, alpha unchanged, no GL error`);
        if (OUT && k === 0) {
          const b64 = await page.evaluate(() => window.__P.png(window.__P.cur));
          writePng(path.join(OUT, `${Q}-${v}.png`), info.w, info.h, Buffer.from(b64, "base64"));
        }
      }
      await page.evaluate(() => window.__P.set("ref"));
    }
    if (TIMING > 0) {
      const names = ["ref", ...VARIANTS];
      const samples = Object.fromEntries(names.map((n) => [n, []]));
      for (let round = 0; round <= TIMING; round++) {
        const order = names.slice(round % names.length).concat(names.slice(0, round % names.length));
        for (const v of order) {
          await page.evaluate(({ v, pose }) => {
            const P = window.__P;
            P.set(v);
            P.pose(pose);
            P.g.renderComposer();
          }, { v, pose: POSES[0] });
          await tick();
          const ms = await page.evaluate(() => {
            const { g, gl } = window.__P;
            const px = new Uint8Array(4);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
            const t0 = performance.now();
            g.renderComposer();
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
            return performance.now() - t0;
          });
          if (round > 0) samples[v].push(ms);
          await tick();
        }
      }
      const med = (a) => {
        const s = [...a].sort((x, y) => x - y);
        return (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2;
      };
      for (const n of names) console.log(`     timing ${n.padEnd(15)} ${med(samples[n]).toFixed(1)} ms per frame (median of ${samples[n].length})`);
      await page.evaluate(() => window.__P.set("ref"));
    }
    check(errors.length === 0, `${Q}: no console error (${errors.slice(0, 3).join(" | ")})`);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(failures ? `${failures} FAILED` : "ALL OK");
process.exit(failures ? 1 : 0);
