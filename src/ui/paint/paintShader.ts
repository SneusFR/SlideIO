import { PAINT_MAX_CLUSTERS, PAINT_MAX_NODES } from "./paintTypes";

/**
 * Paint shader — ONE signed-distance volume raymarched along -z (orthographic,
 * plate pixels). All capsule chains are fused with a polynomial SMOOTH UNION,
 * so the mass is a single continuous surface (no visible spheres): necks,
 * bulbs and fillets at the attachments come from the field itself.
 *
 *   shading : wrapped diffuse + darker underside + contact AO (low z)
 *   gloss   : reflection of a procedural studio (window softboxes) on the
 *             marched NORMAL, so highlights slide over the curvature when the
 *             mass deforms (nothing is painted in)
 *   pigment : opaque, grazing-edge pigment glow (sss) — not a clear gel
 *   contact : soft shadow cast on the plate frame, offset away from the light
 *
 * Output is PREMULTIPLIED alpha.
 */
export const PAINT_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const HEAD = /* glsl */ `
#define MAXN ${PAINT_MAX_NODES}
#define MAXC ${PAINT_MAX_CLUSTERS}
varying vec2 vUv;
uniform vec4 uNodes[MAXN];
uniform float uLinks[MAXN];
uniform float uCl[MAXN];
uniform vec3 uColor[MAXC];
uniform vec4 uMat[MAXC];
uniform int uCount;
uniform int uNC;
uniform vec2 uSize;
uniform vec2 uOrigin;
uniform float uPx;
uniform vec4 uRect0;
uniform vec4 uRect1;
uniform vec2 uRad;

const float K_SMOOTH = 4.5;

float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

float capsule(vec3 p, vec4 a, vec4 b) {
  vec3 ab = b.xyz - a.xyz;
  float t = clamp(dot(p - a.xyz, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
  return length(p - a.xyz - ab * t) - mix(a.w, b.w, t);
}

float nodeDist(vec3 p, int i) {
  vec4 a = uNodes[i];
  if (uLinks[i] > 0.5 && i + 1 < uCount) {
    vec4 b = uNodes[i + 1];
    if (b.w > 0.05) return capsule(p, a, b);
  }
  return length(p - a.xyz) - a.w;
}

float mapAll(vec3 p) {
  float d = 1e5;
  for (int i = 0; i < MAXN; i++) {
    if (i >= uCount) break;
    if (uNodes[i].w < 0.05) continue;
    d = smin(d, nodeDist(p, i), K_SMOOTH);
  }
  return d;
}

// Rounded-rect distance in plate px (the frame the paint rests on).
float sdRRect(vec2 p, vec4 r, float rad) {
  vec2 c = r.xy + r.zw * 0.5;
  vec2 q = abs(p - c) - r.zw * 0.5 + rad;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
}
float sdFrame(vec2 p) {
  return min(sdRRect(p, uRect0, uRad.x), sdRRect(p, uRect1, uRad.y));
}
float softbox(vec3 r, vec3 dir, float cosA, float w) {
  return smoothstep(cosA - w, cosA + w, dot(r, dir));
}
`;

export const PAINT_FRAG_HEAD = HEAD;
