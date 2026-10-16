import * as THREE from "three";
import type { GivreSnowData } from "./GivreData";

/**
 * GIVRE v3 — falling snow (adapted from
 * src/assets/MAP/Givre/reference/givreSnow.reference.ts).
 *
 * ONE THREE.Points (one draw call), the whole simulation in the vertex
 * shader:
 *  - world-fixed flakes: position = seed × box + (wind, −fall) × t × k + sway;
 *  - the box (60 × 25 × 60 m) follows the camera: every flake is wrapped
 *    inside it (modulo) — no flake is ever spawned / killed on the CPU;
 *  - hidden under roofs thanks to the height map givre_neige_toits.png (no
 *    snow inside the rooms, under the hall or under the gallery), and
 *    within 0.9 m of the camera.
 * No collision, no physics cost, client-only (never networked). It lives in
 * the WORLD scene only: the first-person weapon pass never shows it.
 * Excluded from GivreOutlinePass (Points + userData.noOutline).
 *
 * Time = seconds elapsed since the map loaded (never an absolute date: GPU
 * float precision).
 */
const SNOW_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aSeed;      // seed 0..1 (x, y, z)
attribute vec3 aVar;       // (phase 0..2pi, speed factor 0.8..1.2, size factor 0.6..1.4)
uniform float uTime;
uniform vec3 uBox;         // boxSize (x, y, z)
uniform float uYMin;
uniform vec3 uVel;         // (wind x, -fall, wind z) in m/s
uniform float uSwayAmp;
uniform float uSwayW;      // 2 pi x frequency
uniform float uFlake;      // mean diameter (m)
uniform float uMinDist;
uniform vec3 uCam;         // camera world position
uniform sampler2D uMask;   // roof height (r x 25.5 m)
uniform float uViewportHeight;
varying float vAlpha;
void main() {
  float t = uTime;
  vec3 p = aSeed * uBox + vec3(0.0, uYMin, 0.0) + uVel * (t * aVar.y);
  float wt = t * uSwayW;
  p.x += sin(wt + aVar.x) * uSwayAmp;
  p.z -= cos(wt * 0.8 + aVar.x * 1.7) * uSwayAmp;
  // wrap inside the box around the camera (XZ) and between uYMin and uYMin + uBox.y (world Y)
  vec3 lo = vec3(uCam.x - 0.5 * uBox.x, uYMin, uCam.z - 0.5 * uBox.z);
  p = lo + mod(p - lo, uBox);
  // roof map: u = (x + 140) / 280, v = (80 - z) / 220 (texture loaded with flipY = true)
  vec2 muv = vec2((p.x + 140.0) / 280.0, (80.0 - p.z) / 220.0);
  float roof = texture2D(uMask, muv).r * 25.5;
  bool hidden = p.y < roof || distance(p, uCam) < uMinDist;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float px = uFlake * aVar.z * projectionMatrix[1][1] * 0.5 * uViewportHeight / max(-mv.z, 0.01);
  gl_PointSize = hidden ? 0.0 : clamp(px, 1.0, 24.0);
  vAlpha = hidden ? 0.0 : 0.9 * clamp(px, 0.0, 1.0);   // distant flakes fade (no shimmer)
  if (hidden) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // off-screen
  #include <logdepthbuf_vertex>
}
`;

const SNOW_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
varying float vAlpha;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = vAlpha * (1.0 - smoothstep(0.55, 1.0, r));
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}
`;

/** Graphics option levels ("off" hides the snow). */
export type GivreSnowLevel = "off" | "legere" | "normale" | "dense";

/** Small deterministic PRNG (same flakes on every load). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class GivreSnow {
  readonly points: THREE.Points;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly maxCount: number;
  private readonly volume: number;
  private readonly camPos = new THREE.Vector3();
  private level: GivreSnowLevel = "normale";

  /**
   * @param cfg  JSON `snow` section.
   * @param mask givre_neige_toits.png loaded with TextureLoader (default
   *             flipY = true); its filtering is set here (nearest, no mipmap).
   */
  constructor(
    private readonly cfg: GivreSnowData,
    private readonly mask: THREE.Texture,
    level: GivreSnowLevel = "normale",
  ) {
    mask.magFilter = THREE.NearestFilter;
    mask.minFilter = THREE.NearestFilter;
    mask.generateMipmaps = false;
    mask.wrapS = THREE.ClampToEdgeWrapping;
    mask.wrapT = THREE.ClampToEdgeWrapping;
    mask.colorSpace = THREE.NoColorSpace; // data (heights), not a colour
    mask.needsUpdate = true;

    const [bx, by, bz] = cfg.boxSize;
    this.volume = bx * by * bz;
    const maxLevel = Math.max(...Object.values(cfg.levels));
    this.maxCount = Math.round(cfg.density * this.volume * maxLevel);
    const rnd = mulberry32(20261011);
    const seeds = new Float32Array(this.maxCount * 3);
    const vars = new Float32Array(this.maxCount * 3);
    for (let i = 0; i < this.maxCount; i++) {
      seeds[i * 3] = rnd();
      seeds[i * 3 + 1] = rnd();
      seeds[i * 3 + 2] = rnd();
      vars[i * 3] = rnd() * Math.PI * 2; // sway phase
      vars[i * 3 + 1] = 0.8 + 0.4 * rnd(); // speed
      vars[i * 3 + 2] = 0.6 + 0.8 * rnd(); // size
    }
    const geometry = new THREE.BufferGeometry();
    // `position` is required by three.js — ignored by the shader.
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.maxCount * 3), 3));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 3));
    geometry.setAttribute("aVar", new THREE.BufferAttribute(vars, 3));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6); // never culled
    this.geometry = geometry;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uBox: { value: new THREE.Vector3(bx, by, bz) },
        uYMin: { value: cfg.yMin },
        uVel: { value: new THREE.Vector3(cfg.wind[0], -cfg.fallSpeed, cfg.wind[2]) },
        uSwayAmp: { value: cfg.swayAmplitude },
        uSwayW: { value: cfg.swayHz * Math.PI * 2 },
        uFlake: { value: cfg.flakeSize },
        uMinDist: { value: cfg.minDistance },
        uCam: { value: new THREE.Vector3() },
        uMask: { value: mask },
        uViewportHeight: { value: 1080 },
        uColor: { value: new THREE.Color(0xf4f7ff) },
      },
      vertexShader: SNOW_VERTEX,
      fragmentShader: SNOW_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    const points = new THREE.Points(geometry, this.material);
    points.name = "givre_neige";
    points.frustumCulled = false;
    points.renderOrder = 20;
    points.userData.noOutline = true;
    points.raycast = () => {}; // purely visual
    this.points = points;
    this.setLevel(level);
  }

  get currentLevel(): GivreSnowLevel {
    return this.level;
  }

  /** Flake count of a level (legere ≈ 7 400, normale ≈ 14 850, dense ≈ 25 200). */
  countFor(level: GivreSnowLevel): number {
    if (level === "off") return 0;
    const k = this.cfg.levels[level] ?? 1;
    return Math.min(this.maxCount, Math.round(this.cfg.density * this.volume * k));
  }

  /** Graphics option, applied LIVE (draw range only — no reallocation). */
  setLevel(level: GivreSnowLevel): void {
    this.level = level;
    this.points.visible = level !== "off";
    this.geometry.setDrawRange(0, this.countFor(level));
  }

  /** Every frame: seconds since the map loaded, rendered camera, canvas height (px). */
  update(elapsedSeconds: number, camera: THREE.Camera, viewportHeightPx: number): void {
    if (!this.points.visible) return;
    camera.getWorldPosition(this.camPos);
    const u = this.material.uniforms;
    u.uTime.value = elapsedSeconds;
    (u.uCam.value as THREE.Vector3).copy(this.camPos);
    u.uViewportHeight.value = viewportHeightPx;
  }

  dispose(): void {
    this.points.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.mask.dispose();
  }
}

