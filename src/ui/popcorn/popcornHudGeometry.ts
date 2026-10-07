import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Popcorn HUD mechanism — geometry + materials of the little 3D popcorn
 * machine drawn on the left edge of the Popcorn plate (see PopcornMechanism.ts).
 * Built ONCE, shared by every mesh (grains of one silhouette share one
 * geometry, every grain shares one material).
 *
 * Units: 1 world unit ≈ 1 plate pixel (the plate is authored at 170 × 72 and
 * zoomed by CSS). Y up, origin on the vertical axis of the machine, +z = camera.
 *
 *            ◖●◗            ← hinged red lid (tilts on a shot, opens on a reload)
 *         ┌────────┐
 *         │ ░░░░░░ │        ← transparent window, grains = the real loads
 *         └────────┘        ← red satin frame (4 uprights, top rim)
 *         ▔▔▔▔▔▔▔▔▔▔        ← ivory base
 */
export const POPCORN_HUD_COLORS = {
  red: 0xd8322c,
  ivory: 0xf6ecd6,
  cream: 0xfff1c9,
  golden: 0xe9b04a,
  toasted: 0xb8741f,
  butter: 0xffd57a,
} as const;

const C = POPCORN_HUD_COLORS;

/** Window (glass box) size and the y of its bottom. */
export const WIN = { w: 24, h: 24, d: 16, y0: -15 } as const;
/** Lid hinge (back edge of the top rim); the lid extends toward the camera from here. */
export const LID_HINGE = new THREE.Vector3(0, 11.6, -9.5);
/** Lid thickness and the y of its top face at rest (the grains leave from here). */
export const LID_T = 2.8;
export const LID_TOP_Y = LID_HINGE.y + LID_T;
export const LID_D = 19;
/** Number of reusable grain silhouettes (shared geometries). */
export const GRAIN_VARIANTS = 4;

/** Tiny deterministic PRNG (mulberry32): the same silhouettes on every machine. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One irregular, multi-lobed grain: a central body plus 4–6 overlapping lobes
 * (merged ellipsoids), displaced by a cheap porous noise, with vertex colours
 * (cream → golden in the crevices, toasted at the base). ≈ 8 px wide.
 */
function grainGeometry(variant: number): THREE.BufferGeometry {
  const rnd = prng(0x9c0a31 + variant * 7919);
  const parts: THREE.BufferGeometry[] = [];
  const lobes = 4 + (variant % 3);
  const make = (r: number, x: number, y: number, z: number, sy: number): void => {
    const g = new THREE.IcosahedronGeometry(r, 2);
    g.deleteAttribute("normal");
    g.deleteAttribute("uv");
    g.scale(1, sy, 1);
    g.translate(x, y, z);
    parts.push(g);
  };
  make(2.15 + rnd() * 0.3, 0, 0, 0, 0.92);
  for (let k = 0; k < lobes; k++) {
    const a = (k / lobes) * Math.PI * 2 + rnd() * 0.9;
    const cr = 1.45 + rnd() * 0.85;
    make(1.35 + rnd() * 0.95, Math.cos(a) * cr, (rnd() - 0.5) * 2.1, Math.sin(a) * cr, 0.85 + rnd() * 0.3);
  }
  const merged = mergeVertices(mergeGeometries(parts, false), 1e-3);
  for (const p of parts) p.dispose();

  const pos = merged.getAttribute("position") as THREE.BufferAttribute;
  const n = pos.count;
  const s1 = rnd() * 6;
  const s2 = rnd() * 6;
  const s3 = rnd() * 6;
  const noise = (x: number, y: number, z: number): number =>
    0.55 * Math.sin(x * 1.9 + s1) * Math.sin(y * 2.3 + s2) +
    0.45 * Math.sin(z * 2.7 + s3) * Math.sin(x * 3.1 + s2) +
    0.3 * Math.sin((x + y + z) * 5.3 + s3);
  let minY = Infinity;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const d = 1 + 0.11 * noise(x, y, z); // porous surface: shallow bumps and pits
    pos.setXYZ(i, x * d, y * d, z * d);
    minY = Math.min(minY, y * d);
  }
  merged.computeVertexNormals();

  const colors = new Float32Array(n * 3);
  const cream = new THREE.Color(C.cream);
  const golden = new THREE.Color(C.golden);
  const toasted = new THREE.Color(C.toasted);
  const col = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const pit = Math.min(1, Math.max(0, (0.25 - noise(x, y, z)) / 1.1)); // pits and crevices go golden
    col.copy(cream).lerp(golden, pit * 0.75);
    const foot = Math.min(1, Math.max(0, (minY + 1.1 - y) / 1.1)); // the base is toasted
    col.lerp(toasted, foot * 0.55);
    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }
  merged.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  merged.computeBoundingSphere();
  return merged;
}

/** Every geometry / material of the machine, created once and disposed together. */
export class PopcornHudKit {
  readonly base = new RoundedBoxGeometry(28, 6, 20, 3, 1.3);
  readonly rim = new RoundedBoxGeometry(28, 2.6, 20, 3, 1.0);
  readonly post = new RoundedBoxGeometry(2.6, 24.6, 2.6, 2, 0.6);
  readonly glass = new THREE.BoxGeometry(WIN.w, WIN.h, WIN.d);
  readonly lid = new RoundedBoxGeometry(29, LID_T, LID_D, 3, 1.1);
  readonly knob = new THREE.SphereGeometry(1.6, 14, 10);
  readonly grains: THREE.BufferGeometry[] = Array.from({ length: GRAIN_VARIANTS }, (_, v) => grainGeometry(v));

  /** Red satin plastic: soft sheen, never chrome. */
  readonly red = new THREE.MeshPhysicalMaterial({
    color: C.red,
    roughness: 0.46,
    metalness: 0,
    clearcoat: 0.22,
    clearcoatRoughness: 0.55,
  });
  readonly ivory = new THREE.MeshPhysicalMaterial({
    color: C.ivory,
    roughness: 0.55,
    metalness: 0,
    clearcoat: 0.12,
    clearcoatRoughness: 0.6,
  });
  /** Transparent window: faint tint, a hint of reflection, never hides the grains. */
  readonly window = new THREE.MeshPhysicalMaterial({
    color: 0xd7eef5,
    roughness: 0.06,
    metalness: 0,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    clearcoat: 0.6,
    clearcoatRoughness: 0.1,
  });
  /** Matte, slightly porous grain with a hint of buttery sheen. */
  readonly grain = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.84,
    metalness: 0,
    sheen: 0.55,
    sheenColor: new THREE.Color(C.butter),
    sheenRoughness: 0.55,
    clearcoat: 0.06,
    clearcoatRoughness: 0.7,
  });

  dispose(): void {
    for (const g of [this.base, this.rim, this.post, this.glass, this.lid, this.knob, ...this.grains]) g.dispose();
    for (const m of [this.red, this.ivory, this.window, this.grain]) m.dispose();
  }
}
