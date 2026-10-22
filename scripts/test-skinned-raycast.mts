// SkinnedRaycast — headless checks on the REAL Potato body (Potato_TP_Character.glb, no DOM / WebGL).
// Usage (repo root):  npx --prefix backend tsx scripts/test-skinned-raycast.mts
//   1. the raw-array skinning (skinVertices) and the accessor loop give the same bits: the same
//      rays on the same pose, once through the fast path and once with the weights moved into an
//      interleaved attribute (same values → the accessor loop), every hit identical (face, point);
//   2. against three's own SkinnedMesh.raycast (CPU skinning per triangle): same nearest face on
//      every ray that hits, points within 1e-5 (three works in a different order of operations);
//   3. warmSkinnedRaycast runs on a mesh outside any scene (the cached template's case).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { nextSkinnedRaycastFrame, raycastSkinnedMesh, warmSkinnedRaycast } from "../src/effects/SkinnedRaycast.ts";

let passed = 0;
const ok = (label: string) => {
  passed++;
  console.log(`OK   ${label}`);
};

const buf = readFileSync("src/assets/potato/Potato_TP_Character.glb");
const loader = new GLTFLoader();
loader.register((parser) => {
  (parser as unknown as { loadImageSource: () => Promise<THREE.Texture> }).loadImageSource = () => Promise.resolve(new THREE.Texture());
  return { name: "STUB_IMAGE_SOURCES" };
});
const gltf = await new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>((res, rej) =>
  loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, "", res as never, rej),
);
const scene = gltf.scene;
let body: THREE.SkinnedMesh | null = null;
scene.traverse((o) => {
  const sm = o as THREE.SkinnedMesh;
  if (!body && sm.isSkinnedMesh && sm.name === "Potato") body = sm;
});
assert.ok(body, "the Potato body");
const mesh = body as THREE.SkinnedMesh;

// A real pose: the first clip, half-way through.
if (gltf.animations.length) {
  const mixer = new THREE.AnimationMixer(scene);
  mixer.clipAction(gltf.animations[0]).play();
  mixer.update(gltf.animations[0].duration / 2);
}
scene.position.set(3, 0.5, -2);
scene.rotation.y = 0.7;
scene.updateMatrixWorld(true);

// Rays around the body, toward points of its bounding box (deterministic).
const box = new THREE.Box3().setFromObject(mesh);
const center = box.getCenter(new THREE.Vector3());
const size = box.getSize(new THREE.Vector3());
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const rays: { o: THREE.Vector3; d: THREE.Vector3 }[] = [];
for (let i = 0; i < 300; i++) {
  const a = rnd() * Math.PI * 2;
  const o = new THREE.Vector3(center.x + Math.cos(a) * 3, center.y + (rnd() - 0.5) * size.y * 1.5, center.z + Math.sin(a) * 3);
  const target = new THREE.Vector3(center.x + (rnd() - 0.5) * size.x, center.y + (rnd() - 0.5) * size.y, center.z + (rnd() - 0.5) * size.z);
  rays.push({ o, d: target.sub(o).normalize() });
}
const cast = () =>
  rays.map(({ o, d }) => {
    nextSkinnedRaycastFrame();
    return raycastSkinnedMesh(mesh, o, d, 100);
  });

// ---------------------------------------------------------------- 1. fast path = accessor loop, bit for bit
{
  const fast = cast();
  const weights = mesh.geometry.getAttribute("skinWeight") as THREE.BufferAttribute;
  const n = weights.count;
  const inter = new THREE.InterleavedBuffer(new (weights.array.constructor as Float32ArrayConstructor)(weights.array as unknown as ArrayLike<number>), 4);
  const interleaved = new THREE.InterleavedBufferAttribute(inter, 4, 0, weights.normalized);
  mesh.geometry.setAttribute("skinWeight", interleaved as unknown as THREE.BufferAttribute);
  const slow = cast(); // (another layout: the accessor loop)
  mesh.geometry.setAttribute("skinWeight", weights);
  const hits = fast.filter(Boolean).length;
  assert.ok(hits > 50, `enough hits (${hits})`);
  for (let i = 0; i < rays.length; i++) {
    const a = fast[i], b = slow[i];
    assert.equal(!!a, !!b, `ray ${i}: hit / miss`);
    if (!a || !b) continue;
    assert.equal(a.faceIndex, b.faceIndex, `ray ${i}: face`);
    assert.ok(Object.is(a.point.x, b.point.x) && Object.is(a.point.y, b.point.y) && Object.is(a.point.z, b.point.z), `ray ${i}: same point bits`);
    assert.ok(Object.is(a.distance, b.distance), `ray ${i}: same distance bits`);
  }
  ok(`raw-array skinning = accessor loop, bit for bit: ${rays.length} rays, ${hits} hits (${n} vertices, weights ${weights.array.constructor.name}${weights.normalized ? " normalized" : ""}, joints ${(mesh.geometry.getAttribute("skinIndex") as THREE.BufferAttribute).array.constructor.name})`);
}

// ---------------------------------------------------------------- 2. against three's SkinnedMesh.raycast
{
  const ours = cast();
  let compared = 0;
  for (let i = 0; i < rays.length; i++) {
    const hits: THREE.Intersection[] = [];
    const rc = new THREE.Raycaster(rays[i].o, rays[i].d, 0, 100);
    const side = (mesh.material as THREE.Material).side;
    (mesh.material as THREE.Material).side = THREE.DoubleSide; // ours is double-sided, like the body material
    mesh.raycast(rc, hits);
    (mesh.material as THREE.Material).side = side;
    hits.sort((p, q) => p.distance - q.distance);
    const theirs = hits[0];
    const a = ours[i];
    assert.equal(!!a, !!theirs, `ray ${i}: hit / miss vs three`);
    if (!a || !theirs) continue;
    compared++;
    assert.equal(a.faceIndex, theirs.faceIndex, `ray ${i}: same face as three`);
    assert.ok(a.point.distanceTo(theirs.point) < 1e-5, `ray ${i}: same point as three (${a.point.distanceTo(theirs.point)})`);
  }
  ok(`same nearest face as three's SkinnedMesh.raycast on ${compared} hits (points within 1e-5)`);
}

// ---------------------------------------------------------------- 3. warm-up outside a scene
{
  const template = scene.clone(); // (parentless, like the cached template)
  let m: THREE.SkinnedMesh | null = null;
  template.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (!m && sm.isSkinnedMesh) m = sm;
  });
  warmSkinnedRaycast(m as unknown as THREE.SkinnedMesh, 3);
  warmSkinnedRaycast(mesh, 3);
  ok("warmSkinnedRaycast runs on a parentless template and on the posed body");
}

console.log(`\nAll ${passed} skinned-raycast checks passed.`);
