// Contour cel-shading de Givre : fin liseré clair sur les arêtes, en post-processing three.js.
// Détection sur la géométrie uniquement (pas sur les couleurs) :
//   - normales de vue : cassures de surface (angles des murs, caisses, cadres, chapeaux de neige) ;
//   - profondeur : laplacien de 1/z, nul sur tout plan quel que soit l'angle de vue, donc pas de
//     fausses lignes sur le sol en vue rasante ; il ne réagit qu'aux silhouettes et aux ruptures.
// Le pass ne touche ni aux matériaux, ni aux couleurs, ni à l'éclairage : il dessine seulement le liseré
// par-dessus l'image déjà rendue.
//
// Utilisation (three.js r155+) :
//   const composer = new EffectComposer(renderer);
//   composer.addPass(new RenderPass(scene, camera));
//   const outline = new GivreOutlinePass(scene, camera, { thickness: 1, intensity: 0.85 });
//   composer.addPass(outline);
//   composer.addPass(new OutputPass());       // conversion sRGB / tone mapping APRES le contour
//   // optionnel : un FXAA (ShaderPass(FXAAShader)) après OutputPass pour lisser les lignes
//   // boucle : composer.render() ; redimensionnement : composer.setSize(w, h)
//   // réglages à chaud : outline.thickness = 1.5 ; outline.intensity = 0.6 ; outline.debugEdges = true
//
// Objets ignorés : particules (Points), lignes, sprites, meshes dont tous les matériaux sont transparents,
// invisibles ou en fil de fer, et tout objet marqué userData.noOutline = true (enfants compris).
// Marquer ainsi les effets opaques à ne pas détourer (traceurs, flashs, HUD en 3D), ou remplacer
// outline.exclude par sa propre règle.
//
// Limites : caméra en perspective, depth buffer classique (pas de logarithmicDepthBuffer).
import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

export interface GivreOutlineOptions {
  /** Couleur du liseré (blanc très légèrement bleuté par défaut). */
  color?: THREE.ColorRepresentation;
  /** Opacité maximale du liseré, de 0 à 1. */
  intensity?: number;
  /** Épaisseur en pixels : 1 donne un trait d'environ 2 px. 0,5 à 3. */
  thickness?: number;
  /** Seuil de cassure des normales : plus bas = plus de lignes. 0,4 ≈ angles de plus de 23°. */
  normalThreshold?: number;
  /** Seuil de rupture de profondeur, relatif à la distance. 0,02 = saut de 2 %. */
  depthThreshold?: number;
  /** Distance (m) où le liseré commence à s'estomper, et où il disparaît. */
  fadeStart?: number;
  fadeEnd?: number;
  /** Dessiner aussi les silhouettes contre le ciel. */
  outlineSky?: boolean;
}

/** Règle d'exclusion par défaut (voir l'en-tête). */
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
      m.transparent || !m.visible || !m.colorWrite || (m as THREE.Material & { wireframe?: boolean }).wireframe === true,
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
    outlineColor: { value: new THREE.Color('#f6f9ff') },
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
      if (skyCount > 4.5) { gl_FragColor = base; return; }

      // Profondeur : laplacien de w = 1/z, relatif à w au centre (0 sur un plan, quel que soit l'angle).
      float wC = 1.0 / viewDist(dC);
      float lap = abs(1.0 / viewDist(dL) + 1.0 / viewDist(dR) - 2.0 * wC)
                + abs(1.0 / viewDist(dD) + 1.0 / viewDist(dU) - 2.0 * wC);
      float depthEdge = smoothstep(depthThreshold, depthThreshold * 2.0, lap / wC);

      // Normales : plus grand écart avec les 4 voisins.
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

      if (debugEdges > 0.5) { gl_FragColor = vec4(vec3(edge), 1.0); return; }
      gl_FragColor = vec4(mix(base.rgb, outlineColor, clamp(edge * intensity, 0.0, 1.0)), base.a);
    }
  `,
};

export class GivreOutlinePass extends Pass {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Objets à ne pas détourer ; remplaçable, ex. (o) => defaultOutlineExclude(o) || o.name.startsWith('fx_'). */
  exclude: (o: THREE.Object3D) => boolean = defaultOutlineExclude;
  readonly material: THREE.ShaderMaterial;
  private readonly fsQuad: FullScreenQuad;
  private readonly normalTarget: THREE.WebGLRenderTarget;
  private readonly normalMaterial = new THREE.MeshNormalMaterial();
  private readonly prevClearColor = new THREE.Color();
  private readonly hidden: THREE.Object3D[] = [];

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, opts: GivreOutlineOptions = {}) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.material = new THREE.ShaderMaterial({
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
    const u = this.material.uniforms;
    u.tNormal.value = this.normalTarget.texture;
    u.tDepth.value = this.normalTarget.depthTexture;
    if (opts.color !== undefined) this.color = opts.color;
    if (opts.intensity !== undefined) this.intensity = opts.intensity;
    if (opts.thickness !== undefined) this.thickness = opts.thickness;
    if (opts.normalThreshold !== undefined) this.normalThreshold = opts.normalThreshold;
    if (opts.depthThreshold !== undefined) this.depthThreshold = opts.depthThreshold;
    if (opts.fadeStart !== undefined) this.fadeStart = opts.fadeStart;
    if (opts.fadeEnd !== undefined) this.fadeEnd = opts.fadeEnd;
    if (opts.outlineSky !== undefined) this.outlineSky = opts.outlineSky;
  }

  // ------------------------------------------------------------ réglages
  get intensity(): number { return this.material.uniforms.intensity.value; }
  set intensity(v: number) { this.material.uniforms.intensity.value = v; }
  get thickness(): number { return this.material.uniforms.thickness.value; }
  set thickness(v: number) { this.material.uniforms.thickness.value = v; }
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
  /** Affiche uniquement les arêtes détectées (blanc sur noir), pour régler les seuils. */
  get debugEdges(): boolean { return this.material.uniforms.debugEdges.value > 0.5; }
  set debugEdges(v: boolean) { this.material.uniforms.debugEdges.value = v ? 1 : 0; }
  get color(): THREE.Color { return this.material.uniforms.outlineColor.value; }
  set color(c: THREE.ColorRepresentation) { (this.material.uniforms.outlineColor.value as THREE.Color).set(c); }

  // ------------------------------------------------------------ Pass
  setSize(width: number, height: number): void {
    this.normalTarget.setSize(width, height);
    this.material.uniforms.resolution.value.set(width, height);
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    // 1) Normales de vue + profondeur de la scène (le ciel en BackSide est ignoré par le matériau).
    //    Les objets exclus sont masqués le temps de cette passe, comme dans SSAOPass.
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
    const prevClearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.prevClearColor);

    this.scene.overrideMaterial = this.normalMaterial;
    this.scene.background = null;
    renderer.autoClear = false;
    // Les ombres ont déjà été calculées par le RenderPass : ne pas refaire la shadow map ici.
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.normalTarget);
    renderer.setClearColor(0x8080ff, 1);
    renderer.clear(true, true, false);
    renderer.render(this.scene, this.camera);

    this.scene.overrideMaterial = prevOverride;
    this.scene.background = prevBackground;
    renderer.setClearColor(this.prevClearColor, prevClearAlpha);
    renderer.autoClear = prevAutoClear;
    renderer.shadowMap.autoUpdate = prevShadowAutoUpdate;
    for (const o of hidden) o.visible = true;
    hidden.length = 0;

    // 2) Composition : liseré par-dessus l'image rendue.
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.cameraNear.value = this.camera.near;
    u.cameraFar.value = this.camera.far;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.fsQuad.render(renderer);
  }

  dispose(): void {
    this.normalTarget.dispose();
    this.normalMaterial.dispose();
    this.material.dispose();
    this.fsQuad.dispose();
  }
}
