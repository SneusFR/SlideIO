import * as THREE from "three";

/**
 * Paintball Rifle — gameplay REFERENCE: automatic HITSCAN fire, one ball = one instant raycast (from the camera).
 * Damage (fixed by the designer): 12 to the body, x1.5 to the head (18), no distance falloff, 45 m range.
 * Spread = a small cone that blooms while the trigger stays held (like an AK), recovers when released.
 * Everything comes from a seed so the server and every client compute the same ball directions.
 */
export const FIRE_INTERVAL = 0.1;          // s (600 rpm) — the authored FP / TP fire loop period
export const MAX_RANGE = 45;               // m
export const CAPACITY = 32;                // balls per hopper
export const DAMAGE_BODY = 12;
export const HEADSHOT_MULTIPLIER = 1.5;    // -> 18 to the head

/** Damage of one ball (hitscan, applied by the SERVER at the shot time — the flying ball is only visual). */
export function paintballDamage(headshot: boolean): number {
  return headshot ? DAMAGE_BODY * HEADSHOT_MULTIPLIER : DAMAGE_BODY;
}
export const SPREAD_MIN_DEG = 0.35;        // first shot (and ADS)
export const SPREAD_MAX_DEG = 2.2;         // after ~8 shots of sustained fire
export const BLOOM_PER_SHOT_DEG = 0.25;
export const BLOOM_RECOVERY_DEG_PER_S = 4.0;

export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bloom state of one shooter. */
export class PaintballBloom {
  spreadDeg = SPREAD_MIN_DEG;
  /** Call once per shot (after computing its direction). */
  onShot(): void { this.spreadDeg = Math.min(SPREAD_MAX_DEG, this.spreadDeg + BLOOM_PER_SHOT_DEG); }
  /** Call every frame. */
  update(dt: number, aiming: boolean): void {
    const floor = aiming ? SPREAD_MIN_DEG * 0.6 : SPREAD_MIN_DEG;
    this.spreadDeg = Math.max(floor, this.spreadDeg - BLOOM_RECOVERY_DEG_PER_S * dt);
  }
}

const _r = new THREE.Vector3();
const _u = new THREE.Vector3();

/** Direction of one ball: uniform in a cone of `spreadDeg` around the camera forward (world axes). */
export function ballDirection(forward: THREE.Vector3, up: THREE.Vector3, spreadDeg: number, seed: number, out: THREE.Vector3): THREE.Vector3 {
  const rnd = mulberry32(seed);
  _r.crossVectors(forward, up).normalize();
  _u.crossVectors(_r, forward).normalize();
  const a = rnd() * Math.PI * 2;
  const r = Math.sqrt(rnd()) * THREE.MathUtils.degToRad(spreadDeg);
  return out.copy(forward).addScaledVector(_r, Math.cos(a) * Math.tan(r)).addScaledVector(_u, Math.sin(a) * Math.tan(r)).normalize();
}
