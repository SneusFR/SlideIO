// Detailed GLB animation inspector: per-channel target/path, times, and
// value ranges — used to diagnose parasite motion (root motion, flips).
import { readFileSync } from "node:fs";

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

for (const file of process.argv.slice(2)) {
  const buf = readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString("utf8", 20, 20 + jsonLen));
  // Find the BIN chunk (follows the JSON chunk, 4-byte aligned).
  let off = 20 + jsonLen;
  off += (4 - (off % 4)) % 4;
  const binLen = buf.readUInt32LE(off);
  const binType = buf.toString("ascii", off + 4, off + 8);
  const bin = binType.startsWith("BIN") ? buf.subarray(off + 8, off + 8 + binLen) : null;

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
    console.log(`animation: ${anim.name}`);
    for (const ch of anim.channels) {
      const sampler = anim.samplers[ch.sampler];
      const nodeName = json.nodes[ch.target.node]?.name ?? `#${ch.target.node}`;
      const path = ch.target.path;
      const input = readAccessor(sampler.input);
      const output = readAccessor(sampler.output);
      const t0 = input.values[0];
      const t1 = input.values[input.count - 1];
      const c = output.comp;
      const first = Array.from(output.values.slice(0, c)).map((v) => v.toFixed(3));
      const last = Array.from(output.values.slice((output.count - 1) * c)).map((v) =>
        v.toFixed(3),
      );
      // Min/max per component to catch large swings.
      const min = new Array(c).fill(Infinity);
      const max = new Array(c).fill(-Infinity);
      for (let i = 0; i < output.count; i++) {
        for (let j = 0; j < c; j++) {
          const v = output.values[i * c + j];
          if (v < min[j]) min[j] = v;
          if (v > max[j]) max[j] = v;
        }
      }
      console.log(
        `  ${nodeName}.${path} interp=${sampler.interpolation || "LINEAR"} keys=${input.count} t=[${t0.toFixed(2)},${t1.toFixed(2)}]`,
      );
      console.log(`     first=[${first}] last=[${last}]`);
      console.log(
        `     min=[${min.map((v) => v.toFixed(3))}] max=[${max.map((v) => v.toFixed(3))}]`,
      );
    }
  }
}