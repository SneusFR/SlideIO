import * as THREE from "three";
import { optSwitch } from "../ui/perfDiag";

/**
 * PERF — the KILL FRAME, prepared ahead (`?diag=nokillprep` turns it off).
 *
 * A bot's corpse is drawn for the first time in the frame that already pays
 * the kill (ragdoll, particles, HUD feedback, audio). That first draw used to
 * do three.js's first-use work for objects the scene had never drawn:
 *  - the BONE TEXTURES of the corpse's own skeletons (2 to 4 per corpse:
 *    Float32Array + DataTexture, then createTexture + texStorage2D + upload);
 *  - each NEW fade clone of a material (CorpseManager: the first corpse of
 *    each bot, and every corpse of a painted bot — the paint material's
 *    clones are evicted with their corpse): `material.clone()`, then three's
 *    material init (uniforms cloned, program looked up, lights wired).
 * Both are now done on an ordinary frame of the bot's life, one bot per frame
 * (runKillPrep, at the end of Game.frame), on the very objects the kill will
 * use: the corpse clone prepared ahead (CorpseCloneSpare) gets its bone
 * textures, and CorpseManager keeps one INITIALIZED fade clone ready per
 * material that has none in its pool (CorpseManager.prewarm).
 *
 * Same image, same game:
 *  - a bone texture holds the bone matrices that skeleton.update() writes in
 *    full every frame the corpse is drawn: created early, it is re-uploaded
 *    whole at the corpse's first draw (three's ordinary per-frame update) —
 *    the content is the one the first-draw path uploads;
 *  - a ready fade clone is refreshed at the kill with `copy(source)` and the
 *    fade flags, exactly what `source.clone()` and the same flags give at
 *    that moment (same values, same type); three re-derives its program at
 *    its first draw like for a new clone (compile() leaves the material's
 *    version unchecked), so a source changed since is handled the same way.
 *    Only its ids differ — the corpses' transparent sort never uses them.
 * What stays in the kill frame: three's program check of those clones at
 * their first draw (parameters + cache key, then the program found), the
 * vertex array object of a geometry never drawn with the fade program (no
 * draw ahead: no extra draw in play), the bone uploads every frame does.
 */
export const killPrep = optSwitch("killprep");

/** What the prep needs from the renderer (set once by Game). */
export interface KillPrepGpu {
  readonly renderer: THREE.WebGLRenderer;
  /** The world scene: its lights, fog and environment select the programs. */
  readonly scene: THREE.Scene;
  /** The world camera (light layers). */
  readonly camera: THREE.Camera;
  /**
   * The target the world pass draws into: three compiles a different program
   * variant for the canvas (sRGB + tone mapping) than for a linear target
   * (see Game.precompileScenes).
   */
  target(): THREE.WebGLRenderTarget | null;
}

/** One bot's GPU prep (Bot). */
export interface KillPrepJob {
  runKillPrep(gpu: KillPrepGpu): void;
}

let gpu: KillPrepGpu | null = null;
/** Frames ended so far (runKillPrep calls). */
let frame = 0;
/** FIFO without duplicates (insertion order): job → frame of its request. */
const pending = new Map<KillPrepJob, number>();

export function setKillPrepGpu(next: KillPrepGpu | null): void {
  gpu = next;
  if (!next) pending.clear();
}

/**
 * Schedules `job` for the end of a COMING frame — never the frame that asks
 * (a paint hit asks: that frame already pays the hit). Nothing when the
 * prep is off.
 */
export function requestKillPrep(job: KillPrepJob): void {
  if (killPrep.on && gpu && !pending.has(job)) pending.set(job, frame);
}

export function cancelKillPrep(job: KillPrepJob): void {
  pending.delete(job);
}

/**
 * End of Game.frame, right after the frame's render (the lights three
 * selects programs with are then the ones that frame drew with — a
 * compile must never see another light count: every lit material would
 * re-select its program). ONE job per frame, asked in an earlier frame.
 * Free when nothing is pending.
 */
export function runKillPrep(): void {
  const now = frame++;
  if (pending.size === 0) return;
  if (!killPrep.on || !gpu) {
    pending.clear();
    return;
  }
  for (const [job, asked] of pending) {
    if (asked >= now) return; // (later entries are not older)
    pending.delete(job);
    job.runKillPrep(gpu);
    return;
  }
}

/** Bone texture of `skeleton` created + uploaded now (three does it at the first draw otherwise). */
export function prepareBoneTexture(skeleton: THREE.Skeleton, renderer: THREE.WebGLRenderer): boolean {
  if (skeleton.boneTexture !== null) return false;
  skeleton.computeBoneTexture();
  renderer.initTexture(skeleton.boneTexture!);
  return true;
}

/**
 * `renderer.compile(root, …)` with the world pass's target bound, the way
 * Game.precompileScenes compiles the scene (same program variants as the
 * real frames). Program selection only: no draw.
 */
export function compileLikeWorldPass(root: THREE.Object3D, gpu: KillPrepGpu): void {
  const renderer = gpu.renderer;
  const previous = renderer.getRenderTarget();
  const target = gpu.target();
  if (target !== previous) renderer.setRenderTarget(target);
  try {
    renderer.compile(root, gpu.camera, gpu.scene);
  } finally {
    if (target !== previous) renderer.setRenderTarget(previous);
  }
}
