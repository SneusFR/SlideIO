import * as THREE from "three";
/**
 * Water FAMAS â€” gameplay REFERENCE (the numbers the presentation was authored for).
 *
 * One trigger pull = a FAMAS-style BURST of 3 water jets (0 / 0.075 / 0.15 s). The tank holds 9 jets = 3 bursts.
 * Every jet is HITSCAN: one instant raycast from the camera at the jet's emission time (so a burst dragged across
 * a target can hit three different points); the jet you see flying is purely visual (WaterJets).
 *
 * DAMAGE â€” proposal, not fixed by the designer yet: 16 body, x1.5 head (24). With 100 HP: 2 full bursts on the
 * body (96) do NOT kill, 2 bursts with one head jet do â†’ accuracy matters, a full tank (9 jets) = 1 kill + change.
 * Tune DAMAGE_BODY freely: nothing in the animations depends on it.
 */
export const CAPACITY = 9; // jets in a full tank
export const JETS_PER_BURST = 3;
export const JET_TIMES = [0, 0.075, 0.15]; // s from the trigger pull (authored in FP_Fire / TP_Fire)
export const BURST_INTERVAL = 0.45; // s between two trigger pulls (the burst clip lasts 0.42 s)
export const MAX_RANGE = 28; // m â€” a water jet, not a rifle
export const DAMAGE_BODY = 16; // PROPOSAL (see above)
export const HEADSHOT_MULTIPLIER = 1.5; // -> 24 to the head
/** Damage of one jet (hitscan, applied by the SERVER at the jet time). No falloff within MAX_RANGE. */
export function jetDamage(headshot: boolean): number {
    return headshot ? DAMAGE_BODY * HEADSHOT_MULTIPLIER : DAMAGE_BODY;
}
/** Spread cone (deg) of jet k of a burst: tight first jet, the burst opens a little (recoil of the pump). */
export const SPREAD_DEG = [0.35, 0.8, 1.25];
export const ADS_SPREAD_SCALE = 0.55;
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
 * Direction of jet `k` (0..2) of a burst: uniform in its cone around the camera forward (world axes).
 * Same seed -> same direction on the server and every client.
 */
export function jetDirection(forward: THREE.Vector3, up: THREE.Vector3, k: number, aiming: boolean, seed: number, out: THREE.Vector3): THREE.Vector3 {
    const rnd = mulberry32(seed);
    const spread = SPREAD_DEG[Math.min(k, SPREAD_DEG.length - 1)] * (aiming ? ADS_SPREAD_SCALE : 1);
    _r.crossVectors(forward, up).normalize();
    _u.crossVectors(_r, forward).normalize();
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * THREE.MathUtils.degToRad(spread);
    return out.copy(forward).addScaledVector(_r, Math.cos(a) * Math.tan(r)).addScaledVector(_u, Math.sin(a) * Math.tan(r)).normalize();
}
