// Inspection of the Potato Astronaut cosmetic pack GLBs: node names,
// mesh/material names, transparency flags, skinning + socket contract.
// Usage: node scripts/inspect-astronaut.mjs
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
  return new Promise((resolve, reject) => new GLTFLoader().parse(ab, "", resolve, reject));
}

const base = process.argv[2] ?? "src/cosmetics/astronaut/assets/";
for (const file of ["Astronaut_TP_Clothing.glb", "Astronaut_FP_Clothing.glb", "Astronaut_Helmet.glb", "Astronaut_Backpack.glb"]) {
  const gltf = await load(base + file);
  console.log(`\n=== ${file} === animations: ${gltf.animations.length}`);
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    const kind = o.isBone ? "Bone" : o.isSkinnedMesh ? "SkinnedMesh" : o.isMesh ? "Mesh" : o.type;
    let extra = "";
    if (o.isMesh) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      extra = " mats=" + mats.map((m) => `${m.name}[${m.type} transparent=${m.transparent} opacity=${m.opacity} side=${m.side} depthWrite=${m.depthWrite} alphaMode=${m.userData?.gltfExtensions ? "ext" : "-"} emissive=${m.emissive ? m.emissive.getHexString() : "-"}]`).join(", ");
      extra += ` tris=${o.geometry.index ? o.geometry.index.count / 3 : o.geometry.attributes.position.count / 3} groups=${o.geometry.groups.length}`;
      if (o.isSkinnedMesh) extra += ` bones=${o.skeleton.bones.length}`;
    }
    console.log(`${"  ".repeat(depth(o))}${kind} "${o.name}" pos=${o.position.toArray().map((v) => v.toFixed(3)).join(",")} scale=${o.scale.toArray().map((v) => v.toFixed(3)).join(",")}${extra}`);
  });
}
function depth(o) { let d = 0; while (o.parent) { d++; o = o.parent; } return d; }

// Reference rig sockets
const tp = await load("src/assets/potato/Potato_TP_Character.glb");
console.log("\n=== Potato_TP_Character bodies + sockets ===");
tp.scene.traverse((o) => {
  if (o.isMesh) console.log(`mesh "${o.name}" skinned=${!!o.isSkinnedMesh} mats=${(Array.isArray(o.material) ? o.material : [o.material]).map((m) => m.name).join(",")} groups=${o.geometry.groups.length}`);
  if (/Socket/.test(o.name)) console.log(`socket "${o.name}" parent=${o.parent?.name}`);
});
const fp = await load("src/assets/potato/Potato_FP_CommonArms.glb");
console.log("\n=== Potato_FP_CommonArms ===");
fp.scene.traverse((o) => {
  if (o.isMesh) console.log(`mesh "${o.name}" skinned=${!!o.isSkinnedMesh} mats=${(Array.isArray(o.material) ? o.material : [o.material]).map((m) => m.name).join(",")}`);
});
