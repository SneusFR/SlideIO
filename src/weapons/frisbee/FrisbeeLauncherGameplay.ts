import * as THREE from "three";
import { FRISBEE_TUNING } from "./FrisbeeProjectiles";
/**
 * FRISBEE LAUNCHER — gameplay reference (share it with the server).
 *
 * Crossbow that throws flying discs. One disc on the deck + a cage of 5 under the gun. Each trigger pull throws the
 * loaded disc (a real PROJECTILE: FrisbeeProjectiles / FrisbeeSim), then the character re-cocks by himself: pulls the
 * sled back (the elastic cords stretch), takes the next disc from the cage and lays it on the deck. When the cage is
 * empty the last shot leaves the launcher empty: reload = a full cage (5) + re-cock.
 *   ammo = (disc on the deck ? 1 : 0) + discs in the cage   (max 6)
 */
export const FRISBEE_LAUNCHER = {
    cageCapacity: 5,
    /** Deck + cage. */
    capacity: 6,
    /** Launch speed, lift, bounces, damage… (FrisbeeProjectiles.FRISBEE_TUNING). */
    tuning: FRISBEE_TUNING,
    /** PROPOSAL (to validate): 45 body, x1.5 head (68), x0.6 after a wall bounce (27 / 41). */
    damageBody: FRISBEE_TUNING.damageBody,
    headshotMultiplier: FRISBEE_TUNING.headshotMultiplier,
    /** Aim spread (deg): the disc is accurate. */
    spreadHipDeg: 0.6,
    spreadAimDeg: 0.15,
};
/** Deterministic PRNG (same seed on server / clients). */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** Shot direction from the camera forward / up, with the (tiny) seeded spread. */
export function discDirection(forward: THREE.Vector3, up: THREE.Vector3, aiming: boolean, seed: number, out: THREE.Vector3): THREE.Vector3 {
    const rnd = mulberry32(seed);
    const s = THREE.MathUtils.degToRad(aiming ? FRISBEE_LAUNCHER.spreadAimDeg : FRISBEE_LAUNCHER.spreadHipDeg);
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * s;
    const right = new THREE.Vector3().crossVectors(forward, up).normalize();
    const u = new THREE.Vector3().crossVectors(right, forward).normalize();
    out.copy(forward).normalize()
        .addScaledVector(right, Math.cos(a) * Math.tan(r))
        .addScaledVector(u, Math.sin(a) * Math.tan(r))
        .normalize();
    return out;
}
