/**
 * credit.js — Pièce de crédit 3D procédurale pour Three.js (r152+)
 *
 * Fidèle à l'icône du crédit : tranche épaisse, bord noir arrondi, anneau crème,
 * champ cyan légèrement bombé, haricot crème cerné de noir avec son trait,
 * reflet peint en haut à gauche, et bandes roses sur la tranche.
 * Les formes (haricot, contour, trait, reflet) sont relevées directement sur l'icône.
 *
 *   import { createCredit, animateCredit } from './credit.js';
 *
 *   const credit = createCredit({ size: 0.5 });   // 50 cm de diamètre
 *   credit.position.set(0, 1.1, 0);
 *   scene.add(credit);
 *
 *   // dans la boucle de rendu :
 *   animateCredit(credit, clock.getElapsedTime());
 *
 * Coût : 2 draw calls par pièce (corps + contour). Géométries et matériaux sont
 * construits une seule fois puis partagés entre toutes les pièces.
 *
 * Options de createCredit (toutes facultatives) :
 *   size          diamètre en unités monde (0.5)
 *   detail        'low' | 'medium' | 'high'  (≈ 3,5k / 6,9k / 10,7k triangles, contour compris)
 *   outline       contour noir façon icône (true) ; outlineColor, outlineWidth
 *   lighting      'fixed' : ombrage toon intégré, rendu identique à l'icône quelle que soit la scène
 *                 'scene' : MeshToonMaterial, éclairé par les lumières de ta scène
 *   stripes       nombre de bandes roses sur la tranche (4)
 *   spinSpeed, bobHeight, bobSpeed, phase   réglages de l'animation
 *
 * Les couleurs ne passent pas par le tone mapping : la palette reste celle de l'icône.
 * Brouillard, instancing et clipping restent gérés (matériau basé sur MeshBasicMaterial).
 */
import * as THREE from 'three';

/* ------------------------------------------------------------------ palette */

export const CREDIT_COLORS = {
  cyan: '#0AE4FA',
  cyanDeep: '#03ADCB',
  cream: '#FCF5E4',
  shine: '#F9FBF6',
  ink: '#232127',
  pink: '#FC5B90',
  outline: '#0E0C11',
};

// Ordre des groupes de la géométrie (un groupe = une couleur = un matériau à l'export).
const COLOR_KEYS = ['cyan', 'cyanDeep', 'cream', 'shine', 'ink', 'pink'];

/* ---------------------------------------------------- formes relevées sur l'icône */
// Unité : rayon de la pièce = 1, y vers le haut, sens anti-horaire.

const BEAN = [
  0.2056,0.4097,0.1739,0.4069,0.1425,0.3996,0.1114,0.3879,0.0809,0.3716,0.0519,0.3513,0.0248,0.327,
  -0.0016,0.2974,-0.031,0.2583,-0.06,0.2196,-0.0861,0.1908,-0.1134,0.1668,-0.1422,0.1471,-0.1738,
  0.1309,-0.21,0.1174,-0.2551,0.1051,-0.2993,0.0929,-0.3345,0.0793,-0.3657,0.0627,-0.3933,0.0433,
  -0.4171,0.0212,-0.4374,-0.0034,-0.4538,-0.0301,-0.4661,-0.0585,-0.4741,-0.0879,-0.4777,-0.1178,
  -0.4769,-0.1479,-0.4717,-0.178,-0.4621,-0.2075,-0.4477,-0.2372,-0.4288,-0.2664,-0.4053,-0.2942,
  -0.3758,-0.3224,-0.3436,-0.3485,-0.3103,-0.3701,-0.2735,-0.3893,-0.2364,-0.4044,-0.1962,-0.4161,
  -0.1551,-0.4245,-0.1138,-0.4288,-0.0679,-0.4298,-0.0246,-0.4276,0.0199,-0.4213,0.0644,-0.412,
  0.1071,-0.3992,0.1502,-0.383,0.1898,-0.3643,0.2296,-0.3416,0.2656,-0.3173,0.2999,-0.2895,0.3328,
  -0.2586,0.3606,-0.2277,0.3856,-0.1938,0.4076,-0.1579,0.4256,-0.121,0.441,-0.0807,0.4527,-0.0399,
  0.4606,0.0015,0.4649,0.0441,0.4655,0.0868,0.4624,0.1295,0.4555,0.1721,0.4453,0.2132,0.4321,0.2506,
  0.4159,0.2845,0.3973,0.314,0.3768,0.3388,0.3536,0.3598,0.3273,0.3776,0.2983,0.392,0.2679,0.4024,
  0.237,0.4082,
];

const BEAN_INK = [
  0.1769,0.4879,0.1367,0.4825,0.0984,0.472,0.06,0.4559,0.0222,0.4346,-0.0127,0.4092,-0.0446,0.3796,
  -0.0751,0.3439,-0.1088,0.2977,-0.138,0.2604,-0.165,0.2342,-0.1934,0.2137,-0.2245,0.198,-0.2632,
  0.1853,-0.315,0.1724,-0.3585,0.1578,-0.3987,0.1389,-0.4354,0.1164,-0.4677,0.0904,-0.4963,0.061,
  -0.5204,0.0289,-0.5396,-0.0054,-0.5535,-0.0403,-0.562,-0.0759,-0.5654,-0.1142,-0.5639,-0.1542,
  -0.5574,-0.1923,-0.5457,-0.2289,-0.5285,-0.2653,-0.5059,-0.3008,-0.4773,-0.3359,-0.4434,-0.3699,
  -0.4056,-0.4012,-0.3646,-0.4291,-0.3217,-0.4528,-0.277,-0.4722,-0.2309,-0.4871,-0.1818,-0.4979,
  -0.1297,-0.5049,-0.0791,-0.5075,-0.025,-0.5055,0.0302,-0.5,0.081,-0.4906,0.133,-0.4767,0.1824,
  -0.4593,0.2308,-0.4375,0.2773,-0.4123,0.3212,-0.3834,0.3626,-0.3514,0.3993,-0.3173,0.433,-0.2799,
  0.4626,-0.2404,0.4885,-0.1979,0.5104,-0.1534,0.5279,-0.1074,0.541,-0.0601,0.5497,-0.0106,0.5544,
  0.0402,0.5543,0.0893,0.5495,0.1395,0.5404,0.189,0.5267,0.2378,0.5098,0.2828,0.4896,0.3226,0.4654,
  0.3592,0.4387,0.3909,0.4093,0.4178,0.3759,0.441,0.3393,0.4603,0.301,0.4747,0.2614,0.484,0.2196,
  0.4884,
];

const CREASE = [
  0.0688,0.267,0.0565,0.2622,0.0471,0.2535,0.0376,0.236,0.0251,0.2118,0.0077,0.185,-0.0084,0.1652,
  -0.031,0.1436,-0.0532,0.125,-0.0769,0.1098,-0.1026,0.097,-0.1331,0.0846,-0.1589,0.0765,-0.1814,
  0.0706,-0.1931,0.0636,-0.2002,0.0544,-0.2034,0.0433,-0.2024,0.0315,-0.1972,0.0205,-0.1881,0.0117,
  -0.1754,0.0059,-0.1586,0.004,-0.1342,0.007,-0.1037,0.0135,-0.0763,0.0223,-0.0469,0.0342,-0.0211,
  0.0475,0.0048,0.0638,0.0277,0.0816,0.0506,0.1025,0.0692,0.1235,0.0872,0.1482,0.1017,0.1729,0.116,
  0.2014,0.1222,0.2199,0.1226,0.2351,0.1186,0.2479,0.1111,0.2576,0.1,0.2644,0.0847,0.2679,
];

const SHINE = [
  -0.1816,0.7447,-0.215,0.7375,-0.2493,0.7286,-0.2857,0.7155,-0.32,0.702,-0.3543,0.6848,-0.3889,
  0.6665,-0.4217,0.646,-0.4543,0.6242,-0.4837,0.6011,-0.5135,0.5756,-0.5376,0.551,-0.562,0.5224,
  -0.574,0.5037,-0.578,0.4898,-0.5773,0.4793,-0.5735,0.4715,-0.567,0.4663,-0.5582,0.4638,-0.5469,
  0.4648,-0.5331,0.4712,-0.5151,0.4865,-0.4902,0.5102,-0.4593,0.536,-0.4308,0.5589,-0.3972,0.5825,
  -0.3665,0.6022,-0.3307,0.6225,-0.2985,0.6387,-0.2612,0.6554,-0.2279,0.6687,-0.1907,0.682,-0.1577,
  0.695,-0.1433,0.7039,-0.1367,0.7122,-0.1344,0.7205,-0.1356,0.7284,-0.1402,0.7356,-0.1486,0.7415,
  -0.162,0.7452,
];

/* --------------------------------------------------------------- dimensions */
// Rayon = 1, axe de la pièce = Z, face avant vers +Z. Proportions mesurées sur l'icône.

const DIM = {
  half: 0.24,        // demi-épaisseur (épaisseur totale = 0.24 × diamètre)
  fillet: 0.08,      // bord noir arrondi
  rimIn: 0.853,      // rayon intérieur de l'anneau crème
  wallFoot: 0.83,    // pied du petit mur cyan foncé
  fieldFlat: 0.78,   // partie plate du champ cyan
  fieldDepth: 0.045, // champ cyan sous le niveau de l'anneau crème
  fieldDrop: 0.029,  // arrondi du champ vers la rainure (donne l'ombre cyan foncé)
  beanInk: 0.025,    // socle noir du haricot, au-dessus du champ
  beanCream: 0.041,  // haricot crème, au-dessus du champ (reste sous le bord)
  relief: 0.006,     // épaisseur du trait et du reflet
  stripeDeg: 13,     // largeur d'une bande rose (degrés)
  borderDeg: 2.4,    // filet noir de chaque côté des bandes
};

const DETAIL = {
  low: { segments: 32, fillet: 3, pillow: 2, bevel: 1, contourStep: 2 },
  medium: { segments: 48, fillet: 4, pillow: 3, bevel: 2, contourStep: 1 },
  high: { segments: 72, fillet: 6, pillow: 4, bevel: 3, contourStep: 1 },
};

const DEFAULTS = {
  size: 0.5,            // diamètre en unités monde
  detail: 'medium',     // 'low' | 'medium' | 'high'
  stripes: 4,           // bandes roses sur la tranche
  outline: true,        // contour noir (coque inversée)
  outlineWidth: 0.04,   // épaisseur du contour, en fraction du rayon
  outlineColor: CREDIT_COLORS.outline,
  lighting: 'fixed',    // 'fixed' : ombrage toon intégré, identique à l'icône quelle que soit la scène
                        // 'scene' : MeshToonMaterial éclairé par les lumières de la scène
  spinSpeed: 2.0,       // rad/s
  bobHeight: 0.12,      // amplitude du flottement, en fraction du diamètre
  bobSpeed: 2.4,        // rad/s
  phase: undefined,     // décalage d'animation (aléatoire par défaut)
};

/* ------------------------------------------------------------ mesh builder */

class Builder {
  constructor() {
    this.buckets = {};
    for (const k of COLOR_KEYS) this.buckets[k] = { p: [], n: [] };
  }

  tri(key, a, b, c, na, nb, nc) {
    const B = this.buckets[key];
    B.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    B.n.push(na[0], na[1], na[2], nb[0], nb[1], nb[2], nc[0], nc[1], nc[2]);
  }

  // Copie le contenu de `other`, éventuellement tourné de 180° autour de Y (face arrière).
  append(other, flipToBack = false) {
    for (const k of COLOR_KEYS) {
      const src = other.buckets[k], dst = this.buckets[k];
      for (let i = 0; i < src.p.length; i += 3) {
        const s = flipToBack ? -1 : 1;
        dst.p.push(s * src.p[i], src.p[i + 1], s * src.p[i + 2]);
        dst.n.push(s * src.n[i], src.n[i + 1], s * src.n[i + 2]);
      }
    }
  }
}

// Surface de révolution autour de Z. prof = [[r, z, nr, nz], ...], parcouru de sorte
// que la normale sortante soit (-dz, dr) ; angles croissants.
function revolve(B, key, prof, angles) {
  for (let j = 0; j < angles.length - 1; j++) {
    const c0 = Math.cos(angles[j]), s0 = Math.sin(angles[j]);
    const c1 = Math.cos(angles[j + 1]), s1 = Math.sin(angles[j + 1]);
    for (let i = 0; i < prof.length - 1; i++) {
      const [r0, z0, nr0, nz0] = prof[i];
      const [r1, z1, nr1, nz1] = prof[i + 1];
      const A = [r0 * c0, r0 * s0, z0], Bv = [r1 * c0, r1 * s0, z1];
      const C = [r1 * c1, r1 * s1, z1], Dv = [r0 * c1, r0 * s1, z0];
      const nA = [nr0 * c0, nr0 * s0, nz0], nB = [nr1 * c0, nr1 * s0, nz1];
      const nC = [nr1 * c1, nr1 * s1, nz1], nD = [nr0 * c1, nr0 * s1, nz0];
      if (r1 > 1e-7) B.tri(key, A, Bv, C, nA, nB, nC);
      if (r0 > 1e-7) B.tri(key, A, C, Dv, nA, nC, nD);
    }
  }
}

// Extrusion d'un contour 2D (anti-horaire) avec arête supérieure arrondie et normales lisses.
// Pas de face de dessous : la base est enfoncée dans la pièce.
function extrudeRounded(B, key, flat, z0, z1, bevel, steps) {
  const n = flat.length / 2;
  const P = [];
  for (let i = 0; i < n; i++) P.push([flat[2 * i], flat[2 * i + 1]]);

  const edgeN = [];
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    edgeN.push([dy / l, -dx / l]);
  }
  const vN = [], miter = [];
  for (let i = 0; i < n; i++) {
    const e0 = edgeN[(i - 1 + n) % n], e1 = edgeN[i];
    let x = e0[0] + e1[0], y = e0[1] + e1[1];
    const l = Math.hypot(x, y) || 1;
    x /= l; y /= l;
    vN.push([x, y]);
    miter.push(1 / Math.max(0.5, x * e1[0] + y * e1[1]));
  }

  const rings = [{ inset: 0, z: z0, c: 1, s: 0 }];
  for (let k = 0; k <= steps; k++) {
    const a = (k / steps) * Math.PI / 2;
    rings.push({ inset: bevel * (1 - Math.cos(a)), z: z1 - bevel + bevel * Math.sin(a), c: Math.cos(a), s: Math.sin(a) });
  }
  const pts = rings.map((r) => P.map((p, i) => [p[0] - vN[i][0] * r.inset * miter[i], p[1] - vN[i][1] * r.inset * miter[i], r.z]));
  const nor = rings.map((r) => P.map((p, i) => [vN[i][0] * r.c, vN[i][1] * r.c, r.s]));

  for (let k = 0; k < rings.length - 1; k++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      B.tri(key, pts[k][i], pts[k][j], pts[k + 1][j], nor[k][i], nor[k][j], nor[k + 1][j]);
      B.tri(key, pts[k][i], pts[k + 1][j], pts[k + 1][i], nor[k][i], nor[k + 1][j], nor[k + 1][i]);
    }
  }

  const top = pts[pts.length - 1];
  const up = [0, 0, 1];
  const faces = THREE.ShapeUtils.triangulateShape(top.map((p) => new THREE.Vector2(p[0], p[1])), []);
  for (const [a, b, c] of faces) {
    const A = top[a], Bv = top[b], C = top[c];
    const cross = (Bv[0] - A[0]) * (C[1] - A[1]) - (Bv[1] - A[1]) * (C[0] - A[0]);
    if (cross >= 0) B.tri(key, A, Bv, C, up, up, up);
    else B.tri(key, A, C, Bv, up, up, up);
  }
}

// Intervalles colorés de la tranche + liste d'angles commune à toutes les révolutions
// (mêmes sommets partout : aucune fissure entre la tranche, les bords et les faces).
function buildAngles(segments, stripes) {
  const intervals = [];
  let start = 0;
  if (stripes > 0) {
    const p = THREE.MathUtils.degToRad(DIM.stripeDeg);
    const b = THREE.MathUtils.degToRad(DIM.borderDeg);
    const step = (Math.PI * 2) / stripes;
    start = -(p / 2 + b);
    for (let s = 0; s < stripes; s++) {
      const c = s * step;
      intervals.push({ a0: c - p / 2 - b, a1: c - p / 2, key: 'ink' });
      intervals.push({ a0: c - p / 2, a1: c + p / 2, key: 'pink' });
      intervals.push({ a0: c + p / 2, a1: c + p / 2 + b, key: 'ink' });
      intervals.push({ a0: c + p / 2 + b, a1: c + step - p / 2 - b, key: 'cyan' });
    }
  } else {
    intervals.push({ a0: 0, a1: Math.PI * 2, key: 'cyan' });
  }

  const raw = [];
  for (let k = 0; k <= segments; k++) raw.push(start + (k / segments) * Math.PI * 2);
  for (const it of intervals) raw.push(it.a0, it.a1);
  raw.sort((a, b) => a - b);
  const angles = [];
  for (const a of raw) if (!angles.length || a - angles[angles.length - 1] > 1e-6) angles.push(a);
  return { angles, intervals };
}

function arc(cr, cz, rad, a0, a1, steps) {
  const out = [];
  for (let k = 0; k <= steps; k++) {
    const a = a0 + (a1 - a0) * (k / steps);
    out.push([cr + rad * Math.cos(a), cz + rad * Math.sin(a), Math.cos(a), Math.sin(a)]);
  }
  return out;
}

// Garde un point sur `step` d'un contour [x0, y0, x1, y1, ...].
function decimate(flat, step) {
  if (step <= 1) return flat;
  return flat.filter((_, i) => Math.floor(i / 2) % step === 0);
}

function buildCreditGeometries({ segments, fillet: filletSteps, pillow, bevel, contourStep }, stripes, outlineWidth) {
  const H = DIM.half, F = DIM.fillet, rimOut = 1 - F;
  const zt = H - DIM.fieldDepth;
  const { angles, intervals } = buildAngles(segments, stripes);

  /* ---- corps : bords arrondis noirs + tranche à bandes */
  const body = new Builder();
  revolve(body, 'ink', arc(rimOut, H - F, F, Math.PI / 2, 0, filletSteps), angles);
  revolve(body, 'ink', arc(rimOut, -(H - F), F, 0, -Math.PI / 2, filletSteps), angles);
  const side = [[1, H - F, 1, 0], [1, -(H - F), 1, 0]];
  for (const it of intervals) {
    const sub = angles.filter((a) => a >= it.a0 - 1e-6 && a <= it.a1 + 1e-6);
    revolve(body, it.key, side, sub);
  }

  /* ---- face avant (dupliquée à l'arrière) */
  const face = new Builder();
  const run = DIM.wallFoot - DIM.fieldFlat, drop = DIM.fieldDrop;
  const alpha = 2 * Math.atan(drop / run), pr = run / Math.sin(alpha);
  const field = [[0, zt, 0, 1], [DIM.fieldFlat, zt, 0, 1]];
  for (let k = 1; k <= pillow; k++) {
    const a = (k / pillow) * alpha;
    field.push([DIM.fieldFlat + pr * Math.sin(a), zt - pr * (1 - Math.cos(a)), Math.sin(a), Math.cos(a)]);
  }
  revolve(face, 'cyan', field, angles);

  const wz0 = zt - drop, wl = Math.hypot(H - wz0, DIM.rimIn - DIM.wallFoot);
  const wn = [-(H - wz0) / wl, (DIM.rimIn - DIM.wallFoot) / wl];
  revolve(face, 'cyanDeep', [[DIM.wallFoot, wz0, wn[0], wn[1]], [DIM.rimIn, H, wn[0], wn[1]]], angles);
  revolve(face, 'cream', [[DIM.rimIn, H, 0, 1], [rimOut, H, 0, 1]], angles);

  const creamTop = zt + DIM.beanCream, rel = DIM.relief;
  const k = contourStep;
  extrudeRounded(face, 'shine', decimate(SHINE, k), zt - 0.004, zt + rel, 0.003, 1);
  extrudeRounded(face, 'ink', decimate(BEAN_INK, k), zt - 0.004, zt + DIM.beanInk, 0.01, bevel);
  extrudeRounded(face, 'cream', decimate(BEAN, k), zt - 0.004, creamTop, 0.02, bevel + 1);
  extrudeRounded(face, 'ink', decimate(CREASE, k), creamTop - rel, creamTop + rel, 0.004, 1);

  body.append(face, false);
  body.append(face, true);

  /* ---- coque du contour (rendue en BackSide) */
  const hull = new Builder();
  const w = outlineWidth;
  const hullProf = [[0, H + w, 0, 1]];
  hullProf.push(...arc(rimOut, H - F, F + w, Math.PI / 2, 0, filletSteps + 1));
  hullProf.push(...arc(rimOut, -(H - F), F + w, 0, -Math.PI / 2, filletSteps + 1));
  hullProf.push([0, -(H + w), 0, -1]);
  revolve(hull, 'ink', hullProf, angles);

  return { body: toGeometry(body), hull: toGeometry(hull, false) };
}

// Fusionne les sommets identiques, ajoute couleurs de sommets et un groupe par couleur.
function toGeometry(builder, withColors = true) {
  const pos = [], nor = [], col = [], index = [];
  const groups = [];
  const color = new THREE.Color();
  COLOR_KEYS.forEach((key, materialIndex) => {
    const b = builder.buckets[key];
    if (!b.p.length) return;
    const map = new Map();
    color.set(CREDIT_COLORS[key]);
    const start = index.length;
    for (let i = 0; i < b.p.length; i += 3) {
      const id = `${b.p[i].toFixed(5)},${b.p[i + 1].toFixed(5)},${b.p[i + 2].toFixed(5)},${b.n[i].toFixed(3)},${b.n[i + 1].toFixed(3)},${b.n[i + 2].toFixed(3)}`;
      let v = map.get(id);
      if (v === undefined) {
        v = pos.length / 3;
        map.set(id, v);
        pos.push(b.p[i], b.p[i + 1], b.p[i + 2]);
        const l = Math.hypot(b.n[i], b.n[i + 1], b.n[i + 2]) || 1;
        nor.push(b.n[i] / l, b.n[i + 1] / l, b.n[i + 2] / l);
        col.push(color.r, color.g, color.b);
      }
      index.push(v);
    }
    groups.push({ start, count: index.length - start, materialIndex, key });
  });

  const g = new THREE.BufferGeometry();
  g.setIndex(index);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  if (withColors) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  for (const gr of groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
  g.userData.colorKeys = COLOR_KEYS.slice();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/* ---------------------------------------------------------------- materials */

// Ombrage toon intégré (lumière fixe en haut à gauche de l'écran, 3 tons),
// basé sur MeshBasicMaterial : brouillard, instancing et clipping restent gérés.
function createFixedToonMaterial() {
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  material.name = 'CreditToon';
  const uniforms = {
    uCreditLight: { value: new THREE.Vector3(-0.3, 0.6, 0.75).normalize() },  // espace vue (haut-gauche)
    uCreditTones: { value: new THREE.Vector3(0.32, 0.64, 1.0) },            // ombre, mi-ton, lumière
    uCreditSteps: { value: new THREE.Vector2(0.1, -0.28) },                 // seuils lumière / ombre
  };
  material.userData.toon = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCreditNormal;')
      .replace('#include <begin_vertex>', [
        '#include <begin_vertex>',
        'vec3 creditN = normal;',
        '#ifdef USE_INSTANCING',
        '  creditN = mat3( instanceMatrix ) * creditN;',
        '#endif',
        'vCreditNormal = normalize( normalMatrix * creditN );',
      ].join('\n'));
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', [
        '#include <common>',
        'varying vec3 vCreditNormal;',
        'uniform vec3 uCreditLight;',
        'uniform vec3 uCreditTones;',
        'uniform vec2 uCreditSteps;',
      ].join('\n'))
      .replace('#include <color_fragment>', [
        '#include <color_fragment>',
        '{',
        '  float d = dot( normalize( vCreditNormal ), uCreditLight );',
        '  float fw = max( fwidth( d ), 1e-4 );',
        '  float toMid = smoothstep( uCreditSteps.y - fw, uCreditSteps.y + fw, d );',
        '  float toLit = smoothstep( uCreditSteps.x - fw, uCreditSteps.x + fw, d );',
        '  diffuseColor.rgb *= mix( mix( uCreditTones.x, uCreditTones.y, toMid ), uCreditTones.z, toLit );',
        '}',
      ].join('\n'));
  };
  material.customProgramCacheKey = () => 'credit-fixed-toon-1';
  return material;
}

function createSceneToonMaterial() {
  const ramp = new THREE.DataTexture(new Uint8Array([90, 160, 255]), 3, 1, THREE.RedFormat);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.generateMipmaps = false;
  ramp.needsUpdate = true;
  const material = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp });
  material.name = 'CreditToonLit';
  return material;
}

/* -------------------------------------------------------------------- cache */

const geometryCache = new Map();
const materialCache = new Map();

/**
 * Géométries et matériaux partagés (utile pour un InstancedMesh).
 * bodyGeometry contient un groupe par couleur (userData.colorKeys) et des couleurs de sommets.
 */
export function getCreditAssets(options = {}) {
  const o = { ...DEFAULTS, ...options };
  const detail = DETAIL[o.detail] || DETAIL.medium;

  const gKey = `${o.detail}|${o.stripes}|${o.outlineWidth}`;
  if (!geometryCache.has(gKey)) geometryCache.set(gKey, buildCreditGeometries(detail, o.stripes, o.outlineWidth));
  const geo = geometryCache.get(gKey);

  const mKey = `${o.lighting}|${o.outlineColor}`;
  if (!materialCache.has(mKey)) {
    const outlineMaterial = new THREE.MeshBasicMaterial({ color: o.outlineColor, side: THREE.BackSide, toneMapped: false });
    outlineMaterial.name = 'CreditOutline';
    materialCache.set(mKey, {
      body: o.lighting === 'scene' ? createSceneToonMaterial() : createFixedToonMaterial(),
      outline: outlineMaterial,
    });
  }
  const mat = materialCache.get(mKey);

  return { bodyGeometry: geo.body, outlineGeometry: geo.hull, bodyMaterial: mat.body, outlineMaterial: mat.outline };
}

/** Crée une pièce de crédit (THREE.Group), debout, face avant tournée vers +Z, centrée sur l'origine. */
export function createCredit(options = {}) {
  const o = { ...DEFAULTS, ...options };
  const { bodyGeometry, outlineGeometry, bodyMaterial, outlineMaterial } = getCreditAssets(o);
  const radius = o.size / 2;

  const root = new THREE.Group();
  root.name = 'Credit';
  const pivot = new THREE.Group();
  pivot.name = 'CreditPivot';
  root.add(pivot);

  const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
  body.name = 'CreditBody';
  body.scale.setScalar(radius);
  pivot.add(body);

  if (o.outline) {
    const outline = new THREE.Mesh(outlineGeometry, outlineMaterial);
    outline.name = 'CreditOutline';
    outline.scale.setScalar(radius);
    pivot.add(outline);
  }

  root.userData.credit = {
    pivot,
    phase: o.phase ?? Math.random() * 10,
    spinSpeed: o.spinSpeed,
    bobHeight: o.bobHeight * o.size,
    bobSpeed: o.bobSpeed,
  };
  return root;
}

/** Rotation + flottement. `time` en secondes (ex. clock.getElapsedTime()). */
export function animateCredit(credit, time) {
  const s = credit.userData.credit;
  if (!s) return;
  const t = time + s.phase;
  s.pivot.rotation.y = t * s.spinSpeed;
  s.pivot.position.y = Math.sin(t * s.bobSpeed) * s.bobHeight;
}

/** Libère les géométries/matériaux partagés (quand plus aucune pièce n'est utilisée). */
export function disposeCreditAssets() {
  for (const g of geometryCache.values()) { g.body.dispose(); g.hull.dispose(); }
  for (const m of materialCache.values()) {
    m.body.gradientMap?.dispose();
    m.body.dispose();
    m.outline.dispose();
  }
  geometryCache.clear();
  materialCache.clear();
}
