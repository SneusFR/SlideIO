// AUTOMATIC GRAPHICS DETECTION — headless checks of src/settings/AutoTune (ladder, verdicts, binary
// search, the frame-driven calibration) and src/settings/GraphicsController (store ↔ game, first-launch
// detection, cancel, result → "Automatique", reload-only downgrade), fed with SIMULATED machines: a GPU
// cost model per setting (pixels × anti-aliasing, snow, filtering, shadows…), vsync-paced frames,
// timer-query results arriving late, noise and hitches. The real browser path is covered by the
// end-to-end bench (no GPU there: SwiftShader).
// Usage (repo root):  SLIDEIO_ROOT=$PWD node --import <vitenode>/register.mjs scripts/test-graphics-autotune.mts
import assert from "node:assert/strict";

const G = await import("../src/settings/GraphicsSettings.ts");
const A = await import("../src/settings/AutoTune.ts");
const S = await import("../src/settings/SettingsStore.ts");
const C = await import("../src/settings/GraphicsController.ts");

type Values = ReturnType<typeof G.presetValues>;

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const CAPS = { ...G.DEFAULT_CAPS };
const JUNGLE_CAPS = { ...G.DEFAULT_CAPS, composer: false, snow: false, halos: false, footprints: false, anisotropicTextures: false };

/** Deterministic PRNG (same "noise" every run). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * A machine: GPU ms of a configuration. `pixel` = cost of the full native
 * resolution with FXAA; MSAA multiplies it; snow, halos, filtering, shadow
 * resolution and dynamic shadows add fixed costs.
 */
interface Machine {
  pixel: number;
  fixed: number;
  cpu: number;
  refreshHz: number;
  timer: boolean;
}

function gpuCost(m: Machine, v: Values): number {
  const px = (v.renderScale / 100) ** 2;
  const aa = v.antialiasing === "msaa4" ? 2.1 : v.antialiasing === "msaa2" ? 1.5 : v.antialiasing === "fxaa" ? 1.06 : 1;
  const snow = { off: 0, legere: 0.08, normale: 0.15, dense: 0.26 }[v.snow] * m.pixel * 0.6;
  const aniso = Math.log2(v.anisotropy) * 0.02 * m.pixel;
  const shadowQ = G.SHADOW_QUALITIES.indexOf(v.shadowQuality) * 0.015 * m.pixel;
  const live = v.shadows === "dynamic" ? 0.08 * m.pixel : 0;
  const halos = v.halos ? 0.03 * m.pixel : 0;
  const particles = v.particles === "normal" ? 0.004 * m.pixel : 0;
  return m.fixed + m.pixel * px * aa + snow + aniso + shadowQ + live + halos + particles;
}

/**
 * Runs a Calibration against a simulated machine: vsync-paced frames
 * (interval = max(GPU, CPU, refresh), Chrome's pipelining), GPU results two
 * frames late, ±noise, a hitch every 17 frames, slow first frames after each
 * candidate (render-target allocation).
 */
function simulate(m: Machine, ladder: Values[], budgetMs: number, opts: { noise?: number; supersample?: Values | null; maxFrames?: number } = {}) {
  const r = rng(7);
  const noise = opts.noise ?? 0.06;
  let current: Values = ladder[0];
  let sinceApply = 0;
  let applied = 0;
  const host = {
    apply: (v: Values) => {
      current = v;
      sinceApply = 0;
      applied++;
    },
    gpuTimerAlive: () => m.timer,
  };
  const calib = new A.Calibration(host, ladder, budgetMs, opts.supersample ?? null);
  let t = 1000;
  calib.start(t);
  const pendingGpu: { tag: number; ms: number; due: number }[] = [];
  let frames = 0;
  for (let tag = 1; !calib.done && frames < (opts.maxFrames ?? 20000); tag++, frames++) {
    const jitter = 1 + (r() * 2 - 1) * noise;
    let gpu = gpuCost(m, current) * jitter;
    if (sinceApply < 2) gpu *= 3; // allocation / re-bake after a change
    const cpu = m.cpu * (1 + (r() * 2 - 1) * noise);
    let interval = Math.max(gpu, cpu, 1000 / m.refreshHz);
    if (frames % 17 === 16) interval *= 3; // a hitch (GC, another tab…)
    calib.onFrame(t, cpu, tag);
    if (m.timer) pendingGpu.push({ tag, ms: gpu, due: frames + 2 });
    for (let i = pendingGpu.length - 1; i >= 0; i--) {
      if (pendingGpu[i].due <= frames) {
        calib.onGpu(pendingGpu[i].tag, pendingGpu[i].ms);
        pendingGpu.splice(i, 1);
      }
    }
    t += interval;
    sinceApply++;
  }
  return { outcome: calib.outcome ?? calib.cancel(), frames, applied, seconds: (t - 1000) / 1000, calib };
}

/** Best rung of the ladder (lowest index) whose noise-free GPU cost holds the budget. */
function bestRung(m: Machine, ladder: Values[], budgetMs: number): number {
  for (let i = 0; i < ladder.length; i++) if (gpuCost(m, ladder[i]) <= budgetMs * A.AUTO_TUNE.gpuBudget) return i;
  return ladder.length - 1;
}

const LAPTOP: Machine = { pixel: 22, fixed: 0.8, cpu: 5.5, refreshHz: 60, timer: true }; // Iris Xe, Givre at 1920×928
const GAMING: Machine = { pixel: 1.1, fixed: 0.25, cpu: 3.1, refreshHz: 240, timer: true }; // RTX 2080 Super, 1440p @ 240 Hz

console.log("ladder");

await test("ladder: best first, every rung cheaper than the previous one, the floor last (Givre, DPR 1 and 1.25)", () => {
  for (const dpr of [1, 1.25]) {
    const boot = G.presetValues("bas", { dpr });
    const ladder = A.buildLadder(boot, { dpr }, CAPS);
    assert.ok(ladder.length >= 10 && ladder.length <= 14, `rungs: ${ladder.length}`);
    const top = ladder[0];
    assert.equal(top.antialiasing, "msaa4");
    assert.equal(top.renderScale, 100);
    assert.equal(top.snow, "dense");
    assert.equal(top.anisotropy, 16);
    for (let i = 1; i < ladder.length; i++) {
      assert.ok(gpuCost(LAPTOP, ladder[i]) < gpuCost(LAPTOP, ladder[i - 1]) + 1e-9, `rung ${i} not cheaper`);
      assert.ok(!G.sameValues(ladder[i], ladder[i - 1]), `rung ${i} duplicates`);
    }
    const floor = ladder[ladder.length - 1];
    assert.equal(floor.renderScale, G.floorRenderScale({ dpr }));
    assert.equal(floor.antialiasing, "fxaa");
    assert.equal(floor.snow, "legere");
    assert.equal(floor.halos, true);
    assert.equal(floor.footprints, true);
    assert.equal(floor.shadows, boot.shadows, "shadow mode never touched (reload-only)");
  }
});

await test("ladder never goes under the beauty floor, and keeps the session's reload-only settings on every rung", () => {
  for (const dpr of [0.9, 1, 1.25, 1.5, 2, 3]) {
    for (const boot of [G.presetValues("bas", { dpr }), G.presetValues("eleve", { dpr }), { ...G.presetValues("eleve", { dpr }), effectLights: 1 as const }]) {
      for (const caps of [CAPS, JUNGLE_CAPS]) {
        for (const v of A.buildLadder(boot, { dpr }, caps)) {
          assert.ok(v.renderScale >= G.floorRenderScale({ dpr }) - 1e-9, "scale floor");
          assert.equal(v.shadows, boot.shadows);
          assert.equal(v.characterShadows, boot.characterShadows);
          assert.equal(v.effectLights, boot.effectLights);
          if (caps.composer) assert.notEqual(v.antialiasing, "none", "FXAA at least");
          else assert.equal(v.antialiasing, boot.antialiasing, "context MSAA is reload-only");
          if (caps.snow) assert.notEqual(v.snow, "off");
          assert.ok(G.SHADOW_QUALITIES.indexOf(v.shadowQuality) >= G.SHADOW_QUALITIES.indexOf("medium") || v.shadowQuality === boot.shadowQuality);
        }
      }
    }
  }
});

await test("ladder respects the GPU: MSAA samples, anisotropy and shadow size limits", () => {
  const weakCaps = { ...CAPS, maxSamples: 0, maxAnisotropy: 4, maxShadowQuality: "high" as const };
  const ladder = A.buildLadder(G.presetValues("eleve", { dpr: 1 }), { dpr: 1 }, weakCaps);
  assert.equal(ladder[0].antialiasing, "fxaa");
  assert.equal(ladder[0].anisotropy, 4);
  assert.equal(ladder[0].shadowQuality, "high");
  assert.ok(ladder.every((v) => !G.isMsaa(v.antialiasing)));
});

await test("Retina (DPR 2): more resolution rungs, down to one pixel per CSS pixel", () => {
  const ladder = A.buildLadder(G.presetValues("bas", { dpr: 2 }), { dpr: 2 }, CAPS);
  const scales = [...new Set(ladder.map((v) => v.renderScale))];
  assert.deepEqual(scales, [100, 90, 85, 80, 75, 70, 65, 60, 55, 50]);
});

console.log("verdicts + search");

await test("verdict with GPU timer: fits under 80 % of the budget; processor-bound when the GPU has room but frames are late", () => {
  const budget = 1000 / 60;
  const base = { frames: 30, frameP90: 17, gpuFrames: 30 };
  assert.equal(A.judge({ ...base, frameMs: 16.7, cpuMs: 4, gpuMs: 13 }, budget).fits, true);
  assert.equal(A.judge({ ...base, frameMs: 22, cpuMs: 4, gpuMs: 14 }, budget).fits, false);
  const cpu = A.judge({ ...base, frameMs: 22, cpuMs: 19, gpuMs: 6 }, budget);
  assert.equal(cpu.fits, true);
  assert.equal(cpu.cpuBound, true);
});

await test("verdict without GPU timer: frames at the target rate (vsync) fit; a busy main thread is the processor", () => {
  const budget = 1000 / 60;
  const j = (frameMs: number, p90: number, cpuMs: number) => A.judge({ frames: 30, frameMs, frameP90: p90, cpuMs, gpuMs: null, gpuFrames: 0 }, budget);
  assert.equal(j(16.7, 18, 5).fits, true);
  assert.equal(j(16.7, 33.3, 5).fits, false, "one frame in ten missed is too many");
  assert.equal(j(25, 33, 5).fits, false);
  const cpu = j(25, 33, 23);
  assert.equal(cpu.fits && cpu.cpuBound, true);
});

await test("binary search: answers the best fitting rung of a monotonic ladder in ≤ ⌈log2 n⌉ + 1 probes, with a verdict on it", () => {
  for (let n = 1; n <= 20; n++) {
    for (let best = 0; best <= n; best++) {
      const s = new A.LadderSearch(n);
      let probes = 0;
      for (let next = s.next(); next !== null; next = s.next()) {
        probes++;
        s.report(next, { fits: next >= best, cpuBound: false, frameMs: 16, cpuMs: 4, gpuMs: 10, fps: 60 });
        assert.ok(probes <= 20);
      }
      assert.equal(s.answer, Math.min(best, n - 1));
      assert.ok(s.verdicts.has(s.answer), "the chosen rung was measured");
      assert.ok(probes <= Math.ceil(Math.log2(Math.max(1, n))) + 1, `n=${n} best=${best}: ${probes} probes`);
    }
  }
});

console.log("calibration on simulated machines");

await test("Iris Xe laptop, 60 Hz: picks the best rung that holds 60 i/s with margin, in a few seconds", () => {
  const dpr = 1;
  const ladder = A.buildLadder(G.presetValues("bas", { dpr }), { dpr }, CAPS);
  const budget = 1000 / 60;
  const run = simulate(LAPTOP, ladder, budget);
  const expected = bestRung(LAPTOP, ladder, budget);
  assert.equal(run.outcome.complete, true);
  assert.equal(run.outcome.index, expected, `index ${run.outcome.index} vs ${expected}`);
  assert.ok(gpuCost(LAPTOP, run.outcome.values) <= budget * 0.8);
  assert.ok(run.outcome.probes <= 5, `${run.outcome.probes} probes`);
  assert.ok(run.seconds < 8, `${run.seconds.toFixed(1)} s`);
  assert.equal(run.outcome.limitedBy, "none");
  assert.equal(run.outcome.usedGpuTimer, true);
  // The laptop's real problem (33-41 FPS on Bas): the answer is cheaper than Bas, never under the floor.
  assert.ok(gpuCost(LAPTOP, run.outcome.values) < gpuCost(LAPTOP, G.presetValues("bas", { dpr })));
  assert.ok(run.outcome.values.renderScale >= G.floorRenderScale({ dpr }));
});

await test("same laptop at Windows 125 % (1536 × 742 CSS): the floor is the old LOW resolution, still a valid answer", () => {
  const dpr = 1.25;
  const ladder = A.buildLadder(G.presetValues("bas", { dpr }), { dpr }, CAPS);
  const run = simulate({ ...LAPTOP, pixel: 34 }, ladder, 1000 / 60);
  assert.equal(run.outcome.values.renderScale >= 80, true);
  assert.equal(run.outcome.belowTarget, true, "pixel cost too high: floor reached");
  assert.equal(run.outcome.index, ladder.length - 1);
  assert.equal(run.outcome.limitedBy, "gpu");
});

await test("RTX 2080 Super, 1440p, 240 Hz: top rung holds 240 i/s on the GPU (supersampling only with lots of room)", () => {
  const dpr = 1;
  const ladder = A.buildLadder(G.presetValues("eleve", { dpr }), { dpr }, CAPS);
  const budget = 1000 / 240;
  const run = simulate(GAMING, ladder, budget, { supersample: A.supersampleRung(ladder[0]) });
  assert.equal(run.outcome.index, bestRung(GAMING, ladder, budget));
  assert.ok(gpuCost(GAMING, run.outcome.values) <= budget * 0.8);
  // Same GPU at 60 Hz: plenty of room → supersampling is tried and kept.
  const run60 = simulate({ ...GAMING, refreshHz: 60 }, ladder, 1000 / 60, { supersample: A.supersampleRung(ladder[0]) });
  assert.equal(run60.outcome.index, -1);
  assert.equal(run60.outcome.values.renderScale, A.AUTO_TUNE.supersampleScale);
});

await test("processor-bound machine: graphics stay high (lowering them would not help) and the outcome says so", () => {
  const ladder = A.buildLadder(G.presetValues("eleve", { dpr: 1 }), { dpr: 1 }, CAPS);
  const run = simulate({ pixel: 2, fixed: 0.2, cpu: 21, refreshHz: 60, timer: true }, ladder, 1000 / 60);
  assert.equal(run.outcome.index, 0);
  assert.equal(run.outcome.limitedBy, "cpu");
});

await test("no GPU timer (frames only, vsync-quantized): one rung of margin under the best that holds the rate", () => {
  const ladder = A.buildLadder(G.presetValues("bas", { dpr: 1 }), { dpr: 1 }, CAPS);
  const m = { ...LAPTOP, timer: false };
  const run = simulate(m, ladder, 1000 / 60);
  // Best rung whose frames come at 60 (GPU under the whole frame, within the slack)…
  let holds = ladder.length - 1;
  for (let i = 0; i < ladder.length; i++) {
    if (gpuCost(m, ladder[i]) <= (1000 / 60) * A.AUTO_TUNE.frameSlack / 1.065) {
      holds = i;
      break;
    }
  }
  assert.equal(run.outcome.usedGpuTimer, false);
  assert.ok(run.outcome.index >= holds && run.outcome.index <= Math.min(ladder.length - 1, holds + 2), `index ${run.outcome.index} vs holds ${holds}`);
  assert.ok(gpuCost(m, run.outcome.values) < 1000 / 60, "the result holds 60 with room");
});

await test("robust to noise and hitches: same answer over 6 seeds of ±15 % noise (no oscillation)", () => {
  const ladder = A.buildLadder(G.presetValues("bas", { dpr: 1 }), { dpr: 1 }, CAPS);
  const budget = 1000 / 60;
  const answers = new Set<number>();
  for (let i = 0; i < 6; i++) {
    const m = { ...LAPTOP, pixel: LAPTOP.pixel * (1 + i * 0.0001) };
    answers.add(simulate(m, ladder, budget, { noise: 0.15 }).outcome.index);
  }
  assert.ok(answers.size <= 2, `answers: ${[...answers]}`);
  const expected = bestRung(LAPTOP, ladder, budget);
  for (const a of answers) assert.ok(Math.abs(a - expected) <= 1, `answer ${a} vs ${expected}`);
});

await test("cancel mid-way: the conservative bound of the search (never a rung that failed), marked incomplete", () => {
  const ladder = A.buildLadder(G.presetValues("bas", { dpr: 1 }), { dpr: 1 }, CAPS);
  const run = simulate(LAPTOP, ladder, 1000 / 60, { maxFrames: 60 });
  assert.equal(run.calib.done, true);
  assert.equal(run.outcome.complete, false);
  const v = run.outcome.verdict;
  assert.ok(v === null || v.fits, "never a rung known to miss");
  assert.ok(run.outcome.index >= bestRung(LAPTOP, ladder, 1000 / 60));
});

await test("a probe ignores its settle frames and the GPU results of the previous candidate", () => {
  const ladder = [G.presetValues("eleve", { dpr: 1 }), G.presetValues("bas", { dpr: 1 })];
  const applied: Values[] = [];
  const calib = new A.Calibration({ apply: (v) => applied.push(v), gpuTimerAlive: () => true }, ladder, 1000 / 60, null);
  let t = 0;
  calib.start(t);
  // Probe of rung 0 (mid of 2 rungs): late GPU results of OTHER tags must not count.
  for (let tag = 1; tag <= 40 && !calib.done && applied.length === 1; tag++) {
    t += 16.7;
    calib.onFrame(t, 4, tag);
    calib.onGpu(tag + 1000, 99); // a stranger's result
    calib.onGpu(tag, 10);
  }
  assert.ok(applied.length >= 1);
  const v0 = calib["search"].verdicts.get(0);
  assert.ok(v0, "rung 0 measured");
  assert.ok(Math.abs((v0!.gpuMs ?? 0) - 10) < 1e-9, `gpu ${v0!.gpuMs}`);
});

await test("summary messages (French): target held, floor reached, processor-bound, software renderer", () => {
  const ctx = { targetFps: 60, caps: CAPS, software: false };
  const v = { ...G.presetValues("bas", { dpr: 1 }), renderScale: 85, snow: "legere" as const };
  const ok = A.summarize({ values: v, index: 7, verdict: { fits: true, cpuBound: false, frameMs: 16.7, cpuMs: 5, gpuMs: 12.4, fps: 60 }, probes: 4, complete: true, limitedBy: "none", belowTarget: false, usedGpuTimer: true }, ctx);
  assert.match(ok, /^Réglages choisis pour tenir 60 i\/s : résolution 85 %, FXAA, ombres statiques \(moyenne\), neige légère/);
  assert.match(ok, /12,4 ms par image sur 16,7/);
  const floor = A.summarize({ values: v, index: 11, verdict: { fits: false, cpuBound: false, frameMs: 21, cpuMs: 5, gpuMs: 19, fps: 47.6 }, probes: 5, complete: true, limitedBy: "gpu", belowTarget: true, usedGpuTimer: true }, ctx);
  assert.match(floor, /Même au plancher de qualité .* environ 48 i\/s au lieu de 60 : c'est la carte graphique qui limite/);
  const cpu = A.summarize({ values: v, index: 0, verdict: { fits: true, cpuBound: true, frameMs: 22.1, cpuMs: 21, gpuMs: 5, fps: 45 }, probes: 4, complete: true, limitedBy: "cpu", belowTarget: true, usedGpuTimer: true }, ctx);
  assert.match(cpu, /processeur ou le navigateur qui limite \(22,1 ms par image\)/);
  const sw = A.summarize({ values: v, index: 11, verdict: null, probes: 0, complete: true, limitedBy: "gpu", belowTarget: true, usedGpuTimer: false }, { ...ctx, software: true });
  assert.match(sw, /^Rendu logiciel détecté/);
  const partial = A.summarize({ values: v, index: 9, verdict: null, probes: 2, complete: false, limitedBy: "none", belowTarget: false, usedGpuTimer: true }, ctx);
  assert.match(partial, /détection interrompue/);
});

console.log("controller (store ↔ game)");

function memoryStorage(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init));
  return { map, getItem: (k: string) => (map.has(k) ? map.get(k)! : null), setItem: (k: string, v: string) => void map.set(k, v) };
}

function fakeHost(boot: Values, caps = CAPS, gpuName = "Intel(R) Iris(R) Xe Graphics · D3D11") {
  const calls = { applied: [] as Values[], caps: [] as number[], dyn: [] as [boolean, number][], outline: 0, panel: [] as string[], cancel: [] as boolean[] };
  let resolveTune: ((o: InstanceType<typeof A.Calibration>["outcome"] & object) => void) | null = null;
  const host = {
    graphicsBoot: boot,
    graphicsCaps: caps,
    gpuName,
    softwareRenderer: false,
    autoTuning: false,
    onDisplayDensityChange: null as (() => void) | null,
    applyGraphicsSettings: (v: Values) => void calls.applied.push(v),
    setFpsCap: (fps: number) => void calls.caps.push(fps),
    setDynamicResolution: (on: boolean, fps: number) => void calls.dyn.push([on, fps]),
    applyOutlineSettings: () => void calls.outline++,
    setPerfPanel: (m: string) => void calls.panel.push(m),
    startAutoTune: (_target: number) =>
      new Promise<NonNullable<InstanceType<typeof A.Calibration>["outcome"]>>((r) => {
        resolveTune = r;
      }),
    cancelAutoTune: (restore: boolean) => {
      calls.cancel.push(restore);
      resolveTune?.({ values: boot, index: 0, verdict: null, probes: 1, complete: false, limitedBy: "none", belowTarget: false, usedGpuTimer: true });
    },
  };
  return { host, calls, finish: (o: NonNullable<InstanceType<typeof A.Calibration>["outcome"]>) => resolveTune?.(o) };
}

const isWeak = (n: string) => /intel|iris|uhd/i.test(n);

await test("controller: applies the stored choice at once (graphics, cap, dynamic resolution, outline, crosshair once, panel)", () => {
  let dpr = 1;
  const store = new S.SettingsStore(memoryStorage({ [S.LEGACY_KEYS.quality]: "LOW" }), () => "bas", () => dpr);
  const { host, calls } = fakeHost(G.presetValues("bas", { dpr }));
  const crosshairs: unknown[] = [];
  const ctl = new C.GraphicsController(store, host, () => ({ dpr }), () => 60, (c) => crosshairs.push(c), isWeak);
  assert.deepEqual(calls.applied.at(-1), G.presetValues("bas", { dpr }));
  assert.equal(calls.caps.at(-1), 60);
  assert.deepEqual(calls.dyn.at(-1), [false, 60]);
  assert.equal(crosshairs.length, 1);
  assert.deepEqual(calls.panel, ["full"]);
  store.update((d) => void (d.fpsCap = 144));
  assert.equal(calls.caps.at(-1), 144);
  assert.equal(crosshairs.length, 1, "unchanged crosshair: no HUD command");
  store.update((d) => void (d.crosshair.scale = 2));
  assert.equal(crosshairs.length, 2);
  // Browser zoom: the presets re-resolve for the new density.
  dpr = 1.25;
  host.onDisplayDensityChange?.();
  assert.equal(calls.applied.at(-1)?.renderScale, 80);
  assert.equal(ctl.needsFirstDetection(), false);
});

await test("controller: first launch → detection → stored as Automatique (French summary, this GPU), applied", async () => {
  const store = new S.SettingsStore(memoryStorage(), () => "bas", () => 1);
  const boot = G.presetValues("bas", { dpr: 1 });
  const { host, calls, finish } = fakeHost(boot);
  const ctl = new C.GraphicsController(store, host, () => ({ dpr: 1 }), () => 60, () => {}, isWeak);
  assert.equal(ctl.needsFirstDetection(), true);
  assert.equal(ctl.effectivePreset(), "bas", "auto before detection = heuristic Bas");
  const events: string[] = [];
  ctl.subscribe((e) => events.push(e.kind));
  const done = ctl.runDetection("first");
  assert.equal(ctl.detecting, true);
  assert.equal(ctl.runDetection("first"), done, "one detection at a time");
  const chosen = { ...boot, renderScale: 85, snow: "legere" as const };
  finish({ values: chosen, index: 8, verdict: { fits: true, cpuBound: false, frameMs: 16.7, cpuMs: 5, gpuMs: 12.9, fps: 60 }, probes: 4, complete: true, limitedBy: "none", belowTarget: false, usedGpuTimer: true });
  const result = await done;
  assert.ok(result);
  assert.equal(store.get().graphics.preset, "auto");
  assert.equal(store.get().graphics.auto?.gpu, host.gpuName);
  assert.equal(store.get().graphics.auto?.version, G.AUTO_TUNE_VERSION);
  assert.match(store.get().graphics.auto!.summary, /^Réglages choisis pour tenir 60 i\/s/);
  assert.deepEqual(calls.applied.at(-1), chosen);
  assert.equal(ctl.needsFirstDetection(), false);
  assert.equal(ctl.autoDetected, true);
  assert.deepEqual(events, ["start", "done"]);
  assert.deepEqual(ctl.pendingReload(), []);
});

await test("controller: even the floor misses with live shadows → static shadows proposed for the next load", async () => {
  const store = new S.SettingsStore(memoryStorage(), () => "eleve", () => 1);
  const boot = G.presetValues("eleve", { dpr: 1 });
  const { host, finish } = fakeHost(boot, CAPS, "NVIDIA GeForce MX150");
  const ctl = new C.GraphicsController(store, host, () => ({ dpr: 1 }), () => 60, () => {}, isWeak);
  const done = ctl.runDetection();
  const floor = A.buildLadder(boot, { dpr: 1 }, CAPS).at(-1)!;
  finish({ values: floor, index: 11, verdict: { fits: false, cpuBound: false, frameMs: 22, cpuMs: 5, gpuMs: 20, fps: 45 }, probes: 5, complete: true, limitedBy: "gpu", belowTarget: true, usedGpuTimer: true });
  const result = await done;
  assert.equal(result?.values.shadows, "static");
  assert.match(result!.summary, /statiques au prochain chargement/);
  assert.deepEqual(ctl.pendingReload().map((c) => c.key), ["shadows"]);
});

await test("controller: cancel restores the player's values and stores nothing", async () => {
  const store = new S.SettingsStore(memoryStorage({ [S.LEGACY_KEYS.quality]: "HIGH" }));
  const { host, calls } = fakeHost(G.presetValues("eleve", { dpr: 1 }), CAPS, "NVIDIA GeForce RTX 2080 SUPER");
  const ctl = new C.GraphicsController(store, host, () => ({ dpr: 1 }), () => 240, () => {}, isWeak);
  const events: string[] = [];
  ctl.subscribe((e) => events.push(e.kind));
  const done = ctl.runDetection();
  ctl.cancelDetection();
  assert.equal(await done, null);
  assert.deepEqual(calls.cancel, [true]);
  assert.equal(store.get().graphics.preset, "eleve");
  assert.deepEqual(events, ["start", "cancelled"]);
});

await test("controller: detection target = display rate unless an explicit lower cap; dynamic resolution holds the cap in effect", () => {
  const store = new S.SettingsStore(memoryStorage({ [S.LEGACY_KEYS.quality]: "LOW" }));
  const { host } = fakeHost(G.presetValues("bas", { dpr: 1 }));
  const ctl = new C.GraphicsController(store, host, () => ({ dpr: 1 }), () => 144, () => {}, isWeak);
  assert.equal(ctl.detectionTarget(), 144); // "auto" cap of Automatique = uncapped
  assert.equal(ctl.playTarget(), 60); // Bas: the old 60 cap
  store.update((d) => void (d.fpsCap = 120));
  assert.equal(ctl.detectionTarget(), 120);
  store.update((d) => void (d.fpsTarget = 60));
  assert.equal(ctl.detectionTarget(), 60);
});

console.log(`\nAll ${passed} automatic detection checks passed.`);
