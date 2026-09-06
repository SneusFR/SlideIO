// Smoke test: Potato + HexSniper integration pack in Node.
// Usage: node scripts/smoke-potato-hexsniper.mjs (from the repo root).
// Validates: the five GLBs load, every expected clip/socket exists, pose
// libraries resolve their tracks onto the target rigs (no double
// characters), profile mount matrices apply once with the expected scale,
// and the HexSniperController handles Inspect_Affection.
import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { HexSniperController } from "../src/weapons/hexsniper/HexSniperController.js";

// Node has no DOM image pipeline — stub texture loading (embedded PNGs are
// irrelevant to animation/socket/mount checks).
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

function load(file) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((resolve, reject) => new GLTFLoader().parse(ab, "", resolve, reject));
}

const base = "src/assets/potato/";
const [tp, tpPoses, fpArms, fpPoses, weapon] = await Promise.all([
  load(base + "Potato_TP_Character.glb"),
  load(base + "HexSniper_TP_Poses.glb"),
  load(base + "Potato_FP_CommonArms.glb"),
  load(base + "HexSniper_FP_Poses.glb"),
  load(base + "HexSniper_Weapon.glb"),
]);
const profile = JSON.parse(fs.readFileSync(base + "WeaponProfile_HexSniper.json", "utf8"));
assert(true, "all five GLBs + profile JSON load");

// ---- 1. TP character: clips, bones, sockets ----
const clipNames = (g) => g.animations.map((c) => c.name);
for (const n of ["Run_Goofy", "Jump", "Dash", "Slide"]) {
  assert(clipNames(tp).includes(n), `TP character clip ${n} present`);
}
const TP_BONES = [
  "Root", "Hips", "Spine", "Spine_1", "Chest", "Neck", "Head",
  "Shoulder_L", "Shoulder_R", "UpperArm_L", "UpperArm_R", "LowerArm_L",
  "LowerArm_R", "Hand_L", "Hand_R", "UpperLeg_L", "UpperLeg_R",
  "LowerLeg_L", "LowerLeg_R", "Foot_L", "Foot_R", "Plant_Root", "Plant_Tip",
  "Weapon_R", "Weapon_L", "Head_Socket", "Face_Socket", "Back_Socket",
];
for (const b of TP_BONES) {
  assert(!!tp.scene.getObjectByName(b), `TP bone/socket ${b} present`);
}
// Sockets parented correctly (cosmetic sockets follow their parents).
assert(tp.scene.getObjectByName("Weapon_R").parent.name === "Hand_R", "Weapon_R child of Hand_R");
assert(tp.scene.getObjectByName("Head_Socket").parent.name === "Head", "Head_Socket child of Head");
assert(tp.scene.getObjectByName("Back_Socket").parent.name === "Chest", "Back_Socket child of Chest");
// No Meshy leftovers required anywhere.
for (const legacy of ["Spine01", "Spine02", "neck", "head_end", "headfront", "RightHand", "LeftHand"]) {
  assert(!tp.scene.getObjectByName(legacy), `no legacy Meshy bone ${legacy}`);
}

// ---- 2. TP pose library resolves on the TP rig (no meshes of its own) ----
let poseMeshes = 0;
tpPoses.scene.traverse((o) => { if (o.isMesh) poseMeshes++; });
assert(poseMeshes === 0, "TP pose library carries no meshes (no double character)");
for (const n of ["TP_Hold_HexSniper", "TP_Run_HexSniper", "TP_Aim_HexSniper", "TP_Raise_HexSniper", "TP_Lower_HexSniper"]) {
  assert(clipNames(tpPoses).includes(n), `TP pose clip ${n} present`);
}
const tpClone = skeletonClone(tp.scene);
const tpMixer = new THREE.AnimationMixer(tpClone);
for (const clip of tpPoses.animations) {
  let unresolved = 0;
  for (const t of clip.tracks) {
    const node = THREE.PropertyBinding.findNode(tpClone, t.name.split(".")[0]);
    if (!node) unresolved++;
  }
  assert(unresolved === 0, `every ${clip.name} track resolves on the TP rig`);
}
// Weapon_R animated correction preserved in the TP poses.
assert(
  tpPoses.animations.some((c) => c.tracks.some((t) => t.name.startsWith("Weapon_R."))),
  "TP poses carry animated Weapon_R correction tracks",
);
// Two clones animate independently (shared geometry).
const tpClone2 = skeletonClone(tp.scene);
const act = tpMixer.clipAction(tp.animations[0]);
act.play();
tpMixer.update(0.4);
const boneA = tpClone.getObjectByName("UpperLeg_L").quaternion.toArray();
const boneB = tpClone2.getObjectByName("UpperLeg_L").quaternion.toArray();
assert(boneA.some((v, i) => Math.abs(v - boneB[i]) > 1e-4), "clones animate independent skeletons");

// ---- 3. FP arms + FP pose library ----
assert(fpArms.animations.length === 0, "FP arms GLB has no animations (poses live in the library)");
assert(!!fpArms.scene.getObjectByName("Weapon_R"), "FP arms Weapon_R socket present");
assert(!!fpArms.scene.getObjectByName("FP_Viewmodel"), "FP_Viewmodel conversion container present");
let fpPoseMeshes = 0;
fpPoses.scene.traverse((o) => { if (o.isMesh) fpPoseMeshes++; });
assert(fpPoseMeshes === 0, "FP pose library carries no meshes");
for (const n of ["FP_HexSniper_Hold", "FP_HexSniper_Run", "FP_Aim_HexSniper", "FP_Raise_HexSniper", "FP_Lower_HexSniper", "FP_Inspect_HexSniper"]) {
  assert(clipNames(fpPoses).includes(n), `FP pose clip ${n} present`);
}
const armsClone = skeletonClone(fpArms.scene);
for (const clip of fpPoses.animations) {
  let unresolved = 0;
  for (const t of clip.tracks) {
    if (!THREE.PropertyBinding.findNode(armsClone, t.name.split(".")[0])) unresolved++;
  }
  assert(unresolved === 0, `every ${clip.name} track resolves on the FP arms rig`);
}
const inspectFp = fpPoses.animations.find((c) => c.name === "FP_Inspect_HexSniper");
assert(Math.abs(inspectFp.duration - 5.3) < 1e-3, "FP inspect duration = 5.3 s");

// ---- 4. Weapon GLB: sockets, clips, root scale, controller ----
for (const s of ["GripSocket", "OffhandSocket", "HeadSocket", "Muzzle", "TongueOrigin", "BiteOrigin", "ScopeAim", "Tongue_Idle", "Tongue_Tether"]) {
  assert(!!weapon.scene.getObjectByName(s), `weapon socket/mesh ${s} present`);
}
for (const n of ["Idle", "Fire", "Tongue_Cast", "Tongue_Hold", "Tongue_Return", "Bite", "Inspect_Affection"]) {
  assert(clipNames(weapon).includes(n), `weapon clip ${n} present`);
}
const hexRoot = weapon.scene.getObjectByName("HexSniper");
assert(Math.abs(hexRoot.scale.x - 0.19) < 1e-6, "HexSniper root keeps its authored 0.19 scale");
const inspectClip = weapon.animations.find((c) => c.name === "Inspect_Affection");
assert(Math.abs(inspectClip.duration - 5.3) < 1e-3, "weapon inspect duration = 5.3 s (synced with FP arms)");

const ctl = new HexSniperController(weapon, { effectsParent: new THREE.Group() });
assert(ctl.state === "Idle", "controller starts Idle");
assert(ctl.beginInspect() === true, "beginInspect starts from Idle");
assert(ctl.state === "Inspect", "controller state = Inspect");
assert(ctl.beginInspect() === false, "beginInspect refused while inspecting");
ctl.update(1.0);
ctl.cancelInspect();
assert(ctl.state === "Idle", "cancelInspect returns to Idle");
ctl.beginInspect();
ctl.update(5.4); // clip finished event → reset
assert(ctl.state === "Idle", "inspection completes back to Idle");
// Inspection never touches the attack tether.
assert(ctl.tether.visible === false, "tether stays hidden through inspection");
ctl.beginTongue(new THREE.Vector3(1, 0, 0));
assert(ctl.state === "Tongue_Cast" && ctl.tether.visible === true, "attack path intact after inspection");
ctl.dispose();

// ---- 5. Profile mounts applied ONCE (matrix, column-major, no re-scale) ----
const mountFp = new THREE.Group();
mountFp.matrix.fromArray(profile.mounts.fp.matrixColumnMajor);
mountFp.matrixAutoUpdate = false;
const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
mountFp.matrix.decompose(p, q, s);
assert(Math.abs(s.x - profile.mounts.fp.additionalScale) < 1e-3,
  `FP mount matrix carries its own ~${profile.mounts.fp.additionalScale.toFixed(2)} scale (never re-applied)`);
const mountTp = new THREE.Matrix4().fromArray(profile.mounts.tp.matrixColumnMajor);
mountTp.decompose(p, q, s);
assert(Math.abs(s.x - profile.mounts.tp.additionalScale) < 1e-3,
  `TP mount matrix carries its own ~${profile.mounts.tp.additionalScale.toFixed(2)} scale (never re-applied)`);

// Mount under the FP arms Weapon_R: world position lands near the camera
// (sanity: |pos| < 1.5 m in camera space — the weapon sits in view).
const socket = armsClone.getObjectByName("Weapon_R");
const weaponInstance = skeletonClone(weapon.scene);
socket.add(mountFp);
mountFp.add(weaponInstance);
armsClone.updateMatrixWorld(true);
const gripWorld = weaponInstance.getObjectByName("GripSocket").getWorldPosition(new THREE.Vector3());
assert(gripWorld.length() < 1.5, `FP grip lands in view (|p|=${gripWorld.length().toFixed(3)} m)`);

// ---- 6. Character normalization contract ----
const box = new THREE.Box3().setFromObject(tp.scene);
const h = box.getSize(new THREE.Vector3()).y;
const CHARACTER_HEIGHT = (0.55 + 0.35) * 2 * 1.25; // stand capsule × cosmetic scale
const factor = CHARACTER_HEIGHT / h;
assert(Math.abs(factor - 2.693) < 0.02, `normalization factor ≈ 2.693 (got ${factor.toFixed(4)})`);

console.log(process.exitCode ? "SMOKE TEST FAILED" : "SMOKE TEST PASSED");
