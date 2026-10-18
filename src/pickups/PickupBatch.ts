import * as THREE from "three";

/**
 * PERF — every active loot pickup of one kind (coins, medkits) in a FIXED
 * number of instanced draw calls.
 *
 * A pickup used to be a clone of its template: 5 to 6 flat-coloured meshes
 * + an additive halo sprite = 6 to 7 draw calls EACH. A single bot death
 * drops 1 medkit + 2..10 coins that live 20-25 s, so a busy 8-bot match
 * kept 30 to 90 pickups on the ground: 200 to 600 draw calls that came and
 * went with the kills (the frame-rate dips that followed the fights).
 *
 * Here each template part (geometry + its SHARED material) becomes one
 * InstancedMesh, and the halo sprite one instanced camera-facing quad: 6-7
 * draws for ALL the pickups of a kind. The PickupManager keeps animating
 * each pickup's root transform exactly as before and pushes it here once
 * per frame (CPU frustum culling per pickup, like the per-clone culling).
 */
const HALO_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 center = vec4(0.0, 0.0, 0.0, 1.0);
  float s = 1.0;
  #ifdef USE_INSTANCING
    center = instanceMatrix * center;
    s = length(instanceMatrix[0].xyz);
  #endif
  // Same as three's Sprite (size attenuation, no rotation, centre 0.5).
  vec4 mvPosition = modelViewMatrix * center;
  mvPosition.xy += position.xy * s;
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

const HALO_FRAGMENT = /* glsl */ `
uniform vec3 diffuse;
uniform float opacity;
uniform sampler2D map;
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  vec4 texel = texture2D(map, vUv);
  gl_FragColor = vec4(diffuse * texel.rgb, opacity * texel.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

const _m = new THREE.Matrix4();
const _sphere = new THREE.Sphere();

export class PickupBatch {
  private readonly parts: { mesh: THREE.InstancedMesh; rel: THREE.Matrix4 }[] = [];
  /** Half size of the halo billboard (culling radius). */
  private haloHalf = 0;
  private count = 0;
  private lastCount = -1;
  /** Bounding radius of the template (all parts + halo) at scale 1. */
  private readonly radius: number;
  private readonly center = new THREE.Vector3();

  constructor(
    template: THREE.Object3D,
    scene: THREE.Object3D,
    private readonly capacity: number,
  ) {
    template.updateMatrixWorld(true);
    const rootInverse = template.matrixWorld.clone().invert();
    const bounds = new THREE.Box3();
    template.traverse((o) => {
      const rel = new THREE.Matrix4().multiplyMatrices(rootInverse, o.matrixWorld);
      const mesh = o as THREE.Mesh;
      const sprite = o as THREE.Sprite;
      let instanced: THREE.InstancedMesh | null = null;
      if (sprite.isSprite) {
        instanced = this.haloMesh(sprite.material as THREE.SpriteMaterial);
        bounds.expandByPoint(new THREE.Vector3().setFromMatrixPosition(rel));
        const s = new THREE.Vector3().setFromMatrixScale(rel);
        this.haloHalf = Math.max(this.haloHalf, Math.max(s.x, s.y) / 2);
      } else if (mesh.isMesh && !Array.isArray(mesh.material)) {
        instanced = new THREE.InstancedMesh(mesh.geometry, mesh.material, capacity);
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        bounds.union(mesh.geometry.boundingBox!.clone().applyMatrix4(rel));
      }
      if (!instanced) return;
      instanced.name = `pickup_${o.name || o.type}`;
      instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      instanced.count = 0;
      instanced.visible = false;
      instanced.frustumCulled = false; // culled per pickup on the CPU
      instanced.castShadow = false;
      instanced.receiveShadow = false;
      instanced.matrixAutoUpdate = false;
      instanced.renderOrder = o.renderOrder;
      instanced.userData.noOutline = true;
      instanced.raycast = () => {};
      scene.add(instanced);
      this.parts.push({ mesh: instanced, rel });
    });
    bounds.getBoundingSphere(_sphere);
    this.center.copy(_sphere.center);
    this.radius = Math.max(_sphere.radius, this.haloHalf);
  }

  /** Instanced copy of the template's halo SpriteMaterial (same look). */
  private haloMesh(source: THREE.SpriteMaterial): THREE.InstancedMesh {
    const material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          diffuse: { value: source.color.clone() },
          opacity: { value: source.opacity },
          map: { value: null },
        },
      ]),
      vertexShader: HALO_VERTEX,
      fragmentShader: HALO_FRAGMENT,
      transparent: source.transparent,
      blending: source.blending,
      depthWrite: source.depthWrite,
      depthTest: source.depthTest,
      toneMapped: source.toneMapped,
      fog: source.fog,
    });
    material.uniforms.map.value = source.map; // shared texture (never cloned)
    material.name = "pickup_halo";
    return new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, this.capacity);
  }

  /** Start a frame: no instance yet. */
  begin(): void {
    this.count = 0;
  }

  /**
   * One pickup this frame (its root matrix, world = parent is the scene).
   * Skipped when outside `frustum` (null = no culling).
   */
  push(root: THREE.Matrix4, frustum: THREE.Frustum | null): void {
    if (this.count >= this.capacity) return;
    if (frustum) {
      _sphere.center.copy(this.center).applyMatrix4(root);
      // ×1.25: margin for a camera that still turns after the cull (whirlwind).
      _sphere.radius = this.radius * 1.25 * root.getMaxScaleOnAxis();
      if (!frustum.intersectsSphere(_sphere)) return;
    }
    for (const { mesh, rel } of this.parts) mesh.setMatrixAt(this.count, _m.multiplyMatrices(root, rel));
    this.count++;
  }

  /** Publish the frame's instances (only the used range is uploaded). */
  end(): void {
    const n = this.count;
    for (const { mesh } of this.parts) {
      mesh.count = n;
      mesh.visible = n > 0;
      if (n > 0) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, n * 16);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
    this.lastCount = n;
  }

  /** Instances drawn last frame (debug). */
  get drawn(): number {
    return Math.max(0, this.lastCount);
  }
}
