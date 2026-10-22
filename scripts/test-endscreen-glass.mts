/**
 * End screen — the shattered glass and its cracks are built in the frame
 * where the match ends: buildGlassFast / buildCracksFast (typed arrays,
 * numeric edge keys — Intro3D.fastGlass) must give EXACTLY the geometry of
 * the original buildGlass / buildCracks — every
 * attribute value bit for bit (float32 rounding, -0 included), the same index
 * type and values, the same shards and bounds, the same Math.random-style
 * draws (the shard shapes and motions come from them) — on many seeds,
 * screen shapes, both modes and both densities.
 * Run: tsx scripts/test-endscreen-glass.mts
 */
import assert from "node:assert/strict";
import * as THREE from "three";
// Plain JS modules of the end screen (no type declarations for these internals).
// @ts-ignore
import { buildGlassReference, buildGlassFast, buildCracksReference, buildCracksFast } from "../src/endscreen/Intro3D.js";
// @ts-ignore
import { rng } from "../src/endscreen/anim.js";

type Glass = { geo: THREE.BufferGeometry; polys: number[][][]; maxR: number; ex: number; ey: number; count: number };
const hh = 20 * Math.tan(THREE.MathUtils.degToRad(20)); // CAM_Z × tan(FOV / 2), as in Intro3D.start
let cases = 0;
let draws = 0;
let crackQuads = 0;
let tRef = 0;
let tFast = 0;
for (const aspect of [16 / 9, 1920 / 928, 1.6, 4 / 3, 21 / 9, 0.56]) {
  const hw = hh * aspect;
  for (const mode of ["victory", "defeat"]) {
    for (const density of [1, 0.75]) {
      for (let seed = 1; seed <= 20; seed++) {
        const impact = mode === "victory" ? [0, hh * 0.08] : [hw * 0.16, hh * 0.2];
        const s = (seed * 2654435761) >>> 0;
        // count the draws of each builder: they must consume the same sequence
        let nA = 0;
        let nB = 0;
        const ra = rng(s);
        const rb = rng(s);
        let t0 = performance.now();
        const a: Glass = buildGlassReference({ hw, hh, impact, mode, R: () => (nA++, ra()), density, thickness: 0.07 });
        tRef += performance.now() - t0;
        t0 = performance.now();
        const b: Glass = buildGlassFast({ hw, hh, impact, mode, R: () => (nB++, rb()), density, thickness: 0.07 });
        tFast += performance.now() - t0;
        const where = `${mode} aspect ${aspect.toFixed(3)} density ${density} seed ${seed}`;
        assert.equal(nB, nA, `same number of random draws (${where})`);
        assert.equal(rb(), ra(), `generators left in the same state (${where})`);
        assert.deepEqual([b.count, b.maxR, b.ex, b.ey], [a.count, a.maxR, a.ex, a.ey], `shards and bounds (${where})`);
        assert.deepEqual(b.polys, a.polys, `shard outlines (${where})`);
        const names = Object.keys(a.geo.attributes);
        assert.deepEqual(Object.keys(b.geo.attributes), names, `attribute list (${where})`);
        for (const name of names) {
          const x = a.geo.attributes[name] as THREE.BufferAttribute;
          const y = b.geo.attributes[name] as THREE.BufferAttribute;
          assert.equal(y.itemSize, x.itemSize, `${name} item size (${where})`);
          assert.equal(y.normalized, x.normalized, `${name} normalized (${where})`);
          assert.equal(y.array.constructor, x.array.constructor, `${name} array type (${where})`);
          assert.equal(y.array.length, x.array.length, `${name} length (${where})`);
          for (let i = 0; i < x.array.length; i++) {
            if (!Object.is(y.array[i], x.array[i])) assert.fail(`${name}[${i}]: ${y.array[i]} vs ${x.array[i]} (${where})`);
          }
        }
        const ix = a.geo.index!.array;
        const iy = b.geo.index!.array;
        assert.equal(iy.constructor, ix.constructor, `index type (${where})`);
        assert.deepEqual(Array.from(iy), Array.from(ix), `index values (${where})`);
        assert.deepEqual(b.geo.boundingSphere, a.geo.boundingSphere, `bounding sphere (${where})`);
        // cracks of these shards (the screen height in pixels sets their width)
        for (const px of [540, 1080, 1160]) {
          const halfWidth = ((2 * hh) / px) * 2.2;
          let cA = 0;
          let cB = 0;
          const qa = rng(s ^ 0x9e3779b9);
          const qb = rng(s ^ 0x9e3779b9);
          const ca: THREE.BufferGeometry = buildCracksReference({ polys: a.polys, impact, ex: a.ex, ey: a.ey, halfWidth, R: () => (cA++, qa()) });
          const cb: THREE.BufferGeometry = buildCracksFast({ polys: a.polys, impact, ex: a.ex, ey: a.ey, halfWidth, R: () => (cB++, qb()) });
          assert.equal(cB, cA, `cracks: same number of random draws (${where}, ${px} px)`);
          const cn = Object.keys(ca.attributes);
          assert.deepEqual(Object.keys(cb.attributes), cn, `cracks: attribute list (${where})`);
          for (const name of cn) {
            const x = ca.attributes[name] as THREE.BufferAttribute;
            const y = cb.attributes[name] as THREE.BufferAttribute;
            assert.equal(y.itemSize, x.itemSize, `cracks ${name} item size (${where})`);
            assert.equal(y.array.constructor, x.array.constructor, `cracks ${name} array type (${where})`);
            assert.equal(y.array.length, x.array.length, `cracks ${name} length (${where})`);
            for (let i = 0; i < x.array.length; i++) {
              if (!Object.is(y.array[i], x.array[i])) assert.fail(`cracks ${name}[${i}]: ${y.array[i]} vs ${x.array[i]} (${where})`);
            }
          }
          assert.equal(cb.index!.array.constructor, ca.index!.array.constructor, `cracks index type (${where})`);
          assert.deepEqual(Array.from(cb.index!.array), Array.from(ca.index!.array), `cracks index values (${where})`);
          crackQuads += (ca.index!.count / 6) | 0;
          ca.dispose();
          cb.dispose();
        }
        a.geo.dispose();
        b.geo.dispose();
        cases++;
        draws += nA;
      }
    }
  }
}
console.log(`test-endscreen-glass: OK (${cases} glasses and ${cases * 3} crack sets — ${crackQuads} crack quads, ${draws} random draws — identical; glass ${(tRef / cases).toFixed(2)} → ${(tFast / cases).toFixed(2)} ms per build)`);
