// GRAPHICS SETTINGS MODEL — headless checks of src/settings (GraphicsSettings, SettingsStore, labels)
// and the legacy facade of src/game/GraphicsQuality:
//   - the presets Low / High are EXACTLY the old LOW / HIGH on every display density (pixel ratio,
//     MSAA, shadow sizes, static vs live shadows, frame cap, anisotropy);
//   - the "auto" choice before / after a detection (per GPU, per map, per target), editing →
//     Custom, live vs reload-only changes, the beauty floor, the frame cap and the target;
//   - validation of untrusted storage, the migration of every old key, persistence round trips,
//     storage failures, and the two-way bridge with the old quality / FPS-cap keys.
// Usage (repo root):  npx tsx scripts/test-graphics-settings.mts
import assert from "node:assert/strict";

const G = await import("../src/settings/GraphicsSettings.ts");
const S = await import("../src/settings/SettingsStore.ts");
const Q = await import("../src/game/GraphicsQuality.ts");
const L = await import("../src/settings/labels.ts");
const O = await import("../src/game/OutlineSettings.ts");
const C = await import("../src/ui/CrosshairSettings.ts");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

/** In-memory Storage (optionally failing). */
function memoryStorage(init: Record<string, string> = {}, opts: { failWrites?: boolean; failReads?: boolean } = {}) {
  const map = new Map(Object.entries(init));
  return {
    map,
    writes: 0,
    getItem(key: string): string | null {
      if (opts.failReads) throw new Error("SecurityError");
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      if (opts.failWrites) throw new Error("QuotaExceededError");
      this.writes++;
      map.set(key, value);
    },
  };
}

const DPRS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3];
const STRONG = { name: "NVIDIA GeForce RTX 2080 SUPER · D3D11", weak: false };
const WEAK = { name: "Intel(R) Iris(R) Xe Graphics · D3D11", weak: true };
const MAP = "GIVRE";

// The OLD presets (src/game/GraphicsQuality.ts before the settings page), verbatim.
const OLD = {
  HIGH: { pixelRatioCap: 2, antialias: true, shadowMapSize: 2048, staticShadows: false, maxFps: Infinity, anisotropy: 8 },
  LOW: { pixelRatioCap: 1, antialias: false, shadowMapSize: 1024, staticShadows: true, maxFps: 60, anisotropy: 1 },
} as const;
const OLD_GIVRE_SHADOW = { HIGH: 4096, LOW: 2048 } as const;

console.log("graphics settings model");

await test("Low / High = the old LOW / HIGH on every display density (renderer pixel ratio, MSAA, shadows, cap, anisotropy)", () => {
  for (const dpr of DPRS) {
    for (const [id, level] of [
      ["bas", "LOW"],
      ["eleve", "HIGH"],
    ] as const) {
      const v = G.presetValues(id, { dpr });
      const old = OLD[level];
      const q = Q.legacyQuality(v, { dpr }, G.resolveFpsCap("auto", id));
      // The old renderer pixel ratio: Math.min(devicePixelRatio, cap) — bit for bit.
      assert.equal(G.pixelRatioFor(v.renderScale, dpr), Math.min(dpr, old.pixelRatioCap), `${id} ratio @${dpr}`);
      assert.equal(q.pixelRatioCap, Math.min(dpr, old.pixelRatioCap));
      assert.equal(q.antialias, old.antialias);
      assert.equal(q.shadowMapSize, old.shadowMapSize);
      assert.equal(q.staticShadows, old.staticShadows);
      assert.equal(q.maxFps, old.maxFps);
      assert.equal(q.anisotropy, old.anisotropy);
      assert.equal(q.level, level);
      // Givre: shadow size from the level, FXAA (LOW) vs composer MSAA 4× (HIGH).
      assert.equal(G.shadowMapTierSize(v.shadowQuality, true), OLD_GIVRE_SHADOW[level]);
      assert.equal(v.antialiasing, level === "LOW" ? "fxaa" : "msaa4");
      assert.equal(G.msaaSamples(v.antialiasing), level === "LOW" ? 0 : 4);
      assert.equal(v.snow, "normale");
      assert.equal(v.halos && v.footprints, true);
      assert.equal(v.particles, "normal");
    }
  }
});

await test("presets: Medium sits between Low and High, Ultra above High; every preset matches itself", () => {
  for (const dpr of DPRS) {
    const env = { dpr };
    const bas = G.presetValues("bas", env);
    const moyen = G.presetValues("moyen", env);
    const eleve = G.presetValues("eleve", env);
    const ultra = G.presetValues("ultra", env);
    assert.ok(bas.renderScale <= moyen.renderScale && moyen.renderScale <= eleve.renderScale && eleve.renderScale <= ultra.renderScale);
    assert.equal(ultra.renderScale, 100);
    assert.equal(moyen.antialiasing, "msaa2");
    assert.equal(moyen.shadows, "dynamic");
    assert.equal(ultra.shadowQuality, "ultra");
    assert.equal(ultra.anisotropy, 16);
    for (const id of G.PRESET_IDS) assert.equal(G.matchPreset(G.presetValues(id, env), env), id, `${id} @${dpr}`);
  }
});

await test("render scale: % of native per axis, never above 100 % for a pixel cap, slider bounds respected", () => {
  assert.equal(G.scaleForPixelCap(1, 1.25), 80);
  assert.equal(G.scaleForPixelCap(2, 1.25), 100);
  assert.equal(G.scaleForPixelCap(1, 2), 50);
  assert.equal(G.pixelRatioFor(100, 1.25), 1.25);
  assert.equal(G.pixelRatioFor(80, 1.25), 1);
  assert.equal(G.pixelRatioFor(100 / 1.5, 1.5), 1); // snapped: one pixel per CSS pixel exactly
  assert.equal(G.pixelRatioFor(150, 1), 1.5);
  assert.equal(G.pixelRatioFor(1, 1), 0.25); // never a degenerate canvas
  const v = G.sanitizeGraphicsValues({ renderScale: 9999 }, G.presetValues("eleve", { dpr: 1 }));
  assert.equal(v.renderScale, G.RENDER_SCALE_MAX);
  assert.equal(G.sanitizeGraphicsValues({ renderScale: -5 }, v).renderScale, G.RENDER_SCALE_MIN);
  assert.equal(G.RENDER_SCALE_STEP, 1);
});

await test("beauty floor = the old LOW resolution (one pixel per CSS pixel), within the slider", () => {
  assert.equal(G.floorRenderScale({ dpr: 1 }), 100);
  assert.equal(G.floorRenderScale({ dpr: 0.9 }), 100);
  assert.equal(G.floorRenderScale({ dpr: 1.25 }), 80);
  assert.equal(G.floorRenderScale({ dpr: 2 }), 50);
  assert.equal(G.floorRenderScale({ dpr: 3 }), 50);
  for (const dpr of DPRS) assert.ok(G.floorRenderScale({ dpr }) >= G.presetValues("bas", { dpr }).renderScale - 1e-9);
  assert.equal(G.FLOOR.antialiasing, "fxaa");
  assert.equal(G.FLOOR.anisotropy, 1);
  assert.equal(G.FLOOR.shadowQuality, "medium");
});

await test("auto choice: the old heuristic until a detection of THIS GPU and map, then the measured values", () => {
  const env = { dpr: 1.25 };
  const choice = { preset: "auto" as const, custom: null, auto: {} as Record<string, never> };
  assert.equal(G.sameValues(G.effectiveValues(choice, env, WEAK, MAP), G.presetValues("bas", env)), true);
  assert.equal(G.sameValues(G.effectiveValues(choice, env, STRONG, MAP), G.presetValues("eleve", env)), true);
  assert.equal(G.effectivePreset(choice, WEAK, MAP), "bas");
  assert.equal(G.effectivePreset(choice, STRONG, MAP), "eleve");
  const measured = { ...G.presetValues("bas", env), renderScale: 100, anisotropy: 4 as const };
  const result = {
    values: measured, at: 1, gpu: WEAK.name, map: MAP, targetFps: 60, measuredFps: 60, mode: "target" as const,
    complete: true, measuredShadows: "static" as const, summary: "ok", version: G.AUTO_TUNE_VERSION,
  };
  const detected = { preset: "auto" as const, custom: null, auto: { [MAP]: result } };
  assert.equal(G.sameValues(G.effectiveValues(detected, env, WEAK, MAP), measured), true);
  assert.equal(G.effectivePreset(detected, WEAK, MAP), "auto"); // → the "auto" frame cap: uncapped
  // Another map, another GPU, an older logic: the heuristic again.
  assert.equal(G.sameValues(G.effectiveValues(detected, env, WEAK, "JUNGLE"), G.presetValues("bas", env)), true);
  assert.equal(G.sameValues(G.effectiveValues(detected, env, { name: "Other", weak: true }, MAP), G.presetValues("bas", env)), true);
  const old = { ...detected, auto: { [MAP]: { ...result, version: G.AUTO_TUNE_VERSION - 1 } } };
  assert.equal(G.sameValues(G.effectiveValues(old, env, WEAK, MAP), G.presetValues("bas", env)), true);
  // A named preset ignores the detection, which stays stored.
  const picked = { ...detected, preset: "ultra" as const };
  assert.equal(G.sameValues(G.effectiveValues(picked, env, WEAK, MAP), G.presetValues("ultra", env)), true);
  assert.ok(picked.auto[MAP]);
});

await test("needsDetection: missing / other target / interrupted / older logic / changed shadow mode in effect", () => {
  const env = { dpr: 1 };
  const base = {
    values: G.presetValues("eleve", env), at: 1, gpu: STRONG.name, map: MAP, targetFps: 240, measuredFps: 240,
    mode: "target" as const, complete: true, measuredShadows: "dynamic" as const, summary: "", version: G.AUTO_TUNE_VERSION,
  };
  const choice = (r: typeof base | null, preset: "auto" | "eleve" = "auto") => ({ preset, custom: null, auto: r ? { [MAP]: r } : {} });
  assert.equal(G.needsDetection(choice(null), STRONG, MAP, 240, "dynamic"), true);
  assert.equal(G.needsDetection(choice(base), STRONG, MAP, 240, "dynamic"), false);
  assert.equal(G.needsDetection(choice(base, "eleve"), STRONG, MAP, 240, "dynamic"), false); // not "auto": never
  assert.equal(G.needsDetection(choice(base), STRONG, MAP, 144, "dynamic"), true); // target changed
  assert.equal(G.needsDetection(choice(base), STRONG, "YARD", 240, "dynamic"), true); // first time on that map
  assert.equal(G.needsDetection(choice({ ...base, complete: false }), STRONG, MAP, 240, "dynamic"), true);
  assert.equal(G.needsDetection(choice({ ...base, version: 0 }), STRONG, MAP, 240, "dynamic"), true);
  // The detection advised static shadows (reload): measured again once they are in effect, not before.
  const advised = { ...base, values: { ...base.values, shadows: "static" as const, characterShadows: false } };
  assert.equal(G.needsDetection(choice(advised), STRONG, MAP, 240, "dynamic"), false);
  assert.equal(G.needsDetection(choice(advised), STRONG, MAP, 240, "static"), true);
});

await test("editing a value → Custom; undoing it → the preset again; detections kept", () => {
  const env = { dpr: 1.25 };
  const start = { preset: "eleve" as const, custom: null, auto: {} };
  const edited = G.editChoice(start, "snow", "dense", env, STRONG, MAP);
  assert.equal(edited.preset, "custom");
  assert.equal(edited.custom!.snow, "dense");
  assert.equal(edited.custom!.antialiasing, "msaa4"); // the rest of High
  const undone = G.editChoice(edited, "snow", "normale", env, STRONG, MAP);
  assert.equal(undone.preset, "eleve");
  // From "auto" (heuristic Low on a weak GPU).
  const fromAuto = G.editChoice({ preset: "auto", custom: null, auto: {} }, "renderScale", 100, env, WEAK, MAP);
  assert.equal(fromAuto.preset, "custom");
  assert.equal(fromAuto.custom!.antialiasing, "fxaa");
  assert.equal(fromAuto.custom!.renderScale, 100);
});

await test("live vs reload-only: shadow mode, character shadows and the context MSAA wait for a reload", () => {
  const env = { dpr: 1 };
  const bas = G.presetValues("bas", env);
  const eleve = G.presetValues("eleve", env);
  const keys = (boot: typeof bas, next: typeof bas, composer: boolean) => G.reloadChanges(boot, next, { composer }).map((c) => c.key);
  assert.deepEqual(keys(bas, eleve, true), ["shadows"]); // Givre: MSAA is live (composer)
  assert.deepEqual(keys(bas, eleve, false), ["shadows", "antialiasing"]); // Jungle / Yard: context MSAA
  assert.deepEqual(keys(eleve, { ...eleve, characterShadows: false }, true), ["characterShadows"]);
  assert.deepEqual(keys(bas, { ...bas, characterShadows: true }, true), []); // static shadows: no character shadows anyway
  assert.deepEqual(keys(eleve, { ...eleve, renderScale: 70, snow: "off", anisotropy: 1, shadowQuality: "low", halos: false }, true), []);
  const live = G.liveValues(bas, eleve, { composer: true });
  assert.equal(live.shadows, "static");
  assert.equal(live.characterShadows, false);
  assert.equal(live.antialiasing, "msaa4");
  assert.equal(live.shadowQuality, "high");
  assert.equal(G.liveValues(bas, eleve, { composer: false }).antialiasing, "fxaa");
});

await test("frame cap: auto follows the preset (Low → 60), explicit values, unlimited", () => {
  assert.equal(G.resolveFpsCap("auto", "bas"), 60);
  for (const p of ["auto", "moyen", "eleve", "ultra", "custom"] as const) assert.equal(G.resolveFpsCap("auto", p), Infinity);
  assert.equal(G.resolveFpsCap(144, "bas"), 144);
  assert.equal(G.resolveFpsCap(0, "bas"), Infinity);
});

await test("detection target: the display's rate, never above it, under an explicit cap, 30…240", () => {
  assert.equal(G.targetFps("display", 60.02, Infinity), 60);
  assert.equal(G.targetFps("display", 1000 / 4.166, Infinity), 240);
  assert.equal(G.targetFps("display", 360, Infinity), 240);
  assert.equal(G.targetFps("display", 50, Infinity), 50); // a 50 Hz screen: 50, not an unreachable 60
  assert.equal(G.targetFps(144, 60, Infinity), 60); // never above the display
  assert.equal(G.targetFps(60, 240, Infinity), 60);
  assert.equal(G.targetFps("display", 240, 144), 144);
  assert.equal(G.snapRefreshRate(59.94), 60);
  assert.equal(G.snapRefreshRate(143.8), 144);
  assert.equal(G.snapRefreshRate(238), 240);
  assert.equal(G.snapRefreshRate(NaN), 60);
});

await test("validation of untrusted values: bad / missing fields take the fallback's", () => {
  const fb = G.presetValues("eleve", { dpr: 1 });
  const v = G.sanitizeGraphicsValues(
    { renderScale: "x", antialiasing: "ssaa", shadows: 3, shadowQuality: "ultra", snow: "legere", anisotropy: 3, halos: "yes", effectLights: 2 },
    fb,
  );
  assert.equal(v.renderScale, fb.renderScale);
  assert.equal(v.antialiasing, fb.antialiasing);
  assert.equal(v.shadows, fb.shadows);
  assert.equal(v.shadowQuality, "ultra");
  assert.equal(v.snow, "legere");
  assert.equal(v.anisotropy, fb.anisotropy);
  assert.equal(v.halos, fb.halos);
  assert.equal("effectLights" in v, false); // the removed option is dropped
  for (const raw of [null, undefined, 42, "x", []]) assert.equal(G.sameValues(G.sanitizeGraphicsValues(raw, fb), fb), true);
});

await test("labels: every option value has an English label, descriptions name what the map uses", () => {
  for (const a of G.ANTIALIASING) assert.ok(L.AA_LABELS[a]);
  for (const s of G.SHADOW_MODES) assert.ok(L.SHADOW_LABELS[s]);
  for (const q of G.SHADOW_QUALITIES) assert.ok(L.SHADOW_QUALITY_LABELS[q]);
  for (const s of G.SNOW_LEVELS) assert.ok(L.SNOW_LABELS[s]);
  for (const p of G.PRESET_CHOICES) assert.ok(L.PRESET_LABELS[p]);
  assert.equal(L.formatNumber(16.666, 1), "16.7");
  assert.equal(L.formatPercent(80), "80%");
  const d = L.describeValues(G.presetValues("bas", { dpr: 1.25 }), G.DEFAULT_CAPS);
  assert.match(d, /^80% resolution/);
  assert.match(d, /FXAA/);
  assert.match(d, /static shadows \(medium\)/);
  assert.match(d, /normal snow/);
  assert.equal(/snow/.test(L.describeValues(G.presetValues("bas", { dpr: 1 }), { ...G.DEFAULT_CAPS, snow: false })), false);
  assert.equal(L.fpsCapLabel("auto", "bas"), "Auto (60)");
  assert.equal(L.fpsCapLabel("auto", "eleve"), "Auto (off)");
  assert.equal(L.fpsCapLabel(0, "bas"), "Off");
  assert.equal(L.fpsTargetLabel("display", 143.9), "Screen (144)");
  assert.deepEqual(
    G.PRESET_CHOICES.map((p) => L.PRESET_LABELS[p]),
    ["Auto", "Low", "Medium", "High", "Ultra", "Custom"],
  );
  assert.equal(L.valueLabel("shadows", "dynamic"), "Dynamic");
  assert.equal(L.valueLabel("characterShadows", true), "On");
  // The game's UI is English: no French left in any label.
  const every = [
    ...Object.values(L.PRESET_LABELS), ...Object.values(L.AA_LABELS), ...Object.values(L.SHADOW_LABELS),
    ...Object.values(L.SHADOW_QUALITY_LABELS), ...Object.values(L.SNOW_LABELS), ...Object.values(L.PARTICLE_LABELS),
    ...Object.values(L.SETTING_NAMES), d,
  ];
  for (const text of every) assert.doesNotMatch(text, /[àâçéèêëîïôûùüœ«»]/i, text);
});

console.log("settings store");

const autoWeak = () => "bas" as const;
const autoStrong = () => "eleve" as const;

await test("migration: LOW / HIGH → Low / High, AUTO or nothing → Auto, FPS LIMIT kept", () => {
  const cases: [Record<string, string>, string, unknown][] = [
    [{}, "auto", "auto"],
    [{ "beanzo.graphicsQuality": "AUTO" }, "auto", "auto"],
    [{ "beanzo.graphicsQuality": "LOW" }, "bas", "auto"],
    [{ "beanzo.graphicsQuality": "HIGH", "beanzo.fpsCap": "60" }, "eleve", 60],
    [{ "beanzo.graphicsQuality": "LOW", "beanzo.fpsCap": "OFF" }, "bas", 0],
    [{ "beanzo.graphicsQuality": "garbage", "beanzo.fpsCap": "999" }, "auto", "auto"],
  ];
  for (const [init, preset, cap] of cases) {
    const r = S.migrateLegacy(memoryStorage(init), autoStrong);
    assert.equal(r.graphics.preset, preset, JSON.stringify(init));
    assert.equal(r.fpsCap, cap, JSON.stringify(init));
    assert.deepEqual(r.graphics.auto, {});
  }
});

await test("migration: an explicit snow level → Custom = the same preset with that snow (the game looks the same)", () => {
  const r1 = S.migrateLegacy(memoryStorage({ "beanzo.graphicsQuality": "HIGH", "slideio.givreSnow": "dense" }), autoWeak, 1.25);
  assert.equal(r1.graphics.preset, "custom");
  assert.equal(G.sameValues(r1.graphics.custom!, { ...G.presetValues("eleve", { dpr: 1.25 }), snow: "dense" }), true);
  assert.equal(r1.fpsCap, "auto");
  // AUTO on a weak GPU was LOW (capped at 60): Custom from Low, the 60 cap pinned.
  const r2 = S.migrateLegacy(memoryStorage({ "slideio.givreSnow": "off" }), autoWeak, 1.25);
  assert.equal(r2.graphics.preset, "custom");
  assert.equal(G.sameValues(r2.graphics.custom!, { ...G.presetValues("bas", { dpr: 1.25 }), snow: "off" }), true);
  assert.equal(r2.fpsCap, 60);
  assert.equal(G.resolveFpsCap(r2.fpsCap, "custom"), 60);
  // The default level changes nothing.
  assert.equal(S.migrateLegacy(memoryStorage({ "slideio.givreSnow": "normale" }), autoWeak).graphics.preset, "auto");
});

await test("migration: outline + crosshair records validated as before (untouched old crosshair → the new default)", () => {
  const r = S.migrateLegacy(
    memoryStorage({
      "slideio.givreOutline": JSON.stringify({ enabled: false, thickness: 99, intensity: 0.5 }),
      "slideio.crosshair": JSON.stringify({ shape: "CROSS", scale: 1.5, color: "#FF0000", highContrast: true, reducedMotion: false }),
    }),
    autoStrong,
  );
  assert.deepEqual(r.outline, { enabled: false, thickness: O.OUTLINE_THICKNESS_MAX, intensity: 0.5 });
  assert.deepEqual(r.crosshair, { shape: "CROSS", scale: 1.5, color: "#ff0000", highContrast: true, reducedMotion: false });
  const untouched = S.migrateLegacy(memoryStorage({ "slideio.crosshair": JSON.stringify({ shape: "DOT", scale: 1, color: "#FFFFFF" }) }), autoStrong);
  assert.deepEqual(untouched.crosshair, C.defaultCrosshairSettings());
  const broken = S.migrateLegacy(memoryStorage({ "slideio.givreOutline": "{nope", "slideio.crosshair": "[" }), autoStrong);
  assert.deepEqual(broken.outline, O.DEFAULT_OUTLINE_VALUES);
});

await test("store: first load migrates and persists ONE record; later loads read it; changes persist and notify", () => {
  const storage = memoryStorage({ "beanzo.graphicsQuality": "LOW", "beanzo.fpsCap": "60" });
  const store = new S.SettingsStore(storage, autoStrong);
  assert.equal(store.get().graphics.preset, "bas");
  assert.ok(storage.map.has(S.SETTINGS_KEY));
  let notified = 0;
  const off = store.subscribe(() => notified++);
  store.update((d) => {
    d.graphics.preset = "ultra";
    d.fpsTarget = 144;
    d.perfPanel = "fps";
  });
  assert.equal(notified, 1);
  off();
  store.update((d) => void (d.fpsCap = 144));
  assert.equal(notified, 1);
  const again = new S.SettingsStore(storage, autoWeak).get();
  assert.equal(again.graphics.preset, "ultra");
  assert.equal(again.fpsTarget, 144);
  assert.equal(again.fpsCap, 144);
  assert.equal(again.perfPanel, "fps");
});

await test("store: unreadable / unwritable storage → the session keeps working in memory", () => {
  const ro = memoryStorage({}, { failWrites: true });
  const store = new S.SettingsStore(ro, autoStrong);
  assert.equal(store.get().graphics.preset, "auto");
  store.update((d) => void (d.graphics.preset = "bas"));
  assert.equal(store.get().graphics.preset, "bas");
  const blocked = new S.SettingsStore(memoryStorage({}, { failReads: true }), autoStrong);
  assert.equal(blocked.get().graphics.preset, "auto");
  const none = new S.SettingsStore(null);
  assert.deepEqual(none.get().graphics, { preset: "auto", custom: null, auto: {} });
});

await test("store: corrupted / foreign records read as far as they validate", () => {
  for (const raw of ["{", "null", "[]", JSON.stringify({ v: 99, graphics: { preset: "laser" }, fpsCap: "x", perfPanel: 3 })]) {
    const store = new S.SettingsStore(memoryStorage({ [S.SETTINGS_KEY]: raw }), autoStrong);
    const r = store.get();
    assert.ok(G.PRESET_CHOICES.includes(r.graphics.preset));
    assert.ok(G.FPS_CAPS.includes(r.fpsCap));
    assert.ok(S.PERF_PANEL_MODES.includes(r.perfPanel));
  }
  // "custom" without values falls back to auto; detections: bad map keys and bad entries dropped.
  const r = S.sanitizeRecord({
    v: 1,
    graphics: {
      preset: "custom",
      custom: null,
      auto: { GIVRE: { values: { renderScale: 90 }, gpu: "A", version: 1, targetFps: 60 }, "bad key": { values: {} }, YARD: 5 },
    },
  });
  assert.equal(r.graphics.preset, "auto");
  assert.deepEqual(Object.keys(r.graphics.auto), ["GIVRE"]);
  assert.equal(r.graphics.auto.GIVRE.values.renderScale, 90);
  assert.equal(r.graphics.auto.GIVRE.map, "GIVRE");
  assert.equal(r.graphics.auto.GIVRE.complete, true);
});

await test("old keys bridge: the record keeps LOW / HIGH / AUTO and the FPS limit in step for an older build", () => {
  const storage = memoryStorage({});
  const store = new S.SettingsStore(storage, autoStrong);
  store.get();
  assert.equal(storage.map.get("beanzo.graphicsQuality"), "AUTO");
  store.update((d) => void (d.graphics.preset = "bas"));
  assert.equal(storage.map.get("beanzo.graphicsQuality"), "LOW");
  store.update((d) => void (d.fpsCap = 0));
  assert.equal(storage.map.get("beanzo.fpsCap"), "OFF");
  // Ultra / Custom / a 144 cap have no old equivalent: the keys keep their value.
  store.update((d) => {
    d.graphics.preset = "ultra";
    d.fpsCap = 144;
  });
  assert.equal(storage.map.get("beanzo.graphicsQuality"), "LOW");
  assert.equal(storage.map.get("beanzo.fpsCap"), "OFF");
});

await test("old keys bridge: a value written by someone else since (older build, bench script) is taken over at the next load", () => {
  const storage = memoryStorage({ "beanzo.graphicsQuality": "LOW" });
  new S.SettingsStore(storage, autoStrong).get(); // migrated: Low
  // Same store, nobody else wrote: no change.
  assert.equal(new S.SettingsStore(storage, autoStrong).get().graphics.preset, "bas");
  storage.map.set("beanzo.graphicsQuality", "HIGH");
  storage.map.set("beanzo.fpsCap", "60");
  const r = new S.SettingsStore(storage, autoStrong).get();
  assert.equal(r.graphics.preset, "eleve");
  assert.equal(r.fpsCap, 60);
  // Garbage in the old key is ignored.
  storage.map.set("beanzo.graphicsQuality", "MEGA");
  assert.equal(new S.SettingsStore(storage, autoStrong).get().graphics.preset, "eleve");
  // A detection survives a takeover (only the preset changes).
  const s2 = new S.SettingsStore(storage, autoStrong);
  s2.update((d) => {
    d.graphics.preset = "auto";
    d.graphics.auto = { GIVRE: { ...r.graphics.auto.GIVRE, values: G.presetValues("bas", { dpr: 1 }), gpu: "A", map: "GIVRE", at: 1, targetFps: 60, measuredFps: 60, mode: "target", complete: true, measuredShadows: "static", summary: "", version: G.AUTO_TUNE_VERSION } };
  });
  storage.map.set("beanzo.graphicsQuality", "LOW");
  const r3 = new S.SettingsStore(storage, autoStrong).get();
  assert.equal(r3.graphics.preset, "bas");
  assert.ok(r3.graphics.auto.GIVRE);
});

await test("outline / crosshair validation helpers stay pure (the HUD document imports them)", () => {
  assert.deepEqual(O.sanitizeOutlineValues({ enabled: "no", thickness: 0, intensity: 2 }), {
    enabled: O.DEFAULT_OUTLINE_VALUES.enabled,
    thickness: O.OUTLINE_THICKNESS_MIN,
    intensity: 1,
  });
  const ch = C.sanitizeCrosshairSettings({ shape: "STAR", scale: 99, color: "red" });
  assert.equal(ch.shape, "STICKER");
  assert.equal(ch.scale, C.CROSSHAIR_SCALE_MAX);
  assert.equal(ch.color, C.DEFAULT_CROSSHAIR.color);
});

console.log(`\nAll ${passed} graphics settings checks passed.`);
