// SETTINGS PAGE — headless integration check of the real game page (Givre, the map with every
// option): the page opens from the main menu and from the pause menu, each live option really
// changes the renderer (MSAA samples / FXAA pass, render scale, snow, halos, anisotropy, shadow map
// size, particles, frame cap) WITHOUT compiling a single program, a reload-only option is flagged
// (chip + « Appliquer et recharger » bar, the in-match warning), and the automatic detection
// completes (software path, then the real probes forced on the software renderer) and stores its
// result as « Automatique ». Screenshots of every state go to OUT.
//
//   BASE=http://127.0.0.1:5173 OUT=/tmp/shots node tools/perf/settings-page-check.mjs
//   env: BASE   page URL of a DEV build (npm run dev, or an esbuild bench build) — it needs
//               `window.__settings` (main.ts exposes it in DEV builds)
//        OUT    screenshot folder (default: ./settings-shots)
//        PLAYWRIGHT  path of the playwright module (default: "playwright")
//        FONTS  path of a module exporting routeStandinFonts(page) (machines without Google Fonts)
//        W, H, DSF   viewport (default 1280 × 620 at device scale 0.75: the desktop layout for
//               960 × 465 rendered pixels — software renderers are slow)
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:5173";
const OUT = resolve(process.env.OUT ?? "settings-shots");
const W = Number(process.env.W ?? 1280);
const H = Number(process.env.H ?? 620);
const DSF = Number(process.env.DSF ?? 0.75);
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

const browser = await chromium.launch({
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--disable-gpu-compositing", "--js-flags=--expose-gc"],
});
const gc = (page) => page.evaluate(() => window.gc?.());

async function open({ w = W, h = H, dsf = DSF, legacy = true } = {}) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dsf });
  page.setDefaultTimeout(0);
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 240));
  });
  page.on("pageerror", (e) => errors.push("pageerror " + e.message.slice(0, 240)));
  if (routeFonts) await routeFonts(page);
  await page.goto(`${BASE}/__out/blank.html`).catch(() => page.goto(`${BASE}/favicon.ico`));
  // The old keys of a player who picked LOW in the old menu (migrated → Bas), FPS LIMIT OFF —
  // or a first launch (no key at all: « Automatique », measured at the first menu).
  await page.evaluate((legacy) => {
    localStorage.clear();
    localStorage.setItem("slideio.mapId", "GIVRE");
    if (legacy) {
      localStorage.setItem("beanzo.graphicsQuality", "LOW");
      localStorage.setItem("beanzo.fpsCap", "OFF");
    }
    localStorage.setItem("slideio.loadout.v1", JSON.stringify({ melee: "HAMMER", primary: "PAINTBALL_RIFLE" }));
  }, legacy);
  await page.goto(`${BASE}/?hud=inline`);
  await page.waitForFunction(() => document.getElementById("menu-loading")?.classList.contains("hidden"), null, { timeout: 900000, polling: 1000 });
  await page.waitForFunction(() => !!window.__settings, null, { timeout: 60000, polling: 500 });
  return { page, errors };
}

/** Renderer state the live options act on. */
const state = (page) =>
  page.evaluate(() => {
    const s = window.__settings;
    const g = s.game;
    const snow = g.givreEffects?.snow;
    const sun = g.shadowTuning?.light;
    return {
      preset: s.store.get().graphics.preset,
      programs: g.renderer.info.programs.length,
      ratio: g.renderer.getPixelRatio(),
      canvas: [g.renderer.domElement.width, g.renderer.domElement.height],
      samples: g.composer?.renderTarget1.samples ?? null,
      fxaa: g.fxaaPass?.enabled ?? null,
      snowCount: snow ? snow.geometry.drawRange.count : null,
      snowVisible: snow ? snow.points.visible : null,
      halosVisible: g.givreEffects?.halos?.objects.every((o) => o.visible) ?? null,
      aniso: g.anisoTextures?.[0]?.anisotropy ?? null,
      shadowSize: sun ? [sun.shadow.mapSize.x, sun.shadow.mapSize.y] : null,
      particles: g.particles.density,
      frameInterval: g.frameIntervalMs,
      reloadVisible: !document.querySelector(".gs-reload")?.classList.contains("hidden"),
      reloadText: document.querySelector(".gs-reload-text")?.textContent ?? "",
      reloadWarnVisible: !document.querySelector(".gs-reload-warn")?.classList.contains("hidden"),
      pageOpen: !document.getElementById("settings-page")?.classList.contains("hidden"),
      dpr: window.devicePixelRatio,
    };
  });

/** Clicks the option `label` of the segmented control in the row named `row`. */
async function pick(page, row, label) {
  const ok = await page.evaluate(
    ({ row, label }) => {
      for (const r of document.querySelectorAll("#settings-page .gs-row")) {
        if (r.querySelector(".gs-row-name")?.textContent?.trim() !== row) continue;
        for (const b of r.querySelectorAll(".gs-seg-btn")) {
          if (b.textContent.trim() === label) {
            b.click();
            return true;
          }
        }
      }
      return false;
    },
    { row, label },
  );
  if (!ok) throw new Error(`option « ${label} » of « ${row} » not found`);
  await sleep(400); // a frame or two with the new value
}

async function slide(page, row, value) {
  await page.evaluate(
    ({ row, value }) => {
      for (const r of document.querySelectorAll("#settings-page .gs-row")) {
        if (r.querySelector(".gs-row-name")?.textContent?.trim() !== row) continue;
        const input = r.querySelector("input[type=range]");
        input.value = String(value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    { row, value },
  );
  await sleep(500);
}

const shot = async (page, name) => {
  await gc(page);
  await sleep(300);
  await page.screenshot({ path: resolve(OUT, name) });
  log(`screenshot ${name}`);
};

try {
  const { page, errors } = await open();
  log("menu up");
  let s = await state(page);
  check(s.preset === "bas", `old « LOW » migrated to the Bas preset (${s.preset})`);
  check(s.samples === 0 && s.fxaa === true, `Bas on Givre: FXAA pass, no MSAA buffers (samples ${s.samples}, FXAA ${s.fxaa})`);
  check(s.frameInterval === 0, `old « FPS LIMIT: OFF » migrated (frame interval ${s.frameInterval})`);
  const programs0 = s.programs;
  const ratio0 = s.ratio;
  log(`programs after load: ${programs0}, pixel ratio ${ratio0}, DPR ${s.dpr}`);

  // ---- Open from the main menu ----
  await page.evaluate(() => document.querySelector('[data-menu="settings"]').click());
  await sleep(800);
  s = await state(page);
  const layout = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll("#settings-page .gs-tab")].map((t) => t.textContent),
    presets: [...document.querySelectorAll("#settings-page .gs-presets .gs-seg-btn")].map((b) => b.textContent),
    menuHidden: document.getElementById("main-menu-root").classList.contains("settings-open"),
    rows: [...document.querySelectorAll("#gs-pane-graphics .gs-row-name")].map((n) => n.textContent),
  }));
  check(s.pageOpen && layout.menuHidden, "« PARAMÈTRES » opens the page over the live map (menu UI steps aside)");
  check(layout.tabs.join("|") === "Graphismes|Réticule|Audio", `tabs: ${layout.tabs.join(", ")}`);
  check(layout.presets.join("|") === "Automatique|Bas|Moyen|Élevé|Ultra|Personnalisé", `presets: ${layout.presets.join(", ")}`);
  for (const name of ["Résolution de rendu", "Anticrénelage", "Ombres", "Qualité des ombres", "Ombres des personnages", "Neige", "Halos des lumières", "Empreintes dans la neige", "Particules", "Filtrage anisotrope", "Limite d'images par seconde", "Panneau de performances"]) {
    check(layout.rows.includes(name), `row « ${name} »`);
  }
  check(!layout.rows.some((r) => /Lumières des effets|dynamique/i.test(r)), "no « Lumières des effets » / « Résolution dynamique » row");
  await sleep(1200); // the live card fills
  await shot(page, "01-menu-graphismes.png");

  // ---- Live options ----
  await pick(page, "Anticrénelage", "MSAA 4×");
  s = await state(page);
  check(s.samples >= 2 && s.fxaa === false && s.preset === "custom", `MSAA 4× live: ${s.samples} samples, FXAA off, preset ${s.preset}`);
  await pick(page, "Anticrénelage", "MSAA 2×");
  s = await state(page);
  check(s.samples === 2 && s.fxaa === false, `MSAA 2× live: ${s.samples} samples`);
  await pick(page, "Anticrénelage", "Aucun");
  s = await state(page);
  check(s.samples === 0 && s.fxaa === false, "no anti-aliasing live: no MSAA, FXAA off");
  await pick(page, "Anticrénelage", "FXAA");
  s = await state(page);
  check(s.samples === 0 && s.fxaa === true && s.preset === "bas", `back to FXAA: the Bas preset again (${s.preset})`);

  await slide(page, "Résolution de rendu", 70);
  s = await state(page);
  check(Math.abs(s.ratio - ratio0 * 0.7) < 0.01 && Math.abs(s.canvas[0] - Math.floor(W * ratio0 * 0.7)) <= 1, `render scale 70 % live: pixel ratio ${s.ratio.toFixed(3)}, canvas ${s.canvas.join(" × ")}`);
  await slide(page, "Résolution de rendu", 100);
  s = await state(page);
  check(Math.abs(s.ratio - ratio0) < 1e-6, "render scale back to 100 %");

  const snowBefore = (await state(page)).snowCount;
  await pick(page, "Neige", "Dense");
  s = await state(page);
  check(s.snowCount > snowBefore, `snow « Dense » live: ${snowBefore} → ${s.snowCount} flakes`);
  await pick(page, "Neige", "Désactivée");
  s = await state(page);
  check(s.snowVisible === false, "snow off live");
  await pick(page, "Halos des lumières", "Non");
  s = await state(page);
  check(s.halosVisible === false, "halos off live");
  await pick(page, "Filtrage anisotrope", "8×");
  s = await state(page);
  check(s.aniso === 8, `anisotropic filtering 8× live (texture: ${s.aniso})`);
  const shadowBefore = (await state(page)).shadowSize;
  await pick(page, "Qualité des ombres", "Haute");
  s = await state(page);
  check(s.shadowSize && s.shadowSize[0] === shadowBefore[0] * 2, `shadow quality « Haute » live: ${shadowBefore.join("×")} → ${s.shadowSize.join("×")}`);
  await pick(page, "Particules", "Réduites");
  s = await state(page);
  check(s.particles === 0.5, "particles reduced live");
  await pick(page, "Limite d'images par seconde", "60");
  s = await state(page);
  check(Math.abs(s.frameInterval - 1000 / 60) < 1e-6, "frame cap 60 live");
  await sleep(1000);
  s = await state(page);
  check(s.programs === programs0, `no program compiled by any live change (${programs0} → ${s.programs})`);
  await shot(page, "02-personnalise.png");

  // Back to a preset: everything at once.
  await page.evaluate(() => {
    for (const b of document.querySelectorAll("#settings-page .gs-presets .gs-seg-btn")) if (b.textContent === "Bas") b.click();
  });
  await sleep(600);
  s = await state(page);
  check(s.preset === "bas" && s.snowVisible && s.halosVisible && s.aniso === 1 && s.particles === 1, "« Bas » puts every option back at once");

  // ---- Reload-only option ----
  await pick(page, "Ombres", "Dynamiques");
  s = await state(page);
  const chipShown = await page.evaluate(() => {
    for (const r of document.querySelectorAll("#settings-page .gs-row")) {
      if (r.querySelector(".gs-row-name")?.textContent?.trim() === "Ombres") return !r.querySelector(".gs-chip-reload").classList.contains("hidden");
    }
    return false;
  });
  check(s.reloadVisible && /Ombres\s*:\s*dynamiques/.test(s.reloadText) && chipShown, `reload-only change flagged: « ${s.reloadText.slice(0, 90)}… »`);
  check(!s.reloadWarnVisible, "no in-match warning in the main menu");
  await page.evaluate(() => document.querySelector(".gs-reload")?.scrollIntoView());
  await shot(page, "03-rechargement.png");
  await pick(page, "Ombres", "Statiques");
  s = await state(page);
  check(!s.reloadVisible, "reload bar gone once the change is undone");

  // ---- Other tabs ----
  await page.evaluate(() => document.getElementById("gs-tab-crosshair").click());
  await sleep(500);
  await shot(page, "04-reticule.png");
  await page.evaluate(() => document.getElementById("gs-tab-audio").click());
  await sleep(400);
  await shot(page, "05-audio.png");
  await page.evaluate(() => document.getElementById("gs-tab-graphics").click());
  await sleep(300);

  // ---- Detection: software renderer → the floor at once ----
  const soft = await page.evaluate(async () => {
    const r = await window.__settings.controller.runDetection("manual");
    return { summary: r?.summary ?? "", preset: window.__settings.store.get().graphics.preset, complete: r?.complete };
  });
  check(soft.preset === "auto" && /Rendu logiciel/.test(soft.summary), `software renderer: floor chosen at once (« ${soft.summary.slice(0, 70)}… »)`);

  // ---- Detection: the real probes (forced on the software renderer) ----
  const programsBefore = (await state(page)).programs;
  // Started through the controller as the page's button does (forced on the software renderer), the
  // page's state read in the same task: it must show the run from its very first probe. In SwiftShader
  // the floor misses 60 FPS and the detection ends after two probes (a few seconds).
  const started = await page.evaluate(() => {
    window.__detection = { done: false, result: null, progress: [] };
    const c = window.__settings.controller;
    const off = c.subscribe((e) => {
      if (e.kind === "progress") window.__detection.progress.push(e.progress.done);
    });
    void c.runDetection("manual", { allowSoftware: true }).then((r) => {
      window.__detection.done = true;
      window.__detection.result = r;
      off();
    });
    return {
      text: document.querySelector(".gs-detect-text")?.textContent ?? "",
      button: document.querySelector(".gs-detect .gs-btn")?.textContent ?? "",
      locked: document.querySelector("#gs-pane-graphics .gs-row")?.inert === true,
      progressShown: !document.querySelector(".gs-detect-progress")?.classList.contains("hidden"),
      orbit: window.__settings.game.menuPreview?.orbit ?? null,
      focus: document.hasFocus(),
    };
  });
  log(`detection running (focus ${started.focus})`);
  check(
    /Mesure \d+ sur \d+/.test(started.text) && started.button === "Annuler" && started.locked && started.progressShown,
    `detection in progress shown (« ${started.text.slice(0, 40)}… », button ${started.button}, options locked, progress bar)`,
  );
  await shot(page, "06-detection.png");
  const orbit1 = await page.evaluate(() => (window.__detection.done ? null : window.__settings.game.menuPreview?.orbit ?? null));
  check(orbit1 === null || orbit1 === started.orbit, "the menu camera holds still while the detection measures");
  await page.waitForFunction(() => window.__detection.done, null, { timeout: 240000, polling: 500 });
  const det = await page.evaluate(() => {
    const r = window.__detection.result;
    const rec = window.__settings.store.get();
    return { r, preset: rec.graphics.preset, stored: rec.graphics.auto.GIVRE ?? null, text: document.querySelector(".gs-detect-text")?.textContent ?? "" };
  });
  log(`detection: ${JSON.stringify({ mode: det.r?.mode, measuredFps: det.r?.measuredFps, complete: det.r?.complete, values: det.r?.values })}`);
  check(det.r && det.preset === "auto" && det.stored && det.stored.version >= 1 && det.stored.summary.length > 20, `detection completed and stored as « Automatique » (complete ${det.r?.complete})`);
  s = await state(page);
  const floor = Math.max(50, Math.min(100, 100 / s.dpr));
  check(det.r && det.r.values.renderScale >= floor - 1e-6, `result never under the beauty floor (${det.r?.values.renderScale} % ≥ ${floor} %)`);
  const plain = (t) => (t ?? "").replace(/[\u00a0\u202f]/g, " ");
  check(plain(det.text) === plain(det.stored?.summary), "the page shows the detection's summary");
  s = await state(page);
  check(s.programs === programsBefore, `no program compiled by the detection's probes (${programsBefore} → ${s.programs})`);
  await sleep(1500);
  await shot(page, "07-detection-terminee.png");

  // ---- Pause menu ----
  await page.evaluate(() => window.__settings.page.close());
  await page.evaluate(() => document.getElementById("menu-cta")?.click());
  await page.waitForFunction(() => !document.documentElement.classList.contains("hud-menu-active"), null, { timeout: 300000, polling: 500 });
  await sleep(2000);
  await gc(page);
  // Escape: the pointer lock ends (headless may or may not have granted it) → the pause menu.
  const paused = await page.evaluate(async () => {
    const locked = document.pointerLockElement !== null;
    document.exitPointerLock();
    await new Promise((r) => setTimeout(r, 500));
    if (!document.body.classList.contains("game-paused")) {
      Object.defineProperty(document, "pointerLockElement", { get: () => null, configurable: true });
      document.dispatchEvent(new Event("pointerlockchange"));
    }
    return {
      locked,
      focus: document.hasFocus(),
      paused: document.body.classList.contains("game-paused"),
      menuShown: !document.getElementById("main-menu").classList.contains("menu-hidden"),
    };
  });
  check(paused.paused && paused.menuShown, `pause menu shown (pointer was locked: ${paused.locked}, focus ${paused.focus})`);
  await sleep(800);
  await page.evaluate(() => document.querySelector('[data-menu="settings"]').click());
  await sleep(1500);
  s = await state(page);
  check(s.pageOpen, "« PARAMÈTRES » opens the page from the pause menu");
  await shot(page, "08-pause.png");
  await pick(page, "Ombres", "Dynamiques");
  s = await state(page);
  check(s.reloadVisible && s.reloadWarnVisible, "in a match, the reload bar warns that reloading leaves the match");
  await page.evaluate(() => document.querySelector(".gs-reload")?.scrollIntoView());
  await shot(page, "09-pause-rechargement.png");
  await pick(page, "Ombres", "Statiques");
  // Escape closes the page.
  await page.keyboard.press("Escape");
  await sleep(400);
  s = await state(page);
  check(!s.pageOpen, "Escape closes the page");
  const fatal = errors.filter((e) => !/favicon|net::ERR|Failed to load resource/i.test(e));
  check(fatal.length === 0, `no console error (${fatal.slice(0, 3).join(" | ")})`);
  await page.close();

  // ---- First launch (no old key): « Automatique », measured a few seconds after the menu appears;
  // narrow window: the panel takes the width ----
  {
    const { page: first, errors: firstErrors } = await open({ w: 960, h: 540, dsf: 1, legacy: false });
    const before = await first.evaluate(() => ({ preset: window.__settings.store.get().graphics.preset, detecting: window.__settings.controller.detecting }));
    check(before.preset === "auto", `first launch: « Automatique » (${before.preset})`);
    await first.waitForFunction(() => !!window.__settings.store.get().graphics.auto.GIVRE, null, { timeout: 180000, polling: 500 });
    const toast = await first.evaluate(() => {
      const t = document.getElementById("menu-gfx-toast");
      return { text: t?.textContent ?? "", shown: !!t && !t.classList.contains("hidden"), action: !!t?.querySelector("button") };
    });
    // (SwiftShader: the software-rendering notice; a real GPU: « Graphismes réglés… ».)
    const software = await first.evaluate(() => window.__settings.game.softwareRenderer === true);
    check(
      toast.shown && (software ? /Rendu logiciel détecté/ : /Graphismes réglés/).test(toast.text) && toast.action,
      `first launch: detected by itself, the menu says so (« ${toast.text.slice(0, 80)}… »)`,
    );
    await shot(first, "10-premier-lancement.png");
    await first.evaluate(() => document.querySelector('[data-menu="settings"]').click());
    await sleep(2000);
    await shot(first, "11-fenetre-etroite.png");
    const fatalFirst = firstErrors.filter((e) => !/favicon|net::ERR|Failed to load resource/i.test(e));
    check(fatalFirst.length === 0, `first launch: no console error (${fatalFirst.slice(0, 3).join(" | ")})`);
    await first.close();
  }
} finally {
  await browser.close();
}
console.log(failures ? `${failures} FAILED` : "ALL OK");
process.exit(failures ? 1 : 0);
