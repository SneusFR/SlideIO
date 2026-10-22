// AUTOMATIC GRAPHICS DETECTION — headless checks of src/settings/AutoTune (the ladder, the probe
// verdicts, the frame-driven calibration) and src/settings/GraphicsController (store ↔ game, result →
// "Auto" per map, cancel, reload-only advice), fed with SIMULATED machines: a GPU cost model per
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

/** Mid-range GPU (GTX 1660-like) at 1440p on a 144 Hz screen: High ≈ 105 FPS. */
function midGpu(): Machine {
  const perMpx: Record<string, number> = { none: 1.1, fxaa: 1.2, msaa2: 1.6, msaa4: 2.0 };
  return {
    name: "GTX 1660",
    hz: 144,
    css: [2560, 1440],
    dpr: 1,
    cpuMs: 3,
    jitter: 0.3,
    caps: { ...G.DEFAULT_CAPS },
    gpu: (v, mpx) =>
      0.8 + mpx * (perMpx[v.antialiasing] + ANISO_COST[v.anisotropy] * 0.1) + SNOW_COST[v.snow] * 0.2 + (v.shadows === "dynamic" ? SHADOW_TEXELS[v.shadowQuality] * 0.15 : 0),
  };
}

/** Entry-level GPU (GTX 1050-like) at 1080p / 60 Hz: High ≈ 14 ms — holds 60, without much margin. */
function gtx1050(): Machine {
  const perMpx: Record<string, number> = { none: 3.0, fxaa: 3.2, msaa2: 4.4, msaa4: 5.6 };
  return {
    name: "GTX 1050",
    hz: 60,
    css: [1920, 1080],
    dpr: 1,
    cpuMs: 6,
    jitter: 0.4,
    caps: { ...G.DEFAULT_CAPS },
    gpu: (v, mpx) =>
      0.8 + mpx * (perMpx[v.antialiasing] + ANISO_COST[v.anisotropy] * 0.2) + SNOW_COST[v.snow] * 0.3 + (v.shadows === "dynamic" ? SHADOW_TEXELS[v.shadowQuality] * 0.2 : 0),
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
  /** The look this GPU always had (default: the boot values) — see TuneGoals. */
  look?: Values;
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
  const goals = A.tuneGoals(target, A.defaultRungIndex(ladder, opts.look ?? boot));
  const calib = new A.Calibration(
    {
      apply: (v) => {
        applied = v;
        appliedLog.push(v);
      },
    },
    ladder,
    goals,
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

await test("owner's laptop (Iris Xe, 60 Hz, booted Low): MORE than the old LOW — native resolution, FXAA, sharper static shadows — with margin", () => {
  const m = irisXe("static");
  const boot = G.presetValues("bas", { dpr: m.dpr });
  const run = calibrate(m, boot, { look: boot });
  const o = run.outcome!;
  assert.ok(o && o.complete && o.mode === "target");
  assert.equal(o.marginPixels, A.AUTO_TUNE.marginPixels); // measured with the full margin
  assert.match(A.summarize(o, { targetFps: 60, caps: m.caps, software: false }), /hold 60 FPS with 30% extra pixels as headroom for fights/);
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

await test("owner's laptop booted High (live shadows, MSAA): MSAA and the big shadow map go, the floor is never crossed", () => {
  const m = irisXe("dynamic");
  const boot = G.presetValues("eleve", { dpr: m.dpr });
  const o = calibrate(m, boot, { look: G.presetValues("bas", { dpr: m.dpr }) }).outcome!;
  assert.equal(o.mode, "target");
  assert.equal(o.values.shadows, "dynamic");
  assert.notEqual(o.values.antialiasing, "msaa4");
  assert.ok(["medium", "high"].includes(o.values.shadowQuality));
  assert.ok(o.values.renderScale >= 80);
  assert.ok(gpuShare(m, o.values, 60) <= 0.8);
});

await test("gaming PC (RTX 2080 Super, 240 Hz): at least High, and 240 FPS held with margin", () => {
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
  assert.ok(o.answerFps! < 230);
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

await test("60 Hz, entry-level GPU that holds 60 at High with little room: High is KEPT (smaller margin), not lowered for a borderline measure", () => {
  const m = gtx1050();
  const eleve = G.presetValues("eleve", { dpr: 1 });
  const run = calibrate(m, eleve, { look: eleve });
  const o = run.outcome!;
  assert.equal(o.mode, "target");
  assert.equal(G.sameValues(o.values, eleve), true, JSON.stringify(o.values));
  // With the full 30 % margin it would have gone below High:
  assert.ok(m.gpu(eleve, megapixels(m, A.withMargin(eleve))) > 1000 / 60);
  // …but it still holds 60 with ≈ 13 % of the frame free.
  assert.ok(gpuShare(m, eleve, 60) < 0.88, `${gpuShare(m, eleve, 60)}`);
  // The summary states the margin it was really measured with.
  assert.equal(o.marginPixels, A.AUTO_TUNE.keepMarginPixels);
  assert.match(A.summarize(o, { targetFps: 60, caps: m.caps, software: false }), /with 15% extra pixels as headroom/);
});

await test("144 Hz screen, mid GPU (High ≈ 105 FPS): the default look is KEPT at ≥ 60 FPS, never traded for 144", () => {
  const m = midGpu();
  const eleve = G.presetValues("eleve", { dpr: 1 });
  const run = calibrate(m, eleve, { look: eleve });
  const o = run.outcome!;
  assert.equal(o.mode, "hard");
  assert.equal(G.sameValues(o.values, eleve), true, JSON.stringify(o.values));
  assert.equal(o.goalFps, 60);
  assert.match(A.summarize(o, { targetFps: 144, caps: m.caps, software: false }), /so it is kept, for at least 60 FPS with 15% extra pixels/);
  // The floor would have given 144 — the policy keeps the look instead.
  assert.ok(run.calib.measured.get(run.ladder.length - 1)!.fps >= 140);
  // With the target at 60 (target "60 FPS"), the extras above High come back if they keep 60 with margin.
  const at60 = calibrate(m, eleve, { look: eleve, target: 60 }).outcome!;
  assert.equal(at60.mode, "target");
  assert.ok(at60.index <= run.calib.goals.defaultIndex);
});

await test("144 Hz screen, entry GPU whose default look misses 60 FPS there (vsync: 3 refreshes a frame): lowered only as far as 60 FPS needs, and said so", () => {
  const m = { ...gtx1050(), name: "GTX 1050 at 144 Hz", hz: 144 };
  const eleve = G.presetValues("eleve", { dpr: 1 });
  const run = calibrate(m, eleve, { look: eleve });
  const o = run.outcome!;
  assert.equal(o.mode, "hard");
  assert.equal(o.goalFps, 60);
  assert.ok(o.index > o.defaultIndex, `rung ${o.index}, default look ${o.defaultIndex}`);
  // High really misses 60 on this screen (14 ms of work → shown every 3rd refresh, 48 FPS)…
  const period = 1000 / m.hz;
  const shownEvery = (v: Values, pixels: number) => Math.ceil(m.gpu(v, megapixels(m, A.withMargin(v, A.AUTO_TUNE, pixels))) / period);
  assert.ok(shownEvery(eleve, 1) >= 3);
  // …the answer keeps 60 (every 2nd refresh) with its margin, and the rung above it would not.
  assert.ok(shownEvery(o.values, o.marginPixels) <= 2);
  if (o.index - 1 > o.defaultIndex) assert.ok(shownEvery(run.ladder[o.index - 1], A.AUTO_TUNE.marginPixels) >= 3);
  assert.match(A.summarize(o, { targetFps: 144, caps: m.caps, software: false }), /This graphics card's original look can't hold 60 FPS here/);
});

await test("144 Hz screen, integrated GPU: never below the old LOW look, 60 FPS at least", () => {
  const m = irisXe("static", { hz: 144 });
  const bas = G.presetValues("bas", { dpr: m.dpr });
  const run = calibrate(m, bas, { look: bas });
  const o = run.outcome!;
  assert.ok(o.mode === "target" || o.mode === "hard", o.mode);
  const d = A.defaultRungIndex(run.ladder, bas);
  assert.equal(d, run.ladder.length - 1); // the old LOW look IS the floor here
  assert.ok(o.values.renderScale >= bas.renderScale - 1e-6);
  assert.equal(o.values.antialiasing, "fxaa");
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

await test("summary: target held / processor-limited / graphics-card-limited / software rendering, in English", () => {
  const caps = G.DEFAULT_CAPS;
  const values = G.presetValues("bas", { dpr: 1.25 });
  const base = { values, index: 3, defaultIndex: 3, goalFps: 60, floorFps: 61, answerFps: 60, marginPixels: 1.3, probes: 4, complete: true };
  const ctx = (targetFps: number, software = false) => ({ targetFps, caps, software });
  const all: string[] = [];
  const say = (o: Parameters<typeof A.summarize>[0], c: ReturnType<typeof ctx>): string => {
    const text = A.summarize(o, c);
    all.push(text);
    return text;
  };
  assert.match(say({ ...base, mode: "target" }, ctx(60)), /^Settings picked to hold 60 FPS with 30% extra pixels as headroom for fights: 80% resolution, FXAA/);
  assert.doesNotMatch(say({ ...base, mode: "target" }, ctx(60)), /original look/);
  assert.match(say({ ...base, mode: "target", index: 9, marginPixels: 1 }, ctx(60)), /the quality floor, with no measured headroom/);
  assert.match(say({ ...base, mode: "target", index: 5 }, ctx(60)), /This graphics card's original look didn't keep enough headroom at 60 FPS/);
  assert.match(say({ ...base, mode: "cpu", floorFps: 41 }, ctx(60)), /about 41 FPS whatever the graphics: the processor/);
  assert.match(say({ ...base, mode: "gpu", floorFps: 33 }, ctx(60)), /about 33 FPS instead of 60/);
  assert.match(say({ ...base, mode: "gpu" }, ctx(60, true)), /^Software rendering detected/);
  assert.match(say({ ...base, mode: "target", complete: false }, ctx(60)), /interrupted/);
  assert.match(say({ ...base, mode: "hard", marginPixels: 1.15 }, ctx(144)), /^Holding 144 FPS would mean going below this graphics card's original look, so it is kept, for at least 60 FPS with 15%/);
  assert.match(say({ ...base, mode: "hard", index: 6 }, ctx(144)), /can't hold 60 FPS here with enough headroom: settings picked for at least 60 FPS with 30%/);
  for (const text of all) assert.doesNotMatch(text, /[àâçéèêëîïôûùüœ«»]/i, text);
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
  assert.equal(G.sameValues(f.calls.apply[0], G.presetValues("bas", { dpr: 1.25 })), true); // weak GPU, no detection: Low
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

await test("detection: the result becomes Auto for this map and GPU; another map still needs its own", async () => {
  const store = new S.SettingsStore(memoryStorage());
  store.update((d) => void (d.graphics.preset = "auto"));
  const f = fakeHost();
  const ctl = new GC.GraphicsController(store, f.host, () => ({ dpr: 1.25 }), () => 60, () => {}, isWeak);
  assert.equal(ctl.needsDetection(), true);
  const events: string[] = [];
  // The page locks its options on "start": the detection must already be running then.
  const runningAtStart: boolean[] = [];
  ctl.subscribe((e) => {
    events.push(e.kind);
    if (e.kind === "start") runningAtStart.push(ctl.detecting && ctl.progress !== null);
  });
  const values = { ...G.presetValues("bas", { dpr: 1.25 }), renderScale: 100, anisotropy: 4 as const };
  const run = ctl.runDetection("first");
  assert.equal(ctl.detecting, true);
  assert.deepEqual(runningAtStart, [true]);
  assert.equal(f.target(), 60);
  f.resolve({ values, index: 4, defaultIndex: 9, mode: "target", goalFps: 60, floorFps: 60, answerFps: 60, marginPixels: 1.3, probes: 5, complete: true });
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

await test("detection cancelled (PLAY, Cancel): nothing stored, the player's values come back", async () => {
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
  f.resolve({ values: floor, index: 9, defaultIndex: 0, mode: "gpu", goalFps: 60, floorFps: 41, answerFps: 41, marginPixels: 1, probes: 2, complete: true });
  const result = (await run)!;
  assert.equal(result.values.shadows, "static");
  assert.equal(result.values.characterShadows, false);
  assert.equal(result.mode, "gpu");
  assert.equal(result.measuredFps, 41);
  assert.match(result.summary, /Shadows switch to static at the next page load/);
  assert.deepEqual(ctl.pendingReload().map((c) => c.key), ["shadows"]);
  // This session (live shadows) does not measure again; the next one (static) does, once.
  assert.equal(ctl.needsDetection(), false);
  const f2 = fakeHost({ gpuName: "AMD Radeon RX 6400", boot: { ...boot, shadows: "static", characterShadows: false } });
  const ctl2 = new GC.GraphicsController(store, f2.host, () => ({ dpr: 1 }), () => 60, () => {}, () => false);
  assert.equal(ctl2.needsDetection(), true);
});

await test("detection target: the display's rate; an EXPLICIT cap lowers it, the auto cap of Low does not", () => {
  const store = new S.SettingsStore(memoryStorage());
  store.update((d) => {
    d.graphics.preset = "bas";
    d.fpsCap = "auto";
  });
  const f = fakeHost();
  const ctl = new GC.GraphicsController(store, f.host, () => ({ dpr: 1 }), () => 144, () => {}, isWeak);
  assert.equal(ctl.capFps(), 60); // Low: the old 60 cap in play
  assert.equal(ctl.detectionTarget(), 144); // …but the detection aims at the screen
  store.update((d) => void (d.fpsCap = 120));
  assert.equal(ctl.detectionTarget(), 120);
  store.update((d) => {
    d.fpsCap = 0;
    d.fpsTarget = 60;
  });
  assert.equal(ctl.detectionTarget(), 60);
});

// ------------------------------------------------------------------ integrated GPUs

console.log("integrated GPUs: the margin (default +30 %, ?diag=tunemargin50 = the +50 % A/B)");

await test("integrated GPUs: the same +30 % margin as every GPU by default (the guard covers the matches); ?diag=tunemarginNN overrides (tunemargin50 = the +50 % A/B); never above 100 % of native", () => {
  const igpu = A.tuneConfigFor({ integrated: true });
  assert.equal(igpu.marginPixels, A.AUTO_TUNE.marginPixels);
  assert.equal(igpu.keepMarginPixels, A.AUTO_TUNE.keepMarginPixels);
  assert.equal(igpu.marginPixels, 1.3);
  assert.equal(igpu.keepMarginPixels, 1.15);
  assert.equal(A.tuneConfigFor({ integrated: false }), A.AUTO_TUNE);
  const ab = A.tuneConfigFor({ integrated: true }, 50);
  assert.ok(Math.abs(ab.marginPixels - 1.5) < 1e-9 && Math.abs(ab.keepMarginPixels - 1.25) < 1e-9);
  const thirty = A.tuneConfigFor({ integrated: true }, 30);
  assert.ok(Math.abs(thirty.marginPixels - 1.3) < 1e-9 && Math.abs(thirty.keepMarginPixels - 1.15) < 1e-9);
  assert.equal(A.tuneConfigFor({ integrated: false }, 0).marginPixels, 1);
  // The detection itself is unchanged: no forced new measurement for "Auto" players.
  assert.equal(G.AUTO_TUNE_VERSION, 1);
  // Whatever the margin, the answer is a ladder rung: never above 100 % of native (the probes alone draw more).
  for (const dpr of [1, 1.25, 1.5, 2]) {
    for (const boot of [G.presetValues("bas", { dpr }), G.presetValues("eleve", { dpr })]) {
      for (const v of A.buildLadder(boot, { dpr }, G.DEFAULT_CAPS)) assert.ok(v.renderScale <= 100);
    }
  }
});

/**
 * The owner's personal laptop CALIBRATED ON THE FIELD REPORT (Iris Xe, 1920 × 928 CSS at 125 %, 60 Hz):
 * with the default rule (+30 % pixels) the detection picks 90 % of native (2160 × 1044), FXAA, static shadows
 * high, light snow — what it picked on the real laptop. That rung's MENU view costs 12.4 ms here; the
 * field measured 9.4 ms at the spawn view (the menu's orbit sees the whole arena: heavier than a spawn
 * view — the play scenes below are relative to the menu's view). 3 ms of a frame do not scale with pixels.
 */
function irisXeField(opts: Partial<Machine> = {}): Machine {
  const k = 4.1 / 3.0;
  const perMpx: Record<string, number> = { none: 2.6 * k, fxaa: 3.0 * k, msaa2: 4.4 * k, msaa4: 5.75 * k };
  return {
    name: "Iris Xe (field-calibrated)",
    hz: 60,
    css: [1920, 928],
    dpr: 1.25,
    cpuMs: 4, // the menu: nothing simulated
    jitter: 0.6,
    caps: { ...G.DEFAULT_CAPS },
    gpu: (v, mpx) =>
      3 +
      mpx * (perMpx[v.antialiasing] + ANISO_COST[v.anisotropy] * k) +
      SNOW_COST[v.snow] +
      (v.shadows === "dynamic" ? SHADOW_TEXELS[v.shadowQuality] * 0.6 : 0),
    ...opts,
  };
}

await test("field check: the default rule picks what the real laptop picked (90 % of native, FXAA, light snow); the +50 % A/B (tunemargin50) picks 85 %", () => {
  const m = irisXeField();
  const boot = G.presetValues("bas", { dpr: m.dpr });
  const def = calibrate(m, boot, { look: boot, cfg: A.tuneConfigFor({ integrated: true }) }).outcome!;
  assert.equal(def.values.renderScale, 90);
  assert.equal(def.values.antialiasing, "fxaa");
  assert.equal(def.values.snow, "legere");
  assert.equal(def.values.shadowQuality, "high");
  assert.equal(def.marginPixels, 1.3);
  assert.match(A.summarize(def, { targetFps: 60, caps: m.caps, software: false }), /with 30% extra pixels as headroom for fights: 90% resolution/);
  // Its menu view: 12.4 ms (the field's spawn view at this rung: 9.4 ms).
  assert.ok(Math.abs(m.gpu(def.values, megapixels(m, def.values)) - 12.4) < 0.15);
  const ab = calibrate(m, boot, { look: boot, cfg: A.tuneConfigFor({ integrated: true }, 50) }).outcome!;
  assert.equal(ab.mode, "target");
  assert.equal(ab.values.renderScale, 85);
  assert.equal(ab.marginPixels, 1.5);
  assert.match(A.summarize(ab, { targetFps: 60, caps: m.caps, software: false }), /with 50% extra pixels as headroom for fights: 85% resolution/);
});

// ------------------------------------------------------------------ in-match guard

const GD = await import("../src/settings/AutoGuard.ts");
const L = await import("../src/settings/labels.ts");

console.log("in-match guard (AutoGuard)");

const P60 = 1000 / 60;

type Verdicts = { at: number; v: import("../src/settings/AutoGuard.ts").GuardVerdict }[];

/** A frame for a guard: [ms since the previous frame started, THIS frame's main-thread ms, focused play]. */
type Frame = [number, number, boolean];

/** Feeds a guard a fixed frame list; a step is applied at once (as the host does between two frames). Verdicts at their focused time (s). */
function drive(guard: InstanceType<typeof GD.AutoGuard>, frames: Iterable<Frame>): Verdicts {
  const verdicts: Verdicts = [];
  let t = 1000;
  let focused = 0;
  for (const [dt, cpu, play] of frames) {
    t += dt;
    if (play) focused += dt;
    const v = guard.onFrame(t, cpu, play);
    if (v) {
      verdicts.push({ at: focused / 1000, v });
      if (v.action === "step" || v.action === "keep-step") guard.applied();
    }
  }
  return verdicts;
}

/**
 * `seconds` of frames on a 60 Hz screen (or a browser cap), as Chrome paces them: the next frame starts
 * at the first refresh after the main thread is done AND the GPU finished the frame before (one frame in
 * flight) — a GPU frame of 18 ms → ≈ 55 FPS. `gpuMs(steps, s)`: the GPU time after the guard's `steps`.
 */
function simulate(
  guard: InstanceType<typeof GD.AutoGuard>,
  seconds: number,
  gpuMs: (steps: number, s: number) => number,
  opts: { cpu?: (s: number) => number; play?: (s: number) => boolean; capHz?: number; seed?: number } = {},
): Verdicts {
  const random = rng(opts.seed ?? 3);
  const period = 1000 / (opts.capHz ?? 60);
  const verdicts: Verdicts = [];
  let t = 0;
  let gpuEnd = 0;
  let focused = 0;
  let prevPlay: number | null = null;
  while (t < seconds * 1000) {
    const s = t / 1000;
    const play = opts.play ? opts.play(s) : true;
    const cpu = opts.cpu ? opts.cpu(s) : 6;
    if (play && prevPlay !== null) focused += t - prevPlay;
    prevPlay = play ? t : null;
    const v = guard.onFrame(1000 + t, cpu, play);
    if (v) {
      verdicts.push({ at: focused / 1000, v });
      if (v.action === "step" || v.action === "keep-step") guard.applied();
    }
    const g = gpuMs(guard.steps, s) + (random() * 2 - 1) * 0.4;
    const prevEnd = gpuEnd;
    gpuEnd = Math.max(t + cpu, gpuEnd) + g;
    t = Math.max(Math.ceil(Math.max(t + cpu, prevEnd) / period - 1e-9) * period, t + period);
  }
  return verdicts;
}

await test("stretch: trimmed frame rate (lone hitches out), processor-late intervals apart, sliding over the span", () => {
  const s = new GD.FrameStretch();
  for (let i = 0; i < 600; i++) s.push(P60, false, 10_000);
  assert.ok(Math.abs(s.trimmedFps(GD.AUTO_GUARD.trimShare) - 60) < 0.01);
  assert.ok(Math.abs(s.durationMs - 10_000) < P60 + 1e-6);
  // 8 hitches of 100 ms in 10 s: trimmed away (1.5 % = 9 intervals).
  s.clear();
  for (let i = 0; i < 600; i++) s.push(i % 75 === 0 ? 100 : P60, false, 10_000);
  assert.ok(s.trimmedFps(GD.AUTO_GUARD.trimShare) > 59.5);
  // A GPU 10 % over budget is not a hitch: one interval in ten doubled → ≈ 55 FPS.
  s.clear();
  for (let i = 0; i < 600; i++) s.push(i % 10 === 0 ? 2 * P60 : P60, false, 10_000);
  const f = s.trimmedFps(GD.AUTO_GUARD.trimShare);
  assert.ok(f > 54 && f < 56.5, `${f}`);
  // Processor-late intervals are counted apart (not in the frame rate).
  s.clear();
  for (let i = 0; i < 600; i++) s.push(i % 4 === 0 ? 40 : P60, i % 4 === 0, 10_000);
  assert.ok(Math.abs(s.trimmedFps(0) - 60) < 0.01);
  assert.ok(s.cpuShare > 0.2 && s.cpuShare < 0.3);
  // Sliding: 30 s pushed, the stretch covers the last 10 s.
  s.clear();
  for (let i = 0; i < 1800; i++) s.push(P60, false, 10_000);
  assert.ok(s.frames <= 601 && s.durationMs < 10_000 + P60 + 1e-6);
  // Seconds: 8 at 60 FPS then 2 at 30 → ~20 % of them under 57 (a burst, not a sustained shortfall).
  s.clear();
  for (let sec = 0; sec < 10; sec++) for (let i = 0; i < (sec < 8 ? 60 : 30); i++) s.push(sec < 8 ? P60 : 1000 / 30, false, 10_000);
  const low = s.shareBelow(10, 57)!;
  assert.ok(low >= 0.1 && low <= 0.3, `${low}`);
  assert.ok(s.trimmedFps(GD.AUTO_GUARD.trimShare) < 57); // …while its average is under the line
  // Seconds the processor made late are not judged: none left → no share at all.
  s.clear();
  for (let i = 0; i < 600; i++) s.push(40, true, 10_000);
  assert.equal(s.shareBelow(10, 57), null);
  // Sliding for a long time on values right under a histogram bin's edge: what goes out is exactly what
  // came in (no drift, no bin underflow) — the trimmed rate stays the window's.
  s.clear();
  const edge = [16.749999999, 33.249999999, 16.7500000001, 24.99999999];
  const N = 200_000;
  for (let i = 0; i < N; i++) s.push(edge[i % 4], false, 1000);
  const k = s.frames;
  let sum = 0;
  for (let i = N - k; i < N; i++) sum += edge[i % 4];
  assert.ok(k >= 43 && k <= 47, `${k}`);
  assert.ok(Math.abs(s.durationMs - sum) < 1e-6, `${s.durationMs} vs ${sum}`);
  assert.ok(Math.abs(s.trimmedFps(0) - (k * 1000) / sum) < 1e-6, `${s.trimmedFps(0)} vs ${(k * 1000) / sum}`);
  // (and with the slowest 25 % trimmed: exactly the 33.25 ms ones out)
  const kept = edge.filter((x) => x < 30);
  assert.ok(s.trimmedFps(0.25) > 1000 / Math.max(...kept) && s.trimmedFps(0.25) < 1000 / Math.min(...kept));
});

await test("guard: a burst (2 s at 30 FPS in every 10 s — an explosion, a pile-up of bots) averages ≈ 54 FPS but is not sustained: no step", () => {
  assert.equal(simulate(new GD.AutoGuard(60), 300, (n, s) => (s % 10 < 2 ? 33 : 12)).length, 0);
  // The same 30 FPS for 7 s of every 10: sustained → a step.
  const v = simulate(new GD.AutoGuard(60), 60, (n, s) => (n === 0 && s % 10 < 7 ? 33 : 12));
  assert.ok(v.length >= 1 && v[0].v.action === "step", JSON.stringify(v.map((x) => x.v.action)));
});

await test("guard: holds 60 → never a verdict; a GPU short of 60 for a sustained stretch → ONE step, after ≥ 10 s of focused play", () => {
  assert.equal(simulate(new GD.AutoGuard(60), 300, () => 15.6).length, 0);
  // 17.0 ms per frame (≈ 58.8 FPS): borderline — no step for 1-2 FPS.
  assert.equal(simulate(new GD.AutoGuard(60), 300, () => 17.0).length, 0);
  // 18.5 ms (≈ 54 FPS), never better: a step after the first 3 s of settling + 10 s of stretch, not before.
  const v = simulate(new GD.AutoGuard(60), 60, () => 18.5);
  assert.ok(v.length >= 1 && v[0].v.action === "step", JSON.stringify(v.map((x) => x.v.action)));
  assert.ok(v[0].at >= 13 && v[0].at < 14, `${v[0].at}`);
  assert.ok(v[0].v.fps > 52 && v[0].v.fps < 56.5, `${v[0].v.fps}`);
  // A 50 Hz screen: the promise is 50 (the goal), not 60.
  assert.equal(simulate(new GD.AutoGuard(50), 120, () => 18.5, { capHz: 50 }).length, 0);
});

await test("guard: where it triggers on a 60 Hz screen (GPU ms per frame → delivered FPS → step?) — from ≈ 17.6 ms (≈ 55-56 FPS)", () => {
  const rows: string[] = [];
  let firstStep: number | null = null;
  for (const ms of [16.0, 16.5, 17.0, 17.3, 17.6, 17.8, 18.0, 18.5, 19.0, 20.0]) {
    const v = simulate(new GD.AutoGuard(60), 40, () => ms, { seed: 9 });
    const step = v.find((x) => x.v.action === "step");
    // Delivered FPS of the same frames (untrimmed): what the player gets.
    const g = new GD.FrameStretch();
    let t = 0;
    let gpuEnd = 0;
    const random = rng(9);
    while (t < 20_000) {
      const prevEnd = gpuEnd;
      gpuEnd = Math.max(t + 6, gpuEnd) + ms + (random() * 2 - 1) * 0.4;
      const next = Math.max(Math.ceil(Math.max(t + 6, prevEnd) / P60 - 1e-9) * P60, t + P60);
      g.push(next - t, false, 20_000);
      t = next;
    }
    rows.push(`${ms.toFixed(1)} ms → ${g.trimmedFps(0).toFixed(1)} FPS → ${step ? `step after ${step.at.toFixed(1)} s (judged ${step.v.fps.toFixed(1)})` : "no step"}`);
    if (step && firstStep === null) firstStep = ms;
  }
  console.log(`      ${rows.join("\n      ")}`);
  assert.ok(firstStep !== null && firstStep >= 17.3 && firstStep <= 18.5, `first step at ${firstStep} ms`);
});

await test("guard: only FOCUSED play counts (menu, pause, Alt-Tab): the sustained stretch is 10 s of play, not of wall-clock time", () => {
  // Bad frames, but the window loses the focus 2 s out of every 10 (each return settles 3 s).
  const v = simulate(new GD.AutoGuard(60), 120, () => 18.5, { play: (s) => s % 10 < 8 });
  assert.ok(v.length >= 1);
  assert.ok(v[0].at > 15, `${v[0].at}`); // 10 s judged + a settle after each return
  // Never a verdict without play frames.
  assert.equal(simulate(new GD.AutoGuard(60), 120, () => 25, { play: () => false }).length, 0);
});

await test("guard: lone hitches (kills: the processor's long frames; the browser's GPU process) never cost a step", () => {
  const frames: Frame[] = [];
  const random = rng(11);
  for (let i = 0; i < 60 * 300; i++) {
    // Every ~3 s a kill: one frame of 45 ms of main thread (+ its long interval); every ~2 s a GPU-process hitch.
    if (i % 180 === 90) frames.push([P60, 45, true], [3 * P60, 6, true]);
    else if (i % 120 === 7) frames.push([P60 + 25, 6, true]);
    else frames.push([P60 + (random() - 0.5) * 0.5, 6, true]);
  }
  assert.equal(drive(new GD.AutoGuard(60), frames).length, 0);
});

await test("guard: a processor-limited stretch (most frames late because of the main thread) gets no verdict — lowering the graphics would not help", () => {
  // 20 ms of main thread per frame: every interval follows a processor-late frame.
  assert.equal(simulate(new GD.AutoGuard(60), 120, () => 10, { cpu: () => 20 }).length, 0);
});

await test("guard: a step is judged on the stretch after it — kept when it restores 60, kept + one more when it helps, useless (guard off) when it changes nothing", () => {
  // Restores 60: keep, then watching again.
  const g1 = new GD.AutoGuard(60);
  const v1 = simulate(g1, 60, (n) => (n === 0 ? 18.5 : 15));
  assert.deepEqual(v1.map((x) => x.v.action), ["step", "keep"]);
  assert.ok(v1[1].at - v1[0].at >= 8 && v1[1].at - v1[0].at < 9, `${v1[1].at - v1[0].at}`); // 2 s settle + 6 s
  assert.equal(g1.phase, "watch");
  assert.equal(g1.steps, 1);
  // Helps (54 → 56 FPS) but not enough: keep it and step once more; the second restores 60.
  const g2 = new GD.AutoGuard(60);
  const v2 = simulate(g2, 60, (n) => (n === 0 ? 18.5 : n === 1 ? 17.9 : 15));
  assert.deepEqual(v2.map((x) => x.v.action), ["step", "keep-step", "keep"]);
  assert.ok(v2[1].v.before! < v2[1].v.fps);
  assert.equal(g2.steps, 2);
  // Changes nothing (a browser frame cap at 30 FPS): useless, and the guard stops for the session.
  const g3 = new GD.AutoGuard(60);
  const v3 = simulate(g3, 120, () => 10, { capHz: 30 });
  assert.deepEqual(v3.map((x) => x.v.action), ["step", "useless"]);
  assert.equal(g3.active, false);
  assert.equal(g3.steps, 1);
  // Never two steps without a judged stretch in between (no cascade).
  for (const g of [g1, g2, g3]) assert.ok(g.steps <= 2);
});

await test("guard step: the next rung that really moves the frame time (resolution, anti-aliasing, a live shadow map), the fine knobs above it taken along; the floor → nothing", () => {
  const dpr = 1.25;
  const ladder = A.buildLadder(G.presetValues("bas", { dpr }), { dpr }, G.DEFAULT_CAPS);
  const at = (i: number) => GD.guardStepIndex(ladder, ladder[i]);
  const last = ladder.length - 1;
  // r4 (FXAA, 4× filtering, normal snow, 100 %) → 90 %, with 1× filtering and light snow on the way.
  assert.equal(ladder[4].antialiasing, "fxaa");
  assert.equal(ladder[at(4)!].renderScale, 90);
  assert.equal(ladder[at(4)!].anisotropy, 1);
  assert.equal(ladder[at(4)!].snow, "legere");
  // Resolution rungs: one at a time (90 → 85 → 80), the floor last; nothing below the floor.
  const r90 = ladder.findIndex((v) => v.renderScale === 90);
  assert.equal(ladder[at(r90)!].renderScale, 85);
  assert.equal(at(r90 + 1), last);
  assert.equal(at(last), null);
  // MSAA 4× → 2× is a step of its own.
  assert.equal(ladder[at(0)!].antialiasing, "msaa2");
  // DPR 1 (the floor IS native): only fine knobs below FXAA → the floor at once.
  const l1 = A.buildLadder(G.presetValues("bas", { dpr: 1 }), { dpr: 1 }, G.DEFAULT_CAPS);
  const fx = l1.findIndex((v) => v.antialiasing === "fxaa");
  assert.equal(GD.guardStepIndex(l1, l1[fx]), l1.length - 1);
  // High (live shadows): MSAA 4× → 2×, then the smaller live shadow map, then FXAA.
  const eleve = G.presetValues("eleve", { dpr: 1 });
  const lh = A.buildLadder(eleve, { dpr: 1 }, G.DEFAULT_CAPS);
  const s1 = lh[GD.guardStepIndex(lh, eleve)!];
  assert.equal(s1.antialiasing, "msaa2");
  const s2 = lh[GD.guardStepIndex(lh, s1)!];
  assert.equal(s2.shadowQuality, "medium");
  const s3 = lh[GD.guardStepIndex(lh, s2)!];
  assert.equal(s3.antialiasing, "fxaa");
  // Every step: live (no reload), never costlier in any knob.
  for (let i = 0; i < ladder.length; i++) {
    const j = GD.guardStepIndex(ladder, ladder[i]);
    if (j === null) continue;
    assert.ok(j > i && A.noCostlier(ladder[j], ladder[i]));
    assert.equal(G.reloadChanges(ladder[i], ladder[j], G.DEFAULT_CAPS).length, 0);
  }
});

await test("step back up: the exact undo of one guard step, never above the detection's answer; the wait doubles after each failed try", () => {
  const dpr = 1.25;
  const ladder = A.buildLadder(G.presetValues("bas", { dpr }), { dpr }, G.DEFAULT_CAPS);
  const fx = ladder.findIndex((v) => v.antialiasing === "fxaa"); // 100 %, FXAA, 4× filtering, normal snow
  const r90 = ladder.findIndex((v) => v.renderScale === 90);
  const r85 = ladder.findIndex((v) => v.renderScale === 85);
  // One step down from FXAA/100 % went to 90 % (fine knobs with it): one step up comes back to FXAA/100 %…
  assert.equal(GD.guardStepIndex(ladder, ladder[fx]), r90);
  assert.equal(GD.guardUpIndex(ladder, ladder[r90], ladder[fx]), fx);
  // …but never above the detection's answer (here 100 % with 1× filtering and light snow).
  assert.equal(GD.guardUpIndex(ladder, ladder[r90], ladder[r90 - 1]), r90 - 1);
  // From 85 % one step up is 90 %, whatever the answer above it.
  assert.equal(GD.guardUpIndex(ladder, ladder[r85], ladder[fx]), r90);
  // At (or above) the answer: nothing to climb back to.
  assert.equal(GD.guardUpIndex(ladder, ladder[fx], ladder[fx]), null);
  assert.equal(GD.guardUpIndex(ladder, ladder[fx], ladder[r90]), null);
  // Up then down is the identity on every rung a guard step can land on (no drift between the two directions).
  for (let c = 1; c < ladder.length; c++) {
    if (!ladder.some((_, k) => GD.guardStepIndex(ladder, ladder[k]) === c)) continue;
    const up = GD.guardUpIndex(ladder, ladder[c], ladder[0]);
    assert.ok(up !== null && up < c);
    assert.equal(GD.guardStepIndex(ladder, ladder[up!]), c, `rung ${c}`);
  }
  const h = 3600_000;
  assert.deepEqual([0, 1, 2, 3, 10].map((f) => GD.retryDelay(f) / h), [20, 40, 80, 160, 720]);
});

await test("guard texts: a short English notice of what changed, and the page's summary", () => {
  const caps = G.DEFAULT_CAPS;
  const dpr = 1.25;
  const ladder = A.buildLadder(G.presetValues("bas", { dpr }), { dpr }, caps);
  const r90 = ladder.findIndex((v) => v.renderScale === 90);
  assert.equal(L.guardNoticeText(ladder[r90], ladder[r90 + 1], 60, caps), "Graphics lowered to hold 60 FPS (resolution 90% → 85%)");
  const fx = ladder.findIndex((v) => v.antialiasing === "fxaa");
  assert.equal(
    L.guardNoticeText(ladder[fx - 1], ladder[fx], 60, caps),
    "Graphics lowered to hold 60 FPS (MSAA 2× → FXAA)",
  );
  assert.equal(L.describeChange(ladder[fx], ladder[r90], caps), "resolution 100% → 90%, 4× → 1× filtering, light snow");
  const sum = L.guardSummaryText(ladder[r90 + 1], 1, 53.6, 60, caps);
  assert.match(sum, /^In a match this PC fell to about 54 FPS, so Auto lowered the graphics one step to hold 60 FPS: 85% resolution, FXAA/);
  assert.match(L.guardSummaryText(ladder[r90 + 1], 2, 50, 60, caps), /2 steps/);
  for (const text of [sum, L.guardNoticeText(ladder[0], ladder[1], 60, caps)]) assert.doesNotMatch(text, /[àâçéèêëîïôûùüœ«»]/i);
});

// ------------------------------------------------------------------ Auto in matches (simulated)

console.log("Auto in matches: simulated machines (detection in the menu, then 5-minute matches)");

/** A match, relative to the MENU view the detection measured. */
interface Scene {
  /** GPU time of the view at second s, relative to the menu's (calm spawn views < 1, fights > 1). */
  load: (s: number) => number;
  /** Sustained clocks: GPU time factor at second s (1 = the detection's cool chip in its turbo window). */
  throttle?: (s: number) => number;
  /** Main-thread ms of a frame (AI, physics, the HUD's commands). */
  cpu?: (s: number, random: () => number) => number;
  /** Extra delay before the next frame (the browser's own hitch), ms. */
  hitch?: (s: number, random: () => number) => number;
  focused?: (s: number) => boolean;
  /** Browser frame cap (Hz) from this second on — Chrome's energy saver: 30. */
  cap?: { hz: number; from: number };
  /**
   * GPU time per frame that does NOT follow the 3D render scale: the HUD's raster and compositing
   * in the browser's GPU process (the real laptop: 59.9 → 45 FPS at native with the same WebGL time,
   * before the HUD's CSS fix). Never in the menu (the HUD is hidden there): the detection never sees it.
   */
  hudMs?: number;
}

/** Engagements: calm stretches (spawn views, ≈ 0.78 of the menu's view — the field's 9.4 vs 12.4 ms) and fights up to `peak`. */
function fights(seed: number, peak: number): (s: number) => number {
  const random = rng(seed);
  const segs: { end: number; f: number }[] = [];
  let s = 0;
  let fight = false;
  while (s < 3600) {
    const len = fight ? 6 + random() * 14 : 4 + random() * 8;
    const f = fight ? 0.95 + (peak - 0.95) * (0.5 + 0.5 * random()) : 0.74 + 0.08 * random();
    s += len;
    segs.push({ end: s, f });
    fight = !fight;
  }
  let k = 0;
  return (x) => {
    if (k > 0 && x < segs[k - 1].end) k = 0;
    while (k < segs.length - 1 && x >= segs[k].end) k++;
    return segs[k].f;
  };
}

/** Sustained clocks: GPU time × `factor` reached between `from` and `to` seconds (smooth). */
function throttling(factor: number, from: number, to: number): (s: number) => number {
  return (s) => {
    const x = Math.min(1, Math.max(0, (s - from) / (to - from)));
    return 1 + (factor - 1) * x * x * (3 - 2 * x);
  };
}

interface MatchStats {
  /** Delivered FPS of each 5 s block of focused play. */
  blocks: number[];
  /** Share of those blocks under 57 FPS (the promise not kept). */
  below: number;
  worst: number;
  fps: number;
  /** Match time (s) of each guard step's notice. */
  steps: number[];
}

/** The Game, simulated: renders the machine's frames, feeds the controller's frame listener, applies what the controller asks. */
class SimGame {
  values: Values;
  listener: ((t: number, cpu: number, play: boolean, between: boolean) => void) | null = null;
  readonly queue: (() => void)[] = [];
  readonly notices: { at: number; text: string }[] = [];
  detectConfig: typeof A.AUTO_TUNE | null = null;
  inFrame = false;
  applyInFrame = 0;
  private clock = 1000;
  private matchT = 0;
  readonly host;

  constructor(
    readonly m: Machine & { gpuName: string },
    readonly boot: Values,
  ) {
    this.values = boot;
    const self = this;
    this.host = {
      graphicsBoot: boot,
      graphicsCaps: m.caps,
      gpuName: m.gpuName,
      mapId: "GIVRE",
      softwareRenderer: false,
      onDisplayDensityChange: null as (() => void) | null,
      applyGraphicsSettings(v: Values) {
        if (self.inFrame) self.applyInFrame++;
        self.values = G.liveValues(boot, v, m.caps);
      },
      setFpsCap() {},
      applyOutlineSettings() {},
      setPerfPanel() {},
      startAutoTune(target: number, opts: { defaultLook?: Values; config?: typeof A.AUTO_TUNE }) {
        return Promise.resolve(self.detect(target, opts));
      },
      cancelAutoTune() {},
      addFrameListener(l: (t: number, cpu: number, play: boolean, between: boolean) => void) {
        self.listener = l;
        return () => void (self.listener = null);
      },
      showGraphicsNotice(text: string) {
        self.notices.push({ at: self.matchT / 1000, text });
      },
    };
  }

  /** The menu's detection (as Game.startAutoTune: the session's ladder, the menu view, uncapped vsync frames). */
  private detect(target: number, opts: { defaultLook?: Values; config?: typeof A.AUTO_TUNE }) {
    const m = this.m;
    const ladder = A.buildLadder(this.boot, { dpr: m.dpr }, m.caps);
    const goals = A.tuneGoals(target, A.defaultRungIndex(ladder, opts.defaultLook ?? ladder[ladder.length - 1]));
    this.detectConfig = opts.config ?? null;
    const calib = new A.Calibration({ apply: (v) => void (this.values = v) }, ladder, goals, opts.config);
    const random = rng(17);
    const period = 1000 / m.hz;
    calib.start(this.clock);
    while (!calib.done) {
      const cpu = m.cpuMs + (random() * 2 - 1) * m.jitter;
      const gpu = m.gpu(this.values, megapixels(m, this.values)) + (random() * 2 - 1) * m.jitter;
      calib.onFrame(this.clock, cpu, true);
      this.clock += Math.max(1, Math.ceil(Math.max(cpu, gpu) / period - 1e-9)) * period;
    }
    return calib.outcome;
  }

  /**
   * A match: Chrome's frame pacing on a vsync display, one frame in flight — the next frame starts at
   * the first refresh after the main thread is done AND the GPU finished the frame before (a GPU frame
   * of 18 ms → ≈ 55 FPS, an interval of two refreshes now and then).
   */
  match(scene: Scene, seconds: number, seed = 1, stopWhen?: () => boolean): MatchStats {
    const m = this.m;
    const random = rng(seed);
    const base = this.clock;
    let t = 0;
    let gpuEnd = 0;
    const blocks: number[] = [];
    let blockMs = 0;
    let blockFrames = 0;
    let prevPlayT: number | null = null;
    let total = 0;
    let totalFrames = 0;
    const firstNotice = this.notices.length;
    while (t < seconds * 1000 && !stopWhen?.()) {
      const s = t / 1000;
      this.matchT = t;
      const play = scene.focused ? scene.focused(s) : true;
      const capped = scene.cap && s >= scene.cap.from ? scene.cap.hz : m.hz;
      const period = 1000 / Math.min(m.hz, capped);
      const cpu = Math.max(0.5, (scene.cpu ? scene.cpu(s, random) : 7) + (random() * 2 - 1) * m.jitter * 0.5);
      const gpu = Math.max(
        0.5,
        m.gpu(this.values, megapixels(m, this.values)) * scene.load(s) * (scene.throttle ? scene.throttle(s) : 1) +
          (scene.hudMs ?? 0) +
          (random() * 2 - 1) * m.jitter,
      );
      this.inFrame = true;
      this.listener?.(base + t, cpu, play, false);
      this.inFrame = false;
      // Between two frames: what the controller deferred (a step is on screen from the next frame on).
      while (this.queue.length) this.queue.shift()!();
      if (play && prevPlayT !== null) {
        const dt = t - prevPlayT;
        blockMs += dt;
        blockFrames++;
        total += dt;
        totalFrames++;
        if (blockMs >= 5000) {
          blocks.push((blockFrames * 1000) / blockMs);
          blockMs = 0;
          blockFrames = 0;
        }
      }
      prevPlayT = play ? t : null;
      const prevEnd = gpuEnd;
      gpuEnd = Math.max(t + cpu, gpuEnd) + gpu;
      const hitch = scene.hitch ? scene.hitch(s, random) : 0;
      t = Math.max(Math.ceil((Math.max(t + cpu, prevEnd) + hitch) / period - 1e-9) * period, t + period);
    }
    this.clock = base + t + 30_000; // end screen, menu
    const below = blocks.filter((f) => f < 57).length / Math.max(1, blocks.length);
    return {
      blocks,
      below,
      worst: Math.min(...blocks),
      fps: (totalFrames * 1000) / Math.max(1, total),
      steps: this.notices.slice(firstNotice).map((n) => n.at),
    };
  }

  /** Frames with no match under way (a match's end screen, the menu); what the controller deferred runs between them. */
  menu(seconds = 2): void {
    const period = 1000 / this.m.hz;
    for (let t = 0; t < seconds * 1000; t += period) {
      this.inFrame = true;
      this.listener?.(this.clock, 4, false, true);
      this.inFrame = false;
      while (this.queue.length) this.queue.shift()!();
      this.clock += period;
    }
  }
}

const P = await import("../src/settings/Power.ts");
type PowerState = import("../src/settings/Power.ts").PowerState;

/** The laptop's power, as the controller reads it (settings/Power), set by the test. */
function fakePower(initial: PowerState) {
  let state = initial;
  const listeners: ((s: PowerState) => void)[] = [];
  return {
    get state() {
      return state;
    },
    subscribe(l: (s: PowerState) => void) {
      listeners.push(l);
      return () => void listeners.splice(listeners.indexOf(l), 1);
    },
    set(s: PowerState) {
      state = s;
      for (const l of [...listeners]) l(s);
    },
  };
}

const INTEL = "Intel(R) Iris(R) Xe Graphics · D3D11";

/** A fresh profile (or `store`), the game simulated, the controller as main.ts builds it (+ the deferral queue). */
function session(
  m: Machine & { gpuName: string },
  boot: Values,
  store = new S.SettingsStore(memoryStorage()),
  extra: { experiments?: Set<string>; now?: () => number; power?: import("../src/settings/Power.ts").PowerSource } = {},
) {
  const sim = new SimGame(m, boot);
  const ctl = new GC.GraphicsController(store, sim.host, () => ({ dpr: m.dpr }), () => m.hz, () => {}, isWeak, {
    experiments: extra.experiments ?? new Set(),
    defer: (fn) => void sim.queue.push(fn),
    now: extra.now,
    power: extra.power ?? P.UNKNOWN_POWER,
  });
  return { sim, ctl, store };
}

const fmtValues = (v: Values) => `${v.renderScale} % · ${v.antialiasing} · aniso ${v.anisotropy} · snow ${v.snow}${v.shadows === "dynamic" ? ` · live shadows ${v.shadowQuality}` : ""}`;
const fmtMatch = (r: MatchStats) => `${r.fps.toFixed(1)} FPS, worst 5 s ${r.worst.toFixed(1)}, ${(r.below * 100).toFixed(0)} % of the time under 57, steps at ${r.steps.map((x) => `${x.toFixed(0)} s`).join(", ") || "—"}`;

/** The owner's WORK laptop: Iris Xe, ~1874 × 956 CSS at 125 %, on battery / an office power plan — the chip settles 32 % slower after a minute or two. */
const workLaptop = () => ({ ...irisXeField({ css: [1874, 956] as [number, number] }), name: "work laptop (Iris Xe, battery)", gpuName: INTEL });
const workScene = (seed: number): Scene => ({ load: fights(seed, 1.25), throttle: throttling(1.32, 60, 180) });

await test("the owner's work laptop on battery (Iris Xe, 1874 × 956 at 125 %): 90 % from the menu — 60 FPS at first, then not without the guard; with it, 90 → 85 → 80 % in the first match, stored; the next match holds", async () => {
  const boot = G.presetValues("bas", { dpr: 1.25 });
  // WITHOUT THE GUARD (?diag=noguard): the field report.
  const before = session(workLaptop(), boot, undefined, { experiments: new Set(["noguard"]) });
  await before.ctl.runDetection("first");
  const oldValues = before.ctl.effective();
  const b1 = before.sim.match(workScene(1), 300);
  console.log(`      without the guard: ${fmtValues(oldValues)} → ${fmtMatch(b1)}`);
  assert.equal(oldValues.renderScale, 90);
  assert.equal(b1.steps.length, 0);
  assert.ok(b1.below > 0.2, `without the guard: ${fmtMatch(b1)}`); // the field report: "then not"
  // The first minute (cool chip) held: "60 FPS at first".
  assert.ok(b1.blocks.slice(0, 10).every((f) => f >= 57), `first minute: ${b1.blocks.slice(0, 10).map((f) => f.toFixed(0))}`);

  // WITH THE GUARD (the default): the same detection, the same 90 %.
  const now = session(workLaptop(), boot);
  await now.ctl.runDetection("first");
  const picked = now.ctl.effective();
  const m1 = now.sim.match(workScene(1), 300);
  const stored = now.store.get().graphics.auto.GIVRE;
  console.log(`      with the guard: menu ${fmtValues(picked)} → match 1: ${fmtMatch(m1)}`);
  console.log(`        notices: ${now.sim.notices.map((n) => `${n.at.toFixed(0)} s "${n.text}"`).join(" · ")}; stored ${fmtValues(stored.values)}, ${stored.guardSteps} step(s)`);
  assert.equal(now.sim.detectConfig?.marginPixels, 1.3); // integrated GPU: the same margin as every GPU
  assert.equal(G.sameValues(picked, oldValues), true);
  assert.equal(m1.steps.length, 2, fmtMatch(m1)); // both rungs below 90 %: 85 %, then the floor
  assert.ok(m1.steps[0] > 60, `first step at ${m1.steps[0]} s`); // the cool chip's first minute: untouched
  assert.equal(now.sim.applyInFrame, 0); // applied between two frames, never inside one (blank-frame rule)
  assert.match(now.sim.notices[0].text, /^Graphics lowered to hold 60 FPS \(resolution 90% → 85%\)$/);
  assert.match(now.sim.notices[1].text, /^Graphics lowered to hold 60 FPS \(resolution 85% → 80%\)$/);
  assert.ok(m1.below < b1.below / 2, `with the guard: ${fmtMatch(m1)} vs without ${fmtMatch(b1)}`);
  assert.equal(stored.values.renderScale, 80); // kept: each step helped
  assert.equal(stored.guardSteps, 2);
  assert.equal(G.sameValues(stored.detected!, picked), true); // the detection's answer, to climb back to one day
  assert.match(stored.summary, /^In a match this PC fell to about \d+ FPS, so Auto lowered the graphics 2 steps to hold 60 FPS: 80% resolution/);
  // Next session (same store): starts at 80 %, never back up; the chip is warm from the start.
  const next = session(workLaptop(), boot, now.store);
  assert.equal(next.ctl.needsDetection(), false); // no new detection: the guard's steps stand
  assert.equal(next.ctl.effective().renderScale, 80);
  const m2 = next.sim.match({ load: fights(2, 1.25), throttle: throttling(1.32, 0, 30) }, 300, 2);
  console.log(`      match 2 (warm chip): ${fmtValues(next.ctl.effective())} → ${fmtMatch(m2)}`);
  assert.equal(m2.steps.length, 0); // the floor: nothing below, nothing to do
  assert.ok(m2.below < 0.1, `match 2: ${fmtMatch(m2)}`);
});

await test("the owner's personal laptop plugged in (the field's 90 % held 60): 90 % from the menu, matches hold 60, the guard never steps; the +50 % A/B would cost it one resolution step (85 %)", async () => {
  const m = { ...irisXeField(), gpuName: INTEL };
  const boot = G.presetValues("bas", { dpr: 1.25 });
  const scene = (): Scene => ({ load: fights(4, 1.2), throttle: throttling(1.06, 60, 240) });
  const run = session(m, boot);
  await run.ctl.runDetection("first");
  const r = run.sim.match(scene(), 300, 4);
  console.log(`      ${fmtValues(run.ctl.effective())} → ${fmtMatch(r)}`);
  assert.equal(run.ctl.effective().renderScale, 90);
  assert.equal(r.steps.length, 0, fmtMatch(r));
  assert.ok(r.below === 0, fmtMatch(r));
  // ?diag=tunemargin50: 85 % — it held too, one resolution step lower for nothing on this machine.
  const ab = session(m, boot, undefined, { experiments: new Set(["tunemargin50"]) });
  await ab.ctl.runDetection("first");
  const ra = ab.sim.match(scene(), 300, 4);
  console.log(`      tunemargin50: ${fmtValues(ab.ctl.effective())} → ${fmtMatch(ra)}`);
  assert.equal(ab.ctl.effective().renderScale, 85);
  assert.equal(ra.steps.length, 0, fmtMatch(ra));
});

await test("the work laptop at 100 % zoom (the floor IS native): the guard can only take filtering and snow — then the floor, never lower", async () => {
  const m = { ...workLaptop(), dpr: 1 };
  const boot = G.presetValues("bas", { dpr: 1 });
  const run = session(m, boot);
  await run.ctl.runDetection("first");
  const picked = run.ctl.effective();
  assert.equal(picked.renderScale, 100);
  const r = run.sim.match({ load: fights(5, 1.3), throttle: throttling(1.32, 60, 180) }, 300, 5);
  const floor = A.buildLadder(boot, { dpr: 1 }, m.caps).at(-1)!;
  assert.ok(r.steps.length <= 1, fmtMatch(r));
  assert.ok(G.sameValues(run.ctl.effective(), floor) || G.sameValues(run.ctl.effective(), picked));
  assert.ok(A.noCostlier(floor, run.ctl.effective()));
  console.log(`      menu ${fmtValues(picked)} → ${fmtMatch(r)}; now ${fmtValues(run.ctl.effective())}`);
});

await test("gaming PC (RTX 2080 Super, 240 Hz): matches far above 60 → the guard never steps (its promise is 60, the image stays)", async () => {
  const m = { ...rtx2080(), gpuName: "NVIDIA GeForce RTX 2080 SUPER · D3D11" };
  const boot = G.presetValues("eleve", { dpr: 1 });
  const run = session(m, boot);
  await run.ctl.runDetection("first");
  assert.equal(run.sim.detectConfig?.marginPixels, 1.3); // discrete GPU: the usual margin
  const v = run.ctl.effective();
  const r = run.sim.match({ load: fights(6, 1.35), cpu: () => 3.6 }, 120, 6);
  assert.equal(r.steps.length, 0);
  assert.ok(r.fps > 150, fmtMatch(r));
  assert.equal(G.sameValues(run.ctl.effective(), v), true);
});

await test("entry GPU (GTX 1050, 60 Hz, High kept by the detection): a heavy match → MSAA 4× → 2×, kept", async () => {
  const m = { ...gtx1050(), gpuName: "NVIDIA GeForce GTX 1050 · D3D11" };
  const eleve = G.presetValues("eleve", { dpr: 1 });
  const run = session(m, eleve);
  await run.ctl.runDetection("first");
  assert.equal(G.sameValues(run.ctl.effective(), eleve), true);
  const r = run.sim.match({ load: fights(7, 1.35) }, 300, 7);
  assert.ok(r.steps.length >= 1, fmtMatch(r));
  assert.match(run.sim.notices[0].text, /MSAA 4× → MSAA 2×/);
  assert.ok(r.below < 0.25, fmtMatch(r));
  console.log(`      High → ${fmtValues(run.ctl.effective())} — ${fmtMatch(r)}`);
});

await test("processor-limited laptop (AI and physics take ~18 ms a frame in fights): no step — lower graphics would not give a frame back", async () => {
  const m = { ...irisXeField(), gpuName: INTEL };
  const run = session(m, G.presetValues("bas", { dpr: 1.25 }));
  await run.ctl.runDetection("first");
  const v = run.ctl.effective();
  const r = run.sim.match({ load: fights(8, 1.1), cpu: (s) => (Math.floor(s / 8) % 2 ? 18 : 9) }, 300, 8);
  assert.equal(r.steps.length, 0, fmtMatch(r));
  assert.equal(G.sameValues(run.ctl.effective(), v), true);
});

await test("GPU-bound fight where the render submission WAITS for the GPU process (main thread 16.5 ms, 10 of them submission against its usual 2): the graphics' frames → a step; the same main-thread time really spent by the processor: no verdict", () => {
  /** [ms since the previous frame, main-thread ms, focused play, render submission ms]. */
  const run = (frames: [number, number, boolean, number][]): Verdicts => {
    const guard = new GD.AutoGuard(60);
    const verdicts: Verdicts = [];
    let t = 1000;
    let focused = 0;
    for (const [dt, cpu, play, render] of frames) {
      t += dt;
      if (play) focused += dt;
      const v = guard.onFrame(t, cpu, play, render);
      if (v) {
        verdicts.push({ at: focused / 1000, v });
        if (v.action === "step" || v.action === "keep-step") guard.applied();
      }
    }
    return verdicts;
  };
  const calm: [number, number, boolean, number][] = Array.from({ length: 300 }, () => [P60, 6, true, 2]); // 5 s at 60 FPS
  // The owner's laptop in a GPU-bound fight: 20 ms frames (50 FPS) for 20 s, the submission blocked 8 ms more.
  const gpuBound: [number, number, boolean, number][] = Array.from({ length: 1000 }, (_, i) => [20, 16.5 + (i % 3) * 0.2, true, 10 + (i % 3) * 0.2]);
  const a = run([...calm, ...gpuBound]);
  assert.equal(a[0]?.v.action, "step", JSON.stringify(a));
  assert.ok(a[0].at > 5 && a[0].at < 20, `${a[0].at}`);
  assert.ok(a[0].v.cpuShare < 0.1, `${a[0].v.cpuShare}`);
  // A whole match GPU-bound from its first frame: the level is still found (the odd frame with room in the command buffer).
  const fromStart = run(Array.from({ length: 1200 }, (_, i) => [20, i % 40 === 0 ? 8.5 : 16.5, true, i % 40 === 0 ? 2 : 10]));
  assert.equal(fromStart[0]?.v.action, "step", JSON.stringify(fromStart));
  // Without the split (0 = unknown, the guard before): processor-late → no verdict at all.
  assert.equal(run([...calm, ...gpuBound].map(([dt, cpu, play]) => [dt, cpu, play, 0])).length, 0);
  // Really the processor's: the submission at its usual level, 14.5 ms of game JS.
  assert.equal(run([...calm, ...gpuBound.map(([dt, cpu, play]): [number, number, boolean, number] => [dt, cpu, play, 2])]).length, 0);
  // An odd near-empty frame (0.1 ms of submission) does not pass for the usual level.
  const odd = run([...calm, [P60, 4, true, 0.1], ...gpuBound.map(([dt, cpu, play]): [number, number, boolean, number] => [dt, cpu, play, 2])]);
  assert.equal(odd.length, 0, JSON.stringify(odd));
});

await test("Chrome's energy saver (frames capped at 30 on battery, mid-match): one step that changes nothing → judged useless, UNDONE, guard off, NOT stored", async () => {
  const m = { ...irisXeField(), gpuName: INTEL };
  const run = session(m, G.presetValues("bas", { dpr: 1.25 }));
  await run.ctl.runDetection("first");
  const stored = { ...run.store.get().graphics.auto.GIVRE.values };
  const r = run.sim.match({ load: fights(9, 1.1), cap: { hz: 30, from: 60 } }, 300, 9);
  assert.equal(r.steps.length, 1, fmtMatch(r));
  assert.equal(run.ctl.guardPhase, null); // off for the session
  // On screen: the useless step undone (the stored values again); stored: untouched.
  assert.equal(G.sameValues(run.ctl.effective(), stored), true);
  assert.equal(G.sameValues(run.store.get().graphics.auto.GIVRE.values, stored), true);
  assert.equal(run.store.get().graphics.auto.GIVRE.guardSteps, 0);
  // Next session: the stored values.
  const next = session(m, G.presetValues("bas", { dpr: 1.25 }), run.store);
  assert.equal(G.sameValues(next.ctl.effective(), stored), true);
});

await test("hitchy but fast enough (kills every ~3 s, browser hitches every ~2 s): no step", async () => {
  const m = { ...irisXeField(), gpuName: INTEL };
  const run = session(m, G.presetValues("bas", { dpr: 1.25 }));
  await run.ctl.runDetection("first");
  const r = run.sim.match(
    {
      load: fights(10, 1.1),
      cpu: (s, random) => (random() < 1 / 180 ? 45 : 7),
      hitch: (s, random) => (random() < 1 / 120 ? 25 : 0),
    },
    300,
    10,
  );
  assert.equal(r.steps.length, 0, fmtMatch(r));
});

await test("explicit presets are never touched (Low, High, Custom), and ?diag=noguard turns the guard off", async () => {
  for (const preset of ["bas", "eleve", "custom"] as const) {
    const store = new S.SettingsStore(memoryStorage());
    const run = session(workLaptop(), G.presetValues("bas", { dpr: 1.25 }), store);
    await run.ctl.runDetection("first"); // a detection exists for the map…
    const chosen = preset === "custom" ? { ...G.presetValues("bas", { dpr: 1.25 }), renderScale: 100, anisotropy: 4 as const } : null;
    store.update((d) => {
      d.graphics.preset = preset;
      if (chosen) d.graphics.custom = chosen;
    });
    const v = run.ctl.effective();
    const r = run.sim.match(workScene(11), 300, 11);
    assert.equal(r.steps.length, 0, `${preset}: ${fmtMatch(r)}`); // …but the player picked something else
    assert.equal(G.sameValues(run.ctl.effective(), v), true);
  }
  const off = session(workLaptop(), G.presetValues("bas", { dpr: 1.25 }), undefined, { experiments: new Set(["noguard"]) });
  await off.ctl.runDetection("first");
  assert.equal(off.sim.match(workScene(1), 300).steps.length, 0);
});

await test("no oscillation: over five matches the stored rung only goes down, then stays; a new detection starts from scratch", async () => {
  const store = new S.SettingsStore(memoryStorage());
  const boot = G.presetValues("bas", { dpr: 1.25 });
  // A detection made with no margin at all (?diag=tunemargin0): too heavy for matches on purpose.
  const first = session(workLaptop(), boot, store, { experiments: new Set(["tunemargin0"]) });
  await first.ctl.runDetection("first");
  const scales = [first.ctl.effective().renderScale];
  let steps = 0;
  for (let k = 0; k < 5; k++) {
    const run = k === 0 ? first : session(workLaptop(), boot, store);
    const r = run.sim.match({ load: fights(20 + k, 1.25), throttle: throttling(1.32, k === 0 ? 60 : 0, k === 0 ? 180 : 30) }, 300, 20 + k);
    steps += r.steps.length;
    scales.push(store.get().graphics.auto.GIVRE.values.renderScale);
  }
  for (let i = 1; i < scales.length; i++) assert.ok(scales[i] <= scales[i - 1], `${scales}`);
  assert.ok(steps >= 2, `${steps} steps: ${scales}`);
  assert.equal(scales.at(-1), scales.at(-2)); // settled
  const kept = store.get().graphics.auto.GIVRE.guardSteps ?? 0;
  assert.ok(kept >= 1 && kept <= steps, `${kept} kept of ${steps}`);
  console.log(`      stored resolution after each match: ${scales.join(" → ")} % (${steps} steps, ${kept} kept)`);
  // "Run again": a fresh answer (the default rule: 90 %), no guard steps.
  const again = session(workLaptop(), boot, store);
  await again.ctl.runDetection("manual");
  assert.equal(store.get().graphics.auto.GIVRE.guardSteps, 0);
  assert.equal(again.ctl.effective().renderScale, 90);
});

await test("an edit on the settings page while a step is being judged starts from the values on screen (no jump back up)", async () => {
  // A detection with no margin (too heavy for fights on purpose), a match until the first step is on screen.
  const run = session(workLaptop(), G.presetValues("bas", { dpr: 1.25 }), undefined, { experiments: new Set(["tunemargin0"]) });
  await run.ctl.runDetection("first");
  run.sim.match(workScene(1), 300, 1, () => run.sim.notices.length > 0);
  assert.equal(run.sim.notices.length, 1);
  const onScreen = run.ctl.effective();
  const stored = run.store.get().graphics.auto.GIVRE.values;
  assert.ok(onScreen.renderScale < stored.renderScale || !G.sameValues(onScreen, stored)); // not judged (stored) yet
  const edited = G.editChoice(run.store.get().graphics, "snow", "off", { dpr: 1.25 }, run.ctl.gpu, "GIVRE", onScreen);
  assert.equal(edited.preset, "custom");
  assert.equal(edited.custom!.renderScale, onScreen.renderScale);
  assert.equal(edited.custom!.anisotropy, onScreen.anisotropy);
});

/** A quiet (AFK-like) match: the spawn views, no fight. */
const afk = (hudMs: number): Scene => ({ load: () => 0.8, hudMs });
const HOUR = 3600_000;

/** The personal laptop with an "Auto" answer at 100 % (FXAA, 4×, normal snow), as the real one had at some point. */
async function at100(now: () => number, store = new S.SettingsStore(memoryStorage()), power?: import("../src/settings/Power.ts").PowerSource) {
  const m = { ...irisXeField(), gpuName: INTEL };
  const run = session(m, G.presetValues("bas", { dpr: 1.25 }), store, { experiments: new Set(["tunemargin0"]), now, power });
  await run.ctl.runDetection("first");
  return { m, run };
}

await test("the HUD's own drawing (hidden while the detection measures): WebGL fits, frames are late anyway → 100 % → 90 %, kept — as on the real laptop (100 %: 45-48 FPS, 90 %: 60)", async () => {
  let clock = Date.parse("2026-10-21T12:00:00Z");
  const now = () => clock;
  const { run } = await at100(now);
  const top = run.ctl.effective();
  assert.equal(top.renderScale, 100);
  // The WebGL frame alone fits (12 ms of 16.7); the HUD adds 6 ms of GPU-process work in matches only.
  const r = run.sim.match(afk(6), 300, 31);
  assert.equal(r.steps.length, 1, fmtMatch(r));
  assert.match(run.sim.notices.at(-1)!.text, /resolution 100% → 90%/);
  const stored = run.store.get().graphics.auto.GIVRE;
  assert.equal(stored.values.renderScale, 90);
  assert.equal(stored.guardSteps, 1);
  assert.ok(G.sameValues(stored.detected!, top)); // the detection's answer, to climb back to
  assert.equal(stored.guardRetryAt, clock + 20 * HOUR); // tried again from the next day on
  assert.ok(r.steps[0] < 25, `${r.steps[0]} s`);
  console.log(`      ${fmtMatch(r)}`);
});

await test("step back up: a LATER session tries one rung up (the HUD fixed meanwhile) — kept after a whole match at 60; never inside a session", async () => {
  let clock = Date.parse("2026-10-21T12:00:00Z");
  const now = () => clock;
  const { m, run } = await at100(now);
  run.sim.match(afk(6), 300, 31);
  const store = run.store;
  assert.equal(store.get().graphics.auto.GIVRE.values.renderScale, 90);
  // Same session: never back up, even when the frames are fine again.
  run.sim.match(afk(0), 300, 32);
  assert.equal(run.ctl.effective().renderScale, 90);
  // Next session too early (2 h later): no try.
  clock += 2 * HOUR;
  const early = session(m, G.presetValues("bas", { dpr: 1.25 }), store, { now });
  assert.equal(early.ctl.effective().renderScale, 90);
  assert.equal(early.ctl.guardTrying, false);
  // The next day, the HUD fixed (1 ms): the session starts one rung up, and keeps it after a whole match.
  clock += 20 * HOUR;
  const next = session(m, G.presetValues("bas", { dpr: 1.25 }), store, { now });
  assert.equal(next.ctl.guardTrying, true);
  assert.equal(next.ctl.effective().renderScale, 100);
  const r = next.sim.match(afk(1), 300, 33);
  assert.equal(r.steps.length, 0, fmtMatch(r));
  const kept = store.get().graphics.auto.GIVRE;
  assert.equal(kept.values.renderScale, 100);
  assert.equal(kept.guardSteps, 0);
  assert.equal(kept.guardRetryAt, null); // back to the detection's answer: nothing left to try
  assert.match(kept.summary, /^A whole match held 60 FPS again, so Auto raised the graphics one step \(back to the detected settings\): 100% resolution/);
  assert.equal(next.ctl.guardTrying, false);
  // Switching to Auto in the middle of a session never starts a try.
  store.update((d) => {
    d.graphics.auto.GIVRE = { ...d.graphics.auto.GIVRE, values: { ...d.graphics.auto.GIVRE.values, renderScale: 90, anisotropy: 1, snow: "legere" }, guardSteps: 1, guardRetryAt: clock - 1 };
    d.graphics.preset = "bas";
  });
  store.update((d) => void (d.graphics.preset = "auto"));
  assert.equal(next.ctl.guardTrying, false);
  assert.equal(next.ctl.effective().renderScale, 90);
});

await test("step back up that does not hold (the HUD still heavy): stepped down again, stored as before, the next try waits twice as long", async () => {
  let clock = Date.parse("2026-10-21T12:00:00Z");
  const now = () => clock;
  const { m, run } = await at100(now);
  run.sim.match(afk(6), 300, 31);
  const store = run.store;
  clock += 21 * HOUR;
  const s2 = session(m, G.presetValues("bas", { dpr: 1.25 }), store, { now });
  assert.equal(s2.ctl.effective().renderScale, 100); // the try
  const r = s2.sim.match(afk(6), 300, 34);
  assert.equal(r.steps.length, 1, fmtMatch(r));
  assert.match(s2.sim.notices.at(-1)!.text, /resolution 100% → 90%/);
  const after = store.get().graphics.auto.GIVRE;
  assert.equal(after.values.renderScale, 90);
  assert.equal(after.guardSteps, 1);
  assert.equal(after.guardUpFails, 1);
  assert.equal(after.guardRetryAt, clock + 40 * HOUR);
  // 21 h later: still waiting (40 h); 41 h later: one more try.
  clock += 21 * HOUR;
  assert.equal(session(m, G.presetValues("bas", { dpr: 1.25 }), store, { now }).ctl.guardTrying, false);
  clock += 20 * HOUR;
  assert.equal(session(m, G.presetValues("bas", { dpr: 1.25 }), store, { now }).ctl.guardTrying, true);
});

// ------------------------------------------------------------------ power-aware guard

console.log("power-aware guard (settings/Power: battery or charger)");

/**
 * The work laptop PLUGGED IN (the owner: "on battery it drops, plugged in it is stable"; measured: the
 * main thread 2.5 ms per frame instead of 7, the GPU ~20 % faster): fights, no sustained throttling.
 */
const mainsScene = (seed: number): Scene => ({ load: fights(seed, 1.25), cpu: () => 2.5 });

await test("power: the Battery Status API feature-detected, never waited for — unknown without it, on a refusal, on a throw", async () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  for (const nav of [undefined, null, {}, { getBattery: 5 }]) assert.equal(P.browserPower(nav).state, "unknown");
  const throwing = P.browserPower({
    getBattery: () => {
      throw new Error("no");
    },
  });
  const refused = P.browserPower({ getBattery: () => Promise.reject(new Error("denied")) });
  const odd = P.browserPower({ getBattery: () => Promise.resolve({}) });
  await tick();
  for (const src of [throwing, refused, odd]) assert.equal(src.state, "unknown");
  // A laptop: "unknown" until the API answers (no wait), then its state and each chargingchange.
  const listeners: (() => void)[] = [];
  const battery = { charging: false, addEventListener: (type: string, l: () => void) => void (type === "chargingchange" && listeners.push(l)) };
  const src = P.browserPower({ getBattery: () => Promise.resolve(battery) });
  const seen: string[] = [];
  src.subscribe((s) => seen.push(s));
  assert.equal(src.state, "unknown");
  await tick();
  assert.equal(src.state, "battery");
  battery.charging = true;
  for (const l of listeners) l();
  assert.equal(src.state, "mains");
  assert.deepEqual(seen, ["battery", "mains"]);
  // A desktop (no battery: charging true): mains.
  const desktop = P.browserPower({ getBattery: () => Promise.resolve({ charging: true, addEventListener() {} }) });
  await tick();
  assert.equal(desktop.state, "mains");
});

await test("power: the record keeps one power state per kept step (most recent last), trimmed and checked when read back", () => {
  const r = (steps: number, power?: PowerState[], at = 1) => ({ guardSteps: steps, guardPower: power, guardRetryAt: at, detected: G.presetValues("bas", { dpr: 1 }) });
  assert.equal(GD.topStepPower(r(2, ["mains", "battery"])), "battery");
  assert.equal(GD.topStepPower(r(2, [])), "unknown"); // kept before power awareness
  assert.equal(GD.topStepPower(r(0, ["battery"])), "unknown");
  // Due: at once plugged in after a battery step; otherwise the schedule.
  assert.equal(GD.retryReason(r(1, ["battery"], 1e15), "mains", 0), "power");
  assert.equal(GD.retryReason(r(1, ["battery"], 1e15), "battery", 0), null);
  assert.equal(GD.retryReason(r(1, ["battery"], 1e15), "unknown", 0), null);
  assert.equal(GD.retryReason(r(1, ["mains"], 1e15), "mains", 0), null);
  assert.equal(GD.retryReason(r(1, ["mains"], 10), "mains", 10), "scheduled");
  assert.equal(GD.retryReason({ ...r(1, ["battery"]), detected: null }, "mains", 0), null);
  assert.deepEqual(GD.pushStepPower(["battery"], "mains", 2), ["battery", "mains"]);
  assert.deepEqual(GD.pushStepPower(undefined, "battery", 3), ["battery"]);
  assert.deepEqual(GD.pushStepPower(["unknown", "battery"], "mains", 2), ["battery", "mains"]);
  assert.deepEqual(GD.popStepPower(["mains", "battery"], 1), ["mains"]);
  assert.deepEqual(GD.popStepPower([], 2), []);
  assert.deepEqual(GD.popStepPower(["battery"], 0), []);
  assert.deepEqual(GD.relabelTopPower(["battery", "battery"], "mains"), ["battery", "mains"]);
  const stored = (guardSteps: number, guardPower: unknown) =>
    S.sanitizeRecord({ v: 1, graphics: { preset: "auto", custom: null, auto: { GIVRE: { values: { renderScale: 90 }, gpu: "A", guardSteps, guardPower } } } }).graphics.auto.GIVRE
      .guardPower;
  assert.deepEqual(stored(2, ["battery", "nope", 3, "mains", "unknown"]), ["mains", "unknown"]);
  assert.deepEqual(stored(0, ["battery"]), []);
  assert.deepEqual(stored(1, "battery"), []);
});

await test("power: steps taken ON BATTERY are tried again at once in the next session PLUGGED IN (no 20 h wait), one rung per match, each kept after a whole match at 60", async () => {
  let clock = Date.parse("2026-10-21T12:00:00Z");
  const now = () => clock;
  const boot = G.presetValues("bas", { dpr: 1.25 });
  const s1 = session(workLaptop(), boot, undefined, { power: fakePower("battery"), now });
  await s1.ctl.runDetection("first");
  const m1 = s1.sim.match(workScene(1), 300);
  const r1 = s1.store.get().graphics.auto.GIVRE;
  console.log(`      on battery: 90 % → ${fmtMatch(m1)} — stored ${r1.values.renderScale} %, steps ${JSON.stringify(r1.guardPower)}`);
  const n = r1.guardSteps ?? 0;
  assert.ok(n >= 1, fmtMatch(m1));
  assert.deepEqual(r1.guardPower, new Array(n).fill("battery"));
  // 2 h later, plugged in: one rung up at once — the normal wait (20 h) does not apply.
  clock += 2 * HOUR;
  const s2 = session(workLaptop(), boot, s1.store, { power: fakePower("mains"), now });
  const scales = [r1.values.renderScale];
  for (let k = 0; k < n; k++) {
    if (k > 0) s2.sim.menu(); // between two matches (end screen, menu): the next battery step
    assert.equal(s2.ctl.guardTrying, true, `try ${k + 1}`);
    const m = s2.sim.match(mainsScene(40 + k), 300, 40 + k);
    assert.equal(m.steps.length, 0, `plugged in, try ${k + 1}: ${fmtMatch(m)}`);
    // Kept after a whole match — mid-match, never another rung there.
    assert.equal(s2.ctl.guardTrying, false);
    scales.push(s2.store.get().graphics.auto.GIVRE.values.renderScale);
    assert.ok(scales.at(-1)! > scales.at(-2)!, `${scales}`);
  }
  console.log(`      plugged in (next session, 2 h later): stored ${scales.join(" → ")} %`);
  const back = s2.store.get().graphics.auto.GIVRE;
  assert.equal(G.sameValues(back.values, back.detected!), true); // back to the detection's answer, never above
  assert.equal(back.guardSteps, 0);
  assert.deepEqual(back.guardPower, []);
  assert.equal(back.guardRetryAt, null);
  s2.sim.menu();
  assert.equal(s2.ctl.guardTrying, false); // nothing left to try
  assert.equal(s2.sim.applyInFrame, 0);
});

await test("power: a step taken PLUGGED IN keeps the normal wait (20 h, then doubled after a failed try)", async () => {
  let clock = Date.parse("2026-10-21T12:00:00Z");
  const now = () => clock;
  const boot = G.presetValues("bas", { dpr: 1.25 });
  const s1 = session(workLaptop(), boot, undefined, { power: fakePower("mains"), now });
  await s1.ctl.runDetection("first");
  s1.sim.match(workScene(1), 300); // a heavy, hot match — plugged in
  const store = s1.store;
  const r1 = store.get().graphics.auto.GIVRE;
  const n = r1.guardSteps ?? 0;
  assert.ok(n >= 1);
  assert.deepEqual(r1.guardPower, new Array(n).fill("mains"));
  clock += 2 * HOUR;
  const s2 = session(workLaptop(), boot, store, { power: fakePower("mains"), now });
  assert.equal(s2.ctl.guardTrying, false);
  assert.equal(s2.ctl.effective().renderScale, r1.values.renderScale);
  s2.sim.menu();
  assert.equal(s2.ctl.guardTrying, false);
  clock += 20 * HOUR;
  const s3 = session(workLaptop(), boot, store, { power: fakePower("mains"), now });
  assert.equal(s3.ctl.guardTrying, true); // the normal try, from the next day on
  // Still too heavy (the chip hot from the start): back down, the next try waits twice as long.
  const m3 = s3.sim.match({ load: fights(2, 1.25), throttle: throttling(1.32, 0, 30) }, 300, 2);
  assert.ok(m3.steps.length >= 1, fmtMatch(m3));
  const r3 = store.get().graphics.auto.GIVRE;
  assert.equal(r3.values.renderScale, r1.values.renderScale);
  assert.equal(r3.guardUpFails, 1);
  assert.equal(r3.guardRetryAt, clock + 40 * HOUR);
});

await test("power: without the Battery Status API (or ?diag=nopowerguard) — today's behaviour: every step waits the normal time", async () => {
  let clock = Date.parse("2026-10-21T12:00:00Z");
  const now = () => clock;
  const boot = G.presetValues("bas", { dpr: 1.25 });
  // No API: the steps are stored as "unknown", tried again after the normal wait only.
  const s1 = session(workLaptop(), boot, undefined, { power: P.browserPower({}), now });
  await s1.ctl.runDetection("first");
  s1.sim.match(workScene(1), 300);
  const r1 = s1.store.get().graphics.auto.GIVRE;
  const n = r1.guardSteps ?? 0;
  assert.ok(n >= 1);
  assert.deepEqual(r1.guardPower, new Array(n).fill("unknown"));
  clock += 2 * HOUR;
  assert.equal(session(workLaptop(), boot, s1.store, { power: P.browserPower({}), now }).ctl.guardTrying, false);
  // A step taken on battery, then ?diag=nopowerguard plugged in: the battery is never read — the normal wait too.
  const b = session(workLaptop(), boot, undefined, { power: fakePower("battery"), now });
  await b.ctl.runDetection("first");
  b.sim.match(workScene(1), 300);
  assert.equal(GD.topStepPower(b.store.get().graphics.auto.GIVRE), "battery");
  clock += 2 * HOUR;
  const off = session(workLaptop(), boot, b.store, { power: fakePower("mains"), now, experiments: new Set(["nopowerguard"]) });
  assert.equal(off.ctl.guardTrying, false);
  off.sim.menu();
  assert.equal(off.ctl.guardTrying, false);
  clock += 20 * HOUR;
  assert.equal(session(workLaptop(), boot, s1.store, { power: P.browserPower({}), now }).ctl.guardTrying, true);
});

await test("power: the charger plugged in MID-MATCH changes nothing before the match is over; at the end screen, one rung up", async () => {
  const boot = G.presetValues("bas", { dpr: 1.25 });
  const power = fakePower("battery");
  const run = session(workLaptop(), boot, undefined, { power });
  await run.ctl.runDetection("first");
  run.sim.match(workScene(1), 300); // on battery: stepped down, stored
  const low = run.ctl.effective().renderScale;
  assert.ok(low < 90);
  run.sim.match(workScene(5), 60, 5); // the next match, still on battery…
  power.set("mains"); // …the charger plugged in during it
  assert.equal(run.ctl.effective().renderScale, low);
  assert.equal(run.ctl.guardTrying, false);
  run.sim.match(mainsScene(6), 120, 6); // the rest of that match: untouched
  assert.equal(run.ctl.effective().renderScale, low);
  assert.equal(run.ctl.guardTrying, false);
  run.sim.menu(); // the end screen
  assert.equal(run.ctl.guardTrying, true);
  assert.ok(run.ctl.effective().renderScale > low, `${run.ctl.effective().renderScale}`);
  assert.equal(run.sim.applyInFrame, 0); // applied between two frames
  // Unplugged again before the next match: the try goes on (judged on what the match shows).
  power.set("battery");
  assert.equal(run.ctl.guardTrying, true);
});

await test("power: the API answers AFTER the session started (asynchronously, as in Chrome) — plugged in: the try starts in the menu, at once", async () => {
  let clock = Date.parse("2026-10-21T12:00:00Z");
  const now = () => clock;
  const boot = G.presetValues("bas", { dpr: 1.25 });
  const s1 = session(workLaptop(), boot, undefined, { power: fakePower("battery"), now });
  await s1.ctl.runDetection("first");
  s1.sim.match(workScene(1), 300);
  const low = s1.ctl.effective().renderScale;
  clock += 2 * HOUR;
  const power = fakePower("unknown");
  const s2 = session(workLaptop(), boot, s1.store, { power, now });
  assert.equal(s2.ctl.guardTrying, false); // not known yet: the normal wait
  power.set("mains"); // the API's first answer, the game in its menu
  s2.sim.menu();
  assert.equal(s2.ctl.guardTrying, true);
  assert.ok(s2.ctl.effective().renderScale > low);
  // A scheduled try already under way when the answer comes (the next day, the power not known at the
  // start) undoes a battery step: it counts as one — it fails on the charger: no doubled wait.
  const { m, run } = await at100(now, undefined, fakePower("battery"));
  run.sim.match(afk(6), 300, 31); // 100 → 90 % on battery
  clock += 21 * HOUR;
  const late = fakePower("unknown");
  const s3 = session(m, boot, run.store, { now, power: late });
  assert.equal(s3.ctl.guardTrying, true); // the normal try (the wait is over)
  late.set("mains");
  const r3 = s3.sim.match(afk(6), 300, 35); // the HUD as heavy on the charger: back down
  assert.equal(r3.steps.length, 1, fmtMatch(r3));
  const after = run.store.get().graphics.auto.GIVRE;
  assert.equal(after.values.renderScale, 90);
  assert.equal(after.guardUpFails, 0);
  assert.deepEqual(after.guardPower, ["mains"]);
  assert.equal(after.guardRetryAt, clock + 20 * HOUR);
});

await test("power: a battery step's try that fails ON THE CHARGER too — back down with no doubled wait; that step is a mains step from then on (the normal wait)", async () => {
  let clock = Date.parse("2026-10-21T12:00:00Z");
  const now = () => clock;
  // The HUD's own drawing (6 ms a frame the 3D does not reduce): 100 % → 90 %, on battery.
  const { m, run } = await at100(now, undefined, fakePower("battery"));
  run.sim.match(afk(6), 300, 31);
  const store = run.store;
  assert.equal(store.get().graphics.auto.GIVRE.values.renderScale, 90);
  assert.deepEqual(store.get().graphics.auto.GIVRE.guardPower, ["battery"]);
  // 2 h later plugged in: 100 % at once — the HUD is just as heavy on the charger: stepped down again.
  clock += 2 * HOUR;
  const boot = G.presetValues("bas", { dpr: 1.25 });
  const s2 = session(m, boot, store, { now, power: fakePower("mains") });
  assert.equal(s2.ctl.guardTrying, true);
  assert.equal(s2.ctl.effective().renderScale, 100);
  const r2 = s2.sim.match(afk(6), 300, 34);
  assert.equal(r2.steps.length, 1, fmtMatch(r2));
  const after = store.get().graphics.auto.GIVRE;
  assert.equal(after.values.renderScale, 90);
  assert.equal(after.guardSteps, 1);
  assert.equal(after.guardUpFails, 0); // no penalty
  assert.deepEqual(after.guardPower, ["mains"]); // needed on the charger too
  assert.equal(after.guardRetryAt, clock + 20 * HOUR); // the normal wait, not doubled
  // From now on the normal rules: no try 2 h later (plugged in), one the next day.
  clock += 2 * HOUR;
  assert.equal(session(m, boot, store, { now, power: fakePower("mains") }).ctl.guardTrying, false);
  clock += 19 * HOUR;
  assert.equal(session(m, boot, store, { now, power: fakePower("mains") }).ctl.guardTrying, true);
});

// ------------------------------------------------------------------ what the detection picks

console.log("what the detection picks: the rule (+30 % on every GPU) vs the A/B ?diag=tunemargin50 (+50 %):");

await test("summary table: each simulated machine, the detection's rule vs the +50 % A/B", () => {
  const rows: [string, Machine, Values, boolean][] = [
    ["Iris Xe, field-calibrated (personal laptop, 125 %)", irisXeField(), G.presetValues("bas", { dpr: 1.25 }), true],
    ["Iris Xe, work laptop 1874 × 956 at 125 %", workLaptop(), G.presetValues("bas", { dpr: 1.25 }), true],
    ["Iris Xe, work laptop 1874 × 956 at 100 %", { ...workLaptop(), dpr: 1 }, G.presetValues("bas", { dpr: 1 }), true],
    ["Iris Xe, optimistic model (older test)", irisXe("static"), G.presetValues("bas", { dpr: 1.25 }), true],
    ["Iris Xe booted High (live shadows)", irisXe("dynamic"), G.presetValues("eleve", { dpr: 1.25 }), true],
    ["UHD 620 (GPU-bound at the floor)", uhd620(), G.presetValues("bas", { dpr: 1 }), true],
    ["GTX 1050, 60 Hz", gtx1050(), G.presetValues("eleve", { dpr: 1 }), false],
    ["GTX 1660, 144 Hz", midGpu(), G.presetValues("eleve", { dpr: 1 }), false],
    ["RTX 2080 Super, 240 Hz", rtx2080(), G.presetValues("eleve", { dpr: 1 }), false],
  ];
  for (const [name, m, boot, integrated] of rows) {
    const look = integrated ? G.presetValues("bas", { dpr: m.dpr }) : boot;
    const rule = calibrate(m, boot, { look, cfg: A.tuneConfigFor({ integrated }) }).outcome!;
    const ab = calibrate(m, boot, { look, cfg: A.tuneConfigFor({ integrated }, 50) }).outcome!;
    const share = (v: Values) => `${Math.round(gpuShare(m, v, Math.min(60, m.hz)) * 100)} %`;
    console.log(
      `      ${name}:\n        rule: ${fmtValues(rule.values)} (${rule.mode}, menu GPU ${share(rule.values)} of a 60 FPS frame)\n        tunemargin50: ${fmtValues(ab.values)} (${ab.mode}, ${share(ab.values)})`,
    );
    // The rule is the generic one on every GPU (the same answer as AUTO_TUNE's); the A/B is never costlier.
    assert.equal(G.sameValues(rule.values, calibrate(m, boot, { look }).outcome!.values), true);
    assert.ok(A.noCostlier(ab.values, rule.values));
  }
});

console.log(`\nAll ${passed} detection checks passed.`);
