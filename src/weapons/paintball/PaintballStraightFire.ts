import * as THREE from "three";
import { loadFPPoseClips } from "../viewmodel/FPArmsRig";
import { rebaseOnPose, STRAIGHT_FIRE_SUFFIX } from "../popcorn/PopcornStraightFire";

/**
 * STRAIGHT FIRE for the Paintball Rifle (same technique as the Popcorn
 * Shotgun): the authored FP_Fire loop starts from the HOLD pose (gun off
 * the aim axis) — while firing, the gun must be STRAIGHT like in ADS (and
 * like the TP avatars, always aiming):
 *   - `FP_Fire_PaintballRifle_Straight`: the 0.1 s kick loop re-based on the
 *     AIM pose — every recoil delta kept 1:1, only the base pose changes;
 *   - `FP_FireEnd_PaintballRifle_Straight`: the settle clip re-based on the
 *     AIM pose at its start, fading back to the authored clip at its end —
 *     the gun lowers smoothly from the aim line to the Hold pose.
 * The derived clips are appended to the cached FP pose library ONCE (the
 * ViewmodelSystem resolves action clips by name from that cache) — no shared
 * file and no GLB modified.
 */
const prepared = new Map<string, Promise<void>>();

export function preparePaintballStraightFire(
  fpPosesUrl: string,
  aimClip: string,
  fireClip: string,
  fireEndClip: string,
): Promise<void> {
  const key = `${fpPosesUrl}|${aimClip}|${fireClip}|${fireEndClip}`;
  let done = prepared.get(key);
  if (done) return done;
  done = loadFPPoseClips(fpPosesUrl).then((clips) => {
    const aim = clips.find((c) => c.name === aimClip);
    const fire = clips.find((c) => c.name === fireClip);
    const fireEnd = clips.find((c) => c.name === fireEndClip);
    if (!aim || !fire || !fireEnd) throw new Error("Paintball straight fire: source clip missing");
    const fireName = fireClip + STRAIGHT_FIRE_SUFFIX;
    const endName = fireEndClip + STRAIGHT_FIRE_SUFFIX;
    if (!clips.some((c) => c.name === fireName)) clips.push(rebaseOnPose(fire, aim, fireName));
    if (!clips.some((c) => c.name === endName)) clips.push(rebaseOnPoseFading(fireEnd, aim, endName));
  });
  prepared.set(key, done);
  return done;
}

/**
 * Re-base `src` on the first frame of `pose` with a weight going 1 → 0 over
 * the clip (smoothstep): starts exactly on the re-based pose, ends exactly
 * on the authored last frame (the Hold pose).
 */
export function rebaseOnPoseFading(src: THREE.AnimationClip, pose: THREE.AnimationClip, name: string): THREE.AnimationClip {
  const f0 = new THREE.Quaternion();
  const a0 = new THREE.Quaternion();
  const d = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  const id = new THREE.Quaternion();
  const dur = Math.max(1e-4, src.duration);
  const weight = (t: number) => {
    const x = Math.min(1, Math.max(0, t / dur));
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
