import * as THREE from "three";
import type { Poly } from "./MatchIntroTimeline";

/**
 * MATCH INTRO — 2D compositor (the "comic page").
 *
 * Draws, in screen pixels, the dark background, every blade (sticker
 * polygon with its accent backdrop, halftone, ink cut and hard shadow),
 * the character photo of each blade (sampled from a screen-sized 8-bit
 * MSAA target the stages render into, already ACES tone mapped + sRGB
 * encoded like the game's output), the slash streaks, the flashes and
 * the exit wipe.
 *
 * All 2D shaders output display-ready sRGB directly.
 */

const COMMON_GLSL = /* glsl */ `
  uniform vec2 uRes;
  uniform float uTime;
  float hash21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
  float halftone(vec2 px, float cell, float level){
    const float c45 = 0.70710678;
    vec2 q = mat2(c45, -c45, c45, c45) * px / cell;
    vec2 f = fract(q) - 0.5;
    float r = 0.62 * sqrt(clamp(level, 0.0, 1.0));
    return smoothstep(r, r - 0.09, length(f));
  }
`;

const FULL_VS = /* glsl */ `
  void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const POLY_VS = /* glsl */ `
  uniform vec2 uRes;
  uniform vec2 uOffset;
  void main(){
    vec2 p = position.xy + uOffset;
    gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
  }
`;

const BG_FS = /* glsl */ `
  ${COMMON_GLSL}
  uniform float uOpacity;
  void main(){
    vec2 uv = gl_FragCoord.xy / uRes;
    vec3 top = vec3(0.180, 0.118, 0.055);
    vec3 bot = vec3(0.090, 0.058, 0.028);
    vec3 col = mix(bot, top, uv.y);
    // diagonal speed lines drifting left
    float d = (gl_FragCoord.x + gl_FragCoord.y * 0.35 + uTime * 260.0) / 46.0;
    float lines = smoothstep(0.92, 1.0, fract(d)) * 0.10;
    col += lines * vec3(1.0, 0.85, 0.55);
    // big soft halftone
    col += 0.035 * halftone(gl_FragCoord.xy, 22.0, 0.55 + 0.35 * (1.0 - uv.y));
    // vignette
    vec2 c = uv - 0.5; c.x *= uRes.x / uRes.y;
    col *= 1.0 - 0.45 * smoothstep(0.35, 1.05, length(c));
    gl_FragColor = vec4(col, uOpacity);
  }
`;

const BLADE_FS = /* glsl */ `
  ${COMMON_GLSL}
  uniform sampler2D uTex;
  uniform vec4 uTexMap;     // stage texture uv = (px - xy) * zw
  uniform float uHasTex;
  uniform vec2 uPoly[6];
  uniform vec3 uAccent;
  uniform float uMode;      // 0 empty slot, 1 silhouette, 2 live
  uniform float uColorIn;   // silhouette -> color
  uniform float uFlash;
  uniform float uBurst;     // gold sunburst (MVP)
  uniform vec2 uFocus;      // px
  uniform float uOutline;   // px
  uniform float uSeed;
  uniform float uOpacity;

  float segDist(vec2 p, vec2 a, vec2 b){
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return length(pa - ba * h);
  }
  float edgeDist(vec2 p){
    float d = 1e9;
    for (int i = 0; i < 6; i++) {
      int j = i == 5 ? 0 : i + 1;
      d = min(d, segDist(p, uPoly[i], uPoly[j]));
    }
    return d;
  }

  void main(){
    vec2 px = gl_FragCoord.xy;
    vec2 uv = (px - uTexMap.xy) * uTexMap.zw;
    // comic pop-out pass: only the character pixels, over the blade's cut
    if (uMode > 2.5) {
      vec4 c0 = texture2D(uTex, uv);
      if (c0.a < 0.02) discard;
      vec3 photo0 = c0.rgb / max(c0.a, 1e-4);
      photo0 = mix(photo0, vec3(1.0, 0.98, 0.92), clamp(uFlash, 0.0, 1.0));
      gl_FragColor = vec4(photo0, c0.a * uOpacity);
      return;
    }
    float H = uRes.y;
    vec2 toF = px - uFocus;
    float rF = length(toF) / H;

    // ---- backdrop
    vec3 accent = uAccent;
    vec3 deep = accent * 0.42 + vec3(0.06, 0.035, 0.015);
    vec3 bright = mix(accent, vec3(1.0, 0.97, 0.88), 0.28);
    float g = clamp((px.y - (uFocus.y - 0.55 * H)) / (1.1 * H), 0.0, 1.0);
    vec3 back = mix(deep, bright, g);
    // spotlight behind the character
    back += accent * 0.55 * exp(-rF * rF * 9.0);
    // speed lines along the cut direction
    float sl = (px.x * 0.25 + px.y + uTime * 340.0 + uSeed * 97.0) / 38.0;
    back += 0.10 * smoothstep(0.86, 1.0, fract(sl)) * bright;
    // halftone, denser at the bottom
    float ht = halftone(px + uSeed * 31.0, 11.0, 0.15 + 0.6 * (1.0 - g));
    back = mix(back, deep * 0.72, 0.38 * ht);
    // gold sunburst (MVP)
    if (uBurst > 0.0) {
      float a = atan(toF.y, toF.x);
      float rays = smoothstep(0.35, 0.75, sin(a * 14.0 + uTime * 0.9) * 0.5 + 0.5);
      vec3 gold = vec3(0.98, 0.80, 0.08);
      vec3 burst = mix(vec3(0.85, 0.42, 0.02), gold, rays * 0.65 + 0.35 * exp(-rF * 2.2));
      burst += vec3(1.0, 0.95, 0.75) * exp(-rF * rF * 7.0) * 0.8;
      back = mix(back, burst, uBurst);
      // drifting gold sparkles
      vec2 gq = px / (H * 0.055) + vec2(0.0, -uTime * 0.9);
      vec2 cid = floor(gq);
      vec2 cf = fract(gq) - 0.5;
      float hs = hash21(cid + uSeed);
      vec2 off = (vec2(hash21(cid + 1.3), hash21(cid + 2.7)) - 0.5) * 0.6;
      float tw = pow(max(0.0, sin(uTime * 7.0 + hs * 40.0)), 6.0);
      float sp = smoothstep(0.09, 0.0, length(cf - off)) * step(0.8, hs) * tw;
      float cross = (smoothstep(0.012, 0.0, abs(cf.x - off.x)) * smoothstep(0.22, 0.0, abs(cf.y - off.y))
                   + smoothstep(0.012, 0.0, abs(cf.y - off.y)) * smoothstep(0.22, 0.0, abs(cf.x - off.x))) * step(0.8, hs) * tw;
      back += vec3(1.0, 0.95, 0.72) * (sp + 0.8 * cross) * uBurst;
    }
    // empty slot: dark ink tinted by the accent
    if (uMode < 0.5) {
      vec3 ink = vec3(0.13, 0.085, 0.04);
      back = mix(ink, accent * 0.32 + ink * 0.6, 0.35 + 0.25 * g);
      back = mix(back, ink * 0.7, 0.45 * halftone(px + uSeed * 17.0, 9.0, 0.55));
    }

    vec3 col = back;
    // ---- character photo
    if (uHasTex > 0.5 && uMode > 0.5) {
      vec4 c = texture2D(uTex, uv);
      float a = clamp(c.a, 0.0, 1.0);
      vec3 photo = c.rgb / max(a, 1e-4);
      // silhouette: ink body + gold rim halo
      vec3 sil = vec3(0.10, 0.065, 0.03);
      vec3 body = mix(sil, photo, uColorIn);
      float halo = 0.0;
      if (uColorIn < 0.999) {
        vec2 o = 4.0 * uTexMap.zw;
        float m = 0.0;
        m = max(m, texture2D(uTex, uv + vec2(o.x, 0.0)).a);
        m = max(m, texture2D(uTex, uv - vec2(o.x, 0.0)).a);
        m = max(m, texture2D(uTex, uv + vec2(0.0, o.y)).a);
        m = max(m, texture2D(uTex, uv - vec2(0.0, o.y)).a);
        halo = clamp(m - a, 0.0, 1.0) * (1.0 - uColorIn);
      }
      col = mix(col, body, a);
      col = mix(col, vec3(1.0, 0.82, 0.18), halo);
    }
    // ---- entrance flash
    col = mix(col, vec3(1.0, 0.98, 0.92), clamp(uFlash, 0.0, 1.0));
    // ---- sticker cut: ink border + thin cream inner line
    float d = edgeDist(px);
    float ink = 1.0 - smoothstep(uOutline - 1.0, uOutline + 0.5, d);
    float shine = (1.0 - smoothstep(uOutline + 1.5, uOutline + 3.5, d)) * (1.0 - ink);
    col = mix(col, vec3(1.0, 0.96, 0.86), shine * 0.55);
    col = mix(col, vec3(0.165, 0.106, 0.047), ink);
    gl_FragColor = vec4(col, uOpacity);
  }
`;

const SOLID_FS = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  void main(){ gl_FragColor = vec4(uColor, uOpacity); }
`;

const SLASH_FS = /* glsl */ `
  ${COMMON_GLSL}
  uniform float uP;        // 0..1 progress
  uniform vec3 uAccent;
  uniform vec2 uA;         // line start (px)
  uniform vec2 uB;         // line end (px)
  void main(){
    vec2 p = gl_FragCoord.xy;
    vec2 ab = uB - uA;
    float L = length(ab);
    vec2 dir = ab / L;
    vec2 n = vec2(-dir.y, dir.x);
    float along = dot(p - uA, dir) / L;      // 0..1 along the line
    float across = abs(dot(p - uA, n));
    float head = mix(-0.15, 1.15, 1.0 - pow(1.0 - uP, 2.0));
    float tail = head - 0.55;
    float inSeg = smoothstep(tail, tail + 0.25, along) * (1.0 - smoothstep(head - 0.02, head, along));
    float fade = 1.0 - smoothstep(0.65, 1.0, uP);
    float core = (1.0 - smoothstep(1.5, 4.0, across)) * inSeg;
    float glow = exp(-across / 22.0) * inSeg * 0.7;
    float second = (1.0 - smoothstep(1.0, 3.0, abs(across - 26.0))) * inSeg * 0.8;
    vec3 col = vec3(1.0, 0.98, 0.9) * core + uAccent * (glow + second);
    float a = clamp(core + glow + second, 0.0, 1.0) * fade;
    gl_FragColor = vec4(col * fade, a);
  }
`;

const WIPE_FS = /* glsl */ `
  ${COMMON_GLSL}
  uniform float uP;     // 0..1 wipe progress
  uniform float uEdge;  // 1 = draw the edge stroke, 0 = erase pass
  void main(){
    vec2 uv = gl_FragCoord.xy / uRes;
    float aspect = uRes.x / uRes.y;
    // slanted cut sweeping left -> right
    float x = uv.x + (uv.y - 0.5) * 0.22 / aspect;
    float edge = mix(-0.25, 1.3, uP);
    float dpx = (edge - x) * uRes.x;
    if (uEdge < 0.5) {
      float a = smoothstep(-1.0, 1.0, dpx);
      gl_FragColor = vec4(0.0, 0.0, 0.0, a);
    } else {
      float inkBand = (1.0 - smoothstep(10.0, 13.0, abs(dpx - 6.0))) * step(0.0, uP) * (1.0 - step(1.0, uP));
      float cream = (1.0 - smoothstep(2.0, 4.0, abs(dpx + 9.0))) * step(0.001, uP) * (1.0 - step(0.999, uP));
      vec3 col = mix(vec3(0.165, 0.106, 0.047), vec3(1.0, 0.97, 0.88), cream / max(inkBand + cream, 1e-3));
      gl_FragColor = vec4(col, clamp(inkBand + cream, 0.0, 1.0));
    }
  }
`;

const COPY_FS = /* glsl */ `
  uniform sampler2D uSrc;
  uniform vec2 uSrcTexel;   // 1 / source size (same pixel grid, origin 0,0)
  void main(){ gl_FragColor = texture2D(uSrc, gl_FragCoord.xy * uSrcTexel); }
`;

/**
 * 8-bit multisampled stage target: the stages render tone mapped (ACES,
 * the game's curve) and sRGB encoded, so no HDR buffer is needed — half the
 * bandwidth of a half-float target (integrated GPUs). three.js applies tone
 * mapping / output encoding only to the screen or to "XR" targets: the flag
 * routes this target through that same path; the explicit RGBA8 storage
 * keeps the multisample resolve format-compatible.
 */
function createStageTarget(width: number, height: number, samples: number): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
    internalFormat: "RGBA8",
    samples,
    depthBuffer: true,
    // depth is only needed while a stage renders: never resolved
    resolveDepthBuffer: false,
  });
  (rt as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true;
  return rt;
}

function fullScreenQuad(material: THREE.ShaderMaterial): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  return mesh;
}

function polyGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(7 * 3), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5, 0, 5, 6, 0, 6, 1]);
  return geo;
}

/** Normalized poly (y down) → pixel poly (y up) written into a geometry. */
function writePoly(geo: THREE.BufferGeometry, polyPx: number[]): void {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < 6; i++) {
    cx += polyPx[i * 2];
    cy += polyPx[i * 2 + 1];
  }
  pos.setXYZ(0, cx / 6, cy / 6, 0);
  for (let i = 0; i < 6; i++) pos.setXYZ(i + 1, polyPx[i * 2], polyPx[i * 2 + 1], 0);
  pos.needsUpdate = true;
}

export interface BladeDraw {
  polyPx: number[]; // 12 numbers, pixel space, y up
  accent: THREE.Color;
  /** 0 empty slot, 1 silhouette, 2 live, 3 pop-out (character pixels only). */
  mode: 0 | 1 | 2 | 3;
  colorIn: number;
  flash: number;
  burst: number;
  focusPx: [number, number];
  seed: number;
  hasTex: boolean;
  /** Stage texture (shared target or a settled blade's cache) and its px → uv mapping. */
  tex?: THREE.Texture | null;
  texMap?: [number, number, number, number];
  opacity: number;
}

/** Cached 3D render of a settled blade (refreshed at a lower rate while playing). */
export interface StageCache {
  rt: THREE.WebGLRenderTarget | null;
  /** Used region of `rt` (target pixels). */
  usedW: number;
  usedH: number;
  /** Canvas-pixel size of the rectangle it was rendered for. */
  srcW: number;
  srcH: number;
  frame: number;
  valid: boolean;
}

export function createStageCache(): StageCache {
  return { rt: null, usedW: 1, usedH: 1, srcW: 0, srcH: 0, frame: -1e9, valid: false };
}

export class MatchIntroCompositor {
  readonly rt: THREE.WebGLRenderTarget;
  private readonly cam = new THREE.Camera();
  private readonly scene = new THREE.Scene();
  private readonly res = new THREE.Vector2(1, 1);
  private readonly bg: THREE.Mesh;
  private readonly bgMat: THREE.ShaderMaterial;
  private readonly bladeMat: THREE.ShaderMaterial;
  private readonly bladeMesh: THREE.Mesh;
  private readonly shadowMat: THREE.ShaderMaterial;
  private readonly shadowMesh: THREE.Mesh;
  private readonly polyGeo = polyGeometry();
  private readonly slashMat: THREE.ShaderMaterial;
  private readonly slash: THREE.Mesh;
  private readonly flashMat: THREE.ShaderMaterial;
  private readonly flash: THREE.Mesh;
  private readonly wipeEraseMat: THREE.ShaderMaterial;
  private readonly wipeEdgeMat: THREE.ShaderMaterial;
  private readonly wipe: THREE.Mesh;
  private readonly polyUniform: THREE.Vector2[] = Array.from({ length: 6 }, () => new THREE.Vector2());
  private time = 0;
  private readonly renderer: THREE.WebGLRenderer;
  /** Stage target resolution relative to the canvas (quality knob). */
  private stageScale = 1;
  /** While set, the MSAA resolve of the stage target only copies this rectangle. */
  private blitRect: { x: number; y: number; w: number; h: number } | null = null;
  /** Small multisampled target for settled tiles (its resolve stays cheap). */
  private scratch: THREE.WebGLRenderTarget | null = null;
  private readonly copyMat: THREE.ShaderMaterial;
  private readonly copyQuad: THREE.Mesh;
  private readonly screenMap: [number, number, number, number] = [0, 0, 1, 1];

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.rt = createStageTarget(4, 4, 4);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    // three.js resolves the WHOLE multisampled target after every render()
    // call; the stages each render into their own rectangle of the shared
    // target, so their resolve is restricted to that rectangle (this
    // renderer and its context belong to the intro only).
    const gl = renderer.getContext();
    if (typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext) {
      const nativeBlit = gl.blitFramebuffer.bind(gl);
      gl.blitFramebuffer = (sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter) => {
        const r = this.blitRect;
        if (r) nativeBlit(r.x, r.y, r.x + r.w, r.y + r.h, r.x, r.y, r.x + r.w, r.y + r.h, mask, filter);
        else nativeBlit(sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter);
      };
    }
    const common = { uRes: { value: this.res }, uTime: { value: 0 } };
    this.bgMat = new THREE.ShaderMaterial({
      uniforms: { ...common, uOpacity: { value: 1 } },
      vertexShader: FULL_VS,
      fragmentShader: BG_FS,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.bg = fullScreenQuad(this.bgMat);

    this.bladeMat = new THREE.ShaderMaterial({
      uniforms: {
        ...common,
        uOffset: { value: new THREE.Vector2() },
        uTex: { value: this.rt.texture },
        uTexMap: { value: new THREE.Vector4(0, 0, 1, 1) },
        uHasTex: { value: 0 },
        uPoly: { value: this.polyUniform },
        uAccent: { value: new THREE.Color() },
        uMode: { value: 2 },
        uColorIn: { value: 1 },
        uFlash: { value: 0 },
        uBurst: { value: 0 },
        uFocus: { value: new THREE.Vector2() },
        uOutline: { value: 6 },
        uSeed: { value: 0 },
        uOpacity: { value: 1 },
      },
      vertexShader: POLY_VS,
      fragmentShader: BLADE_FS,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      side: THREE.DoubleSide,
    });
    this.bladeMesh = new THREE.Mesh(this.polyGeo, this.bladeMat);
    this.bladeMesh.frustumCulled = false;

    this.shadowMat = new THREE.ShaderMaterial({
      uniforms: {
        uRes: { value: this.res },
        uOffset: { value: new THREE.Vector2() },
        uColor: { value: new THREE.Color(0.11, 0.07, 0.03) },
        uOpacity: { value: 0.88 },
      },
      vertexShader: POLY_VS,
      fragmentShader: SOLID_FS,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      side: THREE.DoubleSide,
    });
    this.shadowMesh = new THREE.Mesh(this.polyGeo, this.shadowMat);
    this.shadowMesh.frustumCulled = false;

    this.slashMat = new THREE.ShaderMaterial({
      uniforms: {
        ...common,
        uP: { value: 0 },
        uAccent: { value: new THREE.Color() },
        uA: { value: new THREE.Vector2() },
        uB: { value: new THREE.Vector2() },
      },
      vertexShader: FULL_VS,
      fragmentShader: SLASH_FS,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.AdditiveBlending,
    });
    this.slash = fullScreenQuad(this.slashMat);

    this.flashMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(1, 0.97, 0.88) }, uOpacity: { value: 0 } },
      vertexShader: FULL_VS,
      fragmentShader: SOLID_FS,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.flash = fullScreenQuad(this.flashMat);

    this.wipeEraseMat = new THREE.ShaderMaterial({
      uniforms: { ...common, uP: { value: 0 }, uEdge: { value: 0 } },
      vertexShader: FULL_VS,
      fragmentShader: WIPE_FS,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      // dst = dst * (1 - srcAlpha): erases the composed page where alpha = 1
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.wipeEdgeMat = new THREE.ShaderMaterial({
      uniforms: { ...common, uP: { value: 0 }, uEdge: { value: 1 } },
      vertexShader: FULL_VS,
      fragmentShader: WIPE_FS,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.wipe = fullScreenQuad(this.wipeEraseMat);
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { uSrc: { value: null }, uSrcTexel: { value: new THREE.Vector2(1, 1) } },
      vertexShader: FULL_VS,
      fragmentShader: COPY_FS,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.copyQuad = fullScreenQuad(this.copyMat);
    this.scene.matrixWorldAutoUpdate = false;
  }

  setSize(width: number, height: number): void {
    this.res.set(width, height);
    this.rt.setSize(Math.max(1, Math.round(width * this.stageScale)), Math.max(1, Math.round(height * this.stageScale)));
    this.screenMap[2] = 1 / width;
    this.screenMap[3] = 1 / height;
  }

  /** px → uv mapping of the shared stage target (screen space). */
  get screenTexMap(): [number, number, number, number] {
    return this.screenMap;
  }

  /** Stage target quality: resolution scale (0.5…1) and MSAA samples. */
  setStageQuality(scale: number, samples: number): void {
    const k = Math.max(0.5, Math.min(1, scale));
    if (k === this.stageScale && samples === this.rt.samples) return;
    this.stageScale = k;
    if (samples !== this.rt.samples) {
      this.rt.dispose(); // re-created with the new sample count on next use
      this.rt.samples = samples;
    }
    this.scratch?.dispose();
    this.scratch = null;
    this.setSize(this.res.x, this.res.y);
  }

  /**
   * Render a SETTLED stage once and keep the result in its cache target:
   * small tiles go through the small scratch target (cheap MSAA resolve),
   * bigger panels through the shared target's corner. The cache then
   * stands in for the stage until its next refresh.
   */
  renderStageCached(scene: THREE.Scene, camera: THREE.Camera, rect: { w: number; h: number }, cache: StageCache): void {
    const r = this.renderer;
    const k = this.stageScale;
    const w = Math.max(1, Math.min(this.rt.width, Math.ceil(rect.w * k)));
    const h = Math.max(1, Math.min(this.rt.height, Math.ceil(rect.h * k)));
    const small = w * h <= 0.3 * this.rt.width * this.rt.height;
    let src = this.rt;
    if (small) {
      if (!this.scratch || this.scratch.width < w || this.scratch.height < h) {
        const sw = Math.min(this.rt.width, Math.ceil(Math.max(w, this.scratch?.width ?? 0) / 32) * 32);
        const sh = Math.min(this.rt.height, Math.ceil(Math.max(h, this.scratch?.height ?? 0) / 32) * 32);
        this.scratch?.dispose();
        this.scratch = createStageTarget(sw, sh, this.rt.samples);
      }
      src = this.scratch;
    }
    src.viewport.set(0, 0, w, h);
    src.scissor.set(0, 0, w, h);
    src.scissorTest = true;
    r.setRenderTarget(src);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    this.blitRect = { x: 0, y: 0, w, h };
    try {
      r.render(scene, camera);
    } finally {
      this.blitRect = null;
    }
    // copy into the cache (re-allocated only when it no longer fits / is far too big)
    if (!cache.rt || cache.rt.width < w || cache.rt.height < h || cache.rt.width * cache.rt.height > 2.2 * w * h) {
      cache.rt?.dispose();
      cache.rt = new THREE.WebGLRenderTarget(Math.ceil(w * 1.06), Math.ceil(h * 1.06), {
        type: THREE.UnsignedByteType,
        depthBuffer: false,
      });
    }
    cache.usedW = w;
    cache.usedH = h;
    this.copyMat.uniforms.uSrc.value = src.texture;
    this.copyMat.uniforms.uSrcTexel.value.set(1 / src.width, 1 / src.height);
    cache.rt.viewport.set(0, 0, w, h);
    cache.rt.scissor.set(0, 0, w, h);
    cache.rt.scissorTest = true;
    r.setRenderTarget(cache.rt);
    this.draw(this.copyQuad);
    r.setRenderTarget(null);
  }

  setTime(t: number): void {
    this.time = t;
    for (const m of [this.bgMat, this.bladeMat, this.slashMat, this.wipeEraseMat, this.wipeEdgeMat]) {
      if (m.uniforms.uTime) m.uniforms.uTime.value = t;
    }
  }

  private draw(mesh: THREE.Mesh): void {
    this.scene.children.length = 0;
    this.scene.add(mesh);
    this.renderer.render(this.scene, this.cam);
  }

  begin(): void {
    const r = this.renderer;
    r.setRenderTarget(null);
    r.setScissorTest(false);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, true);
  }

  background(opacity: number): void {
    this.bgMat.uniforms.uOpacity.value = opacity;
    this.draw(this.bg);
  }

  /**
   * Render a stage into the shared HDR target, restricted to the blade's
   * pixel rectangle (the camera already frames that rectangle).
   */
  renderStage(scene: THREE.Scene, camera: THREE.Camera, rect: { x: number; y: number; w: number; h: number }): void {
    const r = this.renderer;
    // Canvas pixels → target pixels (the target may be scaled down).
    const k = this.stageScale;
    const tw = this.rt.width;
    const th = this.rt.height;
    const x = Math.max(0, Math.floor(rect.x * k));
    const y = Math.max(0, Math.floor(rect.y * k));
    const w = Math.max(1, Math.min(tw - x, Math.ceil((rect.x + rect.w) * k) - x));
    const h = Math.max(1, Math.min(th - y, Math.ceil((rect.y + rect.h) * k) - y));
    this.rt.viewport.set(x, y, w, h);
    this.rt.scissor.set(x, y, w, h);
    this.rt.scissorTest = true;
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    this.blitRect = { x, y, w, h };
    try {
      r.render(scene, camera);
    } finally {
      this.blitRect = null;
    }
    r.setRenderTarget(null);
  }

  blade(b: BladeDraw, shadowPx: [number, number], outlinePx: number): void {
    writePoly(this.polyGeo, b.polyPx);
    if (b.mode !== 3) {
      // hard offset shadow (sticker)
      this.shadowMat.uniforms.uOffset.value.set(shadowPx[0], shadowPx[1]);
      this.shadowMat.uniforms.uOpacity.value = 0.85 * b.opacity;
      this.draw(this.shadowMesh);
    }
    // blade
    const u = this.bladeMat.uniforms;
    for (let i = 0; i < 6; i++) this.polyUniform[i].set(b.polyPx[i * 2], b.polyPx[i * 2 + 1]);
    u.uAccent.value.copy(b.accent);
    u.uMode.value = b.mode;
    u.uColorIn.value = b.colorIn;
    u.uFlash.value = b.flash;
    u.uBurst.value = b.burst;
    u.uFocus.value.set(b.focusPx[0], b.focusPx[1]);
    u.uOutline.value = outlinePx;
    u.uSeed.value = b.seed;
    u.uHasTex.value = b.hasTex ? 1 : 0;
    u.uTex.value = b.tex ?? this.rt.texture;
    const m = b.texMap ?? this.screenMap;
    u.uTexMap.value.set(m[0], m[1], m[2], m[3]);
    u.uOpacity.value = b.opacity;
    this.draw(this.bladeMesh);
  }

  slashStreak(p: number, accent: THREE.Color, a: [number, number], b: [number, number]): void {
    const u = this.slashMat.uniforms;
    u.uP.value = p;
    u.uAccent.value.copy(accent);
    u.uA.value.set(a[0], a[1]);
    u.uB.value.set(b[0], b[1]);
    this.draw(this.slash);
  }

  flashOverlay(amount: number, gold: number): void {
    if (amount <= 0.001 && gold <= 0.001) return;
    const u = this.flashMat.uniforms;
    const total = Math.min(1, amount + gold);
    u.uColor.value.setRGB(1, 0.97 - 0.12 * (gold / Math.max(total, 1e-3)), 0.88 - 0.6 * (gold / Math.max(total, 1e-3)));
    u.uOpacity.value = total;
    this.draw(this.flash);
  }

  exitWipe(p: number): void {
    if (p <= 0) return;
    this.wipe.material = this.wipeEraseMat;
    this.wipeEraseMat.uniforms.uP.value = p;
    this.draw(this.wipe);
    this.wipe.material = this.wipeEdgeMat;
    this.wipeEdgeMat.uniforms.uP.value = p;
    this.draw(this.wipe);
  }

  get currentTime(): number {
    return this.time;
  }

  dispose(): void {
    this.rt.dispose();
    this.scratch?.dispose();
    this.scratch = null;
    this.polyGeo.dispose();
    for (const m of [this.bgMat, this.bladeMat, this.shadowMat, this.slashMat, this.flashMat, this.wipeEraseMat, this.wipeEdgeMat, this.copyMat]) m.dispose();
    for (const q of [this.bg, this.slash, this.flash, this.wipe, this.copyQuad]) q.geometry.dispose();
  }
}

/** Normalized (y down) polygon → pixel polygon (y up), with zoom + shake. */
export function polyToPx(
  p: Poly,
  w: number,
  h: number,
  zoom: number,
  shake: [number, number],
): number[] {
  const out = new Array<number>(12);
  for (let i = 0; i < 6; i++) {
    const x = 0.5 + (p[i * 2] - 0.5) * zoom + shake[0];
    const y = 0.5 + (p[i * 2 + 1] - 0.5) * zoom + shake[1];
    out[i * 2] = x * w;
    out[i * 2 + 1] = (1 - y) * h;
  }
  return out;
}
