// One-off inspector: mesh POSITION bounds + rest-pose bone world heights
// (Hips/Spine/neck/Head chain) — used to derive hitbox proportions for a
// new character model, plus animation durations.
import { readFileSync } from "node:fs";

for (const file of process.argv.slice(2)) {
  const buf = readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString("utf8", 20, 20 + jsonLen));

  console.log(`\n=== ${file} ===`);

  // Mesh POSITION accessor min/max (glTF stores them in the accessor).
  for (const mesh of json.meshes || []) {
    for (const prim of mesh.primitives) {
      const acc = json.accessors[prim.attributes.POSITION];
      console.log(
        `mesh ${mesh.name}: min=[${acc.min.map((v) => v.toFixed(3))}] max=[${acc.max.map((v) => v.toFixed(3))}]`,
      );
    }
  }

  // Rest-pose node chain: accumulate translation up from each named bone.
  const nodes = json.nodes || [];
  const parentOf = new Map();
  nodes.forEach((n, i) => (n.children || []).forEach((c) => parentOf.set(c, i)));
  const restWorldY = (idx) => {
    let y = 0;
    let cur = idx;
    let scale = 1;
    while (cur !== undefined) {
      const n = nodes[cur];
      const t = n.translation || [0, 0, 0];
      const s = n.scale || [1, 1, 1];
      y = y * s[1] + t[1];
      scale *= s[1];
      cur = parentOf.get(cur);
    }
    return { y, scale };
  };
  nodes.forEach((n, i) => {
    if (/^(Hips|Spine|Spine01|Spine02|neck|Head|head_end|headfront)$/.test(n.name || "")) {
      const { y } = restWorldY(i);
      console.log(`bone ${n.name}: restWorldY=${y.toFixed(3)} local t=[${(n.translation || []).map((v) => v.toFixed(3))}]`);
    }
  });

  for (const anim of json.animations || []) {
    let maxT = 0;
    for (const s of anim.samplers) {
      const acc = json.accessors[s.input];
      if (acc.max && acc.max[0] > maxT) maxT = acc.max[0];
    }
    console.log(`animation ${anim.name}: duration ${maxT.toFixed(2)}s`);
  }
}