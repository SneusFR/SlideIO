// KILL FRAME PREPARED AHEAD (effects/KillPrep.ts, CorpseManager.prewarm): the fade clone the kill
// takes from the ready slot is, property by property, the clone the kill would have created at that
// moment (also after the source changed since the prewarm), the pool keeps its priority, ephemeral
// sources keep their eviction, nothing but the new clones reaches three's compile (invisible meshes,
// shader materials and already pooled sources are left alone; every mesh gets its own materials
// back), a disposed source takes its ready clone with it, the switch off is the old path; a bone
// texture created ahead holds what the first-draw path uploads; one prep job per frame, FIFO.
// Usage (repo root):  npx tsx scripts/test-kill-prep.mts
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  cancelKillPrep,
  compileLikeWorldPass,
  killPrep,
  prepareBoneTexture,
  requestKillPrep,
  runKillPrep,
  setKillPrepGpu,
  type KillPrepGpu,
  type KillPrepJob,
} from "../src/effects/KillPrep.ts";
import { CorpseManager, createFadeClone, refreshFadeClone } from "../src/ragdoll/CorpseManager.ts";
import type { PhysicsWorld } from "../src/physics/PhysicsWorld.ts";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

/** Records what three's compile() would see (no WebGL here). */
class FakeRenderer {
  target: unknown = null;
  readonly compiles: { materials: THREE.Material[]; singlePass: boolean[]; target: unknown; scene: unknown }[] = [];
  readonly uploads: THREE.Texture[] = [];
  getRenderTarget(): unknown {
    return this.target;
  }
  setRenderTarget(t: unknown): void {
    this.target = t;
  }
  compile(root: THREE.Object3D, _camera: THREE.Camera, scene: THREE.Scene): Set<THREE.Material> {
    const materials: THREE.Material[] = [];
    root.traverse((o) => {
      const d = o as THREE.Mesh & { isPoints?: boolean; isLine?: boolean; isSprite?: boolean };
      if (!(d.isMesh || d.isPoints || d.isLine || d.isSprite) || !d.material) return;
      for (const m of Array.isArray(d.material) ? d.material : [d.material]) materials.push(m);
    });
    this.compiles.push({ materials, singlePass: materials.map((m) => m.forceSinglePass), target: this.target, scene });
    return new Set(materials);
  }
  initTexture(t: THREE.Texture): void {
    this.uploads.push(t);
  }
}

const WORLD_TARGET = { worldTarget: true };
function gpuOf(fake: FakeRenderer): KillPrepGpu {
  return {
    renderer: fake as unknown as THREE.WebGLRenderer,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    target: () => WORLD_TARGET as unknown as THREE.WebGLRenderTarget,
  };
}

/** Every own property but the identity ones, deep (textures by reference). */
function assertSameMaterial(a: THREE.Material, b: THREE.Material, label: string): void {
  assert.equal(a.constructor, b.constructor, `${label}: class`);
  const skip = new Set(["id", "uuid", "version", "_listeners"]);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (!skip.has(k)) assertSameValue((a as never)[k], (b as never)[k], `${label}.${k}`);
}
function assertSameValue(x: unknown, y: unknown, path: string): void {
  if (Object.is(x, y)) return;
  assert.ok(x !== null && y !== null && typeof x === "object" && typeof y === "object", `${path}: ${String(x)} ≠ ${String(y)}`);
  const ox = x as Record<string, unknown>, oy = y as Record<string, unknown>;
  assert.ok(!(ox.isTexture || oy.isTexture), `${path}: textures must be the same object`);
  assert.equal(ox.constructor, oy.constructor, `${path}: class`);
  const keys = new Set([...Object.keys(ox), ...Object.keys(oy)]);
  for (const k of keys) assertSameValue(ox[k], oy[k], `${path}.${k}`);
}

const fakePhysics = {} as PhysicsWorld;

/** A corpse-like visual: skinned body (2 materials), visible prop, hidden prop, shader prop. */
function corpseVisual() {
  const body = new THREE.MeshStandardMaterial({ name: "body", color: 0xc08040, roughness: 0.7 });
  const skin = new THREE.MeshToonMaterial({ name: "skin", color: 0xffe0c0 });
  const visor = new THREE.MeshPhysicalMaterial({ name: "visor", transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide });
  const hiddenMat = new THREE.MeshLambertMaterial({ name: "hidden" });
  const shader = new THREE.ShaderMaterial({ name: "shader", uniforms: { k: { value: 1 } } });
  body.side = THREE.DoubleSide;
  const root = new THREE.Group();
  const bones = [new THREE.Bone(), new THREE.Bone()];
  bones[0].add(bones[1]);
  root.add(bones[0]);
  const geometry = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1);
  const n = geometry.getAttribute("position").count;
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Float32Array(n * 4).fill(0.25), 4));
  geometry.addGroup(0, 18, 0);
  geometry.addGroup(18, 18, 1);
  const bodyMesh = new THREE.SkinnedMesh(geometry, [body, skin]);
  bodyMesh.bind(new THREE.Skeleton(bones));
  const visorMesh = new THREE.Mesh(new THREE.BoxGeometry(), visor);
  const hiddenMesh = new THREE.Mesh(new THREE.BoxGeometry(), hiddenMat);
  hiddenMesh.visible = false;
  const hiddenParent = new THREE.Group();
  hiddenParent.visible = false;
  const underHidden = new THREE.Mesh(new THREE.BoxGeometry(), body); // body again, but not shown here
  hiddenParent.add(underHidden);
  const shaderMesh = new THREE.Mesh(new THREE.BoxGeometry(), shader);
  root.add(bodyMesh, visorMesh, hiddenMesh, hiddenParent, shaderMesh);
  return { root, bodyMesh, visorMesh, hiddenMesh, underHidden, shaderMesh, mats: { body, skin, visor, hiddenMat, shader } };
}

/**
 * The clone the kill hands to each source (CorpseManager.warmUp claims like spawn does); the
 * visual gets its sources back (the next life's body), `release` = the corpse removed.
 */
function claim(corpses: CorpseManager, root: THREE.Object3D): { byName: Map<string, THREE.Material>; release: () => void } {
  const sources: { mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) sources.push({ mesh, material: mesh.material });
  });
  const release = corpses.warmUp(root);
  const byName = new Map<string, THREE.Material>();
  for (const { mesh } of sources) {
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) byName.set(mat.name, mat);
  }
  for (const { mesh, material } of sources) mesh.material = material;
  return { byName, release };
}

await test("a refreshed ready clone equals the clone created now, whatever changed in between", () => {
  const sources: THREE.Material[] = [
    new THREE.MeshStandardMaterial({ color: 0x336699, roughness: 0.4, metalness: 0.1, side: THREE.DoubleSide }),
    new THREE.MeshPhysicalMaterial({ clearcoat: 0.5, transparent: true, opacity: 0.5, depthWrite: false }),
    new THREE.MeshToonMaterial({ color: 0xff0000 }),
    new THREE.MeshLambertMaterial({ emissive: 0x111111 }),
    new THREE.MeshPhongMaterial({ shininess: 12 }),
    new THREE.MeshBasicMaterial({ color: 0x00ff00 }),
  ];
  const map = new THREE.Texture();
  for (const source of sources) {
    source.stencilWrite = true; // living enemy materials write the outline mask
    const ready = createFadeClone(source);
    // The life goes on: damage flash, paint flag, authored changes…
    const s = source as THREE.MeshStandardMaterial;
    if (s.emissive) s.emissive.setRGB(0.55, 0.55, 0.55);
    if (s.color) s.color.setRGB(0.2, 0.3, 0.4);
    s.map = map;
    s.alphaTest = 0.5;
    s.opacity = 0.75;
    s.userData.corpsePoolEphemeral = true;
    s.name = "changed";
    s.polygonOffset = true;
    const now = createFadeClone(source);
    const refreshed = refreshFadeClone(ready, source);
    assert.equal(refreshed, ready, "refreshed in place");
    assertSameMaterial(refreshed, now, source.type);
    assert.equal(refreshed.transparent, true);
    assert.equal(refreshed.stencilWrite, false);
  }
});

await test("prewarm: one clone per visible non-shader source, both looks compiled on the world pass target", () => {
  const corpses = new CorpseManager(new THREE.Scene(), fakePhysics);
  const fake = new FakeRenderer();
  const gpu = gpuOf(fake);
  const v = corpseVisual();
  const before = v.root.children.map((c) => (c as THREE.Mesh).material);
  const bodyArray = v.bodyMesh.material;
  assert.equal(corpses.prewarm(v.root, gpu), 3); // body, skin, visor — not hidden, not shader
  assert.equal(fake.compiles.length, 2);
  for (const c of fake.compiles) {
    assert.equal(c.target, WORLD_TARGET, "compiled into the world pass's target");
    assert.equal(c.scene, gpu.scene, "with the world's lights");
    assert.deepEqual(c.materials.map((m) => m.name).sort(), ["body", "skin", "visor"], "only the new clones");
    for (const m of c.materials) assert.notEqual(m, v.mats[m.name as keyof typeof v.mats], "a clone, never the source");
  }
  // First the fade look (three's two passes when the source has them), then the opaque life.
  const fade = fake.compiles[0], life = fake.compiles[1];
  const look = (c: typeof fade, name: string) => c.singlePass[c.materials.findIndex((m) => m.name === name)];
  assert.equal(look(fade, "body"), false);
  assert.equal(look(life, "body"), true); // opaque double-sided source: one pass while opaque
  assert.equal(look(fade, "visor"), false);
  assert.equal(look(life, "visor"), false); // translucent glass keeps two passes
  assert.equal(fake.target, null, "target restored");
  // Every drawable has its own materials back (same objects, same array).
  v.root.children.forEach((c, i) => assert.equal((c as THREE.Mesh).material, before[i]));
  assert.equal(v.bodyMesh.material, bodyArray);
  assert.equal(v.underHidden.material, v.mats.body);
  // Already ready: nothing more to do.
  assert.equal(corpses.prewarm(v.root, gpu), 0);
  assert.equal(fake.compiles.length, 2);
});

await test("the kill takes the ready clone (refreshed to now); the pool keeps its priority afterwards", () => {
  const corpses = new CorpseManager(new THREE.Scene(), fakePhysics);
  const gpu = gpuOf(new FakeRenderer());
  const v = corpseVisual();
  corpses.prewarm(v.root, gpu);
  const readyBody = (corpses as unknown as { ready: Map<THREE.Material, { mat: THREE.Material }> }).ready.get(v.mats.body)!.mat;
  v.mats.body.emissive.setRGB(0.4, 0.4, 0.4); // flash on at the kill
  const expected = createFadeClone(v.mats.body);
  const first = claim(corpses, v.root);
  assert.equal(first.byName.get("body"), readyBody, "the ready clone, not a new one");
  assertSameMaterial(readyBody, expected, "body at the kill");
  const hidden = first.byName.get("hidden")!;
  assert.notEqual(hidden, v.mats.hiddenMat);
  first.release(); // corpse removed: its clones go to the pools
  // Pools are not empty any more: nothing is prepared, the pooled clones come back.
  assert.equal(corpses.prewarm(v.root, gpu), 0);
  const second = claim(corpses, v.root);
  assert.equal(second.byName.get("body"), readyBody, "the pooled clone again");
  assert.equal(second.byName.get("hidden"), hidden);
  second.release();
});

await test("ephemeral sources: ready clone used once, then evicted like a new clone", () => {
  const corpses = new CorpseManager(new THREE.Scene(), fakePhysics);
  const gpu = gpuOf(new FakeRenderer());
  const v = corpseVisual();
  v.mats.skin.userData.corpsePoolEphemeral = true; // paint clone
  corpses.prewarm(v.root, gpu);
  const internals = corpses as unknown as { ready: Map<THREE.Material, { mat: THREE.Material }>; orphanClones: THREE.Material[]; materialPool: Map<THREE.Material, THREE.Material[]> };
  const readySkin = internals.ready.get(v.mats.skin)!.mat;
  const c = claim(corpses, v.root);
  assert.equal(c.byName.get("skin"), readySkin);
  c.release();
  assert.ok(internals.orphanClones.includes(readySkin), "parked in the orphan ring");
  assert.equal(internals.materialPool.has(v.mats.skin), false, "pool entry evicted");
  // Next life of the same painted body: a new ready clone.
  assert.equal(corpses.prewarm(v.root, gpu), 1);
  assert.notEqual(internals.ready.get(v.mats.skin)!.mat, readySkin);
});

await test("a disposed source takes its ready clone with it; dispose() frees them all", () => {
  type Internals = { ready: Map<THREE.Material, { mat: THREE.Material }> };
  const corpses = new CorpseManager(new THREE.Scene(), fakePhysics);
  const v = corpseVisual();
  corpses.prewarm(v.root, gpuOf(new FakeRenderer()));
  const internals = corpses as unknown as Internals;
  const readyVisor = internals.ready.get(v.mats.visor)!.mat;
  let disposed = 0;
  readyVisor.addEventListener("dispose", () => disposed++);
  v.mats.visor.dispose();
  assert.equal(disposed, 1);
  assert.equal(internals.ready.has(v.mats.visor), false);
  const c = claim(corpses, v.root);
  assert.notEqual(c.byName.get("visor"), readyVisor, "a new clone for the (disposed) source");
  c.release();
  // Teardown with clones still waiting.
  const other = new CorpseManager(new THREE.Scene(), fakePhysics);
  other.prewarm(corpseVisual().root, gpuOf(new FakeRenderer()));
  const left = [...(other as unknown as Internals).ready.values()].map((r) => r.mat);
  assert.equal(left.length, 3);
  let freed = 0;
  for (const m of left) m.addEventListener("dispose", () => freed++);
  other.dispose();
  assert.equal(freed, 3);
  assert.equal((other as unknown as Internals).ready.size, 0);
});

await test("switch off: no prewarm, and a ready clone is never handed out (the old path)", () => {
  const corpses = new CorpseManager(new THREE.Scene(), fakePhysics);
  const v = corpseVisual();
  corpses.prewarm(v.root, gpuOf(new FakeRenderer()));
  const readyBody = (corpses as unknown as { ready: Map<THREE.Material, { mat: THREE.Material }> }).ready.get(v.mats.body)!.mat;
  killPrep.on = false;
  try {
    const fake = new FakeRenderer();
    const w = corpseVisual();
    assert.equal(corpses.prewarm(w.root, gpuOf(fake)), 0);
    assert.equal(fake.compiles.length, 0);
    const c = claim(corpses, v.root);
    assert.notEqual(c.byName.get("body"), readyBody);
    c.release();
  } finally {
    killPrep.on = true;
  }
});

await test("compileLikeWorldPass binds the world pass target and restores the previous one", () => {
  const fake = new FakeRenderer();
  const previous = { previous: true };
  fake.target = previous;
  compileLikeWorldPass(new THREE.Group(), gpuOf(fake));
  assert.equal(fake.compiles[0].target, WORLD_TARGET);
  assert.equal(fake.target, previous);
});

await test("a bone texture made ahead holds what the first-draw path uploads", () => {
  const rig = () => {
    const root = new THREE.Bone();
    const bones = [root];
    for (let i = 1; i < 23; i++) {
      const b = new THREE.Bone();
      b.position.set(0.1 * i, 0.2, -0.05 * i);
      b.rotation.set(0.01 * i, 0.02 * i, 0.03);
      bones[i - 1].add(b);
      bones.push(b);
    }
    root.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(bones);
    return { root, bones, skeleton };
  };
  const ahead = rig(), firstDraw = rig();
  const fake = new FakeRenderer();
  assert.equal(prepareBoneTexture(ahead.skeleton, fake as unknown as THREE.WebGLRenderer), true);
  assert.equal(fake.uploads.length, 1);
  assert.equal(fake.uploads[0], ahead.skeleton.boneTexture);
  assert.equal(prepareBoneTexture(ahead.skeleton, fake as unknown as THREE.WebGLRenderer), false, "only once");
  // The kill: both skeletons take the corpse pose, then three draws.
  for (const r of [ahead, firstDraw]) {
    r.bones[3].rotation.x += 0.7;
    r.bones[9].position.y -= 0.3;
    r.root.updateMatrixWorld(true);
  }
  ahead.skeleton.update(); // three's per-frame update (texture flagged for upload)
  firstDraw.skeleton.update();
  firstDraw.skeleton.computeBoneTexture(); // three's first-draw path
  const a = ahead.skeleton.boneTexture!, b = firstDraw.skeleton.boneTexture!;
  assert.equal(a.image.width, b.image.width);
  assert.deepEqual(Array.from(a.image.data as Float32Array), Array.from(b.image.data as Float32Array));
  assert.ok(a.version > 1, "re-uploaded at the draw");
});

await test("prep jobs: one per frame, never the asking frame, FIFO, no duplicates, cancel, off = nothing", () => {
  const ran: string[] = [];
  const job = (name: string): KillPrepJob => ({ runKillPrep: () => ran.push(name) });
  const a = job("a"), b = job("b"), c = job("c"), d = job("d");
  requestKillPrep(a); // no GPU yet: ignored
  runKillPrep();
  runKillPrep();
  assert.deepEqual(ran, []);
  setKillPrepGpu(gpuOf(new FakeRenderer()));
  requestKillPrep(a);
  requestKillPrep(b);
  requestKillPrep(a);
  requestKillPrep(c);
  cancelKillPrep(b);
  runKillPrep(); // the frame that asked: nothing yet
  assert.deepEqual(ran, []);
  runKillPrep();
  assert.deepEqual(ran, ["a"]);
  requestKillPrep(d); // asked now: after c, and not in this frame
  runKillPrep();
  assert.deepEqual(ran, ["a", "c"]);
  runKillPrep();
  assert.deepEqual(ran, ["a", "c", "d"]);
  runKillPrep();
  assert.deepEqual(ran, ["a", "c", "d"]);
  killPrep.on = false;
  requestKillPrep(a);
  killPrep.on = true;
  runKillPrep();
  runKillPrep();
  assert.deepEqual(ran, ["a", "c", "d"]);
  requestKillPrep(b);
  runKillPrep();
  killPrep.on = false;
  runKillPrep(); // switched off meanwhile: dropped
  killPrep.on = true;
  runKillPrep();
  assert.deepEqual(ran, ["a", "c", "d"]);
  setKillPrepGpu(null);
});

console.log(`kill prep: ${passed} tests passed`);
