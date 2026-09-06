// Deep inspection of the Potato/HexSniper integration pack GLBs:
// rest-pose dimensions, per-clip animated tracks, bone rest bases.
// Usage: node scripts/inspect-potato.mjs
import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

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

function load(file) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((resolve, reject) =>
    new GLTFLoader().parse(ab, "", resolve, reject),
  );
}

const base = "src/assets/potato/";

const tp = await load(base + "Potato_TP_Character.glb");
console.log("=== Potato_TP_Character ===");
tp.scene.updateMatrixWorld(true);
const box = new THREE.Box3().setFromObject(tp.scene);
const size = box.getSize(new THREE.Vector3());
console.log("rest bbox size:", size.toArray().map((v) => v.toFixed(5)).join(", "));
console.log("rest bbox min/max y:", box.min.y.toFixed(5), box.max.y.toFixed(5));
console.log("rest bbox center x/z:", ((box.min.x+box.max.x)/2).toFixed(5), ((box.min.z+box.max.z)/2).toFixed(5));
// Scene root children transforms
tp.scene.children.forEach((c) => {
  console.log("root child:", c.name, "pos", c.position.toArray().map(v=>v.toFixed(4)).join(","), "scale", c.scale.toArray().map(v=>v.toFixed(4)).join(","), "rotY", c.rotation.y.toFixed(4));
});
for (const clip of tp.animations) {
  console.log(`clip ${clip.name} (${clip.duration.toFixed(4)}s) tracks:`);
  const names = clip.tracks.map((t) => t.name);
  console.log("  " + names.join(" | "));
}
// Bone rest world bases (spine chain + hands)
for (const name of ["Root", "Hips", "Spine", "Spine_1", "Chest", "Neck", "Head", "Hand_R", "Weapon_R", "Plant_Root"]) {
  const b = tp.scene.getObjectByName(name);
  if (!b) { console.log(name, "MISSING"); continue; }
  const m = b.matrixWorld.elements;
  console.log(
    name,
    "worldPos", b.getWorldPosition(new THREE.Vector3()).toArray().map(v=>v.toFixed(4)).join(","),
    "| X axis", [m[0],m[1],m[2]].map(v=>v.toFixed(3)).join(","),
    "| Y axis", [m[4],m[5],m[6]].map(v=>v.toFixed(3)).join(","),
    "| Z axis", [m[8],m[9],m[10]].map(v=>v.toFixed(3)).join(","),
  );
}
// Hips position track ranges per clip (root-motion check)
for (const clip of tp.animations) {
  const t = clip.tracks.find((tr) => /Hips\.position$/.test(tr.name));
  if (!t) { console.log(clip.name, ": no Hips.position track"); continue; }
  const v = t.values;
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) {
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], v[i+a]); max[a] = Math.max(max[a], v[i+a]); }
  }
  console.log(clip.name, "Hips.position range:", min.map((m,i)=>`${m.toFixed(3)}..${max[i].toFixed(3)}`).join(" "));
}

const tpPoses = await load(base + "HexSniper_TP_Poses.glb");
console.log("\n=== HexSniper_TP_Poses ===");
for (const clip of tpPoses.animations) {
  console.log(`clip ${clip.name} (${clip.duration.toFixed(4)}s):`);
  console.log("  " + clip.tracks.map((t) => t.name).join(" | "));
}

const fpArms = await load(base + "Potato_FP_CommonArms.glb");
console.log("\n=== Potato_FP_CommonArms ===");
fpArms.scene.updateMatrixWorld(true);
fpArms.scene.children.forEach((c) => {
  console.log("root child:", c.name, "pos", c.position.toArray().map(v=>v.toFixed(4)).join(","), "quat", c.quaternion.toArray().map(v=>v.toFixed(4)).join(","), "scale", c.scale.toArray().map(v=>v.toFixed(4)).join(","));
});
const fbox = new THREE.Box3().setFromObject(fpArms.scene);
console.log("rest bbox:", fbox.min.toArray().map(v=>v.toFixed(4)).join(","), "→", fbox.max.toArray().map(v=>v.toFixed(4)).join(","));
for (const name of ["FP_Viewmodel", "Armature", "Root", "Weapon_R", "Hand_R"]) {
  const b = fpArms.scene.getObjectByName(name);
  if (!b) { console.log(name, "MISSING"); continue; }
  console.log(name, "worldPos", b.getWorldPosition(new THREE.Vector3()).toArray().map(v=>v.toFixed(4)).join(","));
}

const fpPoses = await load(base + "HexSniper_FP_Poses.glb");
console.log("\n=== HexSniper_FP_Poses ===");
for (const clip of fpPoses.animations) {
  console.log(`clip ${clip.name} (${clip.duration.toFixed(4)}s):`);
  console.log("  " + clip.tracks.map((t) => t.name).join(" | "));
}

const weapon = await load(base + "HexSniper_Weapon.glb");
console.log("\n=== HexSniper_Weapon ===");
weapon.scene.updateMatrixWorld(true);
weapon.scene.children.forEach((c) => {
  console.log("root child:", c.name, "scale", c.scale.toArray().map(v=>v.toFixed(4)).join(","));
});
const hexRoot = weapon.scene.getObjectByName("HexSniper");
if (hexRoot) console.log("HexSniper node scale:", hexRoot.scale.toArray().map(v=>v.toFixed(4)).join(","), "pos:", hexRoot.position.toArray().map(v=>v.toFixed(4)).join(","));
for (const clip of weapon.animations) {
  console.log(`clip ${clip.name} (${clip.duration.toFixed(4)}s), ${clip.tracks.length} tracks`);
}
for (const name of ["GripSocket", "OffhandSocket", "Muzzle", "TongueOrigin", "BiteOrigin", "ScopeAim", "HeadSocket", "Tongue_Idle", "Tongue_Tether"]) {
  const n = weapon.scene.getObjectByName(name);
  console.log(name, n ? "present, worldPos " + n.getWorldPosition(new THREE.Vector3()).toArray().map(v=>v.toFixed(4)).join(",") : "MISSING");
}
