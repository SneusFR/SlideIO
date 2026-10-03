// PROBE (diagnostic, read-only): which map meshes can intercept a paintball ray? Three's Raycaster ignores `visible`, so
// an invisible / fully transparent mesh in map.group would silently stop shots. Headless: parses the real map GLBs.
// Usage: npx --prefix backend tsx scripts/probe-map-hittables.mts
import fs from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { fileURLToPath } from "node:url";

const g = globalThis as unknown as Record<string, unknown>;
g.self = globalThis;
g.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
const project = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/").replace(/\/$/, "");

const maps: [string, string][] = [
  ["JUNGLE", "src/assets/MAP/ancient_jungle_city.glb"],
  ["YARD", "src/assets/MAP/Yard/yard_01.glb"],
  ["GIVRE", "src/assets/MAP/Givre/givre_01.glb"],
];
for (const [name, file] of maps) {
  const b = fs.readFileSync(`${project}/${file}`);
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, "");
  let meshes = 0, hiddenSelf = 0, hiddenAncestor = 0, matInvisible = 0, transparent = 0, zeroOpacity = 0, tris = 0;
  const flagged: string[] = [];
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    meshes++;
    const idx = m.geometry.index;
    tris += (idx ? idx.count : m.geometry.attributes.position.count) / 3;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    let anc: THREE.Object3D | null = m.parent;
    let ancHidden = false;
    while (anc) { if (!anc.visible) ancHidden = true; anc = anc.parent; }
    const why: string[] = [];
    if (!m.visible) { hiddenSelf++; why.push("mesh.visible=false"); }
    if (ancHidden) { hiddenAncestor++; why.push("hidden ancestor"); }
    if (mats.every((x) => x.visible === false)) { matInvisible++; why.push("material.visible=false"); }
    if (mats.every((x) => x.transparent)) transparent++;
    if (mats.every((x) => x.transparent && x.opacity <= 0.01)) { zeroOpacity++; why.push("opacity~0"); }
    if (why.length) flagged.push(`${m.name || "(unnamed)"} [${why.join(", ")}] tris=${idx ? idx.count / 3 : "-"}`);
  });
  console.log(`${name}: ${meshes} meshes, ${Math.round(tris)} tris | invisible mesh ${hiddenSelf}, hidden ancestor ${hiddenAncestor}, material.visible=false ${matInvisible}, all-transparent ${transparent}, opacity~0 ${zeroOpacity}`);
  for (const f of flagged.slice(0, 15)) console.log(`   hittable but not drawn: ${f}`);
}
