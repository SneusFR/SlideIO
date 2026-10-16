// v3 : neige qui tombe sur Givre (three.js r155+). Code de reference, a adapter au projet.
// Un seul THREE.Points (un appel de rendu), tout le calcul est dans le vertex shader :
//  - flocons fixes dans le monde : position = graine x boite + (vent, -chute) x t x k + balancement ;
//  - la boite (60 x 25 x 60 m) suit la camera : chaque flocon est replie dedans (modulo), il n'y a jamais de
//    flocon a faire naitre ou mourir cote CPU ;
//  - caches sous les toits grace a la carte des hauteurs assets/givre_neige_toits.png (il ne neige ni dans les
//    salles, ni sous la halle, ni sous la galerie), et a moins de 0,9 m de la camera.
// Meme calcul que l'apercu Blender (objet APERCU_Neige). Aucune collision, aucun cout physique.
// Passer le temps ecoule depuis le chargement de la map (pas une date absolue : precision des flottants du GPU).
import * as THREE from 'three';
import type { GivrePhysics } from './givrePhysics.types';

const SNOW_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aSeed;      // graine 0..1 (x, y, z)
attribute vec3 aVar;       // (phase 0..2pi, facteur de vitesse 0.8..1.2, facteur de taille 0.6..1.4)
uniform float uTime;
uniform vec3 uBox;         // boxSize (x, y, z)
uniform float uYMin;
uniform vec3 uVel;         // (vent x, -chute, vent z) en m/s
uniform float uSwayAmp;
uniform float uSwayW;      // 2 pi x frequence
uniform float uFlake;      // diametre moyen (m)
uniform float uMinDist;
uniform vec3 uCam;         // position monde de la camera
uniform sampler2D uMask;   // hauteur des toits (r x 25.5 m)
uniform float uViewportHeight;
varying float vAlpha;
void main() {
  float t = uTime;
  vec3 p = aSeed * uBox + vec3(0.0, uYMin, 0.0) + uVel * (t * aVar.y);
  float wt = t * uSwayW;
  p.x += sin(wt + aVar.x) * uSwayAmp;
  p.z -= cos(wt * 0.8 + aVar.x * 1.7) * uSwayAmp;
  // repli dans la boite autour de la camera (XZ) et entre uYMin et uYMin + uBox.y (Y monde)
  vec3 lo = vec3(uCam.x - 0.5 * uBox.x, uYMin, uCam.z - 0.5 * uBox.z);
  p = lo + mod(p - lo, uBox);
  // carte des toits : u = (x + 140) / 280, v = (80 - z) / 220 (texture chargee avec flipY = true)
  vec2 muv = vec2((p.x + 140.0) / 280.0, (80.0 - p.z) / 220.0);
  float roof = texture2D(uMask, muv).r * 25.5;
  bool hidden = p.y < roof || distance(p, uCam) < uMinDist;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float px = uFlake * aVar.z * projectionMatrix[1][1] * 0.5 * uViewportHeight / max(-mv.z, 0.01);
  gl_PointSize = hidden ? 0.0 : clamp(px, 1.0, 24.0);
  vAlpha = hidden ? 0.0 : 0.9 * clamp(px, 0.0, 1.0);   // flocons lointains plus transparents (pas de scintillement)
  if (hidden) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // hors champ
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

export type GivreSnowLevel = 'off' | 'legere' | 'normale' | 'dense';

export interface GivreSnow {
  points: THREE.Points;
  /** Change la densite (option graphique). 'off' cache la neige. */
  setLevel(level: GivreSnowLevel): void;
  /** A chaque image : temps ecoule en secondes, camera du joueur, hauteur du canvas en pixels. */
  update(elapsedSeconds: number, camera: THREE.Camera, viewportHeightPx: number): void;
  dispose(): void;
}

/** Petit generateur pseudo-aleatoire deterministe (memes flocons a chaque chargement). */
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

/**
 * Cree la neige. `mask` = assets/givre_neige_toits.png charge avec TextureLoader (flipY par defaut = true) ;
 * la fonction regle elle-meme le filtrage (plus proche voisin, sans mipmap).
 */
export function createGivreSnow(phys: GivrePhysics, mask: THREE.Texture, level: GivreSnowLevel = 'normale'): GivreSnow {
  const cfg = phys.snow;
  if (!cfg) throw new Error('Givre : section snow absente du JSON');
  mask.magFilter = THREE.NearestFilter;
  mask.minFilter = THREE.NearestFilter;
  mask.generateMipmaps = false;
  mask.wrapS = THREE.ClampToEdgeWrapping;
  mask.wrapT = THREE.ClampToEdgeWrapping;
  mask.colorSpace = THREE.NoColorSpace; // donnees (hauteurs), pas une couleur
  mask.needsUpdate = true;

  const [bx, by, bz] = cfg.boxSize;
  const maxLevel = Math.max(...Object.values(cfg.levels));
  const maxCount = Math.round(cfg.density * bx * by * bz * maxLevel);
  const rnd = mulberry32(20261011);
  const seeds = new Float32Array(maxCount * 3);
  const vars = new Float32Array(maxCount * 3);
  for (let i = 0; i < maxCount; i++) {
    seeds[i * 3] = rnd();
    seeds[i * 3 + 1] = rnd();
    seeds[i * 3 + 2] = rnd();
    vars[i * 3] = rnd() * Math.PI * 2; // phase du balancement
    vars[i * 3 + 1] = 0.8 + 0.4 * rnd(); // vitesse
    vars[i * 3 + 2] = 0.6 + 0.8 * rnd(); // taille
  }
  const geom = new THREE.BufferGeometry();
  // `position` est exigee par three.js : valeurs ignorees par le shader (la vraie position est calculee)
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxCount * 3), 3));
  geom.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
  geom.setAttribute('aVar', new THREE.BufferAttribute(vars, 3));
  geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6); // jamais elimine par le frustum

  const material = new THREE.ShaderMaterial({
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
  const points = new THREE.Points(geom, material);
  points.name = 'givre_neige';
  points.frustumCulled = false;
  points.renderOrder = 20;
  points.userData.noOutline = true;

  const setLevel = (lv: GivreSnowLevel) => {
    if (lv === 'off') {
      points.visible = false;
      return;
    }
    points.visible = true;
    const k = cfg.levels[lv] ?? 1;
    geom.setDrawRange(0, Math.min(maxCount, Math.round(cfg.density * bx * by * bz * k)));
  };
  setLevel(level);

  const camPos = new THREE.Vector3();
  return {
    points,
    setLevel,
    update(elapsedSeconds: number, camera: THREE.Camera, viewportHeightPx: number) {
      camera.getWorldPosition(camPos);
      material.uniforms.uTime.value = elapsedSeconds;
      (material.uniforms.uCam.value as THREE.Vector3).copy(camPos);
      material.uniforms.uViewportHeight.value = viewportHeightPx;
    },
    dispose() {
      points.removeFromParent();
      geom.dispose();
      material.dispose();
    },
  };
}
