// AUTOMATIC GRAPHICS DETECTION — headless checks of src/settings/AutoTune (the ladder, the probe
// verdicts, the frame-driven calibration) and src/settings/GraphicsController (store ↔ game, result →
// "Automatique" per map, cancel, reload-only advice), fed with SIMULATED machines: a GPU cost model per
// setting, a main-thread cost, a vsync-paced display (a frame that misses its refresh waits for the
// next one), seeded jitter, focus losses.
//
// The machine models are calibrated on what was measured on the real hardware (PERFORMANCE.md,
// 11th pass): the owner's laptop (Intel Iris Xe, 1920 × 928 CSS at 125 %, 60 Hz — Givre LOW 10.5 ms of
// GPU at 2560 × 1238, 16.2 ms at 3200 × 1546; HIGH ≈ 22 ms at 2400 × 1160, 5 ms of it the live shadow
// map) and the gaming PC (RTX 2080 Super, 2560 × 1440, 240 Hz, ~3 ms of game CPU per frame).
// Usage (repo root):  npx tsx scripts/test-graphics-autotune.mts
import assert from "node:assert/strict";

const G = await import("../src/settings/GraphicsSettings.ts");
const A = await import("../src/settings/AutoTune.ts");
const S = await import("../src/settings/SettingsStore.ts");
const GC = await import("../src/settings/GraphicsController.ts");

type Values = import("../src/settings/GraphicsSettings.ts").GraphicsValues;
type Caps = import("../src/settings/GraphicsSettings.ts").GraphicsCaps;

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// ------------------------------------------------------------------ machines

/** Deterministic PRNG (xorshift32). */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

interface Machine {
  name: string;
  hz: number;
  css: [number, number];
  dpr: number;
  /** Main-thread ms per frame (game JS + submission + the browser's own work). */
  cpuMs: number;
  /** GPU ms per frame for these values at this many megapixels. */
  gpu: (v: Values, mpx: number) => number;
  caps: Caps;
  /** ± jitter on both sides (ms). */
  jitter: number;
}

const ANISO_COST: Record<number, number> = { 1: 0, 2: 0.06, 4: 0.12, 8: 0.2, 16: 0.3 };
const SNOW_COST: Record<string, number> = { off: 0, legere: 0.15, normale: 0.3, dense: 0.5 };
const SHADOW_TEXELS: Record<string, number> = { low: 0.52, medium: 2.1, high: 8.4, ultra: 33.5 }; // Givre, Mtexel

/** Intel Iris Xe (the owner's laptop): fill-rate bound, MSAA and the live shadow map expensive. */
function irisXe(boot: "static" | "dynamic", opts: Partial<Machine> = {}): Machine {
  const perMpx: Record<string, number> = { none: 2.6, fxaa: 3.0, msaa2: 4.4, msaa4: 5.75 };
  return {
    name: `Iris Xe (${boot})`,
    hz: 60,
    css: [1920, 928],
    dpr: 1.25,
    cpuMs: 7,
    jitter: 0.6,
    caps: { ...G.DEFAULT_CAPS },
    gpu: (v, mpx) =>
      1 +
      mpx * (perMpx[v.antialiasing] + ANISO_COST[v.anisotropy]) +
      SNOW_COST[v.snow] +
      (v.shadows === "dynamic" ? SHADOW_TEXELS[v.shadowQuality] * 0.6 : 0),
    ...opts,
  };
}

/** RTX 2080 Super at 1440p / 240 Hz (the gaming PC): ~3.6 ms of main thread per frame. */
function rtx2080(opts: Partial<Machine> = {}): Machine {
  const perMpx: Record<string, number> = { none: 0.2, fxaa: 0.22, msaa2: 0.28, msaa4: 0.35 };
  return {
    name: "RTX 2080 Super",
    hz: 240,
    css: [2560, 1440],
    dpr: 1,
    cpuMs: 3.6,
    jitter: 0.25,
    caps: { ...G.DEFAULT_CAPS },
    gpu: (v, mpx) =>
      0.4 + mpx * (perMpx[v.antialiasing] + ANISO_COST[v.anisotropy] * 0.1) + SNOW_COST[v.snow] * 0.1 + (v.shadows === "dynamic" ? SHADOW_TEXELS[v.shadowQuality] * 0.05 : 0),
    ...opts,
  };
}

/** Old office laptop (UHD 620, 1080p): GPU-bound even at the floor. */
function uhd620(): Machine {
  return {
    name: "UHD 620",
    hz: 60,
    css: [1920, 1080],
    dpr: 1,
    cpuMs: 9,
    jitter: 0.8,
    caps: { ...G.DEFAULT_CAPS, maxShadowQuality: "high" },
    gpu: (v, mpx) => 1 + mpx * ({ none: 8, fxaa: 9, msaa2: 13, msaa4: 17 } as Record<string, number>)[v.antialiasing] + SNOW_COST[v.snow],
  };
}

function megapixels(m: Machine, v: Values): number {
  const ratio = G.pixelRatioFor(v.renderScale, m.dpr);
  return (m.css[0] * ratio * m.css[1] * ratio) / 1e6;
}

interface RunOptions {
  target?: number;
  /** Frames (by index) rendered while the window had no focus. */
  unfocused?: (frame: number) => boolean;
  seed?: number;
  maxFrames?: number;
  cfg?: typeof A.AUTO_TUNE;
  /** Stop after this many frames (cancel). */
  cancelAt?: number;
}

/** Runs a whole calibration on a simulated machine. */
function calibrate(m: Machine, boot: Values, opts: RunOptions = {}) {
  const ladder = A.buildLadder(boot, { dpr: m.dpr }, m.caps);
  const target = opts.target ?? Math.min(240, m.hz);
  let applied: Values = boot;
  const appliedLog: Values[] = [];
  const calib = new A.Calibration(
    {
      apply: (v) => {
        applied = v;
        appliedLog.push(v);
      },
    },
    ladder,
    target,
    opts.cfg,
  );
  const random = rng(opts.seed ?? 7);
  const period = 1000 / m.hz;
  let t = 1000;
  calib.start(t);
  let frame = 0;
  const maxFrames = opts.maxFrames ?? 20000;
  while (!calib.done && frame < maxFrames) {
    if (opts.cancelAt !== undefined && frame === opts.cancelAt) {
      calib.cancel();
      break;
    }
    const cpu = m.cpuMs + (random() * 2 - 1) * m.jitter;
    const gpu = m.gpu(applied, megapixels(m, applied)) + (random() * 2 - 1) * m.jitter;
    const work = Math.max(cpu, gpu);
    // rAF on a vsync-paced display: the next frame starts at the first refresh after the work.
    const interval = Math.max(1, Math.ceil(work / period - 1e-9)) * period;
    calib.onFrame(t, cpu, !(opts.unfocused?.(frame) ?? false));
    t += interval;
    frame++;
  }
  return { calib, ladder, outcome: calib.outcome, appliedLog, frames: frame, seconds: (t - 1000) / 1000 };
}

/** Real (unamplified) GPU share of the frame budget of a set of values on a machine. */
function gpuShare(m: Machine, v: Values, target: number): number {
  return m.gpu(v, megapixels(m, v)) / (1000 / target);
}

// ------------------------------------------------------------------ ladder

console.log("detection ladder");

await test("ladder: best first (native, MSAA 4×, sharpest shadows, 16×), the beauty floor last, no duplicate", () => {
  for (const dpr of [1, 1.25, 2]) {
    for (const boot of [G.presetValues("bas", { dpr }), G.presetValues("eleve", { dpr })]) {
      const ladder = A.buildLadder(boot, { dpr }, G.DEFAULT_CAPS);
      const top = ladder[0];
      const floor = ladder[ladder.length - 1];
      assert.equal(top.renderScale, 100);
      assert.equal(top.antialiasing, "msaa4");
      assert.equal(top.anisotropy, 16);
      assert.equal(top.snow, "normale");
      assert.equal(top.shadowQuality, boot.shadows === "dynamic" ? "ultra" : "high");
      assert.equal(floor.antialiasing, "fxaa");
      assert.equal(floor.anisotropy, 1);
      assert.equal(floor.snow, "legere");
      assert.equal(floor.renderScale, G.floorRenderScale({ dpr }));
      assert.equal(floor.shadowQuality, boot.shadows === "dynamic" ? "medium" : "high");
      for (let i = 1; i < ladder.length; i++) assert.equal(G.sameValues(ladder[i], ladder[i - 1]), false);
    }
  }
});

await test("ladder: every rung keeps what only a reload changes (shadow mode, character shadows, context MSAA) and halos / footprints / particles", () => {
  for (const dpr of [1, 1.25, 2]) {
    for (const boot of [
      G.presetValues("bas", { dpr }),
      G.presetValues("eleve", { dpr }),
      { ...G.presetValues("eleve", { dpr }), characterShadows: false },
      { ...G.presetValues("eleve", { dpr }), shadows: "off" as const },
    ]) {
      for (const composer of [true, false]) {
        const caps = { ...G.DEFAULT_CAPS, composer, snow: composer, halos: composer, footprints: composer, anisotropicTextures: composer };
        for (const v of A.buildLadder(boot, { dpr }, caps)) {
          assert.equal(v.shadows, boot.shadows);
          assert.equal(v.characterShadows, boot.characterShadows);
          if (!composer) assert.equal(v.antialiasing, boot.antialiasing);
          assert.equal(v.halos, true && (composer ? true : boot.halos));
          assert.equal(v.particles, "normal");
          assert.ok(v.renderScale >= G.floorRenderScale({ dpr }) - 1e-9 && v.renderScale <= 100);
        }
      }
    }
  }
});

await test("ladder: cost never rises along it (every knob is the same or cheaper than one rung above)", () => {
  const rank = {
    aa: { none: 0, fxaa: 1, msaa2: 2, msaa4: 3 } as Record<string, number>,
    q: { low: 0, medium: 1, high: 2, ultra: 3 } as Record<string, number>,
    snow: { off: 0, legere: 1, normale: 2, dense: 3 } as Record<string, number>,
  };
  for (const dpr of [1, 1.25, 1.5, 2]) {
    for (const boot of [G.presetValues("bas", { dpr }), G.presetValues("eleve", { dpr })]) {
      const ladder = A.buildLadder(boot, { dpr }, G.DEFAULT_CAPS);
      for (let i = 1; i < ladder.length; i++) {
        const a = ladder[i - 1];
        const b = ladder[i];
        assert.ok(b.renderScale <= a.renderScale);
        assert.ok(rank.aa[b.antialiasing] <= rank.aa[a.antialiasing]);
        assert.ok(rank.q[b.shadowQuality] <= rank.q[a.shadowQuality]);
        assert.ok(rank.snow[b.snow] <= rank.snow[a.snow]);
        assert.ok(b.anisotropy <= a.anisotropy);
      }
    }
  }
});

await test("ladder: GPU limits respected (2× MSAA only, no anisotropy, smaller shadow maps), Jungle / Yard without post chain", () => {
  const boot = G.presetValues("eleve", { dpr: 1 });
  const weakCaps = { ...G.DEFAULT_CAPS, maxSamples: 2, maxAnisotropy: 1, maxShadowQuality: "high" as const };
  const ladder = A.buildLadder(boot, { dpr: 1 }, weakCaps);
  assert.equal(ladder[0].antialiasing, "msaa2");
  assert.equal(ladder[0].shadowQuality, "high");
  assert.ok(ladder.every((v) => v.anisotropy === 1));
  const jungle = A.buildLadder(boot, { dpr: 1.25 }, { ...G.DEFAULT_CAPS, composer: false, snow: false, halos: false, footprints: false, anisotropicTextures: false });
  assert.ok(jungle.every((v) => v.antialiasing === "msaa4" && v.snow === boot.snow && v.anisotropy === boot.anisotropy));
  assert.equal(jungle[jungle.length - 1].renderScale, 80);
});

await test("margin probe = +30 % pixels (render scale × √1.3), half-pixel check, capped", () => {
  const v = G.presetValues("bas", { dpr: 1.25 });
  const m = A.withMargin({ ...v, renderScale: 100 });
  assert.ok(Math.abs(m.renderScale ** 2 / 100 ** 2 - 1.3) < 1e-9);
  assert.equal(A.withMargin({ ...v, renderScale: 190 }).renderScale, A.AUTO_TUNE.maxProbeScale);
  assert.ok(Math.abs(A.halfPixels({ ...v, renderScale: 80 }).renderScale ** 2 / 80 ** 2 - 0.5) < 1e-9);
  assert.equal(A.halfPixels({ ...v, renderScale: 30 }).renderScale, A.AUTO_TUNE.minProbeScale);
});

await test("verdicts: delivered frame rate (not the median) and late frames", () => {
  const stats = (intervals: number[]) => {
    const sorted = Float64Array.from(intervals).sort();
    return { ...A.deliveredStats(sorted), cpuMs: 1, sorted };
  };
  const p60 = 1000 / 60;
  assert.equal(A.holds(stats(Array(60).fill(p60)), 60), true);
  // One frame in five misses its refresh: the median still says 60, the player gets 50.
  const mixed = stats(Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? 2 * p60 : p60)));
  assert.ok(Math.abs(mixed.frameMs - p60) < 1e-9);
  assert.ok(mixed.fps < 51);
  assert.equal(A.holds(mixed, 60), false);
  // A single hitch in a second is fine; a few percent of misses are not.
  assert.equal(A.holds(stats([...Array(59).fill(p60), 50]), 60), true);
  assert.equal(A.holds(stats([...Array(56).fill(p60), ...Array(4).fill(2 * p60)]), 60), false);
  // 240 Hz display, goal 60: uncapped frames hold it easily.
  assert.equal(A.holds(stats(Array(200).fill(1000 / 240)), 60), true);
});

// ------------------------------------------------------------------ machines

console.log("detection on simulated machines");

await test("owner's laptop (Iris Xe, 60 Hz, booted Bas): MORE than the old LOW — native resolution, FXAA, sharper static shadows — with margin", () => {
  const m = irisXe("static");
  const boot = G.presetValues("bas", { dpr: m.dpr });
  const run = calibrate(m, boot);
  const o = run.outcome!;
  assert.ok(o && o.complete && o.mode === "target");
  const v = o.values;
  assert.equal(v.renderScale, 100); // 2400 × 1160 instead of the old 1920 × 928
  assert.equal(v.antialiasing, "fxaa");
  assert.equal(v.shadows, "static");
  assert.equal(v.shadowQuality, "high");
  assert.ok(v.anisotropy >= 4);
  // Holds 60 with room: the real GPU time leaves ≥ 20 % of the frame free.
  assert.ok(gpuShare(m, v, 60) <= 0.8, `GPU share ${gpuShare(m, v, 60)}`);
  // …and the rung just above it would not have held the target with the margin.
  const above = run.ladder[o.index - 1];
  assert.ok(m.gpu(above, megapixels(m, A.withMargin(above))) > 1000 / 60 - m.jitter);
  assert.ok(run.seconds < 15, `${run.seconds} s`);
  console.log(`      → ${v.renderScale} %, ${v.antialiasing}, aniso ${v.anisotropy}, ${o.probes} probes, ${run.seconds.toFixed(1)} s, GPU ${(gpuShare(m, v, 60) * 100).toFixed(0)} % of the frame`);
});

await test("owner's laptop booted Élevé (live shadows, MSAA): MSAA and the big shadow map go, the floor is never crossed", () => {
  const m = irisXe("dynamic");
  const boot = G.presetValues("eleve", { dpr: m.dpr });
  const o = calibrate(m, boot).outcome!;
  assert.equal(o.mode, "target");
  assert.equal(o.values.shadows, "dynamic");
  assert.notEqual(o.values.antialiasing, "msaa4");
  assert.ok(["medium", "high"].includes(o.values.shadowQuality));
  assert.ok(o.values.renderScale >= 80);
  assert.ok(gpuShare(m, o.values, 60) <= 0.8);
});

await test("gaming PC (RTX 2080 Super, 240 Hz): at least Élevé, and 240 FPS held with margin", () => {
  const m = rtx2080();
  const boot = G.presetValues("eleve", { dpr: 1 });
  const run = calibrate(m, boot);
  const o = run.outcome!;
  assert.equal(o.mode, "target");
  assert.equal(o.values.renderScale, 100);
  assert.equal(o.values.antialiasing, "msaa4");
  assert.ok(["high", "ultra"].includes(o.values.shadowQuality));
  assert.ok(o.values.anisotropy >= 8);
  assert.ok(m.gpu(o.values, megapixels(m, A.withMargin(o.values))) < 1000 / 240);
  assert.ok(run.seconds < 10, `${run.seconds} s`);
  console.log(`      → ${o.values.antialiasing}, shadows ${o.values.shadowQuality}, aniso ${o.values.anisotropy}, ${o.probes} probes, ${run.seconds.toFixed(1)} s`);
});

await test("processor-limited machine (main thread longer than a 240 Hz frame): the graphics stay at the top — lowering them would not help", () => {
  const m = rtx2080({ cpuMs: 4.6, jitter: 0.5 });
  const o = calibrate(m, G.presetValues("eleve", { dpr: 1 })).outcome!;
  assert.equal(o.mode, "cpu");
  assert.equal(o.index, 0);
  assert.equal(o.values.antialiasing, "msaa4");
  // Same on a 60 Hz laptop whose CPU only gives ~40 FPS.
  const slowCpu = irisXe("static", { cpuMs: 22, jitter: 1 });
  const o2 = calibrate(slowCpu, G.presetValues("bas", { dpr: 1.25 })).outcome!;
  assert.equal(o2.mode, "cpu");
  assert.ok(o2.index <= 4, `rung ${o2.index}`); // no resolution loss
  assert.equal(o2.values.renderScale, 100);
});

await test("GPU-limited machine that misses the target even at the floor: the floor (the old LOW look), never lower", () => {
  const m = uhd620();
  const run = calibrate(m, G.presetValues("bas", { dpr: 1 }));
  const o = run.outcome!;
  assert.equal(o.mode, "gpu");
  assert.equal(o.index, run.ladder.length - 1);
  assert.equal(o.values.renderScale, 100); // 1 px per CSS px at 100 % zoom
  assert.equal(o.values.antialiasing, "fxaa");
  assert.ok(o.floorFps! < 55);
  // Probes never went under the half-pixel check, never under the floor otherwise.
  assert.ok(run.appliedLog.every((v) => v.renderScale >= A.AUTO_TUNE.minProbeScale));
});

await test("an unfocused window restarts the probe (a laptop in the background is much slower): same answer", () => {
  const m = irisXe("static");
  const boot = G.presetValues("bas", { dpr: m.dpr });
  const clean = calibrate(m, boot).outcome!;
  const run = calibrate(m, boot, { unfocused: (f) => (f >= 40 && f < 140) || (f >= 300 && f < 320) });
  assert.equal(run.outcome!.index, clean.index);
  assert.ok(run.frames > 0);
});

await test("deterministic and one-shot: the same machine gives the same answer every run (no oscillation)", () => {
  const m = irisXe("static");
  const boot = G.presetValues("bas", { dpr: m.dpr });
  const answers = new Set<number>();
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) answers.add(calibrate(m, boot, { seed }).outcome!.index);
  assert.equal(answers.size, 1, `answers: ${[...answers]}`);
});

await test("time limit / cancel: the best KNOWN rung (incomplete), or nothing when stopped during the first probe", () => {
  const m = irisXe("static");
  const boot = G.presetValues("bas", { dpr: m.dpr });
  const short = calibrate(m, boot, { cfg: { ...A.AUTO_TUNE, maxFocusedMs: 2500 } });
  assert.equal(short.outcome!.complete, false);
  assert.equal(short.outcome!.index, short.ladder.length - 1); // only the floor was known
  const cancelled = calibrate(m, boot, { cancelAt: 5 });
  assert.equal(cancelled.outcome, null);
});

await test("progress: done / total never decreases, ends at total", () => {
  const m = rtx2080();
  const ladder = A.buildLadder(G.presetValues("eleve", { dpr: 1 }), { dpr: 1 }, m.caps);
  let applied = ladder[0];
  const calib = new A.Calibration({ apply: (v) => (applied = v) }, ladder, 240);
  calib.start(0);
  let t = 0;
  let lastDone = 0;
  while (!calib.done) {
    calib.onFrame(t, 3, true);
    const work = Math.max(3, m.gpu(applied, megapixels(m, applied)));
    t += Math.ceil(work / (1000 / 240)) * (1000 / 240);
    const p = calib.progress;
    assert.ok(p.done >= lastDone && p.done <= p.total);
    lastDone = p.done;
  }
  assert.equal(calib.progress.done, calib.progress.total);
});

await test("summary (French): target held / processor-limited / graphics-card-limited / software rendering", () => {
  const caps = G.DEFAULT_CAPS;
  const values = G.presetValues("bas", { dpr: 1.25 });
  const base = { values, index: 3, goalFps: 60, floorFps: 61, answerFps: 60, probes: 4, complete: true };
  assert.match(A.summarize({ ...base, mode: "target" }, { targetFps: 60, caps, software: false }), /tenir 60 i\/s/);
  assert.match(A.summarize({ ...base, mode: "cpu", floorFps: 41 }, { targetFps: 60, caps, software: false }), /processeur/);
  assert.match(A.summarize({ ...base, mode: "gpu", floorFps: 33 }, { targetFps: 60, caps, software: false }), /environ 33 i\/s au lieu de 60/);
  assert.match(A.summarize({ ...base, mode: "gpu" }, { targetFps: 60, caps, software: true }), /Rendu logiciel/);
  assert.match(A.summarize({ ...base, mode: "target", complete: false }, { targetFps: 60, caps, software: false }), /interrompue/);
});

// ------------------------------------------------------------------ controller

console.log("graphics controller");

function memoryStorage() {
  const map = new Map<string, string>();
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

function fakeHost(opts: { gpuName?: string; map?: string; boot?: Values; caps?: Caps; software?: boolean } = {}) {
  const calls = { apply: [] as Values[], cap: [] as number[], outline: 0, panel: [] as string[], cancel: 0 };
  let pending: ((o: import("../src/settings/AutoTune.ts").TuneOutcome | null) => void) | null = null;
  let lastTarget = 0;
  const boot = opts.boot ?? G.presetValues("bas", { dpr: 1.25 });
  const host = {
    graphicsBoot: boot,
    graphicsCaps: opts.caps ?? G.DEFAULT_CAPS,
    gpuName: opts.gpuName ?? "Intel(R) Iris(R) Xe Graphics · D3D11",
    mapId: opts.map ?? "GIVRE",
    softwareRenderer: opts.software ?? false,
    onDisplayDensityChange: null as (() => void) | null,
    applyGraphicsSettings: (v: Values) => void calls.apply.push(v),
    setFpsCap: (fps: number) => void calls.cap.push(fps),
    applyOutlineSettings: () => void calls.outline++,
    setPerfPanel: (mode: string) => void calls.panel.push(mode),
    startAutoTune: (target: number) => {
      lastTarget = target;
      return new Promise<import("../src/settings/AutoTune.ts").TuneOutcome | null>((r) => (pending = r));
    },
    cancelAutoTune: () => {
      calls.cancel++;
      pending?.(null);
      pending = null;
    },
  };
  return {
    host,
    calls,
    resolve: (o: import("../src/settings/AutoTune.ts").TuneOutcome) => {
      pending?.(o);
      pending = null;
    },
    target: () => lastTarget,
  };
}

const isWeak = (name: string) => /intel|iris/i.test(name);

await test("sync: the stored choice reaches the game once per change (values, cap, outline, crosshair / panel deduplicated)", () => {
  const store = new S.SettingsStore(memoryStorage());
  const f = fakeHost();
  let crosshairs = 0;
  const ctl = new GC.GraphicsController(store, f.host, () => ({ dpr: 1.25 }), () => 60, () => void crosshairs++, isWeak);
  assert.equal(f.calls.apply.length, 1);
  assert.equal(G.sameValues(f.calls.apply[0], G.presetValues("bas", { dpr: 1.25 })), true); // weak GPU, no detection: Bas
  assert.equal(f.calls.cap[0], 60);
  assert.equal(crosshairs, 1);
  assert.deepEqual(f.calls.panel, ["full"]);
  store.update((d) => void (d.graphics.preset = "ultra"));
  assert.equal(G.sameValues(f.calls.apply.at(-1)!, G.presetValues("ultra", { dpr: 1.25 })), true);
  assert.equal(f.calls.cap.at(-1), Infinity);
  assert.equal(crosshairs, 1); // crosshair unchanged: not re-sent
  store.update((d) => void (d.crosshair.scale = 1.5));
  assert.equal(crosshairs, 2);
  assert.equal(ctl.needsDetection(), false); // not "auto"
});

await test("detection: the result becomes « Automatique » for this map and GPU; another map still needs its own", async () => {
  const store = new S.SettingsStore(memoryStorage());
  store.update((d) => void (d.graphics.preset = "auto"));
  const f = fakeHost();
  const ctl = new GC.GraphicsController(store, f.host, () => ({ dpr: 1.25 }), () => 60, () => {}, isWeak);
  assert.equal(ctl.needsDetection(), true);
  const events: string[] = [];
  ctl.subscribe((e) => events.push(e.kind));
  const values = { ...G.presetValues("bas", { dpr: 1.25 }), renderScale: 100, anisotropy: 4 as const };
  const run = ctl.runDetection("first");
  assert.equal(ctl.detecting, true);
  assert.equal(f.target(), 60);
  f.resolve({ values, index: 4, mode: "target", goalFps: 60, floorFps: 60, answerFps: 60, probes: 5, complete: true });
  const result = await run;
  assert.ok(result);
  assert.equal(ctl.detecting, false);
  assert.deepEqual(events, ["start", "done"]);
  const r = store.get();
  assert.equal(r.graphics.preset, "auto");
  assert.equal(G.sameValues(r.graphics.auto.GIVRE.values, values), true);
  assert.equal(r.graphics.auto.GIVRE.gpu, f.host.gpuName);
  assert.equal(r.graphics.auto.GIVRE.targetFps, 60);
  assert.equal(G.sameValues(f.calls.apply.at(-1)!, values), true); // applied for good
  assert.equal(f.calls.cap.at(-1), Infinity); // "auto" cap of a measured choice: uncapped
  assert.equal(ctl.needsDetection(), false);
  assert.equal(ctl.pendingReload().length, 0);
  // Same store, another map: the heuristic until its own detection.
  const f2 = fakeHost({ map: "YARD" });
  const ctl2 = new GC.GraphicsController(store, f2.host, () => ({ dpr: 1.25 }), () => 60, () => {}, isWeak);
  assert.equal(ctl2.needsDetection(), true);
  assert.equal(G.sameValues(ctl2.effective(), G.presetValues("bas", { dpr: 1.25 })), true);
});

await test("detection cancelled (PLAY, Annuler): nothing stored, the player's values come back", async () => {
  const store = new S.SettingsStore(memoryStorage());
  store.update((d) => void (d.graphics.preset = "eleve"));
  const f = fakeHost({ gpuName: "NVIDIA GeForce RTX 2080 SUPER · D3D11", boot: G.presetValues("eleve", { dpr: 1 }) });
  const ctl = new GC.GraphicsController(store, f.host, () => ({ dpr: 1 }), () => 240, () => {}, isWeak);
  const events: string[] = [];
  ctl.subscribe((e) => events.push(e.kind));
  const before = JSON.stringify(store.get());
  const run = ctl.runDetection("manual");
  ctl.cancelDetection();
  assert.equal(await run, null);
  assert.equal(f.calls.cancel, 1);
  assert.deepEqual(events, ["start", "cancelled"]);
  assert.equal(JSON.stringify(store.get()), before);
  assert.equal(G.sameValues(f.calls.apply.at(-1)!, G.presetValues("eleve", { dpr: 1 })), true);
});

await test("graphics card limited with live shadows: static shadows advised for the next load (reload bar), measured again then", async () => {
  const store = new S.SettingsStore(memoryStorage());
  store.update((d) => void (d.graphics.preset = "auto"));
  const boot = G.presetValues("eleve", { dpr: 1 });
  const f = fakeHost({ gpuName: "AMD Radeon RX 6400", boot });
  const ctl = new GC.GraphicsController(store, f.host, () => ({ dpr: 1 }), () => 60, () => {}, () => false);
  const floor = A.buildLadder(boot, { dpr: 1 }, G.DEFAULT_CAPS).at(-1)!;
  const run = ctl.runDetection("first");
  f.resolve({ values: floor, index: 9, mode: "gpu", goalFps: 60, floorFps: 41, answerFps: 41, probes: 2, complete: true });
  const result = (await run)!;
  assert.equal(result.values.shadows, "static");
  assert.equal(result.values.characterShadows, false);
  assert.equal(result.belowTarget, true);
  assert.equal(result.limitedBy, "gpu");
  assert.match(result.summary, /statiques au prochain chargement/);
  assert.deepEqual(ctl.pendingReload().map((c) => c.key), ["shadows"]);
  // This session (live shadows) does not measure again; the next one (static) does, once.
  assert.equal(ctl.needsDetection(), false);
  const f2 = fakeHost({ gpuName: "AMD Radeon RX 6400", boot: { ...boot, shadows: "static", characterShadows: false } });
  const ctl2 = new GC.GraphicsController(store, f2.host, () => ({ dpr: 1 }), () => 60, () => {}, () => false);
  assert.equal(ctl2.needsDetection(), true);
});

await test("detection target: the display's rate; an EXPLICIT cap lowers it, the « auto » cap of Bas does not", () => {
  const store = new S.SettingsStore(memoryStorage());
  store.update((d) => {
    d.graphics.preset = "bas";
    d.fpsCap = "auto";
  });
  const f = fakeHost();
  const ctl = new GC.GraphicsController(store, f.host, () => ({ dpr: 1 }), () => 144, () => {}, isWeak);
  assert.equal(ctl.capFps(), 60); // Bas: the old 60 cap in play
  assert.equal(ctl.detectionTarget(), 144); // …but the detection aims at the screen
  store.update((d) => void (d.fpsCap = 120));
  assert.equal(ctl.detectionTarget(), 120);
  store.update((d) => {
    d.fpsCap = 0;
    d.fpsTarget = 60;
  });
  assert.equal(ctl.detectionTarget(), 60);
});

console.log(`\nAll ${passed} detection checks passed.`);
