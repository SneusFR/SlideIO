// Smoke test: PulseCarbine GLB + controller behavior in Node.
// Usage: node scripts/smoke-pulsecarbine.mjs (from the repo root).
import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PulseCarbineController } from "../src/weapons/bassblaster/PulseCarbineController.js";

// Node has no DOM image pipeline — stub texture loading (2×256px embedded
// PNGs are irrelevant to the animation/socket/orientation checks).
globalThis.self = globalThis;
if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = () => "blob:stub";
if (!globalThis.URL.revokeObjectURL) globalThis.URL.revokeObjectURL = () => {};
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
const stubLoad = function (_url, onLoad) {
  const tex = new THREE.Texture();
  if (onLoad) setTimeout(() => onLoad(tex), 0);
  return tex;
};
THREE.TextureLoader.prototype.load = stubLoad;
THREE.ImageBitmapLoader.prototype.load = function (_url, onLoad) {
  if (onLoad) setTimeout(() => onLoad({ width: 1, height: 1, close() {} }), 0);
};

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exitCode = 1;
  } else {
    console.log("ok:", msg);
  }
};

const buf = fs.readFileSync("src/assets/PulseCarbine/PulseCarbine.glb");
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

new GLTFLoader().parse(ab, "", (gltf) => {
  assert(gltf.animations.length === 5, "5 animation clips present");

  const w = new PulseCarbineController(gltf);
  assert(!!w.muzzle && !!w.grip && !!w.offhand, "Muzzle/GripSocket/OffhandSocket resolved");
  assert(!!w.object.getObjectByName("StockSocket"), "StockSocket present");
  assert(w.state === "Idle", "starts at rest (Idle)");

  // No fire animation when no shot is accepted: update alone keeps Idle.
  w.update(0.5);
  assert(w.state === "Idle", "no fire animation without onFire()");

  // Accepted shots alternate Fire / Fire_AltA / Fire_AltB.
  const clips = [];
  for (let i = 0; i < 3; i++) {
    w.onFire();
    clips.push(w.activeClip);
    w.update(0.1); // burst: next shot before the 0.7s clip ends
  }
  assert(
    clips.join(",") === "Fire,Fire_AltA,Fire_AltB",
    `fire variants alternate (${clips.join(",")})`,
  );

  // Return to rest after the 0.7 s impulse completes.
  w.update(1.0);
  assert(w.state === "Idle", "returns to Idle after the fire impulse");

  // 50 rapid triggers (as in the asset's own validation) never throw.
  for (let i = 0; i < 50; i++) {
    w.onFire();
    w.update(0.016);
  }
  w.update(1.0);
  assert(w.state === "Idle", "back to Idle after 50-shot burst");

  // setMusic(true) → continuous loop; false → back to Idle.
  w.setMusic(true);
  assert(w.state === "MusicLoop", "setMusic(true) plays MusicLoop");
  w.setMusic(false);
  assert(w.state === "Idle", "setMusic(false) returns to Idle");

  // Orientation: muzzle forward is -X in model space → after the
  // viewmodel pivot (rotation.y = -PI/2) it must face -Z (camera forward).
  const pivot = new THREE.Group();
  pivot.rotation.y = -Math.PI / 2;
  pivot.add(w.object);
  pivot.updateMatrixWorld(true);
  const q = w.muzzle.getWorldQuaternion(new THREE.Quaternion());
  const dir = new THREE.Vector3(-1, 0, 0).applyQuaternion(q).normalize();
  assert(
    Math.abs(dir.z + 1) < 1e-6 && Math.abs(dir.x) < 1e-6,
    `muzzle faces -Z after viewmodel pivot (dir=${dir.x.toFixed(3)},${dir.y.toFixed(3)},${dir.z.toFixed(3)})`,
  );

  // Muzzle sits at the FRONT (negative z) half after the pivot.
  const box = new THREE.Box3().setFromObject(pivot);
  const muzzlePos = w.muzzle.getWorldPosition(new THREE.Vector3());
  assert(
    muzzlePos.z < (box.min.z + box.max.z) / 2,
    `Muzzle socket is at the front (z=${muzzlePos.z.toFixed(3)}, bbox z=[${box.min.z.toFixed(3)},${box.max.z.toFixed(3)}])`,
  );

  // Two instances share geometry but animate independent skeletons.
  const w2 = new PulseCarbineController(gltf);
  w2.onFire();
  assert(w.state === "Idle" && w2.state === "Fire", "instances animate independently");
  const geo = (o) => {
    let g = null;
    o.traverse((c) => {
      if (c.isSkinnedMesh && !g) g = c.geometry;
    });
    return g;
  };
  assert(geo(w.object) === geo(w2.object), "geometry SHARED between instances");

  // dispose(): stops this instance, the other keeps working.
  w.dispose();
  w.onFire(); // must be a no-op
  w.update(0.016);
  w2.update(0.016);
  assert(w2.state === "Fire", "dispose() of one instance leaves the other alive");

  console.log(process.exitCode ? "SMOKE TEST FAILED" : "SMOKE TEST PASSED");
}, (err) => {
  console.error("GLB parse failed:", err);
  process.exitCode = 1;
});
