import * as THREE from "three";
import type { GivreHalosData } from "./GivreData";

/**
 * GIVRE v3 — additive glow halos around bulbs and lanterns (adapted from
 * createGivreHalos in src/assets/MAP/Givre/reference/givreMap.reference.ts).
 *
 * 647 sprites in 15 draw calls: ONE Points in world coordinates for the
 * fixed sources + one Points CHILD of each of the 14 animated garlands, so
 * their halos follow the swing. Sizes are in metres (projected with the
 * canvas height in REAL pixels — `update()` at start and on every resize).
 * Never outlined (Points + noOutline), never raycast, client-only.
 */
const HALO_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aRadius;
attribute vec3 aColor;
attribute float aIntensity;
uniform float uViewportHeight;
varying vec3 vColor;
varying float vIntensity;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
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
}

export class GivreHalos {
  readonly objects: THREE.Points[] = [];
  private readonly material: THREE.ShaderMaterial;

  /**
   * @param data   JSON `halos` section.
   * @param world  parent of the fixed halos (world coordinates).
   * @param nodes  animated glb nodes by name (garlands).
   */
  constructor(
    private readonly data: GivreHalosData,
    world: THREE.Object3D,
    nodes: ReadonlyMap<string, THREE.Object3D>,
  ) {
    this.material = new THREE.ShaderMaterial({
      uniforms: { uViewportHeight: { value: 1080 } },
      vertexShader: HALO_VERTEX,
      fragmentShader: HALO_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });

    const fixed = data.static.map((p) => ({ radius: p.radius, type: p.type, xyz: p.position }));
    if (fixed.length > 0) {
      const pts = this.points(fixed);
      pts.name = "givre_halos";
      world.add(pts);
      this.objects.push(pts);
    }
    for (const group of data.nodes) {
      const node = nodes.get(group.node) ?? world.getObjectByName(group.node);
      if (!node) {
        console.warn(`GivreHalos: node ${group.node} not found`);
        continue;
      }
      const pts = this.points(group.points.map((p) => ({ radius: p.radius, type: p.type, xyz: p.local })));
      pts.name = `givre_halos_${group.node}`;
      node.add(pts); // follows the garland swing
      this.objects.push(pts);
    }
  }

  /** Number of halo sprites. */
  get count(): number {
    let n = 0;
    for (const o of this.objects) n += o.geometry.getAttribute("position").count;
    return n;
  }

  private points(sources: HaloSource[]): THREE.Points {
    const n = sources.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const rad = new Float32Array(n);
    const inten = new Float32Array(n);
    const c = new THREE.Color();
    sources.forEach((p, i) => {
      const t = this.data.types[p.type];
      pos.set(p.xyz, i * 3);
      c.set(t?.colorHex ?? "#ffc98a"); // sRGB → linear (three.js colour management)
      col.set([c.r, c.g, c.b], i * 3);
      rad[i] = p.radius;
      inten[i] = t?.intensity ?? 0.9;
    });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    geom.setAttribute("aRadius", new THREE.BufferAttribute(rad, 1));
    geom.setAttribute("aIntensity", new THREE.BufferAttribute(inten, 1));
    geom.computeBoundingSphere();
    const obj = new THREE.Points(geom, this.material);
    obj.userData.noOutline = true;
    obj.castShadow = false;
    obj.receiveShadow = false;
    obj.renderOrder = 10;
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
