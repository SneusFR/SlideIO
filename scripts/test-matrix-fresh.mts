// MATRIX FRESH SKIPS (effects/matrixFresh.ts): a marked subtree root skips ONE non-forced
// updateMatrixWorld (the renderer's pass), a forced one always runs (and clears the mark), a mark
// never outlives its task (cleared in a microtask), a camera root keeps its own method
// (matrixWorldInverse), frozen map roots are marked only when the switch is on and in a scene, and
// the matrices a skip leaves are exactly the ones a full pass computes when nothing moved.
// Usage (repo root):  npx tsx scripts/test-matrix-fresh.mts
import assert from "node:assert/strict";
import * as THREE from "three";
import { freshSkip, markFrozenMapsFresh, markMatrixFresh, registerFrozenMap, skipFreshMatrixUpdate } from "../src/effects/matrixFresh.ts";
import { freezeStaticTransforms } from "../src/world/MapBatching.ts";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function rig(): { scene: THREE.Scene; root: THREE.Group; leaf: THREE.Mesh } {
  const scene = new THREE.Scene();
  scene.matrixAutoUpdate = false; // Game: the scene root is frozen
  const root = new THREE.Group();
  const mid = new THREE.Group();
  const leaf = new THREE.Mesh();
  root.add(mid);
  mid.add(leaf);
  scene.add(root);
  root.position.set(1, 2, 3);
  mid.rotation.set(0.1, 0.2, 0.3);
  leaf.scale.set(2, 2, 2);
  scene.updateMatrixWorld(true);
  return { scene, root, leaf };
}

await test("a marked root skips one non-forced pass, then updates again", async () => {
  const { scene, root, leaf } = rig();
  skipFreshMatrixUpdate(root);
  const before = leaf.matrixWorld.clone();
  markMatrixFresh(root);
  leaf.position.x = 5; // (a change after the mark would be missed by the skipped pass — by contract nothing changes)
  scene.updateMatrixWorld();
  assert.ok(leaf.matrixWorld.equals(before), "skipped");
  scene.updateMatrixWorld();
  assert.ok(!leaf.matrixWorld.equals(before), "next pass runs");
  await tick();
});

await test("a forced pass always runs and clears the mark", async () => {
  const { scene, root, leaf } = rig();
  skipFreshMatrixUpdate(root);
  markMatrixFresh(root);
  leaf.position.x = 7;
  scene.updateMatrixWorld(true);
  assert.equal(leaf.matrixWorld.elements[12] !== 0, true);
  const after = leaf.matrixWorld.clone();
  leaf.position.x = 9;
  scene.updateMatrixWorld(); // the mark was consumed by the forced pass
  assert.ok(!leaf.matrixWorld.equals(after));
  await tick();
});

await test("a mark never outlives its task", async () => {
  const { scene, root, leaf } = rig();
  skipFreshMatrixUpdate(root);
  markMatrixFresh(root);
  await tick(); // the task ended: the mark is void
  const before = leaf.matrixWorld.clone();
  leaf.position.x = 3;
  scene.updateMatrixWorld();
  assert.ok(!leaf.matrixWorld.equals(before), "not skipped in a later task");
});

await test("nothing moved: the skipped matrices equal a full pass, bit for bit", async () => {
  const { scene, root } = rig();
  skipFreshMatrixUpdate(root);
  scene.updateMatrixWorld(); // the frame's explicit pass
  const snap = (): number[] => {
    const out: number[] = [];
    root.traverse((o) => out.push(...o.matrixWorld.elements));
    return out;
  };
  const a = snap();
  markMatrixFresh(root);
  scene.updateMatrixWorld(); // the renderer's pass: skipped
  const b = snap();
  root.updateMatrixWorld(true); // what a full pass computes
  assert.deepEqual(b, a);
  assert.deepEqual(snap(), a);
  await tick();
});

await test("a camera root keeps its own update (matrixWorldInverse)", async () => {
  const scene = new THREE.Scene();
  scene.matrixAutoUpdate = false;
  const cam = new THREE.PerspectiveCamera();
  const child = new THREE.Object3D();
  cam.add(child);
  scene.add(cam);
  skipFreshMatrixUpdate(cam);
  cam.position.set(4, 5, 6);
  scene.updateMatrixWorld();
  const inv = cam.matrixWorld.clone().invert();
  assert.ok(cam.matrixWorldInverse.equals(inv), "inverse refreshed by the camera's own method");
  markMatrixFresh(cam);
  cam.position.set(0, 0, 0);
  scene.updateMatrixWorld();
  assert.ok(cam.matrixWorldInverse.equals(inv), "skipped as a whole");
  await tick();
});

await test("frozen map roots: registered by freezeStaticTransforms, marked when in a scene and switched on", async () => {
  const { scene, root, leaf } = rig();
  const map = new THREE.Group();
  const deco = new THREE.Mesh();
  map.add(deco);
  scene.add(map);
  freezeStaticTransforms(map, new Set([deco]));
  registerFrozenMap(map); // idempotent
  scene.updateMatrixWorld();
  const before = deco.matrixWorld.clone();
  markFrozenMapsFresh();
  deco.position.y = 10;
  scene.updateMatrixWorld();
  assert.ok(deco.matrixWorld.equals(before), "map skipped once");
  scene.updateMatrixWorld();
  assert.ok(!deco.matrixWorld.equals(before), "then updated");
  freshSkip.on = false;
  markFrozenMapsFresh();
  deco.position.y = 11;
  const b2 = deco.matrixWorld.clone();
  scene.updateMatrixWorld();
  assert.ok(!deco.matrixWorld.equals(b2), "switch off: no mark");
  freshSkip.on = true;
  void root;
  void leaf;
  await tick();
});

console.log(`test-matrix-fresh: ${passed} passed`);
