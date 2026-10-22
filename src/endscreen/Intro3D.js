// Partie Three.js de l'écran de fin : la dernière image du jeu se fissure puis éclate en
// éclats de verre 3D, le titre extrudé s'écrase, puis vient se ranger dans l'en-tête.
// Tout est animé en fonction du temps écoulé (t) : on peut sauter à la fin à tout moment.

import * as THREE from 'three';
import titleFont from './titleFont.js';
import { clamp, lerp, invLerp, smoothstep, ease, shakeNoise, rng } from './anim.js';

export const CAM_Z = 20;
const FOV = 40;
const TAN = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
const TITLE_Z = 2;
const GLASS_MARGIN = 1.05; // la vitre déborde un peu de l'écran (tremblements)

const C = (hex) => new THREE.Color(hex);

const THEME = {
  victory: {
    face: ['#FFF38A', '#FFB21F'],
    side: ['#F2742E', '#9A330F'],
    hi: '#FFFDF0',
    ink: '#15131F',
    sticker: '#F7F0E2',
    bg: ['#9BF2FF', '#22B5EA', '#0C3477', '#071A45'],
    edge: '#E3FAFF',
    crack: '#FFFFFF',
    confetti: ['#F27A30', '#FFD60A', '#F7F0E2', '#9DE20A', '#FF6FA8', '#FFFFFF', '#22E3F0'],
  },
  defeat: {
    face: ['#FF8E93', '#C92F42'],
    side: ['#701D2E', '#2E0912'],
    hi: '#FFE0E2',
    ink: '#0E0A12',
    sticker: '#BDB8C9',
    bg: ['#4A4466', '#26243A', '#111019', '#060509'],
    edge: '#C9D0DC',
    crack: '#F4F6FA',
    confetti: ['#8F8AA3', '#B9B4C8', '#6E6985'],
  },
};

// ---------------------------------------------------------------- shaders

const SHARD_VERT = /* glsl */ `
attribute vec3 aCenter;
attribute vec3 aVel;
attribute vec3 aAxis;
attribute float aSpin;
attribute float aDelay;
attribute float aFace;
attribute vec3 aPre;
uniform float uTime;
uniform float uCrack;
uniform float uGravity;
uniform float uCamZ;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vW;
varying float vFace;
varying float vFade;
vec3 rot(vec3 v, vec3 a, float ang) {
  float c = cos(ang), s = sin(ang);
  return v * c + cross(a, v) * s + a * dot(a, v) * (1.0 - c);
}
void main() {
  float t = max(uTime - aDelay, 0.0);
  float ang = aSpin * t;
  vec3 local = rot(position - aCenter, aAxis, ang);
  vec3 c = aCenter + aPre * uCrack + aVel * t + vec3(0.0, 0.5 * uGravity * t * t, 0.0);
  vec4 w = modelMatrix * vec4(c + local, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * rot(normal, aAxis, ang));
  vUv = uv;
  vFace = aFace;
  vFade = 1.0 - smoothstep(uCamZ - 7.0, uCamZ - 2.0, w.z);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const SHARD_FRAG = /* glsl */ `
uniform sampler2D uSnap;
uniform float uSat;
uniform float uBright;
uniform vec3 uEdge;
uniform vec3 uTint;
uniform float uOpacity;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vW;
varying float vFace;
varying float vFade;
uniform float uTime;
void main() {
  // avant l'éclatement, seules les faces avant existent (évite le z-fighting des tranches)
  if (vFace > 0.5 && uTime <= 0.0) discard;
  vec3 col = texture2D(uSnap, clamp(vUv, 0.001, 0.999)).rgb;
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat) * uBright;
  col = mix(col, col * uTint, 1.0 - uSat);
  vec3 n = normalize(vN);
  vec3 L = normalize(vec3(-0.45, 0.65, 0.62));
  vec3 V = normalize(cameraPosition - vW);
  if (vFace < 0.5) {
    col *= 1.0 + 0.55 * (dot(n, L) - L.z);
    vec3 H = normalize(L + V);
    float glint = pow(max(dot(n, H), 0.0), 48.0) * (1.0 - n.z) * 3.0;
    col += glint;
  } else if (vFace < 1.5) {
    col = col * 0.35 + uEdge * 0.12;
  } else {
    float d = 0.55 + 0.45 * max(dot(n, L), 0.0);
    col = mix(col, uEdge, 0.75) * d + pow(1.0 - abs(dot(n, V)), 2.0) * 0.4;
  }
  gl_FragColor = vec4(col, vFade * uOpacity);
  #include <colorspace_fragment>
}`;

// Image intacte derrière la vitre jusqu'à l'éclatement : masque les micro-jointures
const BACKING_FRAG = /* glsl */ `
uniform sampler2D uSnap;
uniform float uSat;
uniform float uBright;
uniform vec3 uTint;
uniform vec2 uUvScale;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  vec2 uv = clamp((vUv - 0.5) * uUvScale + 0.5, 0.001, 0.999);
  vec3 col = texture2D(uSnap, uv).rgb;
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat) * uBright;
  col = mix(col, col * uTint, 1.0 - uSat);
  gl_FragColor = vec4(col, uOpacity);
  #include <colorspace_fragment>
}`;

const CRACK_VERT = /* glsl */ `
attribute float aSide;
attribute float aDist;
attribute float aRand;
attribute float aStr;
varying float vSide;
varying float vDist;
varying float vRand;
varying float vStr;
void main() {
  vSide = aSide; vDist = aDist; vRand = aRand; vStr = aStr;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const CRACK_FRAG = /* glsl */ `
uniform float uGrow;
uniform float uAlpha;
uniform float uMaxR;
uniform vec3 uColor;
varying float vSide;
varying float vDist;
varying float vRand;
varying float vStr;
void main() {
  float reveal = 1.0 - smoothstep(uGrow - 0.35, uGrow, vDist + vRand * 0.5);
  float s = abs(vSide);
  float core = 1.0 - smoothstep(0.08 + 0.2 * vStr, 0.35 + 0.25 * vStr, s);
  float glow = (1.0 - s) * 0.22;
  float far = mix(1.0, 0.35, smoothstep(0.0, uMaxR * 0.8, vDist));
  float a = (core * 0.92 + glow) * reveal * uAlpha * vStr * far;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

const LETTER_VERT = /* glsl */ `
varying vec3 vObj;
varying vec3 vN;
varying vec3 vW;
void main() {
  vObj = position;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const LETTER_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uBot;
uniform vec3 uHi;
uniform vec2 uYRange;
uniform float uPart;
uniform float uFlash;
uniform float uOpacity;
varying vec3 vObj;
varying vec3 vN;
varying vec3 vW;
void main() {
  vec3 n = normalize(vN);
  float h = clamp((vObj.y - uYRange.x) / (uYRange.y - uYRange.x), 0.0, 1.0);
  vec3 base = mix(uBot, uTop, smoothstep(0.0, 1.0, h));
  if (uPart < 0.5) {
    float band = smoothstep(0.64, 0.69, h) * (1.0 - smoothstep(0.79, 0.84, h));
    base = mix(base, uHi, band * 0.6 * smoothstep(0.55, 0.95, n.z));
  }
  vec3 L = normalize(vec3(-0.35, 0.75, 0.6));
  float ndl = dot(n, L);
  float toon = ndl > 0.42 ? 1.0 : (ndl > -0.05 ? 0.83 : 0.68);
  vec3 col = base * toon;
  vec3 V = normalize(cameraPosition - vW);
  col += pow(1.0 - max(dot(n, V), 0.0), 3.0) * 0.18 * uHi;
  col = mix(col, vec3(1.0), uFlash);
  gl_FragColor = vec4(col, uOpacity);
  #include <colorspace_fragment>
}`;

const FLAT_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  gl_FragColor = vec4(uColor, uOpacity);
  #include <colorspace_fragment>
}`;

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const BG_FRAG = /* glsl */ `
uniform float uTime;
uniform float uOpacity;
uniform float uMode;
uniform float uAspect;
uniform vec2 uCenter;
uniform float uRays;
uniform float uLight;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 p = (vUv * 2.0 - 1.0) * vec2(uAspect, 1.0);
  vec2 q = p - uCenter * vec2(uAspect, 1.0);
  float r = length(q);
  float a = atan(q.y, q.x);
  vec3 col;
  if (uMode < 0.5) {
    col = mix(uC0, uC1, smoothstep(0.0, 0.55, r));
    col = mix(col, uC2, smoothstep(0.45, 1.5, r));
    col = mix(col, uC3, smoothstep(1.3, 2.6, r));
    float rays = smoothstep(-0.12, 0.12, sin(a * 11.0 + uTime * 0.22));
    float fall = 1.0 - smoothstep(0.1, 2.4, r);
    col = mix(col, col * 1.22 + vec3(0.02, 0.03, 0.05), rays * uRays * fall * 0.75);
    vec2 cell = gl_FragCoord.xy / 9.0;
    float dotm = 1.0 - smoothstep(0.24, 0.3, length(fract(cell) - 0.5));
    col += dotm * smoothstep(1.0, 2.2, r) * 0.035;
    col += uLight * (1.0 - smoothstep(0.0, 0.9, r)) * 0.35;
  } else {
    vec2 sp = p - vec2(uCenter.x * uAspect, 1.4);
    float cone = 1.0 - smoothstep(0.0, 1.0, abs(sp.x) / (0.25 + max(0.0, -sp.y) * 0.42));
    cone *= smoothstep(-2.6, -0.6, sp.y) * 0.6;
    col = mix(uC1, uC2, smoothstep(0.2, 1.4, r));
    col = mix(col, uC3, smoothstep(1.2, 2.5, r));
    col += uC0 * cone * 0.55 * uRays;
    col += (hash(gl_FragCoord.xy + floor(uTime * 24.0)) - 0.5) * 0.025;
  }
  gl_FragColor = vec4(max(col, 0.0), uOpacity);
  #include <colorspace_fragment>
}`;

const SHADOW_FRAG = /* glsl */ `
uniform float uOpacity;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float a = (1.0 - smoothstep(0.15, 1.0, length(p))) * uOpacity;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

const RING_FRAG = /* glsl */ `
uniform float uOpacity;
uniform vec3 uColor;
uniform float uWidth;
varying vec2 vUv;
void main() {
  float d = abs(length(vUv * 2.0 - 1.0) - 0.82);
  float a = (1.0 - smoothstep(0.0, uWidth, d)) * uOpacity;
  gl_FragColor = vec4(uColor * a, a);
  #include <colorspace_fragment>
}`;

const SPEED_FRAG = /* glsl */ `
uniform float uAmount;
uniform float uTime;
uniform float uAspect;
uniform vec2 uCenter;
varying vec2 vUv;
float hash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  vec2 p = (vUv * 2.0 - 1.0) * vec2(uAspect, 1.0) - uCenter * vec2(uAspect, 1.0);
  float r = length(p);
  float a = atan(p.y, p.x) / 6.28318 + 0.5;
  float bin = floor(a * 140.0);
  float rnd = hash(bin * 1.7 + floor(uTime * 30.0) * 13.1);
  float lineMask = step(0.62, rnd);
  float inner = 0.55 + hash(bin + 3.0) * 0.5;
  float m = lineMask * smoothstep(inner, inner + 0.5, r);
  float edge = abs(fract(a * 140.0) - 0.5);
  m *= 1.0 - smoothstep(0.08, 0.32, edge);
  float alpha = m * uAmount * 0.85;
  gl_FragColor = vec4(vec3(alpha), alpha);
}`;

const POINTS_VERT = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute float aPhase;
uniform float uScale;
uniform float uTime;
uniform float uTwinkle;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float tw = mix(1.0, 0.5 + 0.5 * sin(uTime * 7.0 + aPhase), uTwinkle);
  vA = aAlpha * tw;
  gl_PointSize = aSize * uScale * mix(1.0, 0.55 + 0.45 * tw, uTwinkle) / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const STAR_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vA;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float cross = exp(-abs(p.x) * 14.0) * exp(-abs(p.y) * 2.6) + exp(-abs(p.y) * 14.0) * exp(-abs(p.x) * 2.6);
  float core = exp(-dot(p, p) * 16.0);
  float a = clamp((cross * 0.9 + core) * vA, 0.0, 1.0);
  gl_FragColor = vec4(uColor * a, a);
  #include <colorspace_fragment>
}`;

const DUST_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vA;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float a = (1.0 - smoothstep(0.35, 1.0, length(p))) * vA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

const CONFETTI_VERT = /* glsl */ `
varying vec3 vColor;
varying float vShade;
void main() {
  mat4 im = mat4(1.0);
  #ifdef USE_INSTANCING
  im = instanceMatrix;
  #endif
  vec4 w = modelMatrix * im * vec4(position, 1.0);
  vec3 n = normalize(mat3(modelMatrix * im) * normal);
  vec3 V = normalize(cameraPosition - w.xyz);
  vShade = abs(dot(n, V));
  vColor = vec3(1.0);
  #ifdef USE_INSTANCING_COLOR
  vColor = instanceColor;
  #endif
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const CONFETTI_FRAG = /* glsl */ `
uniform float uOpacity;
varying vec3 vColor;
varying float vShade;
void main() {
  vec3 col = vColor * (0.42 + 0.7 * vShade) + pow(vShade, 12.0) * 0.25;
  gl_FragColor = vec4(col, uOpacity);
  #include <colorspace_fragment>
}`;

// ---------------------------------------------------------------- géométrie : titre

let glyphCache = null;
// `${glyph}|${segments}|main|marks` → [3 plates, extruded letter] (Intro3D.keepWarm)
const titleGeometry = new Map();

function glyphShapes(ch) {
  glyphCache ??= new Map();
  if (glyphCache.has(ch)) return glyphCache.get(ch);
  const g = titleFont.glyphs[ch] ?? titleFont.glyphs[ch.toUpperCase()] ?? titleFont.glyphs['?'];
  const s = 1 / titleFont.resolution;
  const path = new THREE.ShapePath();
  const o = g.o ? g.o.split(' ') : [];
  for (let i = 0; i < o.length;) {
    const cmd = o[i++];
    if (cmd === 'm') path.moveTo(o[i++] * s, o[i++] * s);
    else if (cmd === 'l') path.lineTo(o[i++] * s, o[i++] * s);
    else if (cmd === 'q') {
      const x = o[i++] * s; const y = o[i++] * s; const cx = o[i++] * s; const cy = o[i++] * s;
      path.quadraticCurveTo(cx, cy, x, y);
    } else if (cmd === 'b') {
      const x = o[i++] * s; const y = o[i++] * s;
      const c1x = o[i++] * s; const c1y = o[i++] * s; const c2x = o[i++] * s; const c2y = o[i++] * s;
      path.bezierCurveTo(c1x, c1y, c2x, c2y, x, y);
    }
  }
  const res = { shapes: path.toShapes(false), advance: g.ha * s };
  glyphCache.set(ch, res);
  return res;
}

function capHeight() {
  const { shapes } = glyphShapes('E');
  let ymax = 0;
  for (const sh of shapes) for (const p of sh.getPoints()) ymax = Math.max(ymax, p.y);
  return ymax || 0.7;
}

function shapeBox(shape) {
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
  for (const p of shape.getPoints()) {
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  return { x0, x1, y0, y1 };
}

// Plaque "autocollant" : union de capsules le long des contours du glyphe + remplissage.
// Toujours propre, même sur les formes concaves (trou du O, empattements), et les plaques
// de lettres voisines fusionnent comme un vrai sticker.
function buildPlate(shapes, d, divisions) {
  const P = [];
  const SEG = 12;
  const cs = []; const sn = [];
  for (let k = 0; k <= SEG; k++) { cs.push(Math.cos((k / SEG) * Math.PI * 2) * d); sn.push(Math.sin((k / SEG) * Math.PI * 2) * d); }
  const SMOOTH = Math.cos(THREE.MathUtils.degToRad(14));
  for (const shape of shapes) {
    const { shape: outer, holes } = shape.extractPoints(divisions);
    for (const raw of [outer, ...holes]) {
      const c = raw.slice();
      if (c.length > 2 && c[0].distanceTo(c[c.length - 1]) < 1e-6) c.pop();
      const n = c.length;
      if (n < 3) continue;
      const nx = new Float32Array(n); const ny = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const a = c[i]; const b = c[(i + 1) % n];
        const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        nx[i] = -(b.y - a.y) / L; ny[i] = (b.x - a.x) / L;
      }
      // décalage par sommet : onglet (miter) si le contour tourne peu, sinon disque arrondi
      const smooth = new Uint8Array(n); const ox = new Float32Array(n); const oy = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const p = (i + n - 1) % n;
        const cos = nx[p] * nx[i] + ny[p] * ny[i];
        if (cos > SMOOTH) {
          let ax = nx[p] + nx[i]; let ay = ny[p] + ny[i];
          const al = Math.hypot(ax, ay) || 1; ax /= al; ay /= al;
          const m = d / Math.max(0.6, ax * nx[i] + ay * ny[i]);
          smooth[i] = 1; ox[i] = ax * m; oy[i] = ay * m;
        }
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = c[i]; const b = c[j];
        const oax = smooth[i] ? ox[i] : nx[i] * d; const oay = smooth[i] ? oy[i] : ny[i] * d;
        const obx = smooth[j] ? ox[j] : nx[i] * d; const oby = smooth[j] ? oy[j] : ny[i] * d;
        P.push(a.x + oax, a.y + oay, 0, b.x + obx, b.y + oby, 0, b.x - obx, b.y - oby, 0);
        P.push(a.x + oax, a.y + oay, 0, b.x - obx, b.y - oby, 0, a.x - oax, a.y - oay, 0);
        if (!smooth[i]) for (let k = 0; k < SEG; k++) P.push(a.x, a.y, 0, a.x + cs[k], a.y + sn[k], 0, a.x + cs[k + 1], a.y + sn[k + 1], 0);
      }
    }
  }
  const fill = new THREE.ShapeGeometry(shapes, divisions).toNonIndexed();
  const fp = fill.attributes.position.array;
  for (let i = 0; i < fp.length; i++) P.push(fp[i]);
  fill.dispose();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  return geo;
}

// ---------------------------------------------------------------- géométrie : vitre

function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; }
  return a / 2;
}

function clipRect(poly, x0, x1, y0, y1) {
  const pass = (pts, inside, cut) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i]; const prev = pts[(i + pts.length - 1) % pts.length];
      const ci = inside(cur); const pi = inside(prev);
      if (ci) { if (!pi) out.push(cut(prev, cur)); out.push(cur); } else if (pi) out.push(cut(prev, cur));
    }
    return out;
  };
  const cx = (x) => (a, b) => [x, a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1])];
  const cy = (y) => (a, b) => [a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]), y];
  let p = poly;
  p = pass(p, (q) => q[0] >= x0, cx(x0)); if (p.length < 3) return [];
  p = pass(p, (q) => q[0] <= x1, cx(x1)); if (p.length < 3) return [];
  p = pass(p, (q) => q[1] >= y0, cy(y0)); if (p.length < 3) return [];
  p = pass(p, (q) => q[1] <= y1, cy(y1));
  return p.length < 3 ? [] : p;
}

function splitPoly(poly, c, d) {
  const nx = -d[1]; const ny = d[0];
  const side = (p) => (p[0] - c[0]) * nx + (p[1] - c[1]) * ny;
  const A = []; const B = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]; const q = poly[(i + 1) % poly.length];
    const sp = side(p); const sq = side(q);
    if (sp >= 0) A.push(p);
    if (sp <= 0) B.push(p);
    if ((sp > 0 && sq < 0) || (sp < 0 && sq > 0)) {
      const t = sp / (sp - sq);
      const x = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
      A.push(x); B.push(x);
    }
  }
  return [A, B];
}

function centroid(p) {
  let x = 0; let y = 0;
  for (const q of p) { x += q[0]; y += q[1]; }
  return [x / p.length, y / p.length];
}

function fracture({ hw, hh, impact, mode, R, density }) {
  const ex = hw * GLASS_MARGIN; const ey = hh * GLASS_MARGIN;
  const corners = [[-ex, -ey], [ex, -ey], [ex, ey], [-ex, ey]];
  const maxR = Math.max(...corners.map((c) => Math.hypot(c[0] - impact[0], c[1] - impact[1]))) * 1.08;
  const M = Math.round((mode === 'victory' ? 17 : 14) * density);
  const step = (Math.PI * 2) / M;
  const a0 = R() * Math.PI * 2;
  const angles = Array.from({ length: M }, (_, i) => a0 + (i + (R() - 0.5) * 0.55) * step);
  const radii = [];
  let r = hh * 0.06;
  while (r < maxR) { radii.push(r); r *= (1.36 + R() * 0.14) / Math.min(1.12, Math.max(0.9, density)); }
  radii.push(maxR);
  const pts = angles.map((a) => radii.map((rk, k) => {
    const j = k === radii.length - 1 ? 1 : 1 + (R() - 0.5) * 0.3;
    return [impact[0] + Math.cos(a) * rk * j, impact[1] + Math.sin(a) * rk * j];
  }));
  const cells = [];
  for (let i = 0; i < M; i++) {
    const i2 = (i + 1) % M;
    cells.push([impact, pts[i][0], pts[i2][0]]);
    for (let k = 0; k < radii.length - 1; k++) cells.push([pts[i][k], pts[i2][k], pts[i2][k + 1], pts[i][k + 1]]);
  }
  const maxArea = (hh * 0.3) * (hh * 0.3) / Math.max(0.6, density);
  const out = [];
  const queue = [];
  for (const cell of cells) {
    let p = clipRect(cell, -ex, ex, -ey, ey);
    if (p.length < 3) continue;
    if (polyArea(p) < 0) p = p.reverse();
    queue.push(p);
  }
  while (queue.length) {
    const p = queue.pop();
    const area = polyArea(p);
    if (area < 1e-4) continue;
    if (area > maxArea && out.length + queue.length < 600) {
      const c = centroid(p);
      const radial = Math.atan2(c[1] - impact[1], c[0] - impact[0]);
      const ang = radial + Math.PI / 2 + (R() - 0.5) * 1.6;
      const [A, B] = splitPoly(p, c, [Math.cos(ang), Math.sin(ang)]);
      if (A.length >= 3) queue.push(A);
      if (B.length >= 3) queue.push(B);
    } else {
      out.push(p);
    }
  }
  return { polys: out, maxR, ex, ey };
}

function buildGlass({ hw, hh, impact, mode, R, density, thickness }) {
  const { polys, maxR, ex, ey } = fracture({ hw, hh, impact, mode, R, density });
  const P = []; const N = []; const UV = []; const F = []; const CEN = []; const VEL = [];
  const AX = []; const SP = []; const DL = []; const PRE = []; const idx = [];
  let vb = 0;
  const z0 = thickness / 2; const z1 = -thickness / 2;
  const U = (x) => (x + hw) / (2 * hw);
  const V = (y) => (y + hh) / (2 * hh);
  const axis = new THREE.Vector3();
  for (const poly of polys) {
    const c = centroid(poly);
    const dx = c[0] - impact[0]; const dy = c[1] - impact[1];
    const d = Math.hypot(dx, dy);
    const dir = d > 1e-4 ? [dx / d, dy / d] : [R() - 0.5, R() - 0.5];
    const near = 1 - smoothstep(0, maxR * 0.75, d);
    let vel; let spin; let delay;
    if (mode === 'victory') {
      const sp = (3 + 10 * near) * (0.6 + 0.8 * R());
      vel = [dir[0] * sp, dir[1] * sp + 1.2 * R(), (7 + 24 * near) * (0.5 + 0.75 * R())];
      spin = (2.5 + 9 * R()) * (R() < 0.5 ? -1 : 1);
      delay = (d / maxR) * 0.07;
    } else {
      vel = [dir[0] * (0.3 + 1.3 * R()), dir[1] * (0.2 + 0.7 * R()) + 0.8 * R(), 0.5 + 2.8 * R()];
      spin = (0.6 + 3.4 * R()) * (R() < 0.5 ? -1 : 1);
      delay = (d / maxR) * 0.4 + R() * 0.12;
    }
    axis.set(R() - 0.5, R() - 0.5, (R() - 0.5) * 0.4).normalize();
    const pre = [dir[0] * (0.006 + 0.035 * near * R()), dir[1] * (0.006 + 0.035 * near * R()), -0.08 * near * R()];
    const push = (x, y, z, nx, ny, nz, face) => {
      P.push(x, y, z); N.push(nx, ny, nz); UV.push(U(x), V(y)); F.push(face);
      CEN.push(c[0], c[1], 0); VEL.push(vel[0], vel[1], vel[2]); AX.push(axis.x, axis.y, axis.z);
      SP.push(spin); DL.push(delay); PRE.push(pre[0], pre[1], pre[2]);
      return vb++;
    };
    const n = poly.length;
    const f0 = vb;
    for (const p of poly) push(p[0], p[1], z0, 0, 0, 1, 0);
    for (let i = 1; i < n - 1; i++) idx.push(f0, f0 + i, f0 + i + 1);
    const b0 = vb;
    for (const p of poly) push(p[0], p[1], z1, 0, 0, -1, 1);
    for (let i = 1; i < n - 1; i++) idx.push(b0, b0 + i + 1, b0 + i);
    for (let i = 0; i < n; i++) {
      const p = poly[i]; const q = poly[(i + 1) % n];
      const lx = q[0] - p[0]; const ly = q[1] - p[1]; const len = Math.hypot(lx, ly) || 1;
      const nx = ly / len; const ny = -lx / len;
      const s0 = push(p[0], p[1], z0, nx, ny, 0, 2);
      push(q[0], q[1], z0, nx, ny, 0, 2);
      push(q[0], q[1], z1, nx, ny, 0, 2);
      push(p[0], p[1], z1, nx, ny, 0, 2);
      idx.push(s0, s0 + 3, s0 + 2, s0, s0 + 2, s0 + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  geo.setAttribute('aFace', new THREE.Float32BufferAttribute(F, 1));
  geo.setAttribute('aCenter', new THREE.Float32BufferAttribute(CEN, 3));
  geo.setAttribute('aVel', new THREE.Float32BufferAttribute(VEL, 3));
  geo.setAttribute('aAxis', new THREE.Float32BufferAttribute(AX, 3));
  geo.setAttribute('aSpin', new THREE.Float32BufferAttribute(SP, 1));
  geo.setAttribute('aDelay', new THREE.Float32BufferAttribute(DL, 1));
  geo.setAttribute('aPre', new THREE.Float32BufferAttribute(PRE, 3));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return { geo, polys, maxR, ex, ey, count: polys.length };
}

// PERF (Intro3D.fastGlass) — buildGlass written into typed arrays of the exact size (counted
// first) instead of growing JS arrays then converting them: the same values, bit for bit (the
// same expressions, the same R() draws in the same order, the same float32 rounding, the same
// index type), 3× less CPU — built in the frame where the match ends.
// Equivalence test: scripts/test-endscreen-glass.mts.
function buildGlassFast({ hw, hh, impact, mode, R, density, thickness }) {
  const { polys, maxR, ex, ey } = fracture({ hw, hh, impact, mode, R, density });
  let nv = 0; let ni = 0;
  for (const poly of polys) { nv += 6 * poly.length; ni += 12 * poly.length - 12; }
  const P = new Float32Array(nv * 3); const N = new Float32Array(nv * 3); const UV = new Float32Array(nv * 2);
  const F = new Float32Array(nv); const CEN = new Float32Array(nv * 3); const VEL = new Float32Array(nv * 3);
  const AX = new Float32Array(nv * 3); const SP = new Float32Array(nv); const DL = new Float32Array(nv);
  const PRE = new Float32Array(nv * 3);
  // (three's setIndex(array) picks 32 bits as soon as an index reaches 65535)
  const idx = nv - 1 >= 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vb = 0; let ib = 0;
  const z0 = thickness / 2; const z1 = -thickness / 2;
  const axis = new THREE.Vector3();
  let cx = 0; let cy = 0; let vel = null; let spin = 0; let delay = 0; let pre = null;
  const put = (x, y, z, nx, ny, nz, face) => {
    const v = vb++;
    let j = v * 3;
    P[j] = x; P[j + 1] = y; P[j + 2] = z;
    N[j] = nx; N[j + 1] = ny; N[j + 2] = nz;
    CEN[j] = cx; CEN[j + 1] = cy; CEN[j + 2] = 0;
    VEL[j] = vel[0]; VEL[j + 1] = vel[1]; VEL[j + 2] = vel[2];
    AX[j] = axis.x; AX[j + 1] = axis.y; AX[j + 2] = axis.z;
    PRE[j] = pre[0]; PRE[j + 1] = pre[1]; PRE[j + 2] = pre[2];
    j = v * 2;
    UV[j] = (x + hw) / (2 * hw); UV[j + 1] = (y + hh) / (2 * hh);
    F[v] = face; SP[v] = spin; DL[v] = delay;
    return v;
  };
  for (const poly of polys) {
    const c = centroid(poly);
    const dx = c[0] - impact[0]; const dy = c[1] - impact[1];
    const d = Math.hypot(dx, dy);
    const dir = d > 1e-4 ? [dx / d, dy / d] : [R() - 0.5, R() - 0.5];
    const near = 1 - smoothstep(0, maxR * 0.75, d);
    if (mode === 'victory') {
      const sp = (3 + 10 * near) * (0.6 + 0.8 * R());
      vel = [dir[0] * sp, dir[1] * sp + 1.2 * R(), (7 + 24 * near) * (0.5 + 0.75 * R())];
      spin = (2.5 + 9 * R()) * (R() < 0.5 ? -1 : 1);
      delay = (d / maxR) * 0.07;
    } else {
      vel = [dir[0] * (0.3 + 1.3 * R()), dir[1] * (0.2 + 0.7 * R()) + 0.8 * R(), 0.5 + 2.8 * R()];
      spin = (0.6 + 3.4 * R()) * (R() < 0.5 ? -1 : 1);
      delay = (d / maxR) * 0.4 + R() * 0.12;
    }
    axis.set(R() - 0.5, R() - 0.5, (R() - 0.5) * 0.4).normalize();
    pre = [dir[0] * (0.006 + 0.035 * near * R()), dir[1] * (0.006 + 0.035 * near * R()), -0.08 * near * R()];
    cx = c[0]; cy = c[1];
    const n = poly.length;
    const f0 = vb;
    for (const p of poly) put(p[0], p[1], z0, 0, 0, 1, 0);
    for (let i = 1; i < n - 1; i++) { idx[ib++] = f0; idx[ib++] = f0 + i; idx[ib++] = f0 + i + 1; }
    const b0 = vb;
    for (const p of poly) put(p[0], p[1], z1, 0, 0, -1, 1);
    for (let i = 1; i < n - 1; i++) { idx[ib++] = b0; idx[ib++] = b0 + i + 1; idx[ib++] = b0 + i; }
    for (let i = 0; i < n; i++) {
      const p = poly[i]; const q = poly[(i + 1) % n];
      const lx = q[0] - p[0]; const ly = q[1] - p[1]; const len = Math.hypot(lx, ly) || 1;
      const nx = ly / len; const ny = -lx / len;
      const s0 = put(p[0], p[1], z0, nx, ny, 0, 2);
      put(q[0], q[1], z0, nx, ny, 0, 2);
      put(q[0], q[1], z1, nx, ny, 0, 2);
      put(p[0], p[1], z1, nx, ny, 0, 2);
      idx[ib++] = s0; idx[ib++] = s0 + 3; idx[ib++] = s0 + 2; idx[ib++] = s0; idx[ib++] = s0 + 2; idx[ib++] = s0 + 1;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
  geo.setAttribute('aFace', new THREE.BufferAttribute(F, 1));
  geo.setAttribute('aCenter', new THREE.BufferAttribute(CEN, 3));
  geo.setAttribute('aVel', new THREE.BufferAttribute(VEL, 3));
  geo.setAttribute('aAxis', new THREE.BufferAttribute(AX, 3));
  geo.setAttribute('aSpin', new THREE.BufferAttribute(SP, 1));
  geo.setAttribute('aDelay', new THREE.BufferAttribute(DL, 1));
  geo.setAttribute('aPre', new THREE.BufferAttribute(PRE, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return { geo, polys, maxR, ex, ey, count: polys.length };
}

// (equivalence test of the two glass builders: scripts/test-endscreen-glass.mts)
export { buildGlass as buildGlassReference, buildGlassFast };

function buildCracks({ polys, impact, ex, ey, halfWidth, R }) {
  const seen = new Set();
  const P = []; const SIDE = []; const DIST = []; const RAND = []; const STR = []; const idx = [];
  const eps = 1e-3;
  const onBorder = (a, b) =>
    (Math.abs(a[0] + ex) < eps && Math.abs(b[0] + ex) < eps) || (Math.abs(a[0] - ex) < eps && Math.abs(b[0] - ex) < eps) ||
    (Math.abs(a[1] + ey) < eps && Math.abs(b[1] + ey) < eps) || (Math.abs(a[1] - ey) < eps && Math.abs(b[1] - ey) < eps);
  const k = (p) => `${Math.round(p[0] * 500)},${Math.round(p[1] * 500)}`;
  let vb = 0;
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]; const b = poly[(i + 1) % poly.length];
      if (onBorder(a, b)) continue;
      const ka = k(a); const kb = k(b);
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const lx = b[0] - a[0]; const ly = b[1] - a[1]; const len = Math.hypot(lx, ly);
      if (len < 1e-4) continue;
      const ux = lx / len; const uy = ly / len;
      // fissures radiales franches, anneaux partiels, sous-découpes discrètes
      const mx = (a[0] + b[0]) / 2 - impact[0]; const my = (a[1] + b[1]) / 2 - impact[1];
      const ml = Math.hypot(mx, my) || 1;
      const radial = Math.abs((ux * mx + uy * my) / ml);
      let str;
      if (radial > 0.86) str = 1;
      else if (radial < 0.4) { if (R() > 0.72) continue; str = 0.7; } else { if (R() > 0.45) continue; str = 0.5; }
      const nx = -uy * halfWidth; const ny = ux * halfWidth;
      const ax = a[0] - ux * halfWidth * 0.6; const ay = a[1] - uy * halfWidth * 0.6;
      const bx = b[0] + ux * halfWidth * 0.6; const by = b[1] + uy * halfWidth * 0.6;
      const da = Math.hypot(a[0] - impact[0], a[1] - impact[1]);
      const db = Math.hypot(b[0] - impact[0], b[1] - impact[1]);
      const rr = R();
      P.push(ax - nx, ay - ny, 0, ax + nx, ay + ny, 0, bx + nx, by + ny, 0, bx - nx, by - ny, 0);
      SIDE.push(-1, 1, 1, -1);
      DIST.push(da, da, db, db);
      RAND.push(rr, rr, rr, rr);
      STR.push(str, str, str, str);
      idx.push(vb, vb + 1, vb + 2, vb, vb + 2, vb + 3);
      vb += 4;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('aSide', new THREE.Float32BufferAttribute(SIDE, 1));
  geo.setAttribute('aDist', new THREE.Float32BufferAttribute(DIST, 1));
  geo.setAttribute('aRand', new THREE.Float32BufferAttribute(RAND, 1));
  geo.setAttribute('aStr', new THREE.Float32BufferAttribute(STR, 1));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return geo;
}

// PERF (Intro3D.fastGlass) — buildCracks with numeric edge keys (two integer point codes in a
// map of sets, instead of three strings per edge) and typed arrays: the same edges kept, in
// the same order, with the same R() draws — the same geometry, bit for bit.
function buildCracksFast({ polys, impact, ex, ey, halfWidth, R }) {
  let maxEdges = 0;
  for (const poly of polys) maxEdges += poly.length;
  const P = new Float32Array(maxEdges * 12); const SIDE = new Float32Array(maxEdges * 4);
  const DIST = new Float32Array(maxEdges * 4); const RAND = new Float32Array(maxEdges * 4); const STR = new Float32Array(maxEdges * 4);
  const seen = new Map(); // point code → codes of the points it is already joined to
  const eps = 1e-3;
  const onBorder = (a, b) =>
    (Math.abs(a[0] + ex) < eps && Math.abs(b[0] + ex) < eps) || (Math.abs(a[0] - ex) < eps && Math.abs(b[0] - ex) < eps) ||
    (Math.abs(a[1] + ey) < eps && Math.abs(b[1] + ey) < eps) || (Math.abs(a[1] - ey) < eps && Math.abs(b[1] - ey) < eps);
  // same rounding as buildCracks' `${x},${y}` key, packed in one exact integer (< 2^42)
  const code = (p) => (Math.round(p[0] * 500) + 1048576) * 2097152 + (Math.round(p[1] * 500) + 1048576);
  let vb = 0;
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]; const b = poly[(i + 1) % poly.length];
      if (onBorder(a, b)) continue;
      const ca = code(a); const cb = code(b);
      const lo = ca < cb ? ca : cb; const hi = ca < cb ? cb : ca;
      let joined = seen.get(lo);
      if (!joined) { joined = new Set(); seen.set(lo, joined); }
      if (joined.has(hi)) continue;
      joined.add(hi);
      const lx = b[0] - a[0]; const ly = b[1] - a[1]; const len = Math.hypot(lx, ly);
      if (len < 1e-4) continue;
      const ux = lx / len; const uy = ly / len;
      const mx = (a[0] + b[0]) / 2 - impact[0]; const my = (a[1] + b[1]) / 2 - impact[1];
      const ml = Math.hypot(mx, my) || 1;
      const radial = Math.abs((ux * mx + uy * my) / ml);
      let str;
      if (radial > 0.86) str = 1;
      else if (radial < 0.4) { if (R() > 0.72) continue; str = 0.7; } else { if (R() > 0.45) continue; str = 0.5; }
      const nx = -uy * halfWidth; const ny = ux * halfWidth;
      const ax = a[0] - ux * halfWidth * 0.6; const ay = a[1] - uy * halfWidth * 0.6;
      const bx = b[0] + ux * halfWidth * 0.6; const by = b[1] + uy * halfWidth * 0.6;
      const da = Math.hypot(a[0] - impact[0], a[1] - impact[1]);
      const db = Math.hypot(b[0] - impact[0], b[1] - impact[1]);
      const rr = R();
      const o = vb * 3;
      P[o] = ax - nx; P[o + 1] = ay - ny; P[o + 2] = 0; P[o + 3] = ax + nx; P[o + 4] = ay + ny; P[o + 5] = 0;
      P[o + 6] = bx + nx; P[o + 7] = by + ny; P[o + 8] = 0; P[o + 9] = bx - nx; P[o + 10] = by - ny; P[o + 11] = 0;
      SIDE[vb] = -1; SIDE[vb + 1] = 1; SIDE[vb + 2] = 1; SIDE[vb + 3] = -1;
      DIST[vb] = da; DIST[vb + 1] = da; DIST[vb + 2] = db; DIST[vb + 3] = db;
      RAND[vb] = rr; RAND[vb + 1] = rr; RAND[vb + 2] = rr; RAND[vb + 3] = rr;
      STR[vb] = str; STR[vb + 1] = str; STR[vb + 2] = str; STR[vb + 3] = str;
      vb += 4;
    }
  }
  const idx = vb - 1 >= 65535 ? new Uint32Array((vb / 4) * 6) : new Uint16Array((vb / 4) * 6);
  for (let v = 0, i = 0; v < vb; v += 4) {
    idx[i++] = v; idx[i++] = v + 1; idx[i++] = v + 2; idx[i++] = v; idx[i++] = v + 2; idx[i++] = v + 3;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P.slice(0, vb * 3), 3));
  geo.setAttribute('aSide', new THREE.BufferAttribute(SIDE.slice(0, vb), 1));
  geo.setAttribute('aDist', new THREE.BufferAttribute(DIST.slice(0, vb), 1));
  geo.setAttribute('aRand', new THREE.BufferAttribute(RAND.slice(0, vb), 1));
  geo.setAttribute('aStr', new THREE.BufferAttribute(STR.slice(0, vb), 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return geo;
}

// (equivalence test of the two crack builders: scripts/test-endscreen-glass.mts)
export { buildCracks as buildCracksReference, buildCracksFast };

// ---------------------------------------------------------------- particules CPU (points)

class PointPool {
  constructor(count, frag, { additive = false, color = '#ffffff', twinkle = 0 } = {}) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.size = new Float32Array(count);
    this.alpha = new Float32Array(count);
    this.phase = new Float32Array(count);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.grow = new Float32Array(count);
    this.baseSize = new Float32Array(count);
    this.baseAlpha = new Float32Array(count);
    this.drag = new Float32Array(count);
    this.cursor = 0;
    for (let i = 0; i < count; i++) this.phase[i] = Math.random() * 6.283;
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aSize', this.aSize);
    geo.setAttribute('aAlpha', this.aAlpha);
    geo.setAttribute('aPhase', new THREE.BufferAttribute(this.phase, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: POINTS_VERT,
      fragmentShader: frag,
      uniforms: {
        uScale: { value: 1 }, uTime: { value: 0 }, uTwinkle: { value: twinkle }, uColor: { value: C(color) },
      },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
  }

  // Same state as a freshly constructed pool — including its Math.random() draws (the
  // phases), in the same order: a reused pool behaves exactly like a new one.
  renew() {
    this.cursor = 0;
    for (const a of [this.pos, this.vel, this.size, this.alpha, this.life, this.maxLife, this.grow, this.baseSize, this.baseAlpha, this.drag]) a.fill(0);
    for (let i = 0; i < this.count; i++) this.phase[i] = Math.random() * 6.283;
    this.points.geometry.attributes.aPhase.needsUpdate = true;
    this.aPos.needsUpdate = true; this.aSize.needsUpdate = true; this.aAlpha.needsUpdate = true;
  }

  // Draws nothing at all: every point has alpha 0 (STAR_FRAG adds 0, DUST_FRAG discards).
  get blank() {
    for (let i = 0; i < this.count; i++) if (this.alpha[i] !== 0) return false;
    return true;
  }

  spawn(x, y, z, vx, vy, vz, { size = 20, alpha = 1, life = 1, grow = 0, drag = 0 } = {}) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.baseSize[i] = size; this.baseAlpha[i] = alpha;
    this.life[i] = 0; this.maxLife[i] = life; this.grow[i] = grow; this.drag[i] = drag;
    this.size[i] = size; this.alpha[i] = alpha;
  }

  update(dt, gravity = 0) {
    for (let i = 0; i < this.count; i++) {
      if (this.maxLife[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] += dt;
      const k = this.life[i] / this.maxLife[i];
      if (k >= 1) { this.maxLife[i] = 0; this.alpha[i] = 0; continue; }
      const dr = Math.exp(-this.drag[i] * dt);
      const j = i * 3;
      this.vel[j] *= dr; this.vel[j + 1] = this.vel[j + 1] * dr + gravity * dt; this.vel[j + 2] *= dr;
      this.pos[j] += this.vel[j] * dt; this.pos[j + 1] += this.vel[j + 1] * dt; this.pos[j + 2] += this.vel[j + 2] * dt;
      this.size[i] = this.baseSize[i] * (1 + this.grow[i] * k);
      this.alpha[i] = this.baseAlpha[i] * (1 - k) * Math.min(1, this.life[i] * 12);
    }
    this.aPos.needsUpdate = true; this.aSize.needsUpdate = true; this.aAlpha.needsUpdate = true;
  }

  clear() { this.maxLife.fill(0); this.alpha.fill(0); this.aAlpha.needsUpdate = true; }

  dispose() { this.points.geometry.dispose(); this.mat.dispose(); }
}

// ---------------------------------------------------------------- confettis (instanciés)

class Confetti {
  constructor(count, colors) {
    this.count = count;
    const geo = new THREE.PlaneGeometry(1, 1);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: CONFETTI_VERT,
      fragmentShader: CONFETTI_FRAG,
      uniforms: { uOpacity: { value: 1 } },
      side: THREE.DoubleSide,
      transparent: true,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, count);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.p = new Float32Array(count * 3);
    this.v = new Float32Array(count * 3);
    this.r = new Float32Array(count * 3);
    this.w = new Float32Array(count * 3);
    this.s = new Float32Array(count * 2);
    this.ph = new Float32Array(count);
    this.alive = new Uint8Array(count);
    this.ambient = 0;
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.e = new THREE.Euler();
    this.sc = new THREE.Vector3();
    this.pv = new THREE.Vector3();
    this.zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this.setColors(colors);
    for (let i = 0; i < count; i++) this.mesh.setMatrixAt(i, this.zero);
  }

  setColors(colors) {
    const col = new THREE.Color();
    for (let i = 0; i < this.count; i++) {
      col.set(colors[i % colors.length]);
      this.mesh.setColorAt(i, col);
    }
    this.mesh.instanceColor.needsUpdate = true;
  }

  _init(i, x, y, z, vx, vy, vz) {
    const j = i * 3;
    this.p[j] = x; this.p[j + 1] = y; this.p[j + 2] = z;
    this.v[j] = vx; this.v[j + 1] = vy; this.v[j + 2] = vz;
    this.r[j] = Math.random() * 6.28; this.r[j + 1] = Math.random() * 6.28; this.r[j + 2] = Math.random() * 6.28;
    this.w[j] = (Math.random() - 0.5) * 14; this.w[j + 1] = (Math.random() - 0.5) * 14; this.w[j + 2] = (Math.random() - 0.5) * 6;
    const big = Math.random() < 0.25;
    this.s[i * 2] = (big ? 0.16 : 0.1) + Math.random() * 0.06;
    this.s[i * 2 + 1] = (big ? 0.28 : 0.17) + Math.random() * 0.08;
    this.ph[i] = Math.random() * 6.28;
    this.alive[i] = 1;
  }

  // Draws nothing at all: no live piece (the others are zero-scale matrices, no fragment).
  get blank() {
    for (let i = 0; i < this.count; i++) if (this.alive[i]) return false;
    return true;
  }

  burst(n, origin, dir, spread, speed) {
    let made = 0;
    for (let i = 0; i < this.count && made < n; i++) {
      if (this.alive[i]) continue;
      const a = Math.atan2(dir[1], dir[0]) + (Math.random() - 0.5) * spread;
      const sp = speed * (0.45 + Math.random() * 0.75);
      this._init(i, origin[0] + (Math.random() - 0.5) * 0.4, origin[1] + (Math.random() - 0.5) * 0.4, origin[2] + (Math.random() - 0.5) * 2,
        Math.cos(a) * sp, Math.sin(a) * sp, (Math.random() - 0.3) * sp * 0.35);
      made++;
    }
  }

  update(dt, t, bounds) {
    const g = -5.5;
    const drag = Math.exp(-1.9 * dt);
    for (let i = 0; i < this.count; i++) {
      const j = i * 3;
      if (!this.alive[i]) {
        if (this.ambient > 0 && Math.random() < this.ambient * dt * 0.6) {
          const z = -4 + Math.random() * 8;
          const hb = bounds.halfH(z);
          this._init(i, (Math.random() * 2 - 1) * bounds.halfW(z) * 1.05, hb + 0.6, z, (Math.random() - 0.5) * 0.6, -0.4 - Math.random() * 0.6, 0);
        } else {
          continue;
        }
      }
      this.v[j] *= drag; this.v[j + 1] = this.v[j + 1] * drag + g * dt * 0.5; this.v[j + 2] *= drag;
      if (this.v[j + 1] < -2.6) this.v[j + 1] = -2.6;
      const sway = Math.sin(t * 3.1 + this.ph[i]) * 0.9;
      this.p[j] += (this.v[j] + sway) * dt; this.p[j + 1] += this.v[j + 1] * dt; this.p[j + 2] += this.v[j + 2] * dt;
      this.r[j] += this.w[j] * dt; this.r[j + 1] += this.w[j + 1] * dt; this.r[j + 2] += this.w[j + 2] * dt;
      if (this.p[j + 1] < -bounds.halfH(this.p[j + 2]) - 1) {
        this.alive[i] = 0;
        this.mesh.setMatrixAt(i, this.zero);
        continue;
      }
      this.e.set(this.r[j], this.r[j + 1], this.r[j + 2]);
      this.q.setFromEuler(this.e);
      this.sc.set(this.s[i * 2], this.s[i * 2 + 1], 1);
      this.pv.set(this.p[j], this.p[j + 1], this.p[j + 2]);
      this.m.compose(this.pv, this.q, this.sc);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.alive.fill(0);
    for (let i = 0; i < this.count; i++) this.mesh.setMatrixAt(i, this.zero);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() { this.mesh.geometry.dispose(); this.mat.dispose(); this.mesh.dispose?.(); }
}

// ---------------------------------------------------------------- scène principale

export class Intro3D {
  constructor(canvas, { pixelRatio = Math.min(window.devicePixelRatio || 1, 2), quality = 'high', reducedMotion = false, onCue = () => {} } = {}) {
    this.canvas = canvas;
    this.quality = quality;
    this.reducedMotion = reducedMotion;
    this.onCue = onCue;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance', premultipliedAlpha: true });
    this.renderer.setPixelRatio(quality === 'low' ? Math.min(1, pixelRatio) : pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 500);
    this.camera.position.set(0, 0, CAM_Z);

    this.w = 1; this.h = 1; this.aspect = 1;
    this.t = 0;
    this.running = false;
    this.trauma = 0;
    this.shakeSeed = Math.random() * 100;
    this.cues = [];
    this.dock = null;
    this.mode = 'victory';
    this.slotFn = null;
    // PERF (see EndScreen `warmIntro` / `skipEmptyDraws`): keepWarm = programs and title
    // geometry kept from one build to the next (warm-up → end screen → replay); skipEmpty =
    // draws that cannot change a pixel left out of the render.
    this.keepWarm = false;
    this.skipEmpty = false;
    this.fastGlass = false; // (EndScreen `fastSnapshot`) buildGlassFast / buildCracksFast: same geometry, less CPU
    this._hidden = new Array(16).fill(null);
    this._nHidden = 0;
    this._pinnedCount = 0;
    this._anchors = {}; // (keepWarm, see _retire)
    this._buildStatic();
  }

  // A pooled instance (prewarmIntro3D) taken by a new end screen: exactly the state of a
  // freshly constructed one — including its Math.random() draws, in the same order (shake
  // seed, then the particle phases of _buildStatic) — on the already warm context.
  adopt({ pixelRatio = Math.min(window.devicePixelRatio || 1, 2), reducedMotion = false, onCue = () => {} } = {}) {
    this.clear();
    this.reducedMotion = reducedMotion;
    this.onCue = onCue;
    this.renderer.setPixelRatio(this.quality === 'low' ? Math.min(1, pixelRatio) : pixelRatio);
    this.camera.position.set(0, 0, CAM_Z);
    this.camera.rotation.set(0, 0, 0);
    this.w = 1; this.h = 1; this.aspect = 1;
    this.t = 0;
    this.running = false;
    this.trauma = 0;
    this.shakeSeed = Math.random() * 100;
    this.cues = [];
    this.dock = null;
    this.mode = 'victory';
    this.slotFn = null;
    for (const pool of [this.sparkles, this.dust, this.puffs]) pool.renew();
    return this;
  }

  _buildStatic() {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.quadGeo = quad;

    this.bgMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: BG_FRAG,
      uniforms: {
        uOpacity: { value: 1 },
        uTime: { value: 0 }, uMode: { value: 0 }, uAspect: { value: 1 }, uCenter: { value: new THREE.Vector2() },
        uRays: { value: 0 }, uLight: { value: 0 },
        uC0: { value: new THREE.Color() }, uC1: { value: new THREE.Color() }, uC2: { value: new THREE.Color() }, uC3: { value: new THREE.Color() },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.bg = new THREE.Mesh(quad, this.bgMat);
    this.bg.position.z = -40;
    this.bg.renderOrder = -100;
    this.scene.add(this.bg);

    this.speedMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: SPEED_FRAG,
      uniforms: { uAmount: { value: 0 }, uTime: { value: 0 }, uAspect: { value: 1 }, uCenter: { value: new THREE.Vector2() } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.speed = new THREE.Mesh(quad, this.speedMat);
    this.speed.position.z = 12;
    this.speed.renderOrder = 50;
    this.scene.add(this.speed);

    const ringMat = (color) => new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: RING_FRAG,
      uniforms: { uOpacity: { value: 0 }, uColor: { value: C(color) }, uWidth: { value: 0.08 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.rings = [ringMat('#ffffff'), ringMat('#7ff3ff')].map((m) => {
      const mesh = new THREE.Mesh(quad, m);
      mesh.renderOrder = 4;
      mesh.visible = false;
      this.scene.add(mesh);
      return mesh;
    });

    this.sparkles = new PointPool(64, STAR_FRAG, { additive: true, color: '#fff6c8', twinkle: 1 });
    this.sparkles.points.renderOrder = 6;
    this.scene.add(this.sparkles.points);

    this.dust = new PointPool(this.quality === 'low' ? 90 : 220, DUST_FRAG, { color: '#9EA6C4' });
    this.dust.points.renderOrder = 7;
    this.scene.add(this.dust.points);

    this.puffs = new PointPool(160, DUST_FRAG, { color: '#D9D2E6' });
    this.puffs.points.renderOrder = 8;
    this.scene.add(this.puffs.points);

    this.confetti = new Confetti(this.quality === 'low' ? 140 : 320, THEME.victory.confetti);
    this.confetti.mesh.renderOrder = 9;
    this.scene.add(this.confetti.mesh);

    this.flashMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: SHADOW_FRAG,
      uniforms: { uOpacity: { value: 0 }, uColor: { value: C('#ffffff') } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.impactFlash = new THREE.Mesh(quad, this.flashMat);
    this.impactFlash.renderOrder = 30;
    this.scene.add(this.impactFlash);

    this.titleMats = null;
    this.word = null;
    this.glass = null;
    this.cracks = null;
  }

  // ------------------------------------------------------------ dimensions

  halfH(z) { return (this.camera.position.z - z) * TAN; }
  halfW(z) { return this.halfH(z) * this.aspect; }

  resize(w, h) {
    this.w = Math.max(1, w); this.h = Math.max(1, h);
    this.aspect = this.w / this.h;
    this.renderer.setSize(this.w, this.h, false);
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
    const fit = (mesh, z, k = 1.25) => {
      const hh = (CAM_Z - z) * TAN * k;
      mesh.scale.set(hh * 2 * this.aspect, hh * 2, 1);
    };
    fit(this.bg, this.bg.position.z, 1.3);
    fit(this.speed, this.speed.position.z, 1.1);
    this.bgMat.uniforms.uAspect.value = this.aspect * (1.3 / 1.3);
    this.speedMat.uniforms.uAspect.value = this.aspect;
    const ps = this.h * this.renderer.getPixelRatio() / (2 * TAN);
    for (const pool of [this.sparkles, this.dust, this.puffs]) pool.mat.uniforms.uScale.value = ps / 100;
    if (this.word && !this.dock) this._placeIntroTitle();
  }

  // ------------------------------------------------------------ cycle de vie

  start(mode, snapshot, { titleText, impact } = {}) {
    this.clear();
    this.mode = mode;
    this.th = THEME[mode];
    this.t = 0;
    this.trauma = 0;
    this.dock = null;
    this.running = true;
    const th = this.th;
    const rm = this.reducedMotion;

    const u = this.bgMat.uniforms;
    u.uOpacity.value = 1;
    u.uMode.value = mode === 'victory' ? 0 : 1;
    u.uC0.value.set(th.bg[0]); u.uC1.value.set(th.bg[1]); u.uC2.value.set(th.bg[2]); u.uC3.value.set(th.bg[3]);
    u.uRays.value = 0; u.uLight.value = 0;
    this.confetti.setColors(th.confetti);

    this._buildTitle(titleText ?? (mode === 'victory' ? 'VICTOIRE' : 'DÉFAITE'));

    const hh = CAM_Z * TAN; const hw = hh * this.aspect;
    this.hasGlass = !!snapshot;
    if (snapshot) {
      const ip = impact ?? (mode === 'victory' ? [0, hh * 0.08] : [hw * 0.16, hh * 0.2]);
      this.impact = ip;
      this._buildGlass(snapshot, hw, hh, ip);
    }

    // chronologie (secondes)
    const V = mode === 'victory';
    const tl = this.tl = V
      ? { crack: 0.18, crackDur: 0.16, brk: 0.42, arrive0: 0.64, stagger: 0.045, fly: 0.36, ui: 2.05 }
      : { crack: 0.45, crack2: 0.95, brk: 1.3, land0: 2.0, stagger: 0.11, fall: 0.3, ui: 3.25 };
    if (!snapshot) {
      if (V) Object.assign(tl, { crack: -1, brk: -1, arrive0: 0.32, ui: 1.7 });
      else Object.assign(tl, { crack: -1, crack2: -1, brk: -1, land0: 0.55, ui: 1.8 });
    }
    if (rm) Object.assign(tl, { ui: 1.1 });
    const n = this.letters.length;
    if (V) {
      tl.slam = tl.arrive0 + (n - 1) * tl.stagger + 0.08;
    } else {
      tl.lastLand = tl.land0 + (n - 1) * tl.stagger;
      tl.gag = tl.lastLand + 0.3;
      tl.sting = tl.lastLand + 0.12;
    }

    const cue = (time, fn) => this.cues.push({ time, fn, done: false });
    this.cues = [];
    if (rm) {
      cue(0.1, () => this.onCue(V ? 'fanfare' : 'defeat'));
    } else if (V) {
      cue(0, () => this.onCue('whoosh', { dur: 0.35 }));
      if (snapshot) {
        cue(tl.crack, () => { this.onCue('crack'); this.trauma = Math.min(1, this.trauma + 0.25); this.flash = 0.9; });
        cue(tl.brk, () => { this.onCue('shatter'); this.onCue('flash', 0.35); this.trauma = Math.min(1, this.trauma + 0.35); });
      }
      for (let i = 0; i < n; i++) {
        cue(tl.arrive0 + i * tl.stagger, () => { this.onCue('pop', { pitch: 1 + i * 0.07 }); this.trauma = Math.min(1, this.trauma + 0.12); });
      }
      cue(tl.slam, () => this._slam());
    } else {
      if (snapshot) {
        cue(tl.crack, () => { this.onCue('crack', { strength: 0.75 }); this.trauma = Math.min(1, this.trauma + 0.3); this.flash = 0.5; });
        cue(tl.crack2, () => { this.onCue('crack', { strength: 1 }); this.trauma = Math.min(1, this.trauma + 0.38); this.flash = 0.7; });
        cue(tl.brk, () => { this.onCue('shatter', { dark: true }); this.trauma = Math.min(1, this.trauma + 0.25); });
      }
      for (let i = 0; i < n; i++) {
        cue(tl.land0 + i * tl.stagger, () => this._land(i));
      }
      cue(tl.sting, () => this.onCue('defeat'));
      if (this.accent) cue(tl.gag, () => this.onCue('tink'));
    }
    this.flash = 0;
    if (!V) this._seedDust();
    return { uiAt: tl.ui };
  }

  setSlotProvider(fn) { this.slotFn = fn; }

  // Le titre rejoint l'emplacement réservé dans l'en-tête (durée en s)
  dockTitle(duration = 0.75) {
    if (!this.word) return;
    this.dock = { from: { x: this.word.position.x, y: this.word.position.y, s: this.word.scale.x }, t0: this.t, dur: duration };
  }

  skip() {
    if (!this.running) return;
    const tl = this.tl;
    for (const c of this.cues) c.done = true;
    const end = tl.ui + 0.05;
    if (this.t < end) this.t = end;
    if (this.glass) { this.glass.visible = false; this.backing.visible = false; }
    if (this.cracks) this.cracks.visible = false;
    this.trauma = 0;
    this.flash = 0;
    this.speedMat.uniforms.uAmount.value = 0;
    if (this.mode === 'victory') this.confetti.ambient = this.reducedMotion ? 0 : 6;
    if (!this.dock) this.dockTitle(0.35);
  }

  // ------------------------------------------------------------ construction

  _buildTitle(text) {
    const th = this.th;
    const cap = capHeight();
    const S = 1 / cap; // hauteur de capitale = 1 unité
    const depth = 0.34;
    const bevelT = 0.07; const bevelS = 0.04;
    if (!this.titleMats) {
      const mk = (part) => new THREE.ShaderMaterial({
        vertexShader: LETTER_VERT,
        fragmentShader: LETTER_FRAG,
        uniforms: {
          uTop: { value: new THREE.Color() }, uBot: { value: new THREE.Color() }, uHi: { value: new THREE.Color() },
          uYRange: { value: new THREE.Vector2(-0.05, 1.05) }, uPart: { value: part }, uFlash: { value: 0 }, uOpacity: { value: 1 },
        },
        transparent: true,
      });
      const flat = () => new THREE.ShaderMaterial({
        vertexShader: QUAD_VERT,
        fragmentShader: FLAT_FRAG,
        uniforms: { uColor: { value: new THREE.Color() }, uOpacity: { value: 1 } },
        side: THREE.DoubleSide,
        transparent: true,
      });
      this.titleMats = { face: mk(0), side: mk(1), plateIn: flat(), plateMid: flat(), plateOut: flat() };
    }
    const m = this.titleMats;
    m.face.uniforms.uTop.value.set(th.face[0]); m.face.uniforms.uBot.value.set(th.face[1]); m.face.uniforms.uHi.value.set(th.hi);
    m.side.uniforms.uTop.value.set(th.side[0]); m.side.uniforms.uBot.value.set(th.side[1]); m.side.uniforms.uHi.value.set(th.hi);
    m.plateIn.uniforms.uColor.value.set(th.ink);
    m.plateMid.uniforms.uColor.value.set(th.sticker);
    m.plateOut.uniforms.uColor.value.set(th.ink);
    for (const k of Object.keys(m)) { m[k].uniforms.uOpacity.value = 1; }
    m.face.uniforms.uFlash.value = 0; m.side.uniforms.uFlash.value = 0;

    this.word = new THREE.Group();
    this.word.position.z = TITLE_Z;
    this.scene.add(this.word);
    this.letters = [];
    this.accent = null;

    const segs = this.quality === 'low' ? 5 : 8;
    const zBack = -depth / 2 - bevelT;
    const extrude = (shapes) => {
      const geo = new THREE.ExtrudeGeometry(shapes, {
        depth, bevelEnabled: true, bevelThickness: bevelT, bevelSize: bevelS, bevelSegments: 3, curveSegments: segs,
      });
      geo.scale(S, S, 1);
      geo.translate(0, 0, -depth / 2);
      return geo;
    };
    // épaisseurs finales (unités monde, hauteur de capitale = 1)
    const rings = [
      { mat: m.plateIn, d: bevelS * S + 0.055, z: zBack - 0.01, order: 3 },
      { mat: m.plateMid, d: bevelS * S + 0.16, z: zBack - 0.03, order: 2 },
      { mat: m.plateOut, d: bevelS * S + 0.205, z: zBack - 0.05, order: 1 },
    ];
    const meshesFor = (shapes, key) => {
      const g = new THREE.Group();
      // PERF (keepWarm): the geometry of a glyph only depends on the glyph and the
      // quality — built once (warm-up), shared by every later title, never disposed.
      const cached = this.keepWarm ? titleGeometry.get(key) : undefined;
      const geos = [];
      rings.forEach((r, i) => {
        let pg = cached?.[i];
        if (!pg) {
          pg = buildPlate(shapes, r.d / S, segs);
          pg.scale(S, S, 1);
          pg.translate(0, 0, r.z);
        }
        geos.push(pg);
        const pm = new THREE.Mesh(pg, r.mat);
        pm.renderOrder = r.order;
        g.add(pm);
      });
      const geo = cached?.[3] ?? extrude(shapes);
      geos.push(geo);
      const fill = new THREE.Mesh(geo, [m.face, m.side]);
      fill.renderOrder = 4;
      g.add(fill);
      if (this.keepWarm) titleGeometry.set(key, geos);
      g.userData.geos = this.keepWarm ? [] : geos;
      return g;
    };

    let x = 0;
    const tracking = 0.07;
    const chars = Array.from(text.toUpperCase());
    for (const ch of chars) {
      const { shapes, advance } = glyphShapes(ch);
      const adv = advance * S;
      if (ch === ' ' || !shapes.length) { x += adv + tracking; continue; }
      const main = []; const marks = [];
      for (const sh of shapes) {
        const b = shapeBox(sh);
        (b.y0 > cap * 0.98 ? marks : main).push(sh);
      }
      // pivot = centre de la base de la lettre (les écrasements partent du sol)
      const pivot = new THREE.Group();
      const cx = x + adv / 2;
      pivot.position.set(cx, 0, 0);
      const body = meshesFor(main, `${ch}|${segs}|main`);
      body.position.x = -adv / 2; // la géométrie est en coordonnées locales du glyphe
      pivot.add(body);
      let accentGroup = null;
      if (marks.length) {
        // accent séparé : il peut tomber tout seul (gag de la défaite)
        accentGroup = new THREE.Group();
        const mk = meshesFor(marks, `${ch}|${segs}|marks`);
        const mb = shapeBox(marks[0]);
        const ax = ((mb.x0 + mb.x1) / 2) * S;
        const ay = mb.y0 * S;
        mk.position.set(-ax, -ay, 0);
        accentGroup.position.set(ax - adv / 2, ay, 0);
        accentGroup.add(mk);
        pivot.add(accentGroup);
      }
      const L = { pivot, accent: accentGroup, x: cx, w: adv, rand: Math.random(), tilt: (Math.random() - 0.5) * 0.09 };
      if (accentGroup && !this.accent) this.accent = L;
      this.letters.push(L);
      this.word.add(pivot);
      x += adv + tracking;
    }
    const total = x - tracking;
    for (const L of this.letters) { L.pivot.position.x -= total / 2; L.x -= total / 2; }
    // taille visuelle (contour autocollant compris) pour le cadrage
    this.wordW = total + 0.5;
    this.wordH = 1.5;

    // ombre douce derrière le titre (lisibilité sur les rayons)
    this.shadowMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: SHADOW_FRAG,
      uniforms: { uOpacity: { value: 0 }, uColor: { value: C('#04060f') } },
      transparent: true,
      depthWrite: false,
    });
    this.shadow = new THREE.Mesh(this.quadGeo, this.shadowMat);
    this.shadow.scale.set(total * 1.35, 2.9, 1);
    this.shadow.position.set(0, 0.45, -1.2);
    this.shadow.renderOrder = -5;
    this.word.add(this.shadow);
    this._placeIntroTitle();
  }

  _placeIntroTitle() {
    const d = CAM_Z - TITLE_Z;
    const vh = d * TAN * 2; const vw = vh * this.aspect;
    const s = Math.min((vw * 0.74) / this.wordW, (vh * 0.24) / this.wordH);
    this.introPlace = { x: 0, y: -0.42 * s, s };
    if (!this.dock) {
      this.word.position.x = this.introPlace.x;
      this.word.position.y = this.introPlace.y;
      this.word.scale.setScalar(s);
    }
  }

  _slotPlace() {
    const r = this.slotFn?.();
    if (!r || r.width < 4) return null;
    const d = CAM_Z - TITLE_Z;
    const vh = d * TAN * 2; const vw = vh * this.aspect;
    const cx = ((r.left + r.width / 2) / this.w) * 2 - 1;
    const cy = 1 - ((r.top + r.height / 2) / this.h) * 2;
    const s = Math.min(((r.width / this.w) * vw * 0.98) / this.wordW, ((r.height / this.h) * vh * 0.86) / this.wordH);
    return { x: (cx * vw) / 2, y: (cy * vh) / 2 - 0.5 * s, s };
  }

  _buildGlass(snapshot, hw, hh, impact) {
    const tex = new THREE.CanvasTexture(snapshot);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    this.snapTex = tex;
    const R = rng((Math.random() * 1e9) | 0);
    const density = this.quality === 'low' ? 0.75 : 1;
    const glass = (this.fastGlass ? buildGlassFast : buildGlass)({ hw, hh, impact, mode: this.mode, R, density, thickness: 0.07 });
    this.glassInfo = glass;
    this.glassMat = new THREE.ShaderMaterial({
      vertexShader: SHARD_VERT,
      fragmentShader: SHARD_FRAG,
      uniforms: {
        uSnap: { value: tex }, uTime: { value: 0 }, uCrack: { value: 0 },
        uGravity: { value: this.mode === 'victory' ? -9 : -26 }, uCamZ: { value: CAM_Z },
        uSat: { value: 1 }, uBright: { value: 1 }, uEdge: { value: C(this.th.edge) }, uTint: { value: C('#b8c4ff') }, uOpacity: { value: 1 },
      },
      transparent: true,
    });
    this.glass = new THREE.Mesh(glass.geo, this.glassMat);
    this.glass.renderOrder = 2;
    this.glass.frustumCulled = false;
    this.scene.add(this.glass);

    const gu = this.glassMat.uniforms;
    this.backingMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: BACKING_FRAG,
      uniforms: { uSnap: gu.uSnap, uSat: gu.uSat, uBright: gu.uBright, uTint: gu.uTint, uOpacity: gu.uOpacity, uUvScale: { value: new THREE.Vector2(glass.ex / hw, glass.ey / hh) } },
      transparent: true,
    });
    this.backing = new THREE.Mesh(this.quadGeo, this.backingMat);
    this.backing.scale.set(glass.ex * 2, glass.ey * 2, 1);
    this.backing.position.z = -0.06;
    this.backing.renderOrder = 1;
    this.scene.add(this.backing);

    const pxWorld = (2 * hh) / this.h;
    const crackGeo = (this.fastGlass ? buildCracksFast : buildCracks)({ polys: glass.polys, impact, ex: glass.ex, ey: glass.ey, halfWidth: pxWorld * 2.2, R });
    this.crackMat = new THREE.ShaderMaterial({
      vertexShader: CRACK_VERT,
      fragmentShader: CRACK_FRAG,
      uniforms: { uGrow: { value: 0 }, uAlpha: { value: 1 }, uMaxR: { value: glass.maxR }, uColor: { value: C(this.th.crack) } },
      side: THREE.DoubleSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.cracks = new THREE.Mesh(crackGeo, this.crackMat);
    this.cracks.position.z = 0.04;
    this.cracks.renderOrder = 20;
    this.cracks.frustumCulled = false;
    this.scene.add(this.cracks);

    this.impactFlash.position.set(impact[0], impact[1], 0.06);
    this.impactFlash.scale.setScalar(hh * 0.9);
  }

  _seedDust() {
    const n = this.dust.count;
    for (let i = 0; i < n; i++) {
      const z = -8 + Math.random() * 14;
      this.dust.spawn(
        (Math.random() * 2 - 1) * this.halfW(z), (Math.random() * 2 - 1) * this.halfH(z), z,
        (Math.random() - 0.5) * 0.25, -0.12 - Math.random() * 0.25, 0,
        { size: 3 + Math.random() * 6, alpha: 0.15 + Math.random() * 0.4, life: 9999, drag: 0 },
      );
    }
  }

  // ------------------------------------------------------------ impacts

  _slam() {
    this.onCue('slam');
    this.onCue('fanfare');
    this.onCue('flash', 0.55);
    this.trauma = Math.min(1, this.trauma + 0.6);
    this.slamT = this.t;
    const wp = this.word.position;
    const s = this.word.scale.x;
    for (const r of this.rings) {
      r.position.set(wp.x, wp.y + 0.55 * s, TITLE_Z - 0.4);
      r.visible = true;
    }
    if (!this.reducedMotion) {
      const hb = this.halfH(0); const wb = this.halfW(0);
      this.confetti.burst(110, [-wb * 0.95, -hb * 0.95, 0], [0.55, 1], 0.55, 17);
      this.confetti.burst(110, [wb * 0.95, -hb * 0.95, 0], [-0.55, 1], 0.55, 17);
      this.confetti.burst(70, [wp.x, wp.y + 0.6 * s, 1], [0, 1], Math.PI * 2, 9);
      for (let i = 0; i < 36; i++) {
        const a = Math.random() * Math.PI * 2; const rr = 0.4 + Math.random() * 0.9;
        this.sparkles.spawn(wp.x + Math.cos(a) * this.wordW * s * 0.55 * rr, wp.y + 0.55 * s + Math.sin(a) * 1.4 * s * rr, TITLE_Z + 0.8,
          0, 0, 0, { size: 26 + Math.random() * 40, alpha: 1, life: 1.2 + Math.random() * 2.5 });
      }
    }
    this.confetti.ambient = this.reducedMotion ? 0 : 6;
  }

  _land(i) {
    const L = this.letters[i];
    this.onCue('thud', { pitch: 1 - i * 0.03 });
    this.trauma = Math.min(1, this.trauma + (i === this.letters.length - 1 ? 0.42 : 0.2));
    if (this.reducedMotion) return;
    const s = this.word.scale.x;
    const bx = this.word.position.x + L.x * s;
    const by = this.word.position.y;
    for (let k = 0; k < 16; k++) {
      const dir = k % 2 ? 1 : -1;
      this.puffs.spawn(bx + dir * L.w * s * 0.3 * Math.random(), by + 0.05, TITLE_Z + 0.4 + Math.random() * 0.4,
        dir * (1.5 + Math.random() * 3.2) * s, 0.3 + Math.random() * 1.2, (Math.random() - 0.2) * 0.8,
        { size: 18 + Math.random() * 30, alpha: 0.55, life: 0.6 + Math.random() * 0.5, grow: 1.8, drag: 4 });
    }
  }

  // ------------------------------------------------------------ boucle

  update(rawDt, render = true) {
    if (!this.running) return;
    // la chronologie suit le temps réel (même à bas FPS) ; la physique reste à pas bornés
    this.t += Math.min(rawDt, 0.25);
    const dt = Math.min(rawDt, 1 / 30);
    const t = this.t;
    const tl = this.tl;
    const V = this.mode === 'victory';
    const rm = this.reducedMotion;

    for (const c of this.cues) if (!c.done && t >= c.time) { c.done = true; c.fn(); }

    // caméra : petit "punch" puis tremblement
    let camZ = CAM_Z;
    if (!rm && this.hasGlass) {
      if (V) camZ = CAM_Z - 0.7 * ease.outCubic(invLerp(0, 0.35, t)) * (1 - invLerp(tl.brk, tl.brk + 0.6, t));
      else camZ = CAM_Z - 0.55 * ease.outCubic(invLerp(0, 1.2, t)) * (1 - invLerp(tl.brk, tl.brk + 1, t));
    }
    this.trauma = Math.max(0, this.trauma - dt * 1.5);
    const sh = rm ? 0 : this.trauma * this.trauma;
    this.camera.position.set(
      shakeNoise(t, this.shakeSeed) * 0.35 * sh,
      shakeNoise(t, this.shakeSeed + 5) * 0.3 * sh,
      camZ,
    );
    this.camera.rotation.z = shakeNoise(t, this.shakeSeed + 9) * 0.03 * sh;

    // fond
    const bu = this.bgMat.uniforms;
    bu.uTime.value = t;
    // The cinematic backdrop gives way to the game as the title docks in the modal.
    // Only this background plane fades; the title and all particles stay intact.
    bu.uOpacity.value = this.dock
      ? 1 - ease.inOutCubic(clamp((t - this.dock.t0) / this.dock.dur))
      : 1;
    const wp = this.word ? this.word.position : null;
    if (wp) {
      const d = this.camera.position.z - TITLE_Z;
      const cx = (wp.x / (d * TAN * this.aspect)) * (1 / 1.3);
      const cy = ((wp.y + 0.55 * this.word.scale.x) / (d * TAN)) * (1 / 1.3);
      bu.uCenter.value.set(cx, cy);
      this.speedMat.uniforms.uCenter.value.set(cx * 1.3 / 1.1, cy * 1.3 / 1.1);
    }
    if (V) {
      bu.uRays.value = smoothstep(tl.brk - 0.1, tl.slam + 0.4, t);
      bu.uLight.value = Math.max(0, 1 - Math.abs(t - (tl.slam ?? 0)) * 2.2) * (rm ? 0 : 1);
    } else {
      bu.uRays.value = smoothstep(tl.lastLand - 0.6, tl.lastLand + 0.8, t);
    }

    this._updateGlass(t, dt);
    this._updateTitle(t, dt);

    // effets
    this.flash = Math.max(0, (this.flash ?? 0) - dt * 4.5);
    this.flashMat.uniforms.uOpacity.value = this.hasGlass && t < (tl.brk + 0.2) ? this.flash : 0;
    const sp = V && !rm && tl.slam ? Math.max(0, 1 - Math.abs(t - tl.slam - 0.05) * 4.2) : 0;
    this.speedMat.uniforms.uAmount.value = sp;
    this.speedMat.uniforms.uTime.value = t;
    if (this.slamT != null) {
      const k = t - this.slamT;
      this.rings.forEach((r, i) => {
        const kk = k - i * 0.08;
        const vis = kk > 0 && kk < 0.9;
        r.visible = vis;
        if (vis) {
          const s = this.word.scale.x;
          const e = ease.outCubic(kk / 0.9);
          const size = lerp(1.2, this.wordW * 1.7, e) * s;
          r.scale.set(size, size, 1);
          r.material.uniforms.uOpacity.value = (1 - e) * (i === 0 ? 1 : 0.8);
          r.material.uniforms.uWidth.value = lerp(0.12, 0.03, e);
        }
      });
    }
    this.sparkles.mat.uniforms.uTime.value = t;
    this.sparkles.update(dt);
    this.puffs.update(dt, 0.6);
    if (!V) this._updateDust(dt);
    else this.dust.points.visible = false;
    this.dust.points.visible = !V;
    this.confetti.update(dt, t, this);
    this.confetti.mesh.visible = V;

    if (render) this._render();
  }

  // PERF (skipEmpty): the objects whose draw cannot change a single pixel of this frame stay
  // out of the render — full-screen quads at opacity / amount 0 (the backdrop once the title
  // is docked, the speed lines outside the slam, the impact flash), particle pools without a
  // visible point, the title shadow before the dock, fully faded or not yet grown cracks.
  // Each would only blend zero or discard every fragment, and none of them writes depth:
  // same image, without their fragment work (two full-screen passes per frame once docked).
  _render() {
    if (this.skipEmpty) {
      this._hideIfBlank(this.bg, this.bgMat.uniforms.uOpacity.value === 0);
      this._hideIfBlank(this.speed, this.speedMat.uniforms.uAmount.value === 0);
      this._hideIfBlank(this.impactFlash, this.flashMat.uniforms.uOpacity.value === 0);
      if (this.sparkles.points.visible) this._hideIfBlank(this.sparkles.points, this.sparkles.blank);
      if (this.puffs.points.visible) this._hideIfBlank(this.puffs.points, this.puffs.blank);
      if (this.dust.points.visible) this._hideIfBlank(this.dust.points, this.dust.blank);
      if (this.confetti.mesh.visible) this._hideIfBlank(this.confetti.mesh, this.confetti.blank);
      if (this.shadow) this._hideIfBlank(this.shadow, this.shadowMat.uniforms.uOpacity.value === 0);
      if (this.cracks) {
        const cu = this.crackMat.uniforms;
        this._hideIfBlank(this.cracks, cu.uAlpha.value === 0 || cu.uGrow.value === 0);
      }
    }
    this.renderer.render(this.scene, this.camera);
    const hidden = this._hidden;
    for (let i = 0; i < this._nHidden; i++) {
      hidden[i].visible = true;
      hidden[i] = null;
    }
    this._nHidden = 0;
    if (this.keepWarm) {
      // a program compiled here (no warm-up ran) is kept for the next end screen too
      const n = this.renderer.info.programs?.length ?? 0;
      if (n !== this._pinnedCount) { pinPrograms(this.renderer); this._pinnedCount = n; }
    }
  }

  _hideIfBlank(obj, blank) {
    if (!blank || !obj.visible) return;
    obj.visible = false;
    this._hidden[this._nHidden++] = obj;
  }

  _updateDust(dt) {
    const d = this.dust;
    for (let i = 0; i < d.count; i++) {
      const j = i * 3;
      d.pos[j] += (d.vel[j] + Math.sin(this.t * 0.7 + d.phase[i]) * 0.12) * dt;
      d.pos[j + 1] += d.vel[j + 1] * dt;
      const z = d.pos[j + 2];
      if (d.pos[j + 1] < -this.halfH(z) - 0.3) d.pos[j + 1] = this.halfH(z) + 0.3;
      const fade = smoothstep(this.tl.brk ?? 0, (this.tl.brk ?? 0) + 1, this.t);
      d.alpha[i] = d.baseAlpha[i] * fade;
    }
    d.aPos.needsUpdate = true;
    d.aAlpha.needsUpdate = true;
  }

  _updateGlass(t, dt) {
    if (!this.glass || !this.glass.visible) return;
    const tl = this.tl;
    const V = this.mode === 'victory';
    const gu = this.glassMat.uniforms;
    const maxR = this.glassInfo.maxR;
    if (this.reducedMotion) {
      gu.uOpacity.value = 1 - smoothstep(0.1, 0.6, t);
      gu.uSat.value = V ? 1 : 1 - smoothstep(0, 0.5, t) * 0.85;
      this.cracks.visible = false;
      if (t > 0.7) { this.glass.visible = false; this.backing.visible = false; }
      return;
    }
    if (V) {
      gu.uSat.value = 1;
      gu.uBright.value = 1 + smoothstep(0, 0.06, t) * (1 - smoothstep(0.06, 0.3, t)) * 0.25;
      this.crackMat.uniforms.uGrow.value = ease.outCubic(invLerp(tl.crack, tl.crack + tl.crackDur, t)) * maxR * 0.8;
      gu.uCrack.value = smoothstep(tl.crack, tl.crack + 0.12, t);
    } else {
      gu.uSat.value = 1 - 0.88 * ease.outCubic(invLerp(0, 0.9, t));
      gu.uBright.value = 1 - 0.28 * invLerp(0, 1.2, t);
      const g1 = ease.outExpo(invLerp(tl.crack, tl.crack + 0.09, t)) * 0.34;
      const g2 = ease.outCubic(invLerp(tl.crack2, tl.crack2 + 0.22, t)) * 0.66;
      this.crackMat.uniforms.uGrow.value = (g1 + g2) * maxR;
      gu.uCrack.value = smoothstep(tl.crack, tl.crack + 0.1, t) * 0.5 + smoothstep(tl.crack2, tl.crack2 + 0.15, t) * 0.5;
    }
    this.crackMat.uniforms.uAlpha.value = 1 - smoothstep(tl.brk, tl.brk + 0.08, t);
    gu.uTime.value = t - tl.brk;
    // l'image de secours masque les jointures jusqu'à l'impact ; ensuite la lumière filtre par les fissures
    this.backing.visible = t < tl.crack;
    if (t > tl.brk + (V ? 1.6 : 2.6)) {
      this.glass.visible = false;
      this.cracks.visible = false;
    }
  }

  _updateTitle(t, dt) {
    if (!this.word) return;
    const tl = this.tl;
    const V = this.mode === 'victory';
    const rm = this.reducedMotion;
    const n = this.letters.length;
    const m = this.titleMats;

    // placement global : intro -> en-tête
    if (this.dock) {
      const target = this._slotPlace() ?? this.introPlace;
      const k = ease.inOutCubic(clamp((t - this.dock.t0) / this.dock.dur));
      this.word.position.x = lerp(this.dock.from.x, target.x, k);
      this.word.position.y = lerp(this.dock.from.y, target.y, k);
      this.word.scale.setScalar(lerp(this.dock.from.s, target.s, k));
      this.shadowMat.uniforms.uOpacity.value = lerp(0.0, 0.45, k);
    } else {
      this.shadowMat.uniforms.uOpacity.value = 0;
    }

    if (rm) {
      const k = ease.outCubic(invLerp(0.05, 0.6, t));
      for (const k2 of Object.keys(m)) m[k2].uniforms.uOpacity.value = k;
      for (const L of this.letters) {
        L.pivot.position.set(L.x, 0, 0);
        L.pivot.rotation.set(0, 0, 0);
        L.pivot.scale.setScalar(0.92 + 0.08 * k);
      }
      return;
    }

    let flash = 0;
    if (V) {
      const slamK = tl.slam != null ? t - tl.slam : -1;
      const pulse = slamK > 0 ? 1 + 0.13 * Math.exp(-7 * slamK) * Math.cos(13 * slamK) : 1;
      this.letters.forEach((L, i) => {
        const arrive = tl.arrive0 + i * tl.stagger;
        const start = arrive - tl.fly;
        const p = L.pivot;
        if (t < start) { p.visible = false; return; }
        p.visible = true;
        if (t < arrive) {
          const u = (t - start) / tl.fly;
          const e = ease.inQuad(u);
          p.position.set(lerp(L.x * 2.1, L.x, ease.outCubic(u)), lerp((L.rand - 0.5) * 3, 0, ease.outCubic(u)), lerp(-70, 1.6, e));
          const r = 1 - ease.outCubic(u);
          p.rotation.set((L.rand - 0.5) * 2.2 * r, (0.5 - L.rand) * 2.6 * r, (L.rand - 0.5) * 1.2 * r);
          p.scale.setScalar(1);
        } else {
          const s = t - arrive;
          const dz = 1.6 * Math.exp(-9 * s) * Math.cos(14 * s);
          const sq = Math.exp(-9 * s) * Math.cos(16 * s);
          const idle = t > tl.slam + 0.6 ? Math.sin(t * 2 + i * 0.55) * 0.045 : 0;
          p.position.set(L.x, idle, dz);
          p.rotation.set(0, Math.sin(t * 1.3 + i) * 0.03 * smoothstep(tl.slam, tl.slam + 1, t), 0);
          p.scale.set((1 + 0.2 * sq) * pulse, (1 - 0.3 * sq) * pulse, pulse);
        }
      });
      if (slamK > 0) flash = Math.max(0, 0.65 - slamK * 3.5);
    } else {
      this.letters.forEach((L, i) => {
        const land = tl.land0 + i * tl.stagger;
        const start = land - tl.fall;
        const p = L.pivot;
        if (t < start) { p.visible = false; return; }
        p.visible = true;
        if (t < land) {
          const u = (t - start) / tl.fall;
          p.position.set(L.x, lerp(4.6, 0, u * u), 0);
          p.rotation.set(0, 0, L.tilt * 3 * (1 - u));
          p.scale.set(0.94, 1.08, 1);
        } else {
          const s = t - land;
          const sq = Math.exp(-11 * s) * Math.cos(17 * s);
          const bounce = 0.16 * Math.exp(-10 * s) * Math.abs(Math.sin(16 * s));
          let tilt = L.tilt;
          if (i === n - 1 && t > tl.gag) tilt += -0.13 * ease.outElastic(Math.min(1, (t - tl.gag) / 1.1));
          p.position.set(L.x, bounce, 0);
          p.rotation.set(0, 0, tilt * (1 - Math.exp(-8 * s)));
          p.scale.set(1 + 0.24 * sq, 1 - 0.34 * sq, 1);
        }
        if (L.accent) {
          // gag : l'accent saute sous le choc, fait un tour et retombe de travers
          const a = L.accent;
          a.userData.home ??= a.position.clone();
          const h = a.userData.home;
          const g = t - tl.gag;
          if (g <= 0) { a.position.copy(h); a.rotation.set(0, 0, 0); } else {
            const air = 0.5;
            if (g < air) {
              const u = g / air;
              a.position.set(h.x + 0.12 * u, h.y + 1.1 * 4 * u * (1 - u), h.z + 0.3 * Math.sin(Math.PI * u));
              a.rotation.set(0, 0, -(Math.PI * 2 + 0.26) * ease.outCubic(u));
            } else {
              const b = g - air;
              a.position.set(h.x + 0.12, h.y + 0.14 * Math.exp(-9 * b) * Math.abs(Math.sin(14 * b)), h.z);
              a.rotation.set(0, 0, -0.26 - 0.12 * Math.exp(-6 * b) * Math.cos(12 * b));
            }
          }
        }
      });
    }
    m.face.uniforms.uFlash.value = flash;
    m.side.uniforms.uFlash.value = flash;
  }

  // ------------------------------------------------------------ nettoyage

  clear() {
    this.running = false;
    this.cues = [];
    this.slamT = null;
    if (this.word) {
      this.word.traverse((o) => { if (o.userData.geos) o.userData.geos.forEach((g) => g.dispose()); });
      this.scene.remove(this.word);
      this._retire(this.shadowMat, 'shadow');
      this.word = null;
    }
    if (this.glass) {
      this.scene.remove(this.glass); this.glass.geometry.dispose(); this._retire(this.glassMat, 'glass'); this.glass = null;
      this.scene.remove(this.cracks); this.cracks.geometry.dispose(); this._retire(this.crackMat, 'crack'); this.cracks = null;
      this.scene.remove(this.backing); this._retire(this.backingMat, 'backing'); this.backing = null;
    }
    this.snapTex?.dispose();
    this.snapTex = null;
    this.confetti.clear();
    this.confetti.ambient = 0;
    this.sparkles.clear();
    this.puffs.clear();
    this.dust.clear();
    for (const r of this.rings) r.visible = false;
    this.flashMat.uniforms.uOpacity.value = 0;
    this.speedMat.uniforms.uAmount.value = 0;
  }

  // A material rebuilt at every start (glass, its backing, cracks, title shadow) going away.
  // PERF (keepWarm): three numbers each shader source only while a material uses it — once
  // the last one is disposed, the next material gets a new number, hence a new program key,
  // and its program compiled again in the middle of the next intro (3 programs per end
  // screen, the pinned ones never reused). The first material of each kind is kept instead
  // (never drawn again, its snapshot texture let go): the numbers, so the programs, stay.
  _retire(mat, kind) {
    if (!mat) return;
    if (this.keepWarm && !this._anchors[kind]) {
      if (mat.uniforms.uSnap) mat.uniforms.uSnap.value = null;
      this._anchors[kind] = mat;
      return;
    }
    mat.dispose();
  }

  dispose() {
    this.clear();
    for (const k of Object.keys(this._anchors)) this._anchors[k].dispose();
    this._anchors = {};
    this.sparkles.dispose(); this.dust.dispose(); this.puffs.dispose(); this.confetti.dispose();
    this.bgMat.dispose(); this.speedMat.dispose(); this.flashMat.dispose();
    for (const r of this.rings) r.material.dispose();
    if (this.titleMats) for (const k of Object.keys(this.titleMats)) this.titleMats[k].dispose();
    this.quadGeo.dispose();
    this.renderer.dispose();
  }
}

// ---------------------------------------------------------------- instance préchauffée
//
// PERF — at the end of a match the end screen used to create its WebGL context, compile its
// programs (each one waited for by three's checkShaderErrors), upload its buffers and build the
// extruded title, all in the frames where the match ends — then compile again mid-intro (the
// letters, the rings: invisible at first). The warm-up does all of it beforehand, in the idle
// time of the menu, on a 16 × 9 drawing buffer, and the instance is kept from one end screen to
// the next (replays). Nothing is drawn on screen: the canvas is not in the page meanwhile.

const pool = { spare: null, job: null };

const nextIdle = (fn) => (typeof requestIdleCallback === 'function'
  ? requestIdleCallback(fn, { timeout: 1500 })
  : setTimeout(fn, 30));

function programsReady(renderer) {
  for (const p of renderer.info.programs ?? []) if (typeof p.isReady === 'function' && !p.isReady()) return false;
  return true;
}

// Pinned: a program whose last material is disposed (the glass, cracks and title shadow are
// rebuilt at every start) would otherwise be destroyed by three, then compiled again.
function pinPrograms(renderer) {
  for (const p of renderer.info.programs ?? []) {
    if (!p.__endscreenPinned) { p.__endscreenPinned = true; p.usedTimes++; }
  }
}

// Every object drawn, in view or not (programs and their draw-time variants), then restored.
function forceVisible(root) {
  const saved = [];
  root.traverse((o) => { saved.push(o, o.visible, o.frustumCulled); o.visible = true; o.frustumCulled = false; });
  return () => { for (let i = 0; i < saved.length; i += 3) { saved[i].visible = saved[i + 1]; saved[i].frustumCulled = saved[i + 2]; } };
}

class WarmJob {
  constructor({ pixelRatio, quality, titles }) {
    this.opts = { pixelRatio, quality };
    this.titles = titles;
    this.intro = null;
    this.step = 0;
    this.restore = null;
    this.done = false;
    this.promise = new Promise((resolve) => { this.resolve = resolve; });
    this.snap = null;
  }

  // One step (one idle slot each); `sync` = run to completion now.
  run(sync = false) {
    if (this.done) return;
    try {
      switch (this.step) {
        case 0: {
          this.intro = new Intro3D(document.createElement('canvas'), this.opts);
          this.intro.keepWarm = true;
          this.intro.fastGlass = true;
          this.intro.resize(16, 9);
          const snap = document.createElement('canvas');
          snap.width = 8; snap.height = 8;
          const g = snap.getContext('2d');
          g.fillStyle = '#5a6f8c';
          g.fillRect(0, 0, 8, 8);
          this.snap = snap;
          break;
        }
        case 1: {
          // Victory: extruded title + glass + every pool forced visible; the programs go to
          // the GPU process (linked in parallel where the browser can, polled below).
          const it = this.intro;
          it.start('victory', this.snap, { titleText: this.titles[0] });
          this.restore = forceVisible(it.scene);
          it.renderer.compile(it.scene, it.camera);
          break;
        }
        case 2: {
          const it = this.intro;
          if (!sync && !programsReady(it.renderer)) { setTimeout(() => this.run(), 16); return; }
          it.renderer.render(it.scene, it.camera);
          this.restore();
          pinPrograms(it.renderer);
          break;
        }
        case 3: {
          // Defeat: the other title (accent), the dust; same programs, its own buffers.
          const it = this.intro;
          it.start('defeat', this.snap, { titleText: this.titles[1] });
          const restore = forceVisible(it.scene);
          it.renderer.render(it.scene, it.camera);
          restore();
          break;
        }
        default: {
          const it = this.intro;
          pinPrograms(it.renderer);
          it.clear();
          it.renderer.setSize(1, 1, false);
          this.snap = null;
          this.done = true;
          pool.job = null;
          if (!pool.spare) pool.spare = it; else it.dispose();
          this.resolve();
          return;
        }
      }
    } catch (err) {
      console.warn('[EndScreen] warm-up skipped', err);
      this.done = true;
      pool.job = null;
      try { this.intro?.dispose(); } catch { /* */ }
      this.resolve();
      return;
    }
    this.step++;
    if (sync) this.run(true);
    else nextIdle(() => this.run());
  }
}

// Starts the warm-up (idle slots of the page); resolves when the instance is ready.
export function prewarmIntro3D({ pixelRatio = Math.min(window.devicePixelRatio || 1, 2), quality = 'high', titles = ['VICTOIRE', 'DÉFAITE'] } = {}) {
  if (pool.spare) return Promise.resolve();
  if (pool.job) return pool.job.promise;
  const job = new WarmJob({ pixelRatio, quality, titles });
  pool.job = job;
  nextIdle(() => job.run());
  return job.promise;
}

// Finishes the warm-up now (PLAY, a measurement about to start): nothing left for later.
export function flushIntro3DWarmUp() {
  pool.job?.run(true);
}

// The warm instance (removed from the pool), or null: the caller builds a new one as before.
export function takeIntro3D(quality = 'high') {
  if (pool.job) flushIntro3DWarmUp();
  const it = pool.spare;
  if (!it || it.quality !== quality) return null;
  pool.spare = null;
  if (it.renderer.getContext().isContextLost()) {
    try { it.dispose(); } catch { /* */ }
    return null;
  }
  return it;
}

// Back to the pool for the next end screen (its context, programs and buffers stay warm).
export function releaseIntro3D(intro) {
  if (!intro) return;
  if (pool.spare || intro.renderer.getContext().isContextLost()) { intro.dispose(); return; }
  pinPrograms(intro.renderer);
  intro.keepWarm = true;
  intro.clear();
  intro.renderer.setSize(1, 1, false);
  intro.onCue = () => {}; // (no reference kept to the end screen that is going away)
  intro.slotFn = null;
  pool.spare = intro;
}
