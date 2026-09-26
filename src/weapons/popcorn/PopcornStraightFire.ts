import * as THREE from "three";
import { loadFPPoseClips } from "../viewmodel/FPArmsRig";

/**
 * STRAIGHT FIRE (SlideIO): the authored FP_Fire / FP_FireLast start from the
 * HOLD pose (weapon ~12° off the aim axis) while every remote player sees the
 * TP Fire clip with the gun pointing STRAIGHT at them. To stay coherent, the
 * FP shot is re-based on the AIM pose (the gun snaps straight in ~0.1 s, like
 * aiming, then recoils + pumps exactly as authored):
 *
 *   rotation(t)    = Aim(0) · Fire(0)⁻¹ · Fire(t)
 *   translation(t) = Aim(0) + Fire(t) − Fire(0)
 *
 * The motion DELTA of the authored clip is kept 1:1 (recoil, pump rack), only
 * its base pose changes. Measured on the real rig: muzzle 12° → ~1° off the
 * camera axis, left hand ↔ pump gap unchanged (same as the Aim pose).
 *
 * The derived clips are appended to the cached FP pose library ONCE (the
 * ViewmodelSystem resolves action clips by name from that same cache), so no
 * shared file (ViewmodelSystem / FPArmsRig / WeaponProfile) and no GLB is
 * modified.
 */
export const STRAIGHT_FIRE_SUFFIX = "_Straight";

const prepared = new Map<string, Promise<void>>();

/** Derive + register `<clip>_Straight` for each source clip (idempotent per URL). */
export function prepareStraightFireClips(fpPosesUrl: string, aimClip: string, sources: readonly string[]): Promise<void> {
  const key = `${fpPosesUrl}|${aimClip}|${sources.join(",")}`;
  let done = prepared.get(key);
  if (done) return done;
  done = loadFPPoseClips(fpPosesUrl).then((clips) => {
    const aim = clips.find((c) => c.name === aimClip);
    if (!aim) throw new Error(`Straight fire: aim clip missing (${aimClip})`);
    for (const name of sources) {
      const straightName = name + STRAIGHT_FIRE_SUFFIX;
      if (clips.some((c) => c.name === straightName)) continue;
      const src = clips.find((c) => c.name === name);
      if (!src) throw new Error(`Straight fire: source clip missing (${name})`);
      clips.push(rebaseOnPose(src, aim, straightName));
    }
  });
  prepared.set(key, done);
  return done;
}

/** Re-base every track of `src` from its first frame onto the first frame of `pose`. */
export function rebaseOnPose(src: THREE.AnimationClip, pose: THREE.AnimationClip, name: string): THREE.AnimationClip {
  const f0 = new THREE.Quaternion();
  const a0 = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  const tracks = src.tracks.map((track) => {
    const ref = pose.tracks.find((t) => t.name === track.name);
    const out = track.clone();
    if (!ref) return out;
    const n = track.getValueSize();
    if (n === 4) {
      f0.fromArray(track.values, 0).invert();
      a0.fromArray(ref.values, 0).multiply(f0); // Aim(0) · Fire(0)⁻¹
      for (let i = 0; i < track.times.length; i++) {
        q.fromArray(track.values, i * 4).premultiply(a0).normalize();
        q.toArray(out.values, i * 4);
      }
    } else {
      for (let i = 0; i < track.times.length; i++) {
        for (let k = 0; k < n; k++) out.values[i * n + k] = ref.values[k] + track.values[i * n + k] - track.values[k];
      }
    }
    return out;
  });
  return new THREE.AnimationClip(name, src.duration, tracks);
}
