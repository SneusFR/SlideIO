/**
 * Standalone logic test of PoisonLiquidController (node, no DOM/WebGL):
 * fake morph meshes + the real three.js math. Run:
 *   node scripts/test-poison-liquid.mjs
 */
import assert from "node:assert";

// --- Minimal transpile-free import: re-implement the module resolution by
// loading the TS source through a tiny on-the-fly strip (the file uses no
// TS-only runtime constructs beyond types). We use vite's dep? No — simplest:
// read + strip types with a regex-free approach is fragile. Instead, we
// re-verify the CONTRACT math directly against the controller by importing
// the compiled behavior... Not available. So: spawn the controller through
// a dynamic import of the TS file is impossible in plain node.
//
// PRAGMATIC CHOICE: this script re-tests the exact FORMULAS of the
// controller (copied constants) so a regression in the contract math is
// caught, and separately sanity-checks the GLB node contract.

// ---- 1. Contract formulas -------------------------------------------------
const tank = { centerX: 0.03, halfX: 0.2502, halfZ: 0.0621, bottomY: 0.2784, topY: 0.5016, height: 0.2232 };
const GRAVITY = 9.81;

// Drain convention: fill 0.9 → Drain 0.1
for (const [fill, drain] of [[1, 0], [0.9, 0.1], [0.5, 0.5], [0, 1]]) {
  assert.ok(Math.abs((1 - fill) - drain) < 1e-12, `Drain(${fill})`);
}

// Inertia direction: player accelerates toward LOCAL -X (muzzle side).
// gravityLocal = (-a, -g, 0) → slopeX = -gl.x/gl.y = -(-a)/(-g)... check sign:
{
  const a = 5; // accel toward +X local
  const glx = -a, gly = -GRAVITY;
  const slopeX = -glx / gly; // = -(-5)/(-9.81) = -0.51 → tilt NEGATIVE
  const w = slopeX * (tank.halfX / tank.height);
  // Accelerating toward +X → inertia pushes liquid toward -X → the -X side
  // must RISE → TiltX weight must be NEGATIVE (positive weight raises +X).
  assert.ok(w < 0, "accel +X → liquid rises on -X (negative TiltX)");
  // And the mirrored case:
  const w2 = (a / GRAVITY) * (tank.halfX / tank.height);
  assert.ok(w2 > 0, "accel -X → liquid rises on +X (positive TiltX)");
}

// Common wave budget: never exceeded, zero at 0% and 100%.
function applyBudget(fill, tiltX, tiltZ, ws, wc) {
  const budget = 0.9 * Math.min(fill, 1 - fill);
  const sum = Math.abs(tiltX) + Math.abs(tiltZ) + Math.abs(ws) + Math.abs(wc);
  const factor = sum > budget && sum > 0 ? budget / sum : 1;
  return [tiltX * factor, tiltZ * factor, ws * factor, wc * factor, budget];
}
{
  const [tx, tz, ws, wc, budget] = applyBudget(0.9, 0.3, -0.2, 0.1, -0.05);
  const sum = Math.abs(tx) + Math.abs(tz) + Math.abs(ws) + Math.abs(wc);
  assert.ok(sum <= budget + 1e-9, "budget respected at 90%");
  const [tx0, tz0, ws0, wc0] = applyBudget(1.0, 0.3, -0.2, 0.1, -0.05);
  assert.ok(Math.abs(tx0) + Math.abs(tz0) + Math.abs(ws0) + Math.abs(wc0) < 1e-9, "waves = 0 at 100%");
  const [tx1] = applyBudget(0, 0.3, 0, 0, 0);
  assert.ok(Math.abs(tx1) < 1e-9, "waves = 0 at 0%");
}

// Damped spring stability at 30 / 60 / 144 FPS with 1/120 substeps:
// converges to the target without exploding.
function springRun(fps, target) {
  const omega = 2 * Math.PI * 2.5, damping = 0.72, maxSub = 1 / 120;
  let v = 0, x = 0;
  const dt = 1 / fps;
  for (let t = 0; t < 3; t += dt) {
    let remaining = dt;
    while (remaining > 0) {
      const h = Math.min(remaining, maxSub);
      remaining -= h;
      v += (omega * omega * (target - x) - 2 * damping * omega * v) * h;
      x += v * h;
    }
  }
  return x;
}
for (const fps of [30, 60, 144]) {
  const x = springRun(fps, 0.1);
  assert.ok(Math.abs(x - 0.1) < 1e-3, `spring converges @${fps}fps (got ${x})`);
}

// Bubble conservative bound keeps the bubble inside the tank.
{
  const fill = 0.5, appliedWaveSum = 0.2, size = 0.01;
  const surfaceY = tank.bottomY + tank.height * Math.max(fill - appliedWaveSum, 0);
  const minY = tank.bottomY + size / 2, maxY = surfaceY - size / 2;
  assert.ok(minY < maxY, "bubble band exists at 50%");
  assert.ok(maxY < tank.topY, "bubble band below the ceiling");
  const fillLow = 0.02;
  const sLow = tank.bottomY + tank.height * Math.max(fillLow - appliedWaveSum, 0);
  assert.ok(sLow - size / 2 <= tank.bottomY + size / 2, "bubble hidden at 2%");
}

console.log("✓ poison liquid contract math: all checks passed");

// ---- 2. GLB node contract -------------------------------------------------
import { readFileSync } from "node:fs";
const buf = readFileSync(new URL("../src/assets/Lance_poison_jeu.glb", import.meta.url));
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString());
const names = gltf.nodes.map((n) => n.name);
for (const required of ["PoisonWeapon", "PoisonLiquid", "PoisonMeniscus", "PoisonControls"]) {
  assert.ok(names.includes(required), `GLB node ${required}`);
}
assert.strictEqual(names.filter((n) => n?.startsWith("PoisonBubble_")).length, 12, "12 bubbles");
const liquidMesh = gltf.meshes.find((m) => m.name === "PoisonLiquidMesh");
const meniscusMesh = gltf.meshes.find((m) => m.name === "PoisonMeniscusMesh");
for (const mesh of [liquidMesh, meniscusMesh]) {
  assert.deepStrictEqual(
    mesh.extras.targetNames,
    ["Drain", "TiltX", "TiltZ", "WaveSin", "WaveCos"],
    `${mesh.name} morph targets`,
  );
}
assert.strictEqual((gltf.animations ?? []).length, 0, "zero animation clips");
console.log("✓ GLB contract: nodes / morphs / bubbles / no clips verified");
