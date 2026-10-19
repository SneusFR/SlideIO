import * as THREE from "three";
import type { GivreFootprintsData } from "./GivreData";
import { hideWhenEmpty } from "../effects/hideWhenEmpty";

/**
 * GIVRE v3 — bare-foot prints in the snow (adapted from
 * src/assets/MAP/Givre/reference/givreFootprints.reference.ts).
 *
 * ONE InstancedMesh (one draw call) over a fixed pool of decals (1024):
 * every step on snow (material GIV_Neige, slope ≤ 30°) lays a flat decal
 * oriented along the walk, left foot mirrored. A print stays whole for 20 s
 * then fades out until 30 s — the fade runs in the shader (no CPU work per
 * frame). Purely visual: no collision, no network message — every client
 * lays the prints of every character it sees from the positions it already
 * has (local player, interpolated remotes, bots).
 *
 * The snow under a foot is found in a 2D grid of the snow triangles
 * (GivreSnowGrid), built once at load: a few triangles tested per step
 * instead of ~24 000 for a Raycaster. Transparent + userData.noOutline →
 * excluded from GivreOutlinePass and from every raycast.
 */
const FOOT_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aBirth;
attribute float aMirror;
varying vec2 vUv;
varying float vBirth;
void main() {
  vUv = vec2(aMirror > 0.0 ? uv.x : 1.0 - uv.x, uv.y);
  vBirth = aBirth;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const FOOT_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMap;
uniform float uTime;
uniform float uFull;
uniform float uGone;
uniform vec3 uSnow;        // linear base colour of the snow (GIV_Neige)
varying vec2 vUv;
varying float vBirth;
void main() {
  #include <logdepthbuf_fragment>
  float age = uTime - vBirth;
  vec4 tex = texture2D(uMap, vUv);
  float a = tex.a * step(0.0, age) * (1.0 - smoothstep(uFull, uGone, age));
  if (a < 0.004) discard;
  // multiplicative decal: the already-lit snow (sun, shadow, garland light)
  // takes the hollow's tint: snow x mix(1, print / snow, alpha)
  vec3 f = clamp(tex.rgb / uSnow, 0.0, 1.0);
  gl_FragColor = vec4(mix(vec3(1.0), f, a), 1.0);
  #include <colorspace_fragment>
}
`;

/** Vertical window around the foot where snow is searched (m). */
const SEARCH_ABOVE = 0.5; // foot sunk in a drift
const SEARCH_BELOW = 0.35; // lower snow: on a crate / in the air → no print

/**
 * XZ grid (2 m cells) of the snow triangles, in world coordinates. Built
 * once the map is placed (the map never moves afterwards).
 */
export class GivreSnowGrid {
  private readonly tri: Float32Array; // 9 floats per triangle
  private readonly start: Uint32Array; // triangles of cell c: items[start[c] .. start[c + 1] - 1]
  private readonly items: Uint32Array;
  private readonly x0: number;
  private readonly z0: number;
  private readonly nx: number;
  private readonly nz: number;

  constructor(
    meshes: readonly THREE.Mesh[],
    private readonly cell = 2,
  ) {
    // PERF (loading): straight into the float array (no JS array of every
    // coordinate), same values: Vector3.applyMatrix4 then float32 storage.
    let corners = 0;
    for (const mesh of meshes) {
      const index = mesh.geometry.getIndex();
      corners += index ? index.count : mesh.geometry.getAttribute("position").count;
    }
    const t = new Float32Array(corners * 3);
    let w = 0;
    for (const mesh of meshes) {
      mesh.updateWorldMatrix(true, false);
      const pos = mesh.geometry.getAttribute("position");
      const index = mesh.geometry.getIndex();
      const n = index ? index.count : pos.count;
      const e = mesh.matrixWorld.elements;
      // Plain float positions / index: read the arrays directly (getX would
      // give the same numbers, one call per coordinate).
      const plain =
        !(pos as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && !pos.normalized;
      const pa = pos.array as ArrayLike<number>;
      const stride = pos.itemSize;
      const ia = index ? (index.array as ArrayLike<number>) : null;
      for (let i = 0; i < n; i++) {
        const vi = ia ? ia[i] : i;
        const x = plain ? pa[vi * stride] : pos.getX(vi);
        const y = plain ? pa[vi * stride + 1] : pos.getY(vi);
        const z = plain ? pa[vi * stride + 2] : pos.getZ(vi);
        const iw = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
        t[w++] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * iw;
        t[w++] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * iw;
        t[w++] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * iw;
      }
    }
    const count = t.length / 9;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < t.length; i += 3) {
      minX = Math.min(minX, t[i]);
      maxX = Math.max(maxX, t[i]);
      minZ = Math.min(minZ, t[i + 2]);
      maxZ = Math.max(maxZ, t[i + 2]);
    }
    if (count === 0) {
      minX = minZ = 0;
      maxX = maxZ = cell;
    }
    this.tri = t;
    this.x0 = minX;
    this.z0 = minZ;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / cell));
    this.nz = Math.max(1, Math.ceil((maxZ - minZ) / cell));
    const cells = this.nx * this.nz;
    // Cell range of every triangle (its XZ bounding box), computed once.
    const range = new Int32Array(count * 4);
    for (let k = 0; k < count; k++) {
      const o = k * 9;
      range[k * 4] = this.ix(Math.min(t[o], t[o + 3], t[o + 6]));
      range[k * 4 + 1] = this.ix(Math.max(t[o], t[o + 3], t[o + 6]));
      range[k * 4 + 2] = this.iz(Math.min(t[o + 2], t[o + 5], t[o + 8]));
      range[k * 4 + 3] = this.iz(Math.max(t[o + 2], t[o + 5], t[o + 8]));
    }
    const nx = this.nx;
    const start = new Uint32Array(cells + 1);
    for (let k = 0; k < count; k++) {
      const i0 = range[k * 4], i1 = range[k * 4 + 1], j0 = range[k * 4 + 2], j1 = range[k * 4 + 3];
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) start[j * nx + i + 1]++;
    }
    for (let c = 0; c < cells; c++) start[c + 1] += start[c];
    const items = new Uint32Array(start[cells]);
    const fill = start.slice(0, cells);
    for (let k = 0; k < count; k++) {
      const i0 = range[k * 4], i1 = range[k * 4 + 1], j0 = range[k * 4 + 2], j1 = range[k * 4 + 3];
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) items[fill[j * nx + i]++] = k;
    }
    this.start = start;
    this.items = items;
  }

  /** Number of snow triangles indexed. */
  get triangleCount(): number {
    return this.tri.length / 9;
  }

  private ix(x: number): number {
    return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.x0) / this.cell)));
  }

  private iz(z: number): number {
    return Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.z0) / this.cell)));
  }

  /**
   * Height of the highest snow surface straight above/below (x, z) between
   * yMin and yMax, or null. `normal` receives the (upward) triangle normal.
   */
  heightAt(x: number, z: number, yMin: number, yMax: number, normal: THREE.Vector3): number | null {
    if (x < this.x0 || z < this.z0 || x > this.x0 + this.nx * this.cell || z > this.z0 + this.nz * this.cell) {
      return null;
    }
    const t = this.tri;
    const c = this.iz(z) * this.nx + this.ix(x);
    let best: number | null = null;
    for (let k = this.start[c]; k < this.start[c + 1]; k++) {
      const o = this.items[k] * 9;
      const ax = t[o], ay = t[o + 1], az = t[o + 2];
      const bx = t[o + 3], by = t[o + 4], bz = t[o + 5];
      const qx = t[o + 6], qy = t[o + 7], qz = t[o + 8];
      const det = (bz - qz) * (ax - qx) + (qx - bx) * (az - qz);
      if (Math.abs(det) < 1e-12) continue; // vertical triangle
      const l1 = ((bz - qz) * (x - qx) + (qx - bx) * (z - qz)) / det;
      const l2 = ((qz - az) * (x - qx) + (ax - qx) * (z - qz)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      const y = l1 * ay + l2 * by + l3 * qy;
      if (y < yMin || y > yMax || (best !== null && y <= best)) continue;
      best = y;
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = qx - ax, vy = qy - ay, vz = qz - az;
      normal.set(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx).normalize();
      if (normal.y < 0) normal.negate();
    }
    return best;
  }
}


interface Walker {
  last: THREE.Vector3;
  travelled: number;
  right: boolean;
}

export class GivreFootprints {
  readonly mesh: THREE.InstancedMesh;
  readonly grid: GivreSnowGrid;
  private readonly material: THREE.ShaderMaterial;
  private readonly birth: THREE.InstancedBufferAttribute;
  private readonly mirror: THREE.InstancedBufferAttribute;
  private readonly walkers = new Map<string, Walker>();
  private readonly pool: number;
  private next = 0;
  private readonly size: [number, number];
  private readonly lateral: number;
  private readonly minStep: number;
  private readonly lift: number;
  private readonly cosMaxSlope: number;
  /** Step duration for track(): one print every max(minStep, speed × stride) m. */
  private readonly strideSeconds = 0.28;
  // scratch
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly n = new THREE.Vector3();
  private readonly qAlign = new THREE.Quaternion();
  private readonly qYaw = new THREE.Quaternion();
  private readonly m = new THREE.Matrix4();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly side = new THREE.Vector3();

  /**
   * @param cfg          JSON `footprints` section.
   * @param texture      givre_empreinte.png (right foot seen from above, toes up,
   *                     alpha = foot shape); its colour space is set here.
   * @param snowSurfaces merged snow meshes (GivreMap.snowSurfaces), already placed.
   */
  constructor(
    cfg: GivreFootprintsData,
    private readonly texture: THREE.Texture,
    snowSurfaces: readonly THREE.Mesh[],
  ) {
    this.size = cfg.size;
    this.lateral = cfg.lateralOffset;
    this.minStep = cfg.minStep;
    this.lift = cfg.heightAboveSurface;
    this.cosMaxSlope = Math.cos(THREE.MathUtils.degToRad(cfg.maxSlopeDeg));
    this.pool = cfg.poolSize;
    this.grid = new GivreSnowGrid(snowSurfaces);

    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;

    // flat 1 × 1 quad (normal +Y), toes (top of the image) toward −Z = forward
    const geom = new THREE.PlaneGeometry(1, 1);
    geom.rotateX(-Math.PI / 2);
    this.birth = new THREE.InstancedBufferAttribute(new Float32Array(this.pool).fill(-1e9), 1);
    this.mirror = new THREE.InstancedBufferAttribute(new Float32Array(this.pool).fill(1), 1);
    this.birth.setUsage(THREE.DynamicDrawUsage);
    this.mirror.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute("aBirth", this.birth);
    geom.setAttribute("aMirror", this.mirror);

    // snow base colour: the glb material's (linear)
    const first = snowSurfaces[0]?.material;
    const snowMat = (Array.isArray(first) ? first[0] : first) as THREE.MeshStandardMaterial | undefined;
    const snow = snowMat?.color ? snowMat.color.clone() : new THREE.Color("#f4f5f9");

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uTime: { value: 0 },
        uFull: { value: cfg.fullSeconds },
        uGone: { value: cfg.goneSeconds },
        uSnow: { value: new THREE.Vector3(snow.r, snow.g, snow.b) },
      },
      vertexShader: FOOT_VERTEX,
      fragmentShader: FOOT_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // final colour = already-rendered colour × decal colour
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      // no z-fighting with the snow (no shimmering prints)
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });

    this.mesh = new THREE.InstancedMesh(geom, this.material, this.pool);
    this.mesh.name = "givre_empreintes";
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.pool; i++) this.mesh.setMatrixAt(i, zero);
    this.mesh.count = 0; // grows up to the pool size step after step
    hideWhenEmpty(this.mesh);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = -10; // first transparent, right after the opaque ground
    this.mesh.userData.noOutline = true;
    this.mesh.raycast = () => {}; // purely visual
  }


  /**
   * Lays one print when the ground under the foot is snow.
   * @param foot  foot position on the ground, world coordinates
   * @param yaw   heading in radians (Object3D.rotation.y convention, forward = −Z)
   * @param right right foot (else left, mirrored)
   * @param now   game time in seconds, the same clock as update()
   */
  stamp(foot: THREE.Vector3, yaw: number, right: boolean, now: number): boolean {
    // slight disorder, as in the Blender preview: ±1.5 cm and ±5°
    const x = foot.x + (Math.random() - 0.5) * 0.03;
    const z = foot.z + (Math.random() - 0.5) * 0.03;
    const y = this.grid.heightAt(x, z, foot.y - SEARCH_BELOW, foot.y + SEARCH_ABOVE, this.n);
    if (y === null || this.n.y < this.cosMaxSlope) return false;

    const i = this.next;
    this.next = (i + 1) % this.pool;
    this.mesh.count = Math.max(this.mesh.count, i + 1);
    const jitter = THREE.MathUtils.degToRad((Math.random() - 0.5) * 10);
    this.qYaw.setFromAxisAngle(this.up, yaw + jitter);
    this.qAlign.setFromUnitVectors(this.up, this.n).multiply(this.qYaw);
    this.p.set(x, y, z).addScaledVector(this.n, this.lift);
    this.s.set(this.size[0], 1, this.size[1]);
    this.m.compose(this.p, this.qAlign, this.s);
    this.mesh.setMatrixAt(i, this.m);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.birth.setX(i, now);
    this.birth.needsUpdate = true;
    this.mirror.setX(i, right ? 1 : -1);
    this.mirror.needsUpdate = true;
    return true;
  }

  /**
   * Automatic tracking of one character, every frame, for every visible
   * character (local player, remotes, bots) with its FEET position. Lays a
   * step every max(minStep, speed × strideSeconds) metres walked on the
   * ground, alternating feet on each side of the path. For a remote whose
   * ground state is unknown pass grounded = true: stamp()'s vertical window
   * already avoids prints in mid-jump.
   */
  track(id: string, feet: THREE.Vector3, grounded: boolean, now: number, dt: number): void {
    let w = this.walkers.get(id);
    if (!w) {
      w = { last: feet.clone(), travelled: 0, right: true };
      this.walkers.set(id, w);
      return;
    }
    const dx = feet.x - w.last.x;
    const dz = feet.z - w.last.z;
    const d = Math.hypot(dx, dz);
    if (!grounded || d > 5) {
      // airborne, or teleported (respawn): start over
      w.last.copy(feet);
      w.travelled = 0;
      return;
    }
    w.travelled += d;
    const speed = dt > 0 ? d / dt : 0;
    const stride = Math.max(this.minStep, speed * this.strideSeconds);
    if (d > 1e-4 && w.travelled >= stride) {
      w.travelled = 0;
      const yaw = Math.atan2(-dx, -dz);
      // (-dz, dx) / d = right of the walk; right foot right, left foot left
      this.side.set(-dz / d, 0, dx / d).multiplyScalar(w.right ? this.lateral : -this.lateral);
      this.p.copy(feet).add(this.side);
      this.stamp(this.p, yaw, w.right, now);
      w.right = !w.right;
    }
    w.last.copy(feet);
  }

  /** A character left / is no longer tracked. */
  forget(id: string): void {
    this.walkers.delete(id);
  }

  /** Ids currently tracked (to forget the ones that disappeared). */
  trackedIds(): IterableIterator<string> {
    return this.walkers.keys();
  }

  /** Erases every print (new match). */
  clear(): void {
    this.birth.array.fill(-1e9);
    this.birth.needsUpdate = true;
    this.mesh.count = 0;
    this.next = 0;
    this.walkers.clear();
  }

  /** Every frame, with the same clock as stamp() / track(). */
  update(now: number): void {
    this.material.uniforms.uTime.value = now;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

