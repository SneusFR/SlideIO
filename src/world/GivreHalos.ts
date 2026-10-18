import * as THREE from "three";
import type { GivreHalosData } from "./GivreData";

/**
 * GIVRE v3 — additive glow halos around bulbs and lanterns (adapted from
 * createGivreHalos in src/assets/MAP/Givre/reference/givreMap.reference.ts).
 *
 * 647 sprites in ONE draw call (PERF — was 15: one Points per animated
 * garland). The fixed sources are in world coordinates; the garland ones
 * keep their node-local position plus a node index (`aNode`) into a small
 * matrix array (`uNodes`, refreshed once per frame by `update()`), so they
 * still follow the swing exactly. Sizes are in metres (projected with the
 * canvas height in REAL pixels — `setViewportHeight()` every frame).
 * Never outlined (Points + noOutline), never raycast, client-only.
 */
const HALO_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aRadius;
attribute vec3 aColor;
attribute float aIntensity;
attribute float aNode;
uniform float uViewportHeight;
uniform mat4 uNodes[HALO_NODES];
varying vec3 vColor;
varying float vIntensity;
void main() {
  // uNodes[0] = identity (fixed halos); [k] = garland k in this object's space.
  vec4 mv = modelViewMatrix * (uNodes[int(aNode + 0.5)] * vec4(position, 1.0));
  gl_Position = projectionMatrix * mv;
  // diameter (2 x radius) in metres -> pixels, like a fixed-size world sprite
  gl_PointSize = clamp(aRadius * projectionMatrix[1][1] * uViewportHeight / max(-mv.z, 0.01), 0.0, 256.0);
  vColor = aColor;
  vIntensity = aIntensity;
  #include <logdepthbuf_vertex>
}
`;

const HALO_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
varying float vIntensity;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float f = pow(clamp(1.0 - r, 0.0, 1.0), 3.0) * vIntensity;
  if (f < 0.002) discard;
  gl_FragColor = vec4(vColor * f, 1.0);
  #include <colorspace_fragment>
}
`;

interface HaloSource {
  radius: number;
  type: string;
  xyz: [number, number, number];
  /** 0 = fixed (world), k ≥ 1 = garland node k (node-local position). */
  node: number;
}

export class GivreHalos {
  readonly objects: THREE.Points[] = [];
  private readonly material: THREE.ShaderMaterial;
  /** Animated garlands, index k - 1 ↔ uNodes[k]. */
  private readonly nodes: THREE.Object3D[] = [];
  private readonly nodeMatrices: THREE.Matrix4[];
  private readonly parentInverse = new THREE.Matrix4();

  /**
   * @param data   JSON `halos` section.
   * @param world  parent of the halos (world coordinates).
   * @param nodes  animated glb nodes by name (garlands).
   */
  constructor(
    private readonly data: GivreHalosData,
    private readonly world: THREE.Object3D,
    nodes: ReadonlyMap<string, THREE.Object3D>,
  ) {
    const sources: HaloSource[] = data.static.map((p) => ({ radius: p.radius, type: p.type, xyz: p.position, node: 0 }));
    for (const group of data.nodes) {
      const node = nodes.get(group.node) ?? world.getObjectByName(group.node);
      if (!node) {
        console.warn(`GivreHalos: node ${group.node} not found`);
        continue;
      }
      this.nodes.push(node);
      const index = this.nodes.length;
      for (const p of group.points) sources.push({ radius: p.radius, type: p.type, xyz: p.local, node: index });
    }
    this.nodeMatrices = Array.from({ length: this.nodes.length + 1 }, () => new THREE.Matrix4());

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uViewportHeight: { value: 1080 },
        uNodes: { value: this.nodeMatrices },
      },
      defines: { HALO_NODES: this.nodeMatrices.length },
      vertexShader: HALO_VERTEX,
      fragmentShader: HALO_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });

    if (sources.length > 0) {
      const pts = this.points(sources);
      pts.name = "givre_halos";
      world.add(pts);
      this.objects.push(pts);
      this.update();
    }
  }

  /** Number of halo sprites. */
  get count(): number {
    let n = 0;
    for (const o of this.objects) n += o.geometry.getAttribute("position").count;
    return n;
  }

  /**
   * Once per frame, AFTER the mixer (animated node matrices up to date):
   * garland node → halo object space.
   */
  update(): void {
    if (this.objects.length === 0 || this.nodes.length === 0) return;
    // The Points sit at identity under `world`: object space = world's space.
    this.parentInverse.copy(this.world.matrixWorld).invert();
    for (let i = 0; i < this.nodes.length; i++) {
      this.nodeMatrices[i + 1].multiplyMatrices(this.parentInverse, this.nodes[i].matrixWorld);
    }
  }

  private points(sources: HaloSource[]): THREE.Points {
    const n = sources.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const rad = new Float32Array(n);
    const inten = new Float32Array(n);
    const node = new Float32Array(n);
    const c = new THREE.Color();
    sources.forEach((p, i) => {
      const t = this.data.types[p.type];
      pos.set(p.xyz, i * 3);
      c.set(t?.colorHex ?? "#ffc98a"); // sRGB → linear (three.js colour management)
      col.set([c.r, c.g, c.b], i * 3);
      rad[i] = p.radius;
      inten[i] = t?.intensity ?? 0.9;
      node[i] = p.node;
    });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    geom.setAttribute("aRadius", new THREE.BufferAttribute(rad, 1));
    geom.setAttribute("aIntensity", new THREE.BufferAttribute(inten, 1));
    geom.setAttribute("aNode", new THREE.BufferAttribute(node, 1));
    const obj = new THREE.Points(geom, this.material);
    obj.userData.noOutline = true;
    obj.castShadow = false;
    obj.receiveShadow = false;
    obj.renderOrder = 10;
    // Garland halos move (node-local positions): the world-space bounding
    // sphere of the raw attribute would be wrong — 647 points, never culled.
    obj.frustumCulled = false;
    obj.raycast = () => {};
    return obj;
  }

  /** Canvas height in REAL pixels (renderer.domElement.height). */
  setViewportHeight(px: number): void {
    this.material.uniforms.uViewportHeight.value = px;
  }

  dispose(): void {
    for (const o of this.objects) {
      o.removeFromParent();
      o.geometry.dispose();
    }
    this.material.dispose();
  }
}
