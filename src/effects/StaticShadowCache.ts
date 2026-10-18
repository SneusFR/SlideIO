import * as THREE from "three";

/**
 * CACHED STATIC SHADOWS + LIVE CHARACTER SHADOWS (HIGH preset).
 *
 * WHY: with live shadows, three.js re-renders EVERY caster into the sun's
 * shadow map each frame — on Givre that is the whole static map (~70 draw
 * calls, ~130k triangles) just to let a handful of moving characters cast
 * their shadow. The map and the sun never move: its depth only has to be
 * rendered ONCE.
 *
 * HOW (exact same shadow map, no visual change):
 *   1. bake(): the static casters are rendered ONCE, from the sun's shadow
 *      camera, into a private depth texture (same size / format as the
 *      shadow map). They then stop casting (castShadow = false) — they still
 *      RECEIVE shadows.
 *   2. Every frame, three's shadow pass clears the shadow map and walks the
 *      scene graph in order: a "restorer" placed FIRST among the scene's
 *      children copies the baked depth back (one fullscreen triangle writing
 *      gl_FragDepth), then the dynamic casters (characters…) are drawn on
 *      top with the normal depth test. Result: static + dynamic depth, for
 *      1 draw call instead of the whole map.
 * The restorer draws nothing in the colour passes (its main material emits
 * no fragment). On a context loss the bake is redone automatically.
 */
/**
 * The map's shadow-casting sun + its STATIC casters: every mesh under
 * `mapRoot` that casts, except the subtrees driven by an animation clip
 * (fans, cameras… keep casting live). Null when the map has no shadow sun,
 * or more than one shadow-casting light (the casters stop casting once
 * baked — a second shadow map would lose them).
 *
 * Only casters whose depth the bake reproduces EXACTLY are cached: three's
 * shadow pass draws a caster with its material's shadow side, alpha cut-out
 * (alphaTest + map / alphaMap), displacement, clipping, wireframe or custom
 * depth material — a caster using any of these stays a live caster.
 */
export function findStaticShadowSetup(
  mapRoot: THREE.Object3D,
  clips: readonly THREE.AnimationClip[] = [],
  clipRoot: THREE.Object3D = mapRoot,
): { light: THREE.DirectionalLight; casters: THREE.Object3D[] } | null {
  let light: THREE.DirectionalLight | null = null;
  let shadowLights = 0;
  mapRoot.traverse((o) => {
    const l = o as THREE.Light;
    if (!l.isLight || !l.castShadow) return;
    shadowLights++;
    if (!light && (l as THREE.DirectionalLight).isDirectionalLight) light = l as THREE.DirectionalLight;
  });
  if (!light || shadowLights !== 1) return null;
  const animated = new Set<THREE.Object3D>();
  for (const clip of clips) {
    for (const track of clip.tracks) {
      const { nodeName } = THREE.PropertyBinding.parseTrackName(track.name);
      clipRoot.getObjectByName(nodeName)?.traverse((o) => animated.add(o));
    }
  }
  const casters: THREE.Object3D[] = [];
  mapRoot.traverse((o) => {
    const m = o as THREE.Mesh;
    if ((m.isMesh || (o as THREE.Points).isPoints) && m.castShadow && !animated.has(o) && !o.userData.dynamicShadow) {
      if (bakedShadowSide(o) !== null) casters.push(o);
    }
  });
  return casters.length > 0 ? { light, casters } : null;
}

/** three's shadow pass: a material's depth is drawn with the OPPOSITE side by default. */
const SHADOW_SIDE: Record<THREE.Side, THREE.Side> = {
  [THREE.FrontSide]: THREE.BackSide,
  [THREE.BackSide]: THREE.FrontSide,
  [THREE.DoubleSide]: THREE.DoubleSide,
};

/**
 * Side the caster's depth is drawn with in three's shadow pass, or null when
 * a plain MeshDepthMaterial of that side would NOT reproduce it (see
 * WebGLShadowMap.getDepthMaterial): custom depth material, invisible or
 * wireframe material, alpha cut-out, displacement, clipping, or materials of
 * different sides on one mesh.
 */
function bakedShadowSide(object: THREE.Object3D): THREE.Side | null {
  const mesh = object as THREE.Mesh;
  if (mesh.customDepthMaterial !== undefined) return null;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  let side: THREE.Side | null = null;
  for (const material of materials) {
    if (!material || !material.visible || material.alphaToCoverage) return null;
    const m = material as THREE.Material & {
      wireframe?: boolean;
      map?: THREE.Texture | null;
      alphaMap?: THREE.Texture | null;
      displacementMap?: THREE.Texture | null;
      displacementScale?: number;
    };
    if (m.wireframe) return null;
    if (m.alphaTest > 0 && (m.map || m.alphaMap)) return null;
    if (m.displacementMap && m.displacementScale !== 0) return null;
    if (m.clipShadows && Array.isArray(m.clippingPlanes) && m.clippingPlanes.length > 0) return null;
    const s = (object as THREE.Points).isPoints
      ? THREE.DoubleSide
      : m.shadowSide !== null && m.shadowSide !== undefined
        ? m.shadowSide
        : SHADOW_SIDE[m.side];
    if (side !== null && s !== side) return null;
    side = s;
  }
  return side;
}

export class StaticShadowCache {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly restorer: THREE.Mesh;
  private readonly casters: THREE.Object3D[] = [];
  /** Casters grouped by the side three's shadow pass draws them with. */
  private readonly bySide = new Map<THREE.Side, THREE.Object3D[]>();
  private baked = false;
  private readonly onRestored = () => {
    if (this.baked) this.bake();
  };

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly light: THREE.DirectionalLight,
    /** Static meshes (castShadow = true) whose depth is baked once. */
    casters: Iterable<THREE.Object3D>,
  ) {
    for (const c of casters) {
      const side = bakedShadowSide(c);
      if (side === null) continue; // not reproducible by the bake: stays live
      this.casters.push(c);
      let group = this.bySide.get(side);
      if (!group) this.bySide.set(side, (group = []));
      group.push(c);
    }
    const size = light.shadow.mapSize;
    const depth = new THREE.DepthTexture(size.x, size.y, THREE.UnsignedIntType);
    depth.format = THREE.DepthFormat;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    depth.name = `${light.name || "sun"}.staticShadowDepth`;
    this.target = new THREE.WebGLRenderTarget(size.x, size.y, {
      depthBuffer: true,
      depthTexture: depth,
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
      generateMipmaps: false,
    });
    this.target.texture.name = `${light.name || "sun"}.staticShadowColor`;

    // Fullscreen triangle in clip space (the matrices are ignored).
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    // Colour passes: no fragment at all (vertices outside the clip volume).
    const hidden = new THREE.ShaderMaterial({
      vertexShader: "void main() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }",
      fragmentShader: "void main() { gl_FragColor = vec4(0.0); }",
      colorWrite: false,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide, // → the depth material is DoubleSide too (no culling)
    });
    hidden.name = "StaticShadowCache.hidden";
    this.restorer = new THREE.Mesh(geometry, hidden);
    this.restorer.name = "static_shadow_restorer";
    this.restorer.frustumCulled = false;
    this.restorer.castShadow = false; // armed by bake()
    this.restorer.receiveShadow = false;
    this.restorer.matrixAutoUpdate = false;
    this.restorer.raycast = () => {};
    this.restorer.userData.noOutline = true;
    this.restorer.customDepthMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { tDepth: { value: depth }, uActive: { value: 1 } },
      vertexShader: /* glsl */ `
        out vec2 vUv;
        void main() {
          vUv = position.xy * 0.5 + 0.5;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform highp sampler2D tDepth;
        uniform float uActive;
        in vec2 vUv;
        void main() {
          if (uActive < 0.5) discard; // another light's shadow map: untouched
          gl_FragDepth = texture(tDepth, vUv).r;
        }`,
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
    });
    this.restorer.customDepthMaterial.name = "StaticShadowCache.restore";
    // Only the cached light's shadow map receives the baked depth: any other
    // shadow-casting light (none on the current maps) is left untouched.
    const restore = this.restorer.customDepthMaterial as THREE.ShaderMaterial;
    this.restorer.onBeforeShadow = (_r, _o, _c, shadowCamera) => {
      const active = shadowCamera === light.shadow.camera ? 1 : 0;
      if (restore.uniforms.uActive.value !== active) {
        restore.uniforms.uActive.value = active;
        restore.uniformsNeedUpdate = true;
      }
    };
    // Point-light shadow cubes use the distance material: never written.
    this.restorer.customDistanceMaterial = new THREE.ShaderMaterial({
      vertexShader: "void main() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }",
      fragmentShader: "void main() { discard; }",
    });
    // FIRST child: the shadow pass visits the scene graph in order.
    scene.add(this.restorer);
    scene.children.splice(scene.children.indexOf(this.restorer), 1);
    scene.children.unshift(this.restorer);
    renderer.domElement.addEventListener("webglcontextrestored", this.onRestored);
  }

  /** True once the static depth is cached (the map no longer casts live). */
  get active(): boolean {
    return this.baked;
  }

  /**
   * Render the static casters' depth from the sun ONCE (call when the map
   * is final — after the GPU warm-up). Idempotent; also re-run on context restore.
   */
  bake(): void {
    const { renderer, scene, light } = this;
    const shadow = light.shadow;
    // Same view as three's shadow pass (light → target, fitted ortho camera).
    light.updateMatrixWorld(true);
    light.target.updateMatrixWorld(true);
    shadow.updateMatrices(light);
    const camera = shadow.camera;

    const BAKE_LAYER = 31;
    const savedLayers = camera.layers.mask;
    camera.layers.set(BAKE_LAYER);

    // One depth pass per shadow SIDE (same side as three's live shadow pass
    // for each caster), accumulated in the same depth buffer.
    const depthMaterial = new THREE.MeshDepthMaterial();
    depthMaterial.colorWrite = false;
    const savedOverride = scene.overrideMaterial;
    const savedBackground = scene.background;
    const savedAuto = renderer.shadowMap.autoUpdate;
    const savedNeeds = renderer.shadowMap.needsUpdate;
    const savedTarget = renderer.getRenderTarget();
    const savedAutoClear = renderer.autoClear;
    scene.overrideMaterial = depthMaterial;
    scene.background = null;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;
    try {
      renderer.setRenderTarget(this.target);
      renderer.autoClear = false;
      renderer.clear(true, true, true);
      for (const [side, group] of this.bySide) {
        depthMaterial.side = side;
        // During the bake the casters must still be flagged as casters
        // (layers only select them); restored to "receiver only" right after.
        for (const c of group) c.layers.enable(BAKE_LAYER);
        try {
          renderer.render(scene, camera);
        } finally {
          for (const c of group) c.layers.disable(BAKE_LAYER);
        }
      }
    } finally {
      renderer.setRenderTarget(savedTarget);
      renderer.autoClear = savedAutoClear;
      scene.overrideMaterial = savedOverride;
      scene.background = savedBackground;
      renderer.shadowMap.autoUpdate = savedAuto;
      renderer.shadowMap.needsUpdate = savedNeeds;
      camera.layers.mask = savedLayers;
      depthMaterial.dispose();
    }

    for (const c of this.casters) c.castShadow = false;
    this.restorer.castShadow = true;
    this.baked = true;
  }

  dispose(): void {
    this.renderer.domElement.removeEventListener("webglcontextrestored", this.onRestored);
    this.scene.remove(this.restorer);
    this.restorer.geometry.dispose();
    (this.restorer.material as THREE.Material).dispose();
    this.restorer.customDepthMaterial?.dispose();
    this.restorer.customDistanceMaterial?.dispose();
    this.target.depthTexture?.dispose();
    this.target.dispose();
    if (this.baked) for (const c of this.casters) c.castShadow = true;
  }
}
