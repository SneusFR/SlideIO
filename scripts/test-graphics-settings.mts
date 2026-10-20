// GRAPHICS SETTINGS MODEL — headless checks of src/settings (GraphicsSettings, SettingsStore) and the
// legacy facade of src/game/GraphicsQuality: the presets (Bas / Élevé = EXACTLY the old LOW / HIGH on
// every display density), editing → Personnalisé, the "auto" choice before / after a detection, the
// frame cap, live vs reload-only changes, validation of untrusted storage, the migration of every old
// key, persistence round trips and storage failures.
// Usage (repo root):  SLIDEIO_ROOT=$PWD node --import <vitenode>/register.mjs scripts/test-graphics-settings.mts
import assert from "node:assert/strict";

const G = await import("../src/settings/GraphicsSettings.ts");
const S = await import("../src/settings/SettingsStore.ts");
const Q = await import("../src/game/GraphicsQuality.ts");

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

const DPRS = [0.9, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3];
const STRONG = { name: "NVIDIA GeForce RTX 2080 SUPER · D3D11", weak: false };
const WEAK = { name: "Intel(R) Iris(R) Xe Graphics · D3D11", weak: true };

console.log("graphics settings model");

await test("Bas = the old LOW preset on every display density (pixel ratio min(DPR, 1), FXAA, static shadows, 1024 / 2048 maps, 60 FPS, aniso 1)", () => {
  for (const dpr of DPRS) {
    const v = G.presetValues("bas", { dpr });
    const q = Q.legacyQuality(v, { dpr }, G.resolveFpsCap("auto", "bas"));
    assert.equal(q.pixelRatioCap, Math.min(dpr, 1), `ratio @${dpr}`);
    assert.equal(q.antialias, false);
    assert.equal(q.shadowMapSize, 1024);
    assert.equal(q.level, "LOW"); // Givre: GivreConfig.shadowMapSize.LOW = 2048
    assert.equal(q.staticShadows, true);
    assert.equal(q.maxFps, 60);
    assert.equal(q.anisotropy, 1);
    assert.equal(v.antialiasing, "fxaa"); // Givre composer: OutputFXAAPass, no MSAA
    assert.equal(G.msaaSamples(v.antialiasing), 0);
    assert.equal(v.shadows, "static");
    assert.equal(v.snow, "normale");
    assert.equal(v.effectLights, 2);
    assert.equal(v.halos && v.footprints && v.particles === "normal", true);
  }
});

await test("Élevé = the old HIGH preset on every display density (min(DPR, 2), MSAA 4×, live shadows with characters, 2048 / 4096, uncapped, aniso 8)", () => {
  for (const dpr of DPRS) {
    const v = G.presetValues("eleve", { dpr });
    const q = Q.legacyQuality(v, { dpr }, G.resolveFpsCap("auto", "eleve"));
    assert.equal(q.pixelRatioCap, Math.min(dpr, 2), `ratio @${dpr}`);
    assert.equal(q.antialias, true);
    assert.equal(G.msaaSamples(v.antialiasing), 4);
    assert.equal(q.shadowMapSize, 2048);
    assert.equal(q.level, "HIGH"); // Givre 4096
    assert.equal(q.staticShadows, false);
    assert.equal(q.maxFps, Infinity);
    assert.equal(q.anisotropy, 8);
    assert.equal(v.shadows, "dynamic");
    assert.equal(v.characterShadows, true);
  }
});

await test("pixel ratio of a preset is exact (no 0.9999… that would floor the canvas one pixel short)", () => {
  for (const dpr of DPRS) {
    for (const id of G.PRESET_IDS) {
      const ratio = G.pixelRatioFor(G.presetValues(id, { dpr }).renderScale, dpr);
      const cap = G.presetPixelCap(id);
      const expected = cap === null ? dpr : Math.min(dpr, cap);
      assert.equal(ratio, Math.round(expected * 1e6) / 1e6, `${id} @${dpr}`);
      assert.equal(Math.floor(1536 * ratio), Math.floor(1536 * expected), `canvas width ${id} @${dpr}`);
    }
  }
});

await test("Moyen sits between Bas and Élevé; Ultra spends more (native resolution, very fine shadows, 16×, dense snow)", () => {
  const rank = <T>(list: readonly T[], v: T) => list.indexOf(v);
  for (const dpr of [1, 1.25, 2]) {
    const bas = G.presetValues("bas", { dpr });
    const moyen = G.presetValues("moyen", { dpr });
    const eleve = G.presetValues("eleve", { dpr });
    const ultra = G.presetValues("ultra", { dpr });
    assert.ok(moyen.renderScale >= bas.renderScale && moyen.renderScale <= eleve.renderScale);
    assert.ok(rank(G.ANTIALIASING, moyen.antialiasing) > rank(G.ANTIALIASING, bas.antialiasing));
    assert.ok(rank(G.ANTIALIASING, moyen.antialiasing) < rank(G.ANTIALIASING, eleve.antialiasing));
    assert.ok(moyen.anisotropy > bas.anisotropy && moyen.anisotropy < eleve.anisotropy);
    assert.equal(ultra.renderScale, 100);
    assert.ok(ultra.renderScale >= eleve.renderScale);
    assert.equal(ultra.shadowQuality, "ultra");
    assert.equal(ultra.anisotropy, 16);
    assert.equal(ultra.snow, "dense");
  }
});

await test("shadow tiers: medium / high = the old LOW / HIGH sizes per map family", () => {
  assert.equal(G.shadowMapTierSize("medium", false), 1024);
  assert.equal(G.shadowMapTierSize("high", false), 2048);
  assert.equal(G.shadowMapTierSize("medium", true), 2048);
  assert.equal(G.shadowMapTierSize("high", true), 4096);
  assert.equal(G.shadowMapTierSize("low", true), 1024);
  assert.equal(G.shadowMapTierSize("ultra", true), 8192);
});

await test("matchPreset finds each preset back, and nothing for edited values", () => {
  for (const dpr of [1, 1.25, 2]) {
    for (const id of G.PRESET_IDS) assert.equal(G.matchPreset(G.presetValues(id, { dpr }), { dpr }), id);
    assert.equal(G.matchPreset({ ...G.presetValues("eleve", { dpr }), snow: "legere" }, { dpr }), null);
  }
});

await test("editing a value → Personnalisé with the current values + the edit; undoing the edit → the preset again", () => {
  const env = { dpr: 1.25 };
  const choice = { preset: "eleve" as const, custom: null, auto: null };
  const edited = G.editChoice(choice, "antialiasing", "fxaa", env, STRONG);
  assert.equal(edited.preset, "custom");
  assert.deepEqual(edited.custom, { ...G.presetValues("eleve", env), antialiasing: "fxaa" });
  const back = G.editChoice(edited, "antialiasing", "msaa4", env, STRONG);
  assert.equal(back.preset, "eleve");
  // From "auto" (heuristic Bas on a weak GPU): the custom values start from what was on screen.
  const auto = G.editChoice({ preset: "auto", custom: null, auto: null }, "snow", "dense", env, WEAK);
  assert.equal(auto.preset, "custom");
  assert.deepEqual(auto.custom, { ...G.presetValues("bas", env), snow: "dense" });
});

await test('"auto" before any detection = the old AUTO heuristic (weak GPU → Bas, else Élevé); a detection of THIS GPU wins', () => {
  const env = { dpr: 1 };
  const none = { preset: "auto" as const, custom: null, auto: null };
  assert.deepEqual(G.effectiveValues(none, env, WEAK), G.presetValues("bas", env));
  assert.deepEqual(G.effectiveValues(none, env, STRONG), G.presetValues("eleve", env));
  assert.equal(G.effectivePreset(none, WEAK), "bas");
  const detected = { ...G.presetValues("bas", env), renderScale: 85, snow: "legere" as const };
  const result = {
    values: detected,
    at: 1,
    gpu: WEAK.name,
    targetFps: 60,
    expectedFps: 61,
    limitedBy: "none" as const,
    belowTarget: false,
    summary: "ok",
    version: G.AUTO_TUNE_VERSION,
  };
  const withAuto = { preset: "auto" as const, custom: null, auto: result };
  assert.deepEqual(G.effectiveValues(withAuto, env, WEAK), detected);
  assert.equal(G.effectivePreset(withAuto, WEAK), "auto");
  // Another GPU (laptop's dGPU, a new machine) or an older detection logic: the heuristic again.
  assert.deepEqual(G.effectiveValues(withAuto, env, { name: "AMD Radeon RX 6600", weak: false }), G.presetValues("eleve", env));
  assert.deepEqual(G.effectiveValues({ ...withAuto, auto: { ...result, version: 0 } }, env, WEAK), G.presetValues("bas", env));
});

await test("frame cap: auto follows the preset (Bas → 60, the rest uncapped), explicit values win, 0 = unlimited", () => {
  assert.equal(G.resolveFpsCap("auto", "bas"), 60);
  for (const p of ["moyen", "eleve", "ultra", "custom", "auto"] as const) assert.equal(G.resolveFpsCap("auto", p), Infinity);
  assert.equal(G.resolveFpsCap(144, "bas"), 144);
  assert.equal(G.resolveFpsCap(0, "bas"), Infinity);
});

await test("detection target: the display rate (snapped), never below 60, never above 240 nor an explicit cap", () => {
  assert.equal(G.targetFps("display", 59.94, Infinity), 60);
  assert.equal(G.targetFps("display", 143.6, Infinity), 144);
  assert.equal(G.targetFps("display", 239.8, Infinity), 240);
  assert.equal(G.targetFps("display", 360, Infinity), 240);
  assert.equal(G.targetFps("display", 50, Infinity), 60);
  assert.equal(G.targetFps("display", 240, 60), 60);
  assert.equal(G.targetFps(144, 60, Infinity), 144);
  assert.equal(G.snapRefreshRate(1000 / 6.94), 144);
  assert.equal(G.snapRefreshRate(1000 / 16.67), 60);
});

await test("reload-only changes: shadow mode, character shadows (with dynamic shadows), effect lights, context MSAA without composer", () => {
  const env = { dpr: 1 };
  const bas = G.presetValues("bas", env);
  const eleve = G.presetValues("eleve", env);
  const keys = (boot: typeof bas, next: typeof bas, composer: boolean) =>
    G.reloadChanges(boot, next, { composer }).map((c) => c.key).sort();
  assert.deepEqual(keys(bas, eleve, true), ["shadows"]); // Givre: AA, scale, aniso, size… all live
  assert.deepEqual(keys(bas, eleve, false), ["antialiasing", "shadows"]); // Jungle / Yard: MSAA is the context's
  assert.deepEqual(keys(bas, { ...bas, renderScale: 70, snow: "off", anisotropy: 16, shadowQuality: "ultra" }, true), []);
  assert.deepEqual(keys(eleve, { ...eleve, characterShadows: false }, true), ["characterShadows"]);
  assert.deepEqual(keys(bas, { ...bas, characterShadows: true }, true), []); // static shadows: characters never cast anyway
  assert.deepEqual(keys(bas, { ...bas, effectLights: 0 }, true), ["effectLights"]);
  assert.deepEqual(keys(bas, { ...bas, antialiasing: "none" }, false), []); // FXAA ≡ none without a post chain
  // What the session shows meanwhile: live fields from the new values, reload-only ones from the boot.
  const live = G.liveValues(bas, { ...eleve, renderScale: 90 }, { composer: true });
  assert.equal(live.renderScale, 90);
  assert.equal(live.antialiasing, "msaa4");
  assert.equal(live.shadows, "static");
  assert.equal(live.effectLights, bas.effectLights);
});

await test("beauty floor: 80 % of native, never more than one pixel per CSS pixel; FXAA, light snow", () => {
  assert.equal(G.floorRenderScale({ dpr: 1 }), 80);
  assert.equal(G.floorRenderScale({ dpr: 1.25 }), 80); // = ratio 1.0: the old LOW resolution
  assert.equal(G.floorRenderScale({ dpr: 2 }), 50); // Retina at one pixel per CSS pixel
  assert.equal(G.floorRenderScale({ dpr: 4 }), G.RENDER_SCALE_MIN);
  assert.equal(G.FLOOR.antialiasing, "fxaa");
  assert.equal(G.FLOOR.snow, "legere");
});

await test("untrusted values are validated field by field (garbage, out of range, wrong types)", () => {
  const fb = G.presetValues("eleve", { dpr: 1 });
  assert.deepEqual(G.sanitizeGraphicsValues(null, fb), fb);
  assert.deepEqual(G.sanitizeGraphicsValues("nope", fb), fb);
  const v = G.sanitizeGraphicsValues(
    { renderScale: 9999, antialiasing: "ssaa", shadows: 3, shadowQuality: "ultra", snow: "legere", anisotropy: 3, effectLights: 1, halos: "yes" },
    fb,
  );
  assert.equal(v.renderScale, G.RENDER_SCALE_MAX);
  assert.equal(v.antialiasing, fb.antialiasing);
  assert.equal(v.shadows, fb.shadows);
  assert.equal(v.shadowQuality, "ultra");
  assert.equal(v.snow, "legere");
  assert.equal(v.anisotropy, fb.anisotropy);
  assert.equal(v.effectLights, 1);
  assert.equal(v.halos, fb.halos);
  assert.equal(G.sanitizeGraphicsValues({ renderScale: -5 }, fb).renderScale, G.RENDER_SCALE_MIN);
  assert.equal(G.sanitizeGraphicsValues({ renderScale: Number.NaN }, fb).renderScale, fb.renderScale);
});

console.log("settings record + migration");

await test("no old key → Automatique, auto cap, default outline / crosshair / panel; first-launch detection wanted", () => {
  const st = memoryStorage();
  const store = new S.SettingsStore(st, () => "bas", () => 1);
  const r = store.get();
  assert.equal(r.v, S.SETTINGS_VERSION);
  assert.equal(r.graphics.preset, "auto");
  assert.equal(r.fpsCap, "auto");
  assert.equal(r.fpsTarget, "display");
  assert.equal(r.dynamicResolution, false);
  assert.equal(r.perfPanel, "full");
  assert.equal(S.needsFirstDetection(r, "Intel(R) Iris(R) Xe Graphics · D3D11"), true);
  assert.ok(st.map.has(S.SETTINGS_KEY), "migrated record persisted once");
});

await test("old LOW / HIGH → Bas / Élevé exactly, no first-launch detection (the player chose)", () => {
  for (const [old, preset] of [["LOW", "bas"], ["HIGH", "eleve"]] as const) {
    const store = new S.SettingsStore(memoryStorage({ [S.LEGACY_KEYS.quality]: old }), () => "eleve");
    assert.equal(store.get().graphics.preset, preset);
    assert.equal(S.needsFirstDetection(store.get(), "any"), false);
  }
});

await test("old FPS LIMIT AUTO / 60 / OFF → auto / 60 / unlimited", () => {
  for (const [old, cap] of [["AUTO", "auto"], ["60", 60], ["OFF", 0]] as const) {
    const store = new S.SettingsStore(memoryStorage({ [S.LEGACY_KEYS.fpsCap]: old, [S.LEGACY_KEYS.quality]: "HIGH" }));
    assert.equal(store.get().fpsCap, cap);
  }
});

await test("old snow level other than normal → Personnalisé = that preset + the snow (same image), LOW keeps its 60 cap", () => {
  const dpr = 1.25;
  const low = new S.SettingsStore(memoryStorage({ [S.LEGACY_KEYS.quality]: "LOW", [S.LEGACY_KEYS.snow]: "legere" }), () => "eleve", () => dpr);
  const r = low.get();
  assert.equal(r.graphics.preset, "custom");
  assert.deepEqual(r.graphics.custom, { ...G.presetValues("bas", { dpr }), snow: "legere" });
  assert.equal(r.fpsCap, 60, "old LOW + AUTO cap = 60 → kept explicitly");
  assert.equal(G.resolveFpsCap(r.fpsCap, r.graphics.preset), 60);
  // AUTO quality: the custom values start from what the old AUTO picked on this GPU.
  let asked = 0;
  const auto = new S.SettingsStore(memoryStorage({ [S.LEGACY_KEYS.snow]: "off" }), () => (asked++, "bas"), () => 1);
  assert.equal(auto.get().graphics.preset, "custom");
  assert.equal(auto.get().graphics.custom?.snow, "off");
  assert.equal(auto.get().graphics.custom?.antialiasing, "fxaa");
  assert.equal(asked, 1);
  // Old snow "normale" (the default) is no choice at all: Automatique.
  const normal = new S.SettingsStore(memoryStorage({ [S.LEGACY_KEYS.snow]: "normale" }), () => "bas");
  assert.equal(normal.get().graphics.preset, "auto");
  // An explicit OFF cap stays OFF.
  const off = new S.SettingsStore(memoryStorage({ [S.LEGACY_KEYS.quality]: "LOW", [S.LEGACY_KEYS.snow]: "dense", [S.LEGACY_KEYS.fpsCap]: "OFF" }));
  assert.equal(off.get().fpsCap, 0);
});

await test("old outline and crosshair records → validated as before (legacy untouched crosshair → new default look)", () => {
  const st = memoryStorage({
    [S.LEGACY_KEYS.outline]: JSON.stringify({ enabled: false, thickness: 9, intensity: 0.4 }),
    [S.LEGACY_KEYS.crosshair]: JSON.stringify({ shape: "CROSS", scale: 1.5, color: "#FF0000", highContrast: true, reducedMotion: true }),
  });
  const r = new S.SettingsStore(st).get();
  assert.deepEqual(r.outline, { enabled: false, thickness: 3, intensity: 0.4 });
  assert.deepEqual(r.crosshair, { shape: "CROSS", scale: 1.5, color: "#ff0000", highContrast: true, reducedMotion: true });
  const legacy = new S.SettingsStore(
    memoryStorage({ [S.LEGACY_KEYS.crosshair]: JSON.stringify({ shape: "DOT", scale: 1, color: "#ffffff" }) }),
  ).get();
  assert.equal(legacy.crosshair.shape, "STICKER");
  const broken = new S.SettingsStore(memoryStorage({ [S.LEGACY_KEYS.outline]: "{nope", [S.LEGACY_KEYS.crosshair]: "[]" })).get();
  assert.equal(broken.outline.enabled, true);
  assert.equal(broken.crosshair.shape, "STICKER");
});

await test("migration runs once: the new record wins over the old keys afterwards", () => {
  const st = memoryStorage({ [S.LEGACY_KEYS.quality]: "LOW" });
  new S.SettingsStore(st).update((d) => void (d.graphics = { preset: "ultra", custom: null, auto: null }));
  st.map.set(S.LEGACY_KEYS.quality, "HIGH"); // an old key written later (old build) changes nothing
  assert.equal(new S.SettingsStore(st).get().graphics.preset, "ultra");
});

await test("round trip: update → persisted → reloaded identical; subscribers notified with the new record", () => {
  const st = memoryStorage();
  const store = new S.SettingsStore(st);
  const seen: string[] = [];
  store.subscribe((r) => seen.push(r.graphics.preset));
  store.update((d) => {
    d.graphics = { preset: "custom", custom: { ...G.presetValues("moyen", { dpr: 1 }), renderScale: 85 }, auto: null };
    d.fpsCap = 144;
    d.dynamicResolution = true;
    d.perfPanel = "fps";
    d.crosshair.color = "#00ff00";
  });
  assert.deepEqual(seen, ["custom"]);
  const again = new S.SettingsStore(st).get();
  assert.deepEqual(again, store.get());
  assert.equal(again.graphics.custom?.renderScale, 85);
  assert.equal(again.fpsCap, 144);
  assert.equal(again.dynamicResolution, true);
  assert.equal(again.perfPanel, "fps");
  assert.equal(again.crosshair.color, "#00ff00");
});

await test("a corrupted / foreign record is read as far as it validates (never throws, never blocks the game)", () => {
  for (const raw of ["{", "null", "42", JSON.stringify({ v: 1, graphics: "x", fpsCap: 7, perfPanel: "huge" }), JSON.stringify({ v: 99, fpsCap: 240 })]) {
    const r = new S.SettingsStore(memoryStorage({ [S.SETTINGS_KEY]: raw })).get();
    assert.equal(r.v, S.SETTINGS_VERSION);
    assert.ok(G.PRESET_CHOICES.includes(r.graphics.preset));
    assert.ok(G.FPS_CAPS.includes(r.fpsCap));
  }
  assert.equal(new S.SettingsStore(memoryStorage({ [S.SETTINGS_KEY]: JSON.stringify({ v: 99, fpsCap: 240 }) })).get().fpsCap, 240);
  // "custom" without values falls back to auto.
  const r = new S.SettingsStore(memoryStorage({ [S.SETTINGS_KEY]: JSON.stringify({ v: 1, graphics: { preset: "custom" } }) })).get();
  assert.equal(r.graphics.preset, "auto");
});

await test("storage failures (private mode, quota, sandbox) leave the session working in memory", () => {
  const ro = new S.SettingsStore(memoryStorage({}, { failWrites: true }));
  ro.update((d) => void (d.fpsCap = 30));
  assert.equal(ro.get().fpsCap, 30);
  const blocked = new S.SettingsStore(memoryStorage({}, { failReads: true, failWrites: true }));
  assert.equal(blocked.get().graphics.preset, "auto");
  const none = new S.SettingsStore(null);
  none.update((d) => void (d.perfPanel = "off"));
  assert.equal(none.get().perfPanel, "off");
});

await test("a stored detection result survives validation; a stale GPU or version re-detects", () => {
  const st = memoryStorage();
  const store = new S.SettingsStore(st);
  const values = { ...G.presetValues("bas", { dpr: 1 }), renderScale: 80 };
  store.update((d) => {
    d.graphics = {
      preset: "auto",
      custom: null,
      auto: { values, at: 5, gpu: "GPU A", targetFps: 60, expectedFps: 62, limitedBy: "gpu", belowTarget: false, summary: "s", version: G.AUTO_TUNE_VERSION },
    };
  });
  const r = new S.SettingsStore(st).get();
  assert.deepEqual(r.graphics.auto?.values, values);
  assert.equal(S.needsFirstDetection(r, "GPU A"), false);
  assert.equal(S.needsFirstDetection(r, "GPU B"), true);
});

console.log(`\nAll ${passed} graphics settings checks passed.`);
