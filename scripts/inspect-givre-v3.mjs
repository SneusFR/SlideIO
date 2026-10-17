/**
 * Headless checks of the GIVRE v3 visual pipeline (same algorithm as
 * src/world/GivreMap.ts / GivreEffects, three.js in Node):
 *   - glb parses (EXT_texture_webp textures stubbed: no image decoder in Node);
 *   - 25 materials carry emissiveMap + aoMap; merge by material keeps uv → 22 meshes;
 *   - 1 clip of 8 s (linear), loop seamless at 8 s; 95 puffs → 6 InstancedMesh;
 *   - the 14 garland halo nodes are animated; snow triangles for footprints;
 *   - shadow camera fitted to the map seen from the sun → 2048 × 1024
 *     (GivreConfig.shadowMapSize, both presets).
 * Run: node scripts/inspect-givre-v3.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(root, "src/assets/MAP/Givre/givre_01.physics.json"), "utf8"));
const buf = readFileSync(join(root, "src/assets/MAP/Givre/givre_01.glb"));

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) failures++;
};

const loader = new GLTFLoader();
// No image decoder in Node: every texture image becomes an empty placeholder
// (registered plugins run in order; patching the parser covers EXT_texture_webp too).
// Stub one level down (loadImageSource, cached per image like the real one)
// so GLTFLoader's own texture sharing stays observable.
loader.register((parser) => {
  const cache = new Map();
  parser.loadImageSource = (sourceIndex) => {
    if (!cache.has(sourceIndex)) cache.set(sourceIndex, Promise.resolve(new THREE.Texture()));
    return cache.get(sourceIndex).then((t) => t.clone());
  };
  return { name: "STUB_IMAGE_SOURCES" };
});
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const gltf = await new Promise((res, rej) => loader.parse(ab, "", res, rej));
const scene = gltf.scene;
scene.updateMatrixWorld(true);

// ---- animated nodes ----
const nodes = new Map();
const animated = new Set();
for (const clip of gltf.animations) {
  for (const track of clip.tracks) {
    const { nodeName } = THREE.PropertyBinding.parseTrackName(track.name);
    const node = scene.getObjectByName(nodeName);
    if (!node || nodes.has(node.name)) continue;
    nodes.set(node.name, node);
    node.traverse((o) => animated.add(o));
  }
}
const clip = gltf.animations[0];
check(gltf.animations.length === 1 && Math.abs(clip.duration - 8) < 0.05, `1 clip, duration ${clip?.duration.toFixed(3)} s`);
let animatedMeshes = 0;
for (const n of nodes.values()) n.traverse((o) => o.isMesh && animatedMeshes++);
check(nodes.size >= 139, `${nodes.size} animated track targets, ${animatedMeshes} meshes under them (JSON: ${data.animations.animatedNodes} nodes)`);
// Every node listed as animated by the JSON is kept out of the merge (track
// target itself, or a child of one — e.g. VIE_Soupape under the boiler).
const notAnimated = data.animations.nodes.filter((name) => {
  const o = scene.getObjectByName(name);
  return !o || !animated.has(o);
});
check(notAnimated.length === 0, `all ${data.animations.nodes.length} JSON animated nodes excluded from the merge${notAnimated.length ? ` — missing: ${notAnimated.join(",")}` : ""}`);
const interp = new Set(clip.tracks.map((t) => t.getInterpolation()));
check(interp.size === 1 && interp.has(THREE.InterpolateLinear), "all tracks linear");

// ---- materials: baked light on uv ----
const mats = new Map();
scene.traverse((o) => o.isMesh && mats.set(o.material.name, o.material));
// Light SOURCES (lamps, fire, lanterns, bulbs) and the transparent steam /
// smoke carry no baked map: they are emissive by themselves.
const SELF_LIT = new Set(["GIV_Lampe", "GIV_Feu", "GIV_Lanterne", "GIV_AmpouleChaude", "GIV_AmpouleOrange", "GIV_Vapeur", "GIV_Fumee"]);
const unlitSurfaces = [...mats.values()].filter((m) => !SELF_LIT.has(m.name) && !(m.emissiveMap && m.aoMap));
const lit = [...mats.values()].filter((m) => m.emissiveMap && m.aoMap).length;
check(
  mats.size === 25 && unlitSurfaces.length === 0,
  `${mats.size} materials: ${lit} surfaces with emissiveMap + aoMap, ${SELF_LIT.size} self-lit / transparent without` +
    (unlitSurfaces.length ? ` — MISSING on ${unlitSurfaces.map((m) => m.name).join(",")}` : ""),
);
// GLTFLoader creates one Texture per glTF texture entry (36), all pointing at
// the 2 embedded images with the same sampler → three.js uploads each
// image ONCE (GPU textures are shared per Source + parameters).
const texObjs = [...mats.values()].flatMap((m) => [m.emissiveMap, m.aoMap]).filter(Boolean);
const sources = new Set(texObjs.map((t) => t.source.uuid));
check(sources.size === 2, `lightmaps: ${new Set(texObjs.map((t) => t.uuid)).size} Texture objects share ${sources.size} image sources (givre_lumiere + givre_ao, uploaded once)`);
const neige = mats.get("GIV_Neige");
check(neige && neige.emissiveIntensity > 1, `GIV_Neige emissiveIntensity ${neige?.emissiveIntensity.toFixed(3)} (KHR_materials_emissive_strength read)`);

// ---- merge by material (uv kept) ----
const byMat = new Map();
let staticTris = 0;
scene.traverse((o) => {
  if (!o.isMesh || animated.has(o)) return;
  const list = byMat.get(o.material) ?? [];
  list.push(o.geometry);
  byMat.set(o.material, list);
  const g = o.geometry;
  staticTris += (g.index ? g.index.count : g.attributes.position.count) / 3;
});
const missingUv = [...byMat.values()].flat().filter((g) => !g.attributes.uv).length;
check(byMat.size === 22, `${byMat.size} merged static meshes (expected 22), ${Math.round(staticTris)} static tris`);
check(missingUv === 0, `every static primitive has uv (${missingUv} missing)`);

// ---- instancing ----
const groups = new Map();
for (const node of nodes.values()) {
  if (!node.isMesh || node.children.length > 0) continue;
  const key = `${node.geometry.uuid}/${node.material.uuid}`;
  groups.set(key, (groups.get(key) ?? 0) + 1);
}
const inst = [...groups.values()].filter((n) => n >= 4);
const instTotal = inst.reduce((a, b) => a + b, 0);
check(inst.length === 6 && instTotal === 95, `${inst.length} InstancedMesh for ${instTotal} puffs`);
let animatedDraws = 0;
for (const n of nodes.values()) n.traverse((o) => o.isMesh && animatedDraws++);
console.log(`INFO map draw calls ≈ ${byMat.size} static + ${animatedDraws - instTotal} animated + ${inst.length} instanced = ${byMat.size + animatedDraws - instTotal + inst.length} (+ 15 halo Points, 1 snow, 1 footprints)`);

// ---- loop seamless: first key == last key on every track ----
// A track whose last key differs from its first jumps when the 8 s loop
// wraps. Reported per track (asset issue → fix in Blender, never here).
const seams = [];
for (const t of clip.tracks) {
  const n = t.getValueSize();
  const v = t.values;
  const isQuat = t.name.endsWith(".quaternion");
  let d = 0;
  if (isQuat) {
    // rotation angle between the first and last key (q and −q are equal)
    let dot = 0;
    for (let k = 0; k < 4; k++) dot += v[k] * v[v.length - 4 + k];
    d = 2 * Math.acos(Math.min(1, Math.abs(dot))) * (180 / Math.PI); // degrees
  } else {
    for (let k = 0; k < n; k++) d = Math.max(d, Math.abs(v[k] - v[v.length - n + k]));
  }
  if (d > (isQuat ? 0.1 : 0.001)) seams.push(`${t.name} (Δ ${d.toFixed(isQuat ? 1 : 3)}${isQuat ? "°" : " m"})`);
}
const seamless = clip.tracks.length - seams.length;
console.log(`INFO loop seam: ${seamless}/${clip.tracks.length} tracks end where they start`);
for (const s of seams) console.log(`WARN loop jump at 8 s — ${s} (glb asset, to fix in Blender)`);
// The mixer itself wraps continuously (LoopRepeat): time 8 s == time 0 s.
const mixer = new THREE.AnimationMixer(scene);
mixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
const snap = () => [...nodes.values()].map((n) => [...n.position.toArray(), ...n.quaternion.toArray()]);
mixer.setTime(0.5);
const a0 = snap();
mixer.setTime(8.5);
const a1 = snap();
let wrapDiff = 0;
a0.forEach((v, i) => v.forEach((x, k) => (wrapDiff = Math.max(wrapDiff, Math.abs(x - a1[i][k])))));
check(wrapDiff < 1e-4, `mixer LoopRepeat wraps on 8 s (pose at 0.5 s == pose at 8.5 s, Δ ${wrapDiff.toExponential(1)})`);

// ---- halos: garland nodes animated ----
const missingHalo = data.halos.nodes.filter((g) => !nodes.has(g.node));
check(missingHalo.length === 0, `${data.halos.nodes.length} garland halo nodes animated (${missingHalo.map((g) => g.node).join(",") || "all found"})`);
const haloCount = data.halos.static.length + data.halos.nodes.reduce((s, g) => s + g.points.length, 0);
check(haloCount === 647, `${haloCount} halo sprites`);

// ---- snow triangles (footprints) ----
let snowTris = 0;
for (const [m, geoms] of byMat) {
  if (m.name !== "GIV_Neige") continue;
  for (const g of geoms) snowTris += (g.index ? g.index.count : g.attributes.position.count) / 3;
}
check(snowTris > 1000, `${snowTris} GIV_Neige triangles indexed for footprints`);

// ---- snow levels ----
const sn = data.snow;
const vol = sn.boxSize[0] * sn.boxSize[1] * sn.boxSize[2];
const counts = ["legere", "normale", "dense"].map((k) => Math.round(sn.density * vol * sn.levels[k]));
console.log(`INFO snow flakes: legere ${counts[0]}, normale ${counts[1]}, dense ${counts[2]}`);

// ---- shadow camera fit ----
const s = data.lighting.sun.directionToSun;
const bounds = new THREE.Box3(new THREE.Vector3(-140, -1, -140), new THREE.Vector3(140, 21, 80));
const center = bounds.getCenter(new THREE.Vector3()).setY(0);
const cam = new THREE.OrthographicCamera();
cam.position.copy(center).addScaledVector(new THREE.Vector3(...s).normalize(), 300);
cam.lookAt(center);
cam.updateMatrixWorld(true);
const box = new THREE.Box3();
for (let i = 0; i < 8; i++) {
  const c = new THREE.Vector3(i & 1 ? 140 : -140, i & 2 ? 21 : -1, i & 4 ? 80 : -140);
  box.expandByPoint(c.applyMatrix4(cam.matrixWorldInverse));
}
const w = box.max.x - box.min.x + 4;
const h = box.max.y - box.min.y + 4;
const side = (size, r) => Math.min(size, 2 ** Math.ceil(Math.log2(size * Math.min(1, r))));
console.log(`INFO shadow frustum ${w.toFixed(0)} × ${h.toFixed(0)} m → ${side(2048, w / h)} × ${side(2048, h / w)} (${((w / 2048) * 100).toFixed(1)} cm/texel)`);
check(side(2048, w / h) === 2048 && side(2048, h / w) === 1024, "shadow map 2048 × 1024 (HIGH and LOW)");

if (failures > 0) {
  console.error(`\n${failures} GIVRE v3 visual check(s) failed`);
  process.exit(1);
}
console.log("\nAll GIVRE v3 visual checks passed.");

