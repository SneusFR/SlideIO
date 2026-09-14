// Headless (Node) integration test of the Potato Astronaut outfit on the
// REAL game assets: TP character clone + FP arms clone, library.apply with
// the game's presentation hooks, corpse snapshot, removal/restoration,
// invalid-target failure. CPU only (no WebGL) — visual checks are done in
// the running game. Usage (from the repo root):
//   npx --prefix backend tsx scripts/test-astronaut-outfit.mts
import fs from "node:fs";
import assert from "node:assert/strict";
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";

// ---- Browser shims for GLTFLoader / fetch of local files ----
const g = globalThis as unknown as Record<string, unknown>;
g.self = globalThis;
if (!URL.createObjectURL) (URL as unknown as Record<string, unknown>).createObjectURL = () => "blob:stub";
if (!URL.revokeObjectURL) (URL as unknown as Record<string, unknown>).revokeObjectURL = () => {};
g.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
THREE.TextureLoader.prototype.load = function (_url: string, onLoad?: (t: THREE.Texture) => void) {
  const tex = new THREE.Texture();
  if (onLoad) setTimeout(() => onLoad(tex), 0);
  return tex;
} as typeof THREE.TextureLoader.prototype.load;
// file:// fetch for GLTFLoader.loadAsync + masks.json
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("file://")) {
    const path = decodeURIComponent(new URL(url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    return new Response(fs.readFileSync(path), { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

const { loadAstronautCosmetics } = await import("../src/cosmetics/astronaut/runtime/AstronautCosmetics.ts");
const {
  CHARACTER_COSMETIC_SLOTS,
  encodeCharacterCosmetics,
  decodeCharacterCosmetics,
  validateCharacterCosmetics,
  sanitizeCharacterCosmetics,
} = await import("../shared/combat/CharacterCosmetics.ts");

function loadGlb(file: string): Promise<GLTF> {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((resolve, reject) => new GLTFLoader().parse(ab, "", resolve, reject));
}

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✔ ${name}`);
}

// ---- Shared contract ----
console.log("shared/combat/CharacterCosmetics");
check("encode/decode round trip", () => {
  const sel = { hats: "astronaut_helmet", tops: "astronaut_top" };
  const enc = encodeCharacterCosmetics(sel);
  assert.equal(enc, "hats:astronaut_helmet,tops:astronaut_top");
  assert.deepEqual(decodeCharacterCosmetics(enc), sel);
});
check("strict validation refuses unknown slot / id / junk", () => {
  assert.equal(validateCharacterCosmetics({ face: "astronaut_visor" }), null);
  assert.equal(validateCharacterCosmetics({ hats: "../../evil.glb" }), null);
  assert.equal(validateCharacterCosmetics("hats:astronaut_helmet"), null);
  assert.equal(validateCharacterCosmetics([]), null);
  assert.deepEqual(validateCharacterCosmetics({ hats: "astronaut_helmet", bags: "" }), { hats: "astronaut_helmet" });
});
check("lenient sanitizer drops the draft face entry, keeps valid slots", () => {
  assert.deepEqual(sanitizeCharacterCosmetics({ face: "astronaut_visor", shoes: "astronaut_shoes", pants: 42 }), { shoes: "astronaut_shoes" });
});
check("oversized decode falls back to base", () => {
  assert.deepEqual(decodeCharacterCosmetics("hats:astronaut_helmet,".repeat(50)), {});
});

// ---- Library on the real assets ----
console.log("Astronaut library (real GLBs + masks.json)");
const base = new URL("../src/cosmetics/astronaut/assets/", import.meta.url).href;
const library = await loadAstronautCosmetics({
  assetURLs: {
    tpClothing: base + "Astronaut_TP_Clothing.glb",
    fpClothing: base + "Astronaut_FP_Clothing.glb",
    helmet: base + "Astronaut_Helmet.glb",
    backpack: base + "Astronaut_Backpack.glb",
  },
  masksUrl: base + "masks.json",
});
check("library loaded", () => assert.equal(library.disposed, false));

const tp = await loadGlb("src/assets/potato/Potato_TP_Character.glb");
const fp = await loadGlb("src/assets/potato/Potato_FP_CommonArms.glb");
// Mimic PotatoCharacter: normalize + outline hulls on the template, then clone.
const model = tp.scene;
model.scale.setScalar(2.693);
model.rotation.y = Math.PI;
const skinnedParts: THREE.SkinnedMesh[] = [];
model.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinnedParts.push(o as THREE.SkinnedMesh); });
const outlineMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide });
for (const src of skinnedParts) {
  const outline = new THREE.SkinnedMesh(src.geometry, outlineMat);
  outline.bind(src.skeleton, src.bindMatrix);
  outline.userData.enemyOutline = true;
  src.parent!.add(outline);
}
const template = new THREE.Group();
template.add(model);

const countBy = (root: THREE.Object3D, pred: (o: THREE.Object3D) => boolean) => {
  let n = 0;
  root.traverse((o) => { if (pred(o)) n++; });
  return n;
};
const bodyOf = (root: THREE.Object3D, name: string) => {
  let found: THREE.SkinnedMesh | null = null;
  root.traverse((o) => { if (o.name === name && !o.userData.astronautCosmetic && !found) found = o as THREE.SkinnedMesh; });
  return found!;
};

const avatar = skeletonClone(template);
const body = bodyOf(avatar, "Potato");
const baseGeometry = body.geometry;
const baseBones = countBy(avatar, (o) => (o as THREE.Bone).isBone);
const baseTris = baseGeometry.index!.count / 3;

const hooked: { mesh: THREE.Mesh; slot: string }[] = [];
let cleanups = 0;
const hook = (mesh: THREE.Mesh, slot: string) => {
  hooked.push({ mesh, slot });
  return () => { cleanups++; };
};

let handle = library.apply(avatar, ["hats"], { context: "tp", onMeshAdded: hook });
check("hats alone = HelmetSeal (skinned) + Astro_Helmet (rigid, 2 sub-meshes) on Head_Socket", () => {
  const names = hooked.map((h) => h.mesh.name).sort();
  assert.deepEqual(names, ["Astro_HelmetSeal", "Astro_Helmet_1", "Astro_Helmet_2"]);
  const helmetRoot = avatar.getObjectByName("Astronaut_hats")!;
  assert.equal(helmetRoot.parent!.name, "Head_Socket");
  assert.ok(helmetRoot.matrix.equals(new THREE.Matrix4()), "identity at socket");
  const seal = hooked.find((h) => h.mesh.name === "Astro_HelmetSeal")!.mesh as THREE.SkinnedMesh;
  assert.equal(seal.skeleton, body.skeleton, "seal bound to the LIVE skeleton");
  assert.equal(seal.parent, body.parent);
  const visor = hooked.find((h) => h.mesh.name === "Astro_Helmet_2")!.mesh;
  assert.equal((visor.material as THREE.Material).transparent, true, "visor stays transparent");
  assert.equal((visor.material as THREE.Material).depthWrite, false);
  assert.equal(countBy(avatar, (o) => (o as THREE.Bone).isBone), baseBones, "no second armature");
  assert.equal(body.geometry, baseGeometry, "hats mask is empty → body geometry untouched");
});

hooked.length = 0;
handle = library.apply(avatar, ["hats", "tops", "pants", "shoes", "bags"], { context: "tp", onMeshAdded: hook });
check("full outfit replaces the previous handle atomically", () => {
  assert.equal(cleanups, 3, "previous hooks cleaned");
  const names = hooked.map((h) => h.mesh.name).sort();
  assert.deepEqual(names, ["Astro_Backpack", "Astro_Boots", "Astro_HelmetSeal", "Astro_Helmet_1", "Astro_Helmet_2", "Astro_Pants", "Astro_Top"]);
  assert.equal(avatar.getObjectByName("Astronaut_bags")!.parent!.name, "Back_Socket");
  assert.notEqual(body.geometry, baseGeometry, "body masked");
  assert.equal(body.geometry.index!.count / 3, baseTris - 3255, "3255 hidden triangles (union of tops/pants/shoes)");
  assert.equal(body.geometry.getAttribute("position"), baseGeometry.getAttribute("position"), "position buffer shared");
  let outlineMasked = 0;
  avatar.traverse((o) => { if (o.userData.enemyOutline && (o as THREE.Mesh).geometry === body.geometry) outlineMasked++; });
  assert.equal(outlineMasked, 1, "outline duplicate masked too");
});

const avatar2 = skeletonClone(template);
const handle2 = library.apply(avatar2, ["tops", "pants", "shoes"], { context: "tp" });
check("two avatars: private materials, shared geometries", () => {
  const top1 = avatar.getObjectByName("Astro_Top") as THREE.Mesh;
  const top2 = avatar2.getObjectByName("Astro_Top") as THREE.Mesh;
  assert.notEqual(top1.material, top2.material);
  assert.equal(top1.geometry, top2.geometry);
  assert.equal(bodyOf(avatar2, "Potato").geometry, body.geometry, "same masked geometry (cache)");
});

check("corpse snapshot keeps the outfit, one skeleton, first-bone lookup stable", () => {
  const corpse = skeletonClone(avatar);
  assert.equal(countBy(corpse, (o) => (o as THREE.Bone).isBone), baseBones);
  assert.ok(corpse.getObjectByName("Astro_Top"));
  assert.ok(corpse.getObjectByName("Astronaut_hats"));
  const seal = corpse.getObjectByName("Astro_HelmetSeal") as THREE.SkinnedMesh;
  const cBody = bodyOf(corpse, "Potato");
  assert.equal(seal.skeleton.bones[0], cBody.skeleton.bones[0], "seal rides the corpse's own bones");
  assert.equal(cBody.geometry, body.geometry, "masked geometry shared with the corpse");
  handle.dispose();
  assert.equal(body.geometry, baseGeometry, "living body restored");
  assert.equal(avatar.getObjectByName("Astro_Top"), undefined);
  assert.equal(cBody.geometry.index!.count / 3, baseTris - 3255, "corpse still masked after the avatar undressed");
  assert.ok(corpse.getObjectByName("Astro_Top"));
});

check("invalid apply keeps the previous outfit", () => {
  const before = avatar2.getObjectByName("Astro_Top") as THREE.Mesh;
  const beforeGeo = bodyOf(avatar2, "Potato").geometry;
  assert.throws(() => library.apply(avatar2, ["hats", "tops"], { context: "tp", onMeshAdded: () => { throw new Error("hook boom"); } }), /hook boom/);
  assert.equal(avatar2.getObjectByName("Astro_Top"), before, "previous top intact");
  assert.equal(bodyOf(avatar2, "Potato").geometry, beforeGeo);
  assert.equal(avatar2.getObjectByName("Astronaut_hats"), undefined, "no partial helmet");
  assert.equal(handle2.disposed, false);
  const avatar3 = skeletonClone(template);
  const b3 = bodyOf(avatar3, "Potato");
  b3.geometry = b3.geometry.clone();
  (b3.geometry.getAttribute("position") as THREE.BufferAttribute).setX(0, 42);
  assert.throws(() => library.apply(avatar3, ["tops"], { context: "tp" }), /differs from the approved source/);
  assert.equal(avatar3.getObjectByName("Astro_Top"), undefined);
});

check("FP context: Astro_Sleeves only, bound to the arms skeleton", () => {
  const arms = skeletonClone(fp.scene);
  const armsBody = bodyOf(arms, "FP_Arms");
  const added: string[] = [];
  const h = library.apply(arms, ["hats", "tops", "pants", "shoes", "bags"], { context: "fp", onMeshAdded: (m) => { added.push(m.name); } });
  assert.deepEqual(added, ["Astro_Sleeves"]);
  const sleeves = arms.getObjectByName("Astro_Sleeves") as THREE.SkinnedMesh;
  assert.equal(sleeves.skeleton, armsBody.skeleton);
  assert.equal(armsBody.geometry.index!.count / 3, 2209 - 529);
  h.dispose();
  assert.equal(armsBody.geometry.index!.count / 3, 2209, "arms restored");
});

check("skinned clothing shares the live skeleton under animation", () => {
  const dressed = skeletonClone(template);
  library.apply(dressed, ["tops"], { context: "tp" });
  const mixer = new THREE.AnimationMixer(dressed);
  mixer.clipAction(tp.animations.find((c) => c.name === "Run_Goofy")!).play();
  mixer.update(0.37);
  dressed.updateMatrixWorld(true);
  const top = dressed.getObjectByName("Astro_Top") as THREE.SkinnedMesh;
  const b = bodyOf(dressed, "Potato");
  assert.equal(top.skeleton, b.skeleton);
  const v = new THREE.Vector3();
  top.getVertexPosition(0, v);
  assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z));
  mixer.stopAllAction();
});

handle2.dispose();
console.log(`\n${passed} checks passed. slots=${CHARACTER_COSMETIC_SLOTS.join(",")} activeHandles=${library.activeCount}`);
