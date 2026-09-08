import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
globalThis.self = globalThis;
if (!globalThis.URL.createObjectURL) globalThis.URL.createObjectURL = () => "blob:stub";
if (!globalThis.URL.revokeObjectURL) globalThis.URL.revokeObjectURL = () => {};
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
THREE.TextureLoader.prototype.load = function (_url, onLoad) { const t = new THREE.Texture(); if (onLoad) setTimeout(() => onLoad(t), 0); return t; };
THREE.ImageBitmapLoader.prototype.load = function (_url, onLoad) { if (onLoad) setTimeout(() => onLoad({ width: 1, height: 1, close() {} }), 0); };
const buf = readFileSync("src/assets/potato/Potato_TP_Character.glb");
const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");
const lines = [];
const skels = new Set();
gltf.scene.traverse((o) => {
  if (o.isSkinnedMesh) {
    skels.add(o.skeleton);
    const g = o.geometry;
    lines.push(
      `${o.name} parent=${o.parent.name} pos=${o.position.toArray().map(v=>v.toFixed(3))} q=${o.quaternion.toArray().map(v=>v.toFixed(3))} s=${o.scale.toArray().map(v=>v.toFixed(3))} ` +
      `attrs=${Object.keys(g.attributes)} indexed=${!!g.index} idxCount=${g.index?.count} groups=${g.groups.length} ` +
      `bind=${o.bindMatrix.elements.map(v=>v.toFixed(3))} bindMode=${o.bindMode}`,
    );
  }
});
lines.push(`distinct skeletons: ${skels.size}`);
writeFileSync("scripts/tmp-inspect-mats.txt", lines.join("\n"));
