// Dump the Hips.translation keyframes (time → x,y,z) of a GLB animation.
import { readFileSync } from "node:fs";

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

for (const file of process.argv.slice(2)) {
  const buf = readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString("utf8", 20, 20 + jsonLen));
  let off = 20 + jsonLen;
  off += (4 - (off % 4)) % 4;
  const binLen = buf.readUInt32LE(off);
  const bin = buf.subarray(off + 8, off + 8 + binLen);

  const readAccessor = (idx) => {
    const acc = json.accessors[idx];
    const bv = json.bufferViews[acc.bufferView];
    const comp = COMPONENTS[acc.type];
    const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const out = new Float32Array(acc.count * comp);
    for (let i = 0; i < out.length; i++) out[i] = bin.readFloatLE(start + i * 4);
    return { values: out, comp, count: acc.count };
  };

  console.log(`\n=== ${file} ===`);
  for (const anim of json.animations || []) {
    for (const ch of anim.channels) {
      const nodeName = json.nodes[ch.target.node]?.name ?? "";
      if (nodeName !== "Hips" || ch.target.path !== "translation") continue;
      const sampler = anim.samplers[ch.sampler];
      const input = readAccessor(sampler.input);
      const output = readAccessor(sampler.output);
      const dur = input.values[input.count - 1];
      console.log(`animation: ${anim.name} (duration ${dur.toFixed(2)}s)`);
      for (let i = 0; i < input.count; i++) {
        const t = input.values[i];
        const x = output.values[i * 3];
        const y = output.values[i * 3 + 1];
        const z = output.values[i * 3 + 2];
        console.log(
          `  t=${t.toFixed(3)} (${((t / dur) * 100).toFixed(1)}%)  x=${x.toFixed(1)} y=${y.toFixed(1)} z=${z.toFixed(1)}`,
        );
      }
    }
  }
}