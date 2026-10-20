// DYNAMIC RESOLUTION — headless checks of src/settings/DynamicResolution: it holds the target by
// moving the render scale between the beauty floor and the player's scale, fast down / slow up, with
// hysteresis (no ping-pong at the boundary), with or without GPU timer queries, within its bounds.
// Simulated GPU: cost ∝ scale², ±noise, vsync-paced frames.
// Usage (repo root):  SLIDEIO_ROOT=$PWD node --import <vitenode>/register.mjs scripts/test-dynamic-resolution.mts
import assert from "node:assert/strict";

const { DynamicResolutionController, DYNAMIC_RESOLUTION } = await import("../src/settings/DynamicResolution.ts");

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Plays `seconds` of frames: GPU ms = costAt100 × (scale/100)² (± noise), frame
 * interval = max(GPU, refresh). `cost` may change over time (a heavy fight).
 */
function play(
  ctl: InstanceType<typeof DynamicResolutionController>,
  opts: { seconds: number; cost: (t: number) => number; refreshHz?: number; timer?: boolean; noise?: number; seed?: number },
) {
  const r = rng(opts.seed ?? 3);
  const refresh = 1000 / (opts.refreshHz ?? 60);
  let t = 0;
  const changes: { t: number; scale: number }[] = [];
  const gpuQueue: { due: number; ms: number }[] = [];
  while (t < opts.seconds * 1000) {
    const s = ctl.scale / 100;
    const gpu = opts.cost(t) * s * s * (1 + (r() * 2 - 1) * (opts.noise ?? 0.05));
    // vsync: a GPU over the interval takes the next refresh (2×, 3×…)
    const frame = Math.ceil(gpu / refresh - 0.02) * refresh || refresh;
    t += frame;
    if (opts.timer !== false) gpuQueue.push({ due: t + 2 * refresh, ms: gpu });
    while (gpuQueue.length && gpuQueue[0].due <= t) ctl.gpu(t, gpuQueue.shift()!.ms);
    const next = ctl.frame(t, frame);
    if (next !== null) changes.push({ t, scale: next });
  }
  return { changes };
}

const BUDGET = 1000 / 60;

test("overloaded GPU (26 ms at 100 %): drops fast to a scale that holds 60, then stays (≤ 3 changes, settled within 3 s)", () => {
  const ctl = new DynamicResolutionController(80, 100, BUDGET);
  const { changes } = play(ctl, { seconds: 60, cost: () => 26 });
  assert.ok(changes.length >= 1 && changes.length <= 3, `${changes.length} changes`);
  assert.ok(changes.at(-1)!.t < 3000, `settled at ${changes.at(-1)!.t.toFixed(0)} ms`);
  assert.equal(ctl.scale, 80, "floor: 26 × 0.64 = 16.6 ms — the most it can do");
});

test("moderate overload (18 ms at 100 %): goes down just enough, never under the floor", () => {
  const ctl = new DynamicResolutionController(80, 100, BUDGET);
  play(ctl, { seconds: 60, cost: () => 18 });
  assert.ok(ctl.scale >= 80 && ctl.scale <= 90, `scale ${ctl.scale}`);
  assert.ok(18 * (ctl.scale / 100) ** 2 <= BUDGET * DYNAMIC_RESOLUTION.downAt, "holds the target afterwards");
});

test("light load: climbs back step by step up to the player's scale, never above it", () => {
  const ctl = new DynamicResolutionController(80, 95, BUDGET);
  // Heavy for 10 s (a fight), then light.
  const { changes } = play(ctl, { seconds: 60, cost: (t) => (t < 10000 ? 30 : 6) });
  assert.equal(ctl.scale, 95);
  assert.ok(changes.every((c) => c.scale <= 95 && c.scale >= 80));
  const ups = changes.filter((c, i) => i > 0 && c.scale > changes[i - 1].scale);
  for (let i = 1; i < ups.length; i++) assert.ok(ups[i].t - ups[i - 1].t >= DYNAMIC_RESOLUTION.upHoldMs, "one step per hold time");
});

test("at the boundary (next step up would just overflow): no ping-pong over two minutes", () => {
  // At 80 %: 21 × 0.64 = 13.4 ms (≤ 92 % of the budget: stays); 85 % would cost 15.2 ms (> 80 % predicted: no climb).
  const ctl = new DynamicResolutionController(80, 100, BUDGET);
  const { changes } = play(ctl, { seconds: 120, cost: () => 21, noise: 0.08 });
  assert.ok(changes.length <= 3, `${changes.length} changes: ${changes.map((c) => c.scale).join(" ")}`);
  const late = changes.filter((c) => c.t > 10000);
  assert.ok(late.length <= 1, `changes after 10 s: ${late.length}`);
});

test("without GPU timer (frames only): steps down on missed refreshes, retries up with growing waits — bounded changes", () => {
  const ctl = new DynamicResolutionController(80, 100, BUDGET);
  // 100 % costs 20 ms (misses 60), 95 % 18 ms (misses), 90 % 16.2 ms (holds).
  const { changes } = play(ctl, { seconds: 180, cost: () => 20, timer: false, noise: 0.02 });
  assert.ok(ctl.scale >= 85 && ctl.scale <= 95, `scale ${ctl.scale}`);
  assert.equal(changes[0].scale, 95, "one step at a time (vsync-quantized frames)");
  assert.ok(changes.length <= 12, `${changes.length} changes in 3 min`);
  // Retries get rarer (backoff): the gaps between up-steps grow.
  const ups = changes.filter((c, i) => i > 0 && c.scale > changes[i - 1].scale).map((c) => c.t);
  for (let i = 2; i < ups.length; i++) assert.ok(ups[i] - ups[i - 1] >= ups[i - 1] - ups[i - 2] - 50, "backoff never shrinks");
});

test("bounds: a new player scale / floor clamps the current scale; budget changes apply", () => {
  const ctl = new DynamicResolutionController(80, 100, BUDGET);
  assert.equal(ctl.setBounds(80, 90), 90);
  assert.equal(ctl.setBounds(85, 120), 90);
  assert.equal(ctl.setBounds(95, 120), 95);
  assert.equal(ctl.setBounds(50, 60), 60);
  ctl.setBudget(1000 / 144);
  // 60 % (its max now): 12 × 0.36 = 4.3 ms ≤ 92 % of 6.9 ms → holds, nothing to do.
  const { changes } = play(ctl, { seconds: 20, cost: () => 12, refreshHz: 144 });
  assert.equal(changes.length, 0);
  assert.equal(ctl.scale, 60);
  // A heavier scene at 144 Hz: down to the floor of the new bounds.
  play(ctl, { seconds: 10, cost: () => 30, refreshHz: 144 });
  assert.equal(ctl.scale, 50);
});

test("reset (back from the menus): no decision on stale frames", () => {
  const ctl = new DynamicResolutionController(80, 100, BUDGET);
  play(ctl, { seconds: 5, cost: () => 30 });
  const before = ctl.scale;
  ctl.reset(1e9);
  assert.equal(ctl.frame(1e9 + 10, 50), null);
  assert.equal(ctl.scale, before);
});

console.log(`\nAll ${passed} dynamic resolution checks passed.`);
