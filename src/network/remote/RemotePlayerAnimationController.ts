import * as THREE from "three";
import { NetworkMovementState } from "../NetworkMovementState";
import { RemoteInterpolationConfig as cfg } from "../interpolation/RemoteInterpolationConfig";

/**
 * Shared animation clips for the remote character. Loaded/derived ONCE
 * (see RemotePlayerManager) and reused by every per-player mixer:
 *
 *   Character asset loaded once → clips cached → mixer per RemotePlayer.
 *
 * Real clips available in the project assets (inspected):
 *   "Armature|Alert|baselayer"   → used as IDLE (already the project idle)
 *   "Armature|running|baselayer" → RUNNING
 * There is no dedicated jump/slide clip, so AIRBORNE/SLIDING use frozen
 * run-poses + light procedural bone adjustments (never scale hacks).
 */
export interface RemoteCharacterClips {
  idle: THREE.AnimationClip;
  run: THREE.AnimationClip;
  /** CLONE of `run` (separate action) frozen mid-stride for airborne. */
  airPose: THREE.AnimationClip;
  /** CLONE of `run` frozen with legs extended for the slide pose. */
  slidePose: THREE.AnimationClip;
}

/** Blend durations (seconds) — short: SlideIO is a fast FPS. */
const FADE = { idle: 0.18, run: 0.12, air: 0.1, slide: 0.08, dash: 0.08 };
/** Run-clip playback speed mapping from horizontal speed (m/s). */
const RUN_REF_SPEED = 9; // horizontal speed at which run plays at 1.0×
const RUN_SPEED_MIN = 0.75;
const RUN_SPEED_MAX = 1.6;
const DASH_TIMESCALE = 1.8;
/** Frozen pose times (fraction of the run clip). */
const AIR_POSE_FRAC = 0.25; // mid-stride, legs apart
const SLIDE_POSE_FRAC = 0.6;
/** Procedural lean/crouch targets. */
const SLIDE_ROOT_DROP = 0.55; // meters the visual model sinks while sliding
const SLIDE_TORSO_LEAN = 0.7; // radians backward-ish lean on the spine
const DASH_TORSO_LEAN = 0.25; // slight forward lean while dashing
const POSE_SMOOTHING = 12; // 1/s exponential smoothing for procedural pose

/**
 * Drives one remote character's THREE.AnimationMixer from the sampled
 * network movement state. PURELY VISUAL: consumes interpolation output,
 * never network packets (animation state ≠ network snapshot).
 *
 * All transitions use crossFadeTo() — no instant pops, no per-frame
 * action re-creation (actions are created once and reused).
 */
export class RemotePlayerAnimationController {
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions: Record<string, THREE.AnimationAction>;
  private current: THREE.AnimationAction;
  private currentState = NetworkMovementState.IDLE;

  // Bones for procedural pitch look + lean (found once, by name).
  private readonly spineBones: THREE.Bone[] = [];
  private smoothedPitch = 0;
  private smoothedLean = 0;
  private smoothedDrop = 0;

  constructor(
    private readonly model: THREE.Object3D,
    /** Model's rest local Y (feet offset) — drop is applied relative to it. */
    private readonly modelRestY: number,
    clips: RemoteCharacterClips,
  ) {
    this.mixer = new THREE.AnimationMixer(model);

    const make = (clip: THREE.AnimationClip): THREE.AnimationAction => {
      const a = this.mixer.clipAction(clip);
      a.setLoop(THREE.LoopRepeat, Infinity);
      a.enabled = true;
      return a;
    };
    const air = make(clips.airPose);
    air.play();
    air.paused = true;
    air.time = clips.airPose.duration * AIR_POSE_FRAC;
    air.stop();
    const slide = make(clips.slidePose);
    slide.play();
    slide.paused = true;
    slide.time = clips.slidePose.duration * SLIDE_POSE_FRAC;
    slide.stop();

    this.actions = { idle: make(clips.idle), run: make(clips.run), air, slide };
    this.current = this.actions.idle;
    this.current.play();

    // Cache the upper-body chain for the procedural pitch (root stays
    // upright — only spine/chest/neck/head bend, clamped).
    model.traverse((obj) => {
      const bone = obj as THREE.Bone;
      if (bone.isBone && /spine|chest|neck|head/i.test(bone.name)) {
        this.spineBones.push(bone);
      }
    });
  }

  /**
   * Per render frame. `pitch` is the interpolated network pitch (radians),
   * `horizontalSpeed` the estimated remote speed (m/s).
   */
  update(
    dt: number,
    state: NetworkMovementState,
    horizontalSpeed: number,
    verticalVelocity: number,
    pitch: number,
  ): void {
    if (state !== this.currentState) this.transitionTo(state);
    this.currentState = state;

    // Run/dash playback speed follows the actual movement speed (clamped —
    // legs never spin at 800%).
    if (this.current === this.actions.run) {
      const scale = THREE.MathUtils.clamp(
        horizontalSpeed / RUN_REF_SPEED,
        RUN_SPEED_MIN,
        RUN_SPEED_MAX,
      );
      this.current.timeScale = state === NetworkMovementState.DASHING ? DASH_TIMESCALE : scale;
    }

    this.mixer.update(dt);

    // ---- Procedural adjustments AFTER the mixer (it would otherwise
    // overwrite the bone rotations set here) ----
    const k = 1 - Math.exp(-POSE_SMOOTHING * dt);

    // Slide crouch: sink the visual root + lean the torso. NEVER scale.
    const targetDrop = state === NetworkMovementState.SLIDING ? SLIDE_ROOT_DROP : 0;
    this.smoothedDrop += (targetDrop - this.smoothedDrop) * k;
    this.model.position.y = this.modelRestY - this.smoothedDrop;

    let targetLean = 0;
    if (state === NetworkMovementState.SLIDING) targetLean = SLIDE_TORSO_LEAN;
    else if (state === NetworkMovementState.DASHING) targetLean = DASH_TORSO_LEAN;
    this.smoothedLean += (targetLean - this.smoothedLean) * k;

    // Falling hint: while airborne and clearly falling, tip the pose a bit.
    const fallLean =
      state === NetworkMovementState.AIRBORNE && verticalVelocity < -4 ? 0.12 : 0;

    // Remote pitch look: distribute the clamped pitch over the upper-body
    // chain so "looking up" reads without breaking the rig.
    const clamped = THREE.MathUtils.clamp(
      pitch,
      -cfg.remoteVisualPitchClamp,
      cfg.remoteVisualPitchClamp,
    );
    const pk = 1 - Math.exp(-cfg.remotePitchSmoothing * dt);
    this.smoothedPitch += (clamped - this.smoothedPitch) * pk;

    const n = this.spineBones.length;
    if (n > 0) {
      const perBonePitch = (this.smoothedPitch * cfg.remotePitchBoneSign) / n;
      const perBoneLean = (this.smoothedLean + fallLean) / n;
      for (const bone of this.spineBones) {
        bone.rotation.x += perBonePitch + perBoneLean;
      }
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
  }

  private transitionTo(state: NetworkMovementState): void {
    let next: THREE.AnimationAction;
    let fade: number;
    switch (state) {
      case NetworkMovementState.RUNNING:
        next = this.actions.run;
        fade = FADE.run;
        break;
      case NetworkMovementState.DASHING:
        next = this.actions.run; // accelerated run + lean = dash feedback
        fade = FADE.dash;
        break;
      case NetworkMovementState.AIRBORNE:
        next = this.actions.air; // frozen mid-stride: no "running on air"
        fade = FADE.air;
        break;
      case NetworkMovementState.SLIDING:
        next = this.actions.slide; // frozen pose + crouch/lean above
        fade = FADE.slide;
        break;
      default:
        next = this.actions.idle;
        fade = FADE.idle;
        break;
    }
    if (next === this.current) return;

    // Restart the incoming action then crossfade — supports rapid
    // slide-hop chains (SLIDE→AIR→RUN→SLIDE…) without T-poses or a stuck
    // mixer, because the outgoing action keeps playing during the fade.
    next.reset();
    if (next === this.actions.air || next === this.actions.slide) {
      // Frozen poses: park the action at its pose time.
      next.paused = true;
      next.time =
        next === this.actions.air
          ? next.getClip().duration * AIR_POSE_FRAC
          : next.getClip().duration * SLIDE_POSE_FRAC;
    }
    next.play();
    this.current.crossFadeTo(next, fade, false);
    this.current = next;
  }
}