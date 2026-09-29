import * as THREE from "three";
import { loadFPPoseClips } from "../viewmodel/FPArmsRig";
import { STRAIGHT_FIRE_SUFFIX } from "../popcorn/PopcornStraightFire";

/**
 * STRAIGHT FIRE for the Water FAMAS (same technique as the Paintball Rifle /
 * Popcorn Shotgun): the authored FP_Fire_WaterFamas starts from the HOLD pose
 * (gun off the aim axis) — while firing, the gun must be STRAIGHT like in ADS
 * (and like the TP avatars, always aiming):
 *   - `FP_Fire_WaterFamas_Straight`: the 0.42 s burst (3 kicks) re-based on
 *     the AIM pose — every recoil delta kept 1:1, only the base pose changes.
 *     The gun snaps onto the aim line (the controller fades the action in over
 *     30 ms), then, in the LAST 0.10 s only, blends back to the authored last
 *     frame (the Hold pose): the return is fast, no slow drift to the hip.
 * The derived clip is appended to the cached FP pose library ONCE (the
 * ViewmodelSystem resolves action clips by name from that cache) — no shared
 * file and no GLB modified.
 */
/** Seconds at the end of the burst over which the gun blends back to the Hold pose. */
const RETURN_TIME = 0.1;

const prepared = new Map<string, Promise<void>>();

export function prepareWaterFamasStraightFire(fpPosesUrl: string, aimClip: string, fireClip: string): Promise<void> {
  const key = `${fpPosesUrl}|${aimClip}|${fireClip}`;
  let done = prepared.get(key);
  if (done) return done;
  done = loadFPPoseClips(fpPosesUrl).then((clips) => {
    const aim = clips.find((c) => c.name === aimClip);
    const fire = clips.find((c) => c.name === fireClip);
    if (!aim || !fire) throw new Error("WaterFamas straight fire: source clip missing");
    const name = fireClip + STRAIGHT_FIRE_SUFFIX;
    if (!clips.some((c) => c.name === name)) clips.push(rebaseOnPoseReturning(fire, aim, name));
  });
  prepared.set(key, done);
  return done;
}

/**
 * Re-base `src` on the first frame of `pose` (rotation = Aim(0)·Src(0)⁻¹·Src(t),
 * translation = Aim(0) + Src(t) − Src(0)) with a weight 1 → 0 over the last
 * RETURN_TIME seconds (smoothstep): straight during the whole burst, ends
 * exactly on the authored last frame (the Hold pose).
 */
export function rebaseOnPoseReturning(src: THREE.AnimationClip, pose: THREE.AnimationClip, name: string): THREE.AnimationClip {
  const f0 = new THREE.Quaternion();
  const a0 = new THREE.Quaternion();
  const d = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  const id = new THREE.Quaternion();
  const dur = Math.max(1e-4, src.duration);
  const start = Math.max(0, dur - RETURN_TIME);
  const weight = (t: number) => {
    if (t <= start) return 1;
    const x = Math.min(1, (t - start) / Math.max(1e-4, dur - start));
    return 1 - x * x * (3 - 2 * x);
  };
  const tracks = src.tracks.map((track) => {
    const ref = pose.tracks.find((t) => t.name === track.name);
    const out = track.clone();
    if (!ref) return out;
    const n = track.getValueSize();
    if (n === 4) {
      f0.fromArray(track.values, 0).invert();
      a0.fromArray(ref.values, 0).multiply(f0); // Aim(0) · Src(0)⁻¹
      for (let i = 0; i < track.times.length; i++) {
        d.copy(id).slerp(a0, weight(track.times[i]));
        q.fromArray(track.values, i * 4).premultiply(d).normalize();
        q.toArray(out.values, i * 4);
      }
    } else {
      for (let i = 0; i < track.times.length; i++) {
        const w = weight(track.times[i]);
        for (let k = 0; k < n; k++) out.values[i * n + k] = track.values[i * n + k] + (ref.values[k] - track.values[k]) * w;
      }
    }
    return out;
  });
  return new THREE.AnimationClip(name, src.duration, tracks);
}
