/**
 * Fragment main() of the paint shader (appended to PAINT_FRAG_HEAD).
 * 1. coarse 2D reject, 2. sphere-traced march along -z (30 steps),
 * 3. normal by tetrahedral gradient, 4. pigment + gloss on the normal,
 * 5. contact shadow / occlusion on the plate frame. Premultiplied output.
 */
export const PAINT_FRAG_MAIN = /* glsl */ `
void main() {
  // vUv.y = 0 at the bottom of the canvas; plate px grow downward.
  vec2 p2 = vec2(uOrigin.x + vUv.x * uSize.x, uOrigin.y + (1.0 - vUv.y) * uSize.y);

  float nearest = 1e5;
  for (int i = 0; i < MAXN; i++) {
    if (i >= uCount) break;
    vec4 a = uNodes[i];
    if (a.w < 0.05) continue;
    nearest = min(nearest, length(p2 - a.xy) - a.w);
  }

  vec3 ro = vec3(p2, 40.0);
  float t = 0.0;
  float dmin = 1e5;
  bool hit = false;
  if (nearest < 14.0) {
    for (int s = 0; s < 30; s++) {
      float d = mapAll(ro + vec3(0.0, 0.0, -t));
      dmin = min(dmin, d);
      if (d < 0.04) { hit = true; break; }
      t += d * 0.85;
      if (t > 56.0) break;
    }
  }

  // Light from the top-left, a little in front (matches the plate's shadow).
  vec3 L = normalize(vec3(-0.5, -0.65, 0.58));
  vec3 paintCol = vec3(0.0);
  float paintA = 0.0;

  if (hit) {
    vec3 pos = ro + vec3(0.0, 0.0, -t);
    float e = 0.55;
    vec2 k = vec2(1.0, -1.0);
    vec3 n = normalize(
      k.xyy * mapAll(pos + k.xyy * e) + k.yyx * mapAll(pos + k.yyx * e) +
      k.yxy * mapAll(pos + k.yxy * e) + k.xxx * mapAll(pos + k.xxx * e));

    // Per-cluster distance → soft pigment / material blend near the seams.
    float dc[MAXC];
    for (int c = 0; c < MAXC; c++) dc[c] = 1e5;
    for (int i = 0; i < MAXN; i++) {
      if (i >= uCount) break;
      if (uNodes[i].w < 0.05) continue;
      int c = int(uCl[i] + 0.5);
      dc[c] = min(dc[c], nodeDist(pos, i));
    }
    float dm = 1e5;
    for (int c = 0; c < MAXC; c++) dm = min(dm, dc[c]);
    vec3 col = vec3(0.0);
    vec4 mat = vec4(0.0);
    float wsum = 0.0;
    for (int c = 0; c < MAXC; c++) {
      if (c >= uNC) break;
      float w = exp(-(dc[c] - dm) * 1.1);
      col += uColor[c] * w;
      mat += uMat[c] * w;
      wsum += w;
    }
    col /= wsum;
    mat /= wsum;

    float ndl = dot(n, L);
    vec3 deep = col * col * 0.5 + col * 0.22;
    vec3 shade = mix(deep, col * 1.06, smoothstep(-0.35, 0.85, ndl));
    shade *= mix(1.0, 0.74, smoothstep(0.05, 0.85, n.y));        // shaded underside
    shade *= mix(0.7, 1.0, smoothstep(0.0, 4.5, pos.z));        // occlusion at the attachment

    vec3 V = vec3(0.0, 0.0, 1.0);
    vec3 r = reflect(-V, n);
    float w = mix(0.07, 0.014, mat.x);
    float win = softbox(r, normalize(vec3(-0.42, -0.62, 0.66)), 0.955, w);
    float win2 = softbox(r, normalize(vec3(0.58, 0.28, 0.76)), 0.975, w * 0.8) * 0.55;
    float strip = softbox(r, normalize(vec3(0.05, -0.9, 0.43)), 0.97, w * 1.4) * 0.35;
    float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
    shade += col * fres * mat.z * 0.55;                          // pigment glow on edges
    shade += vec3(fres * 0.1 * mat.y * smoothstep(-0.2, 0.6, -n.y)); // bounce on the underside
    paintCol = shade + vec3((win + win2 + strip) * mat.y);
    paintA = mat.w;
  } else if (dmin < uPx * 1.4) {
    // silhouette anti-aliasing: grazing rays that missed by < 1.4 px
    vec3 ap = ro + vec3(0.0, 0.0, -t);
    float best = 1e5;
    vec3 col = vec3(0.0);
    for (int i = 0; i < MAXN; i++) {
      if (i >= uCount) break;
      if (uNodes[i].w < 0.05) continue;
      float d = nodeDist(ap, i);
      if (d < best) { best = d; col = uColor[int(uCl[i] + 0.5)]; }
    }
    paintCol = col * 0.8;
    paintA = (1.0 - smoothstep(0.0, uPx * 1.4, dmin)) * 0.9;
  }

  // Contact shadow + occlusion on the plate frame (cast away from the light).
  float onFrame = 1.0 - smoothstep(-1.0, 1.5, sdFrame(p2));
  float shA = 0.0;
  if (nearest < 18.0 && onFrame > 0.0) {
    float dsh = mapAll(vec3(p2 - L.xy * 6.0, 2.2));
    float dao = mapAll(vec3(p2, 0.0));
    shA = clamp((1.0 - smoothstep(-1.0, 4.5, dsh)) * 0.5 + (1.0 - smoothstep(0.0, 3.5, dao)) * 0.28, 0.0, 0.7) * onFrame;
  }

  float a = paintA + shA * (1.0 - paintA);
  vec3 rgb = paintCol * paintA + vec3(0.03, 0.02, 0.05) * shA * (1.0 - paintA);
  gl_FragColor = vec4(rgb, a);
}`;
