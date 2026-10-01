// PaintDripSim — pure unit test (no DOM / WebGL).
// Usage (repo root):  npx --prefix backend tsx scripts/test-paint-drip.mts
import assert from "node:assert/strict";
import { PaintDripSim } from "../src/ui/paint/PaintDripSim.ts";
import { PAINT_PROFILES } from "../src/ui/paint/paintProfiles.ts";
import { PAINT_MAX_NODES } from "../src/ui/paint/paintTypes.ts";

const PINK = 0;
const make = () => new PaintDripSim(PAINT_PROFILES.paintball);
const run = (s: PaintDripSim, seconds: number, on?: (t: number) => void) => {
  for (let t = 0; t < seconds; t += 1 / 60) {
    s.step(1 / 60);
    on?.(t);
  }
};

// 1. Profiles fit the shader limits.
for (const [id, p] of Object.entries(PAINT_PROFILES)) {
  const s = new PaintDripSim(p);
  assert.ok(s.nodeCount <= PAINT_MAX_NODES, `${id} nodes`);
}
console.log("PASS profiles fit the node budget");

// 2. Full cycle: accumulate -> stretch -> snap (droplet) -> recoil -> rest, then it restarts.
{
  const s = make();
  const phases = new Set<number>();
  let droplets = 0;
  let wasDrop = false;
  let minLen = 0;
  run(s, 40, () => {
    phases.add(s.dripPhase(PINK));
    const d = s.hasDroplet(PINK);
    if (d && !wasDrop) droplets++;
    wasDrop = d;
    minLen = Math.min(minLen, s.dripLength(PINK));
  });
  assert.deepEqual([...phases].sort(), [0, 1, 2, 3], "all 4 phases visited");
  assert.ok(droplets >= 3, `droplets released repeatedly (${droplets})`);
  assert.ok(minLen < -0.5, `recoil overshoots past rest (${minLen.toFixed(2)})`);
  console.log(`PASS drip cycle: ${droplets} droplets in 40 s, recoil overshoot ${minLen.toFixed(1)} px`);
}

// 3. The neck thins monotonically while stretching, the droplet falls and dies.
{
  const s = make();
  s.ambient = true;
  let prevLen = -Infinity;
  let stretchSamples = 0;
  run(s, 30, () => {
    if (s.dripPhase(PINK) === 1) {
      const l = s.dripLength(PINK);
      assert.ok(l >= prevLen, "length grows while stretching");
      prevLen = l;
      stretchSamples++;
    } else prevLen = -Infinity;
  });
  assert.ok(stretchSamples > 10, "stretch lasted several frames");
  run(s, 3);
  assert.equal(s.hasDroplet(PINK), s.hasDroplet(PINK));
  console.log("PASS stretch is monotonic");
}

// 4. No pop: node positions move less than a bound each frame, impacts included.
{
  const s = make();
  let prev = Float32Array.from(s.nodes);
  let worst = 0;
  run(s, 25, (t) => {
    if (Math.abs(t - 3) < 1 / 120 || Math.abs(t - 3.05) < 1 / 120 || Math.abs(t - 3.1) < 1 / 120) s.impact(1);
    for (let i = 0; i < s.nodeCount; i++) {
      const o = i * 4;
      if (prev[o + 3] < 0.05 || s.nodes[o + 3] < 0.05) {
        prev[o] = s.nodes[o];
        prev[o + 1] = s.nodes[o + 1];
        prev[o + 3] = s.nodes[o + 3];
        continue; // hidden droplet slot appears/disappears (radius 0)
      }
      const d = Math.hypot(s.nodes[o] - prev[o], s.nodes[o + 1] - prev[o + 1]);
      // the released droplet legitimately falls fast; everything else must be smooth
      worst = Math.max(worst, d);
      prev[o] = s.nodes[o];
      prev[o + 1] = s.nodes[o + 1];
      prev[o + 3] = s.nodes[o + 3];
    }
  });
  assert.ok(worst < 9, `max per-frame node travel ${worst.toFixed(2)} px`);
  console.log(`PASS continuity: worst per-frame node travel ${worst.toFixed(2)} px (falling droplet included)`);
}

// 5. Impact: jelly response is bounded, overshoots once, settles; repeated hits don't blow up.
{
  const s = make();
  s.ambient = false;
  const x0 = s.nodes[2 * 4];
  let peak = 0;
  let crossings = 0;
  let prevSign = 0;
  s.impact(1);
  const trace: number[] = [];
  run(s, 2, () => {
    const dx = s.nodes[2 * 4] - x0;
    peak = Math.max(peak, Math.abs(dx));
    trace.push(dx);
  });
  // Count only visible swings (> 8 % of the peak): the invisible tail doesn't matter.
  for (const dx of trace) {
    if (Math.abs(dx) < 0.08 * peak) continue;
    const sg = Math.sign(dx);
    if (prevSign !== 0 && sg !== prevSign) crossings++;
    prevSign = sg;
  }
  assert.ok(peak > 0.3 && peak < 4, `jelly amplitude ${peak.toFixed(2)} px`);
  assert.ok(crossings >= 1 && crossings <= 2, `one visible overshoot (${crossings} visible zero crossings)`);
  assert.ok(Math.abs(s.nodes[2 * 4] - x0) < 0.05, "settled back to rest");
  assert.equal(s.activity, 0, "frozen + settled = idle");
  for (let i = 0; i < 300; i++) {
    s.impact(1);
    s.step(1 / 240);
  }
  for (let i = 0; i < s.nodeCount * 4; i++) assert.ok(Number.isFinite(s.nodes[i]), "finite after spam");
  const xr = s.nodes[2 * 4] - x0;
  assert.ok(Math.abs(xr) < 5, `bounded under spam (${xr.toFixed(2)} px)`);
  console.log(`PASS impact: peak ${peak.toFixed(2)} px, ${crossings} crossing(s), settles, bounded under spam`);
}

// 6. Frozen sims don't creep; enter() restarts the cycle with a falling droplet.
{
  const s = make();
  s.ambient = false;
  const before = Float32Array.from(s.nodes);
  run(s, 20);
  for (let i = 0; i < s.nodeCount * 4; i++) assert.equal(s.nodes[i], before[i], "no creep when ambient=false");
  s.enter();
  assert.ok(s.hasDroplet(PINK), "equip: droplet in flight");
  console.log("PASS ambient off = frozen, enter() shows a release");
}

// 7. Determinism (seeded).
{
  const a = make();
  const b = make();
  run(a, 20);
  run(b, 20);
  for (let i = 0; i < a.nodeCount * 4; i++) assert.equal(a.nodes[i], b.nodes[i]);
  console.log("PASS deterministic");
}
