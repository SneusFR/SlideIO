import * as THREE from "three";
import { FullScreenQuad, Pass } from "three/examples/jsm/postprocessing/Pass.js";

/**
 * Cel-shading outline (GIVRE): a thin light rim on geometric edges, as a
 * post-processing Pass for EffectComposer. Adapted from the integration
 * pack's reference (src/assets/MAP/Givre/reference/GivreOutlinePass.ts).
 *
 * Detection is GEOMETRY ONLY (never colour):
 *  - view-space normals → creases (wall corners, crate edges, door frames,
 *    the underside of the snow caps);
 *  - Laplacian of 1/z → silhouettes. It is exactly 0 on any plane at any
 *    view angle, so the grazing ground and flat colour bands never get
 *    spurious lines.
 * Composition only blends the rim OVER the already-rendered image:
 * materials, colours and lighting are untouched.
 *
 * Game adaptations vs the reference:
 *  - the pass reads/writes LINEAR HDR buffers (the composer's HalfFloat
 *    targets) — sRGB conversion happens later in OutputPass, so the rim
 *    colour is converted to linear once (`color` setter);
 *  - `thickness` is in CSS pixels and scaled by the renderer pixel ratio,
 *    so the line looks the same on DPR 1 and DPR 2 screens;
 *  - excluded objects are hidden for the normal pre-pass only (visibility
 *    toggle, restored right after; already-hidden branches are skipped by
 *    traverseVisible);
 *  - the normal pre-pass never re-renders the shadow map;
 *  - `enabled = false` makes the composer skip it at zero cost (A/B).
 *
 * Excluded automatically: Points, Lines, Sprites, meshes whose materials are
 * all transparent / invisible / colorWrite-off / wireframe, and anything
 * flagged `userData.noOutline = true` (children included). The renderer must
 * use a classic depth buffer (no logarithmicDepthBuffer) and the camera
 * must be a PerspectiveCamera.
 */
export interface GivreOutlineOptions {
  /** Rim colour (sRGB). */
  color?: THREE.ColorRepresentation;
  /** Maximum rim opacity, 0..1. */
  intensity?: number;
  /** Sampling offset in CSS pixels: 1 ≈ 2 px line. 0.5..3. */
  thickness?: number;
  /** Normal crease threshold: lower = more lines. 0.4 ≈ angles over 23°. */
  normalThreshold?: number;
  /** Depth discontinuity threshold, relative to distance. 0.02 = 2 % jump. */
  depthThreshold?: number;
  /** Distance (m) where the rim starts fading, and where it vanishes. */
  fadeStart?: number;
  fadeEnd?: number;
  /** Also draw silhouettes against the sky. */
  outlineSky?: boolean;
}

/** Default exclusion rule (see the header). */
export function defaultOutlineExclude(o: THREE.Object3D): boolean {
  if (o.userData.noOutline === true) return true;
  const obj = o as THREE.Object3D & {
    isPoints?: boolean;
    isLine?: boolean;
    isSprite?: boolean;
    material?: THREE.Material | THREE.Material[];
  };
  if (obj.isPoints || obj.isLine || obj.isSprite) return true;
  if (!obj.material) return false;
  const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
  return materials.every(
    (m) =>
      m.transparent ||
      !m.visible ||
      !m.colorWrite ||
      (m as THREE.Material & { wireframe?: boolean }).wireframe === true,
  );
}

const OutlineShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tNormal: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 1000 },
    outlineColor: { value: new THREE.Color(1, 1, 1) },
    intensity: { value: 0.85 },
    thickness: { value: 1.0 },
    normalThreshold: { value: 0.4 },
    depthThreshold: { value: 0.02 },
    fadeStart: { value: 150 },
    fadeEnd: { value: 400 },
    outlineSky: { value: 1.0 },
    debugEdges: { value: 0.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    #include <packing>
    uniform sampler2D tDiffuse;
    uniform sampler2D tNormal;
    uniform sampler2D tDepth;
    uniform vec2 resolution;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform vec3 outlineColor;
    uniform float intensity;
    uniform float thickness;
    uniform float normalThreshold;
    uniform float depthThreshold;
    uniform float fadeStart;
    uniform float fadeEnd;
    uniform float outlineSky;
    uniform float debugEdges;
    varying vec2 vUv;

    float viewDist(float d) { return max(-perspectiveDepthToViewZ(d, cameraNear, cameraFar), 1e-4); }
    vec3 viewNormal(vec2 uv) { return unpackRGBToNormal(texture2D(tNormal, uv).rgb); }

    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec2 o = thickness / resolution;
      vec2 uvL = vUv - vec2(o.x, 0.0);
      vec2 uvR = vUv + vec2(o.x, 0.0);
      vec2 uvD = vUv - vec2(0.0, o.y);
      vec2 uvU = vUv + vec2(0.0, o.y);

      float dC = texture2D(tDepth, vUv).x;
      float dL = texture2D(tDepth, uvL).x;
      float dR = texture2D(tDepth, uvR).x;
      float dD = texture2D(tDepth, uvD).x;
      float dU = texture2D(tDepth, uvU).x;
      float skyCount = step(0.99999, dC) + step(0.99999, dL) + step(0.99999, dR)
                     + step(0.99999, dD) + step(0.99999, dU);
      // debugEdges: 0 = off, 1 = REPLACE (edge mask, sky black), 2 = OVERLAY
      // (max(previous, edge) — used by the FP pass over the world mask).
      if (skyCount > 4.5) {
        gl_FragColor = (debugEdges > 0.5 && debugEdges < 1.5) ? vec4(0.0, 0.0, 0.0, 1.0) : base;
        return;
      }

      // Depth: Laplacian of w = 1/z relative to w at the centre (0 on any plane).
      float wC = 1.0 / viewDist(dC);
      float lap = abs(1.0 / viewDist(dL) + 1.0 / viewDist(dR) - 2.0 * wC)
                + abs(1.0 / viewDist(dD) + 1.0 / viewDist(dU) - 2.0 * wC);
      float depthEdge = smoothstep(depthThreshold, depthThreshold * 2.0, lap / wC);

      // Normals: largest difference with the 4 neighbours.
      vec3 nC = viewNormal(vUv);
      float nd = max(max(length(nC - viewNormal(uvL)), length(nC - viewNormal(uvR))),
                     max(length(nC - viewNormal(uvD)), length(nC - viewNormal(uvU))));
      float normalEdge = smoothstep(normalThreshold, normalThreshold + 0.25, nd);

      if (skyCount > 0.5) {
        normalEdge = 0.0;
        depthEdge *= outlineSky;
      }

      float nearest = min(dC, min(min(dL, dR), min(dD, dU)));
      float fade = 1.0 - smoothstep(fadeStart, fadeEnd, viewDist(nearest));
      float edge = max(depthEdge, normalEdge) * fade;

      if (debugEdges > 1.5) { gl_FragColor = vec4(max(base.rgb, vec3(edge)), 1.0); return; }
      if (debugEdges > 0.5) { gl_FragColor = vec4(vec3(edge), 1.0); return; }
      gl_FragColor = vec4(mix(base.rgb, outlineColor, clamp(edge * intensity, 0.0, 1.0)), base.a);
    }
  `,
};

/** How `debugEdges` is drawn: REPLACE (edge mask) or OVERLAY (over the previous pass). */
export type OutlineDebugMode = "REPLACE" | "OVERLAY";

export class GivreOutlinePass extends Pass {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Objects never outlined; replaceable, e.g. (o) => defaultOutlineExclude(o) || o.name.startsWith("fx_"). */
  exclude: (o: THREE.Object3D) => boolean = defaultOutlineExclude;
  /** debugEdges draw mode (the FP pass uses OVERLAY over the world mask). */
  debugMode: OutlineDebugMode = "REPLACE";
  readonly material: THREE.ShaderMaterial;
  private readonly fsQuad: FullScreenQuad;
  private readonly normalTarget: THREE.WebGLRenderTarget;
  private readonly normalMaterial = new THREE.MeshNormalMaterial();
  private readonly prevClearColor = new THREE.Color();
  private readonly hidden: THREE.Object3D[] = [];
  private cssThickness = 1;
  private pixelRatio = 1;
  private debug = false;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, opts: GivreOutlineOptions = {}) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.material = new THREE.ShaderMaterial({
      name: "GivreOutline",
      uniforms: THREE.UniformsUtils.clone(OutlineShader.uniforms),
      vertexShader: OutlineShader.vertexShader,
      fragmentShader: OutlineShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
    const depthTexture = new THREE.DepthTexture(1, 1);
    depthTexture.type = THREE.UnsignedIntType;
    this.normalTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthTexture,
    });
    this.normalTarget.texture.name = "GivreOutline.normals";
    const u = this.material.uniforms;
    u.tNormal.value = this.normalTarget.texture;
    u.tDepth.value = this.normalTarget.depthTexture;
    this.color = opts.color ?? "#f6f9ff";
    if (opts.intensity !== undefined) this.intensity = opts.intensity;
    if (opts.thickness !== undefined) this.thickness = opts.thickness;
    if (opts.normalThreshold !== undefined) this.normalThreshold = opts.normalThreshold;
    if (opts.depthThreshold !== undefined) this.depthThreshold = opts.depthThreshold;
    if (opts.fadeStart !== undefined) this.fadeStart = opts.fadeStart;
    if (opts.fadeEnd !== undefined) this.fadeEnd = opts.fadeEnd;
    if (opts.outlineSky !== undefined) this.outlineSky = opts.outlineSky;
  }

  // ------------------------------------------------------------ settings (live)
  get intensity(): number { return this.material.uniforms.intensity.value; }
  set intensity(v: number) { this.material.uniforms.intensity.value = v; }
  /** CSS pixels (scaled by the renderer pixel ratio — see setPixelRatio). */
  get thickness(): number { return this.cssThickness; }
  set thickness(v: number) {
    this.cssThickness = v;
    this.material.uniforms.thickness.value = v * this.pixelRatio;
  }
  get normalThreshold(): number { return this.material.uniforms.normalThreshold.value; }
  set normalThreshold(v: number) { this.material.uniforms.normalThreshold.value = v; }
  get depthThreshold(): number { return this.material.uniforms.depthThreshold.value; }
  set depthThreshold(v: number) { this.material.uniforms.depthThreshold.value = v; }
  get fadeStart(): number { return this.material.uniforms.fadeStart.value; }
  set fadeStart(v: number) { this.material.uniforms.fadeStart.value = v; }
  get fadeEnd(): number { return this.material.uniforms.fadeEnd.value; }
  set fadeEnd(v: number) { this.material.uniforms.fadeEnd.value = v; }
  get outlineSky(): boolean { return this.material.uniforms.outlineSky.value > 0.5; }
  set outlineSky(v: boolean) { this.material.uniforms.outlineSky.value = v ? 1 : 0; }
  /** Show the detected edges only (white on black) — threshold tuning. */
  get debugEdges(): boolean { return this.debug; }
  set debugEdges(v: boolean) { this.debug = v; }
  /** Rim colour (sRGB in, stored LINEAR: the composer buffers are linear). */
  set color(c: THREE.ColorRepresentation) {
    (this.material.uniforms.outlineColor.value as THREE.Color).set(c);
  }
  get color(): THREE.Color { return this.material.uniforms.outlineColor.value; }

  /** Keep `thickness` in CSS pixels whatever the device pixel ratio. */
  setPixelRatio(ratio: number): void {
    this.pixelRatio = ratio;
    this.thickness = this.cssThickness;
  }

  // ------------------------------------------------------------ Pass
  /** Called by EffectComposer with DRAWING-BUFFER pixels (CSS × pixel ratio). */
  setSize(width: number, height: number): void {
    this.normalTarget.setSize(width, height);
    this.material.uniforms.resolution.value.set(width, height);
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    // 1) View normals + depth (excluded objects hidden for this pre-pass only;
    //    the BackSide sky is hidden by its noOutline flag).
    const hidden = this.hidden;
    this.scene.traverseVisible((o) => {
      if (this.exclude(o)) {
        o.visible = false;
        hidden.push(o);
      }
    });
    const prevOverride = this.scene.overrideMaterial;
    const prevBackground = this.scene.background;
    const prevAutoClear = renderer.autoClear;
    const prevShadowAutoUpdate = renderer.shadowMap.autoUpdate;
    const prevShadowNeedsUpdate = renderer.shadowMap.needsUpdate;
    const prevClearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.prevClearColor);

    this.scene.overrideMaterial = this.normalMaterial;
    this.scene.background = null;
    renderer.autoClear = false;
    // The shadow map was already refreshed by the colour pass: never redo it.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;
    renderer.setRenderTarget(this.normalTarget);
    renderer.setClearColor(0x8080ff, 1);
    renderer.clear(true, true, false);
    try {
      renderer.render(this.scene, this.camera);
    } finally {
      this.scene.overrideMaterial = prevOverride;
      this.scene.background = prevBackground;
      renderer.setClearColor(this.prevClearColor, prevClearAlpha);
      renderer.autoClear = prevAutoClear;
      renderer.shadowMap.autoUpdate = prevShadowAutoUpdate;
      renderer.shadowMap.needsUpdate = prevShadowNeedsUpdate;
      for (const o of hidden) o.visible = true;
      hidden.length = 0;
    }

    // 2) Composition: rim over the rendered image.
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.cameraNear.value = this.camera.near;
    u.cameraFar.value = this.camera.far;
    u.debugEdges.value = this.debug ? (this.debugMode === "OVERLAY" ? 2 : 1) : 0;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.fsQuad.render(renderer);
  }

  dispose(): void {
    this.normalTarget.depthTexture?.dispose();
    this.normalTarget.dispose();
    this.normalMaterial.dispose();
    this.material.dispose();
    this.fsQuad.dispose();
  }
}

