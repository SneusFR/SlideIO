import * as THREE from "three";

/**
 * Dispersion + dégâts du Popcorn Shotgun (point de départ, à régler).
 * Pattern : 12 plombs = 1 au centre + 5 sur un anneau à 1,6° + 6 sur un anneau à 3,4°,
 * rotation aléatoire du motif à chaque tir + petit bruit par plomb. Tout vient d'une graine
 * (seed) : serveur et clients recalculent exactement les mêmes directions.
 */
export const PELLETS = 12;
const RINGS = [
  { n: 1, deg: 0, phaseDeg: 0 },
  { n: 5, deg: 1.6, phaseDeg: 0 },
  { n: 6, deg: 3.4, phaseDeg: 30 },
] as const;
const JITTER_DEG = 0.25;   // écart-type du bruit par plomb
export const MAX_RANGE = 40; // m : au-delà, le plomb ne touche plus rien

/** PRNG déterministe (mulberry32) : même seed → mêmes plombs partout. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _r = new THREE.Vector3();
const _u = new THREE.Vector3();

/**
 * forward / up : axes MONDE de la caméra de jeu (up = axe Y de la caméra, pas le Y du monde).
 * out : tableau de PELLETS vecteurs réutilisés (aucune allocation).
 */
export function pelletDirections(forward: THREE.Vector3, up: THREE.Vector3, seed: number, out: THREE.Vector3[]): THREE.Vector3[] {
  const rnd = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  _r.crossVectors(forward, up).normalize();
  _u.crossVectors(_r, forward).normalize();
  const spin = rnd() * 360;
  let k = 0;
  for (const ring of RINGS) {
    for (let i = 0; i < ring.n; i++) {
      const a = THREE.MathUtils.degToRad(spin + ring.phaseDeg + (360 / ring.n) * i);
      const x = THREE.MathUtils.degToRad(ring.deg * Math.cos(a) + JITTER_DEG * gauss());
      const y = THREE.MathUtils.degToRad(ring.deg * Math.sin(a) + JITTER_DEG * gauss());
      out[k++].copy(forward).addScaledVector(_r, Math.tan(x)).addScaledVector(_u, Math.tan(y)).normalize();
    }
  }
  return out;
}

/** Part des PV max retirée par UN plomb à pleine puissance : 8 plombs pleins = mort. */
export const PELLET_DAMAGE_FRACTION = 1 / 8;
/** Règle imposée : toucher la tête = one shot. */
export const HEADSHOT_ONE_SHOT = true;

/** Atténuation avec la distance : 100 % jusqu'à 8 m, 50 % à 18 m, 25 % à 28 m et au-delà. */
export function pelletFalloff(distance: number): number {
  if (distance <= 8) return 1;
  if (distance <= 18) return 1 - 0.5 * (distance - 8) / 10;
  if (distance <= 28) return 0.5 - 0.25 * (distance - 18) / 10;
  return 0.25;
}

export interface PelletHit { distance: number; zone: "head" | "body" }

/** Dégâts d'UN tir sur UNE cible : on additionne tous ses plombs, puis on applique une seule fois. */
export function shotDamage(hits: readonly PelletHit[], maxHp: number, currentHp: number): number {
  let dmg = 0;
  let head = false;
  for (const h of hits) {
    dmg += maxHp * PELLET_DAMAGE_FRACTION * pelletFalloff(h.distance);
    if (h.zone === "head") head = true;
  }
  if (head && HEADSHOT_ONE_SHOT) dmg = Math.max(dmg, currentHp);
  return dmg;
}
