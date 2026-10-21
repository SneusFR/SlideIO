// GIVRE world A/B — same pixels, and the frame time, for the overdraw switches (DEV build).
//
// MODE=prepass (default) — the depth prepass, toggled INSIDE one session. Page opened with
// `?diag=prepass` (+ DIAG extra values): the proxies exist and the map materials carry
// `invariant gl_Position`; solo play with BOTS bots (skinned meshes + their outline hulls
// interleaved with the map in the opaque list), simulation frozen. For each pose the whole
// composer frame (world + FP arms + output + FXAA / MSAA) is read back from the canvas (RGBA) in
// four states, one render per task:
//   ON    prepass drawn                         (what `?diag=prepass` shows)
//   OFF   prepass hidden, same programs         → ON vs OFF: the prepass itself changes nothing
//   PROD  prepass hidden + materials un-patched (no `invariant`: the production program)
//                                              → ON vs PROD: nothing changes vs today's build
//   ON2   ON again                              → determinism of the bench itself
// then times the composer frame closed by a 1-pixel canvas read (the page waits for the CPU
// rasteriser to finish the frame — gl.finish() does not, there) alternating ON / PROD, FRAMES
// times each, and counts draws / triangles.
//
// MODE=xsession — a switch read at LOAD (the batches differ: `percomponent`…), compared ACROSS
// two sessions: DIAGS="nopercomponent|percomponent" (session A | session B, each a `?diag=` value —
// commas inside a session, empty = defaults; DIFFDIR = folder for A / B / diff PNGs). Only the
// deterministic part of the world is drawn (static map batches, prepass, backdrop, sky, lights:
// décor animation, snow, halos, footprints, FP arms hidden, no bot), same poses, RGBA compared, and
// the same frame timing per session.
//
//   BASE=http://127.0.0.1:5173 node tools/perf/prepass-ab.mjs
//   env: BASE, PLAYWRIGHT, FONTS (as settings-page-check.mjs), W/H (960 × 540), QS (LOW,HIGH),
//        MODE, DIAG (extra ?diag values, prepass mode), DIAGS (xsession), BOTS (3, prepass mode),
//        FRAMES (5; 0 = no timing), TIMEPOSES (comma list: time only these poses — the CPU
//        rasteriser takes seconds per frame), POSES / ONLY (tools/perf/givre-poses.mjs),
//        OUT (JSON file, optional)
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { selectPoses } from "./givre-poses.mjs";

/** Minimal RGBA PNG encoder (GL rows are bottom-up: flipped here). */
function png(rgba, w, h) {
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + (h - 1 - y) * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:5173";
const W = Number(process.env.W ?? 960);
const H = Number(process.env.H ?? 540);
const QS = (process.env.QS ?? "LOW,HIGH").split(",");
const MODE = process.env.MODE ?? "prepass";
const BOTS = Number(process.env.BOTS ?? 3);
const FRAMES = Number(process.env.FRAMES ?? 5);
// Timing only for these poses (comma names; default: every pose) — a software frame takes seconds.
const TIMEPOSES = process.env.TIMEPOSES ? new Set(process.env.TIMEPOSES.split(",")) : null;
const POSES = selectPoses();
const routeFonts = process.env.FONTS ? (await import(process.env.FONTS)).routeStandinFonts : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0)}s]`, ...a);
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const pctDelta = (a, b) => `${(((b - a) / a) * 100).toFixed(1)} %`;

const browser = await chromium.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--disable-gpu-compositing", "--js-flags=--expose-gc"],
});

/** Opens the game (quality q, `?diag=diag`), enters play with `bots` bots, freezes it. */
async function openGame(q, diag, bots) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.setDefaultTimeout(0);
  const errors = [];
  const infos = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 240));
    if (m.text().startsWith("[GPU]")) infos.push(m.text());
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
  }, q);
  await page.goto(`${BASE}/?hud=inline${diag ? `&diag=${diag}` : ""}`);
  await page.waitForFunction(() => document.getElementById("menu-loading")?.classList.contains("hidden"), null, { timeout: 900000, polling: 1000 });
  await page.evaluate(() => document.getElementById("menu-cta")?.click());
  await page.waitForFunction(() => !document.documentElement.classList.contains("hud-menu-active"), null, { timeout: 300000, polling: 500 });
  await page.evaluate((bots) => {
    const g = window.__game;
    g.input.pointerLocked = true;
    g.playerCombatant.health.protectionTimer = 1e9;
    g.botManager.setBotCount(bots);
    g.rebuildHittables();
  }, bots);
  await sleep(3000);
  await page.evaluate(() => window.__game.renderer.setAnimationLoop(null));
  await sleep(800);
  await page.evaluate(() => {
    const g = window.__game;
    const gl = g.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const read = () => {
      const px = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const pose = (p) => {
      const cam = g.fpsCamera.camera;
      cam.position.set(p.x, p.y, p.z);
      cam.rotation.set((p.pitch * Math.PI) / 180, (p.yaw * Math.PI) / 180, 0, "YXZ");
      cam.updateMatrixWorld(true);
      g.viewmodelSystem.syncCamera(cam);
      g.spaceSky.update(0, 0, cam);
    };
    const diff = (a, b) => {
      let n = 0, max = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
        if (d) {
          n++;
          if (d > max) max = d;
        }
      }
      return { n, max, pct: +((100 * n) / (a.length / 4)).toFixed(4) };
    };
    const lit = (px) => {
      let n = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 30) n++;
      return +((100 * n) / (px.length / 4)).toFixed(1);
    };
    // One composer frame, ms — closed by a 1-pixel read of the canvas: the GPU process must
    // complete every draw of the frame first (gl.finish() does NOT wait for SwiftShader here).
    const one = new Uint8Array(4);
    const timed = () => {
      const t0 = performance.now();
      g.renderComposer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one);
      return performance.now() - t0;
    };
    window.__ab = { g, gl, w, h, read, pose, diff, lit, timed, shots: [] };
  });
  return { page, errors, infos };
}

const results = [];
try {
  for (const q of QS) {
    if (MODE === "xsession") {
      const [diagA, diagB = ""] = (process.env.DIAGS ?? "nopercomponent|percomponent").split("|");
      const captures = [];
      for (const diag of [diagA, diagB]) {
        const { page, errors, infos } = await openGame(q, diag, 0);
        const info = await page.evaluate(() => {
          const { g } = window.__ab;
          // Only what is deterministic across sessions: the static map (+ prepass), backdrop, sky.
          const keep = new Set(["givre_01_merged", "givre_prepass", "givre_01_fond", "givre_sky"]);
          for (const top of g.scene.children) {
            if (top.name === "givre_01") {
              for (const c of top.children) if (!keep.has(c.name) && !c.isLight) c.visible = false;
            } else if (!keep.has(top.name) && !top.isLight) top.visible = false;
          }
          g.viewmodelSystem.setVisible(false);
          let batches = 0, single = 0;
          g.scene.getObjectByName("givre_01_merged").traverse((o) => {
            if (o.isMesh) {
              batches++;
              if (o.material.side === 0) single += (o.geometry.index ? o.geometry.index.count : o.geometry.getAttribute("position").count) / 3;
            }
          });
          return { batches, single };
        });
        log(`${q} ?diag=${diag || "(defaults)"}: ${info.batches} map batches, ${info.single} FrontSide tris ${infos.join(" ")}`);
        const shots = [];
        const times = [];
        for (const p of POSES) {
          await page.evaluate((p) => {
            window.__ab.pose(p);
            window.__ab.g.renderComposer();
            window.gc?.();
          }, p);
          await sleep(30);
          const r = await page.evaluate(() => {
            const ab = window.__ab;
            ab.g.renderer.info.reset();
            ab.g.renderComposer();
            const px = ab.read();
            const calls = ab.g.renderer.info.render.calls;
            let s = "";
            for (let i = 0; i < px.length; i += 0x8000) s += String.fromCharCode.apply(null, px.subarray(i, i + 0x8000));
            window.gc?.();
            return { b64: btoa(s), calls, lit: ab.lit(px) };
          });
          const pngLess = new Uint8Array(Buffer.from(r.b64, "base64"));
          const t = [];
          for (let i = 0; i < FRAMES; i++) {
            await sleep(20);
            t.push(await page.evaluate(() => {
              const v = window.__ab.timed();
              window.gc?.();
              return v;
            }));
          }
          shots.push({ px: pngLess, calls: r.calls, lit: r.lit });
          times.push(median(t));
        }
        captures.push({ diag, shots, times, info });
        check(errors.length === 0, `${q} ?diag=${diag || "(defaults)"}: no console error (${errors.slice(0, 3).join(" | ")})`);
        await page.close();
      }
      const [A, B] = captures;
      POSES.forEach((p, i) => {
        const a = A.shots[i].px, b = B.shots[i].px;
        let n = 0, max = 0;
        for (let k = 0; k < a.length; k += 4) {
          const d = Math.max(Math.abs(a[k] - b[k]), Math.abs(a[k + 1] - b[k + 1]), Math.abs(a[k + 2] - b[k + 2]), Math.abs(a[k + 3] - b[k + 3]));
          if (d) {
            n++;
            if (d > max) max = d;
          }
        }
        const row = { q, pose: p.name, mode: "xsession", n, max, draws: [A.shots[i].calls, B.shots[i].calls], ms: [A.times[i], B.times[i]], lit: A.shots[i].lit };
        results.push(row);
        if (n > 0 && process.env.DIFFDIR) {
          // A, B, and B with every differing pixel in magenta (bounding box printed).
          mkdirSync(process.env.DIFFDIR, { recursive: true });
          const marked = new Uint8Array(b);
          let x0 = W, y0 = H, x1 = -1, y1 = -1;
          for (let k = 0; k < a.length; k += 4) {
            if (a[k] !== b[k] || a[k + 1] !== b[k + 1] || a[k + 2] !== b[k + 2] || a[k + 3] !== b[k + 3]) {
              marked.set([255, 0, 255, 255], k);
              const px = (k / 4) % W, py = H - 1 - Math.floor(k / 4 / W);
              x0 = Math.min(x0, px), y0 = Math.min(y0, py), x1 = Math.max(x1, px), y1 = Math.max(y1, py);
            }
          }
          const base = resolve(process.env.DIFFDIR, `${q}-${p.name}`);
          writeFileSync(`${base}-A.png`, png(a, W, H));
          writeFileSync(`${base}-B.png`, png(b, W, H));
          writeFileSync(`${base}-diff.png`, png(marked, W, H));
          console.log(`     differing pixels within x ${x0}-${x1}, y ${y0}-${y1} → ${base}-diff.png`);
        }
        const frame = FRAMES > 0 ? ` · frame ${row.ms.map((v) => v.toFixed(0)).join(" → ")} ms` : "";
        log(`${q} ${p.name}: ${n} px differ (max ${max}) · draws ${row.draws.join(" → ")}${frame} · lit ${row.lit} %`);
        check(n === 0 && row.lit > 20, `${q} ${p.name}: identical RGBA ?diag=${diagA || "(defaults)"} vs ?diag=${diagB || "(defaults)"}`);
      });
      const sa = A.times.reduce((s, v) => s + v, 0), sb = B.times.reduce((s, v) => s + v, 0);
      if (FRAMES > 0) console.log(`${q}: static-map frame (sum of pose medians) ${sa.toFixed(0)} → ${sb.toFixed(0)} ms (${pctDelta(sa, sb)}) — two sessions apart: machine load differs`);
      continue;
    }

    // ---------------------------------------------------------------- MODE=prepass
    const diag = ["prepass", process.env.DIAG].filter(Boolean).join(",");
    const { page, errors, infos } = await openGame(q, diag, BOTS);
    const setup = await page.evaluate(() => {
      const ab = window.__ab;
      const group = ab.g.scene.getObjectByName("givre_prepass");
      const merged = ab.g.scene.getObjectByName("givre_01_merged");
      if (!group || !merged) return { error: "no prepass group (is ?diag=prepass on?)" };
      const patched = [];
      // (the map batches + the backdrop's plain / mountains)
      for (const root of [merged, ab.g.scene.getObjectByName("givre_01_fond")]) {
        root?.traverse((o) => {
          if (o.isMesh && o.material.__invariantPosition) patched.push(o.material);
        });
      }
      const unique = [...new Set(patched)];
      const saved = new Map(unique.map((m) => [m, { pre: m.__invariantPosition, onBeforeCompile: m.onBeforeCompile, customProgramCacheKey: m.customProgramCacheKey }]));
      // PROD: the production program (no invariant) — swap the patched functions back and forth.
      const setProd = (prod) => {
        for (const [m, s] of saved) {
          m.onBeforeCompile = prod ? s.pre.onBeforeCompile : s.onBeforeCompile;
          m.customProgramCacheKey = prod ? s.pre.customProgramCacheKey : s.customProgramCacheKey;
          m.needsUpdate = true;
        }
      };
      ab.state = (s) => {
        group.visible = s === "ON" || s === "ON2";
        setProd(s === "PROD");
      };
      let tris = 0;
      for (const p of group.children) tris += p.geometry.index.count / 3;
      return { w: ab.w, h: ab.h, proxies: group.children.length, tris, patchedMaterials: unique.length, verifiedOn: group.visible };
    });
    if (setup.error) throw new Error(setup.error);
    log(`${q} ?diag=${diag}: ${setup.w}×${setup.h}, ${setup.proxies} prepass proxies (${setup.tris} tris), ${setup.patchedMaterials} patched materials, load check kept it ${setup.verifiedOn ? "ON" : "OFF"} ${infos.join(" ")}`);
    check(setup.verifiedOn, `${q}: the load-time check kept the prepass on (same pixels on this GPU)`);
    for (const p of POSES) {
      await page.evaluate((p) => window.__ab.pose(p), p);
      const shots = {};
      for (const s of ["ON", "OFF", "PROD", "ON2"]) {
        // (a warm-up render after a state change: the program switch / first upload)
        await page.evaluate((s) => {
          window.__ab.state(s);
          window.__ab.g.renderComposer();
          window.gc?.();
        }, s);
        await sleep(30);
        shots[s] = await page.evaluate(() => {
          const ab = window.__ab;
          ab.g.renderer.info.reset();
          ab.g.renderComposer();
          const info = { calls: ab.g.renderer.info.render.calls, triangles: ab.g.renderer.info.render.triangles };
          ab.shots.push(ab.read());
          window.gc?.();
          return { info, id: ab.shots.length - 1 };
        });
        await sleep(30);
      }
      const cmp = await page.evaluate((ids) => {
        const ab = window.__ab;
        const S = ab.shots;
        const out = { onOff: ab.diff(S[ids.ON], S[ids.OFF]), onProd: ab.diff(S[ids.ON], S[ids.PROD]), repeat: ab.diff(S[ids.ON], S[ids.ON2]), litPct: ab.lit(S[ids.ON]) };
        ab.shots = [];
        return out;
      }, { ON: shots.ON.id, OFF: shots.OFF.id, PROD: shots.PROD.id, ON2: shots.ON2.id });
      // Timing: ON / PROD alternated (PROD = today's frame exactly).
      const times = { ON: [], PROD: [] };
      const frames = !TIMEPOSES || TIMEPOSES.has(p.name) ? FRAMES : 0;
      for (let i = 0; i < frames; i++) {
        for (const s of i % 2 ? ["PROD", "ON"] : ["ON", "PROD"]) {
          await page.evaluate((s) => {
            window.__ab.state(s);
            window.__ab.timed();
            window.gc?.();
          }, s);
          await sleep(20);
          times[s].push(
            await page.evaluate(() => {
              const v = window.__ab.timed();
              window.gc?.();
              return v;
            }),
          );
          await sleep(20);
        }
      }
      await page.evaluate(() => window.__ab.state("ON"));
      const row = {
        q,
        pose: p.name,
        mode: "prepass",
        ...cmp,
        drawsOn: shots.ON.info.calls,
        drawsProd: shots.PROD.info.calls,
        trisOn: shots.ON.info.triangles,
        trisProd: shots.PROD.info.triangles,
        msOn: median(times.ON),
        msProd: median(times.PROD),
        samplesOn: times.ON,
        samplesProd: times.PROD,
      };
      results.push(row);
      const frame = frames ? ` · frame ${row.msProd.toFixed(0)} → ${row.msOn.toFixed(0)} ms (${pctDelta(row.msProd, row.msOn)}, ${frames} each)` : "";
      log(
        `${q} ${p.name}: ON vs OFF ${cmp.onOff.n} px (max ${cmp.onOff.max}) · ON vs PROD ${cmp.onProd.n} px (max ${cmp.onProd.max}) · repeat ${cmp.repeat.n} · lit ${cmp.litPct} % · draws ${row.drawsProd} → ${row.drawsOn} · tris ${row.trisProd} → ${row.trisOn}${frame}`,
      );
      check(cmp.onOff.n === 0 && cmp.onProd.n === 0 && cmp.repeat.n === 0 && cmp.litPct > 20, `${q} ${p.name}: identical RGBA (prepass on / off / production program)`);
    }
    check(errors.length === 0, `${q}: no console error (${errors.slice(0, 3).join(" | ")})`);
    await page.close();
  }
} finally {
  await browser.close();
}
for (const q of QS) {
  const rows = results.filter((r) => r.q === q && r.mode === "prepass" && Number.isFinite(r.msOn));
  if (!rows.length) continue;
  const on = rows.reduce((s, r) => s + r.msOn, 0);
  const prod = rows.reduce((s, r) => s + r.msProd, 0);
  console.log(`${q}: SwiftShader frame (sum of pose medians) ${prod.toFixed(0)} → ${on.toFixed(0)} ms (${pctDelta(prod, on)})`);
}
if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify(results, null, 1));
console.log(failures ? `${failures} FAILED` : "ALL OK");
process.exit(failures ? 1 : 0);
