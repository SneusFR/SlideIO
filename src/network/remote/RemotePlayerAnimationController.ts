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
 *   "Armature|Alert|baselayer"        → used as IDLE (the project idle)
 *   "Armature|running|baselayer"      → RUNNING (direction-aware, see below)
 *   "Armature|Regular_Jump|baselayer" → JUMP (root motion stripped — the
 *                                       network position provides the arc)
 * There is no dedicated slide clip, so SLIDING uses a frozen run-pose +
 * light procedural bone adjustments (never scale hacks).
 */
export interface RemoteCharacterClips {
  idle: THREE.AnimationClip;
  run: THREE.AnimationClip;
  /** Real jump clip (played ONCE per AIRBORNE entry, held while falling). */
  jump: THREE.AnimationClip;
  /** CLONE of `run` frozen with legs extended for the slide pose. */
  slidePose: THREE.AnimationClip;
}

/** Blend durations (seconds) — short: SlideIO is a fast FPS. */
const FADE = { idle: 0.18, run: 0.12, jump: 0.08, slide: 0.08, dash: 0.08 };
/** Run-clip playback speed mapping from horizontal speed (m/s). */
const RUN_REF_SPEED = 9; // horizontal speed at which run plays at 1.0×
const RUN_SPEED_MIN = 0.75;
const RUN_SPEED_MAX = 1.6;
const DASH_TIMESCALE = 1.8;
/** Frozen pose time (fraction of the run clip). */
const SLIDE_POSE_FRAC = 0.6;
/**
 * JUMP clip windows (fractions of the ~1.9 s Regular_Jump clip):
 *  - START skips the grounded crouch anticipation (the player is already
 *    in the air when the AIRBORNE state arrives);
 *  - HOLD freezes the falling pose before the landing-recovery frames so
 *    a long fall never plays "landing" in mid-air. The hold is released
 *    by the next state transition (ground / dash / slide…), which
 *    crossfades the jump out — it NEVER keeps playing after landing.
 */
const JUMP_START_FRAC = 0.18;
const JUMP_HOLD_FRAC = 0.6;
const JUMP_TIMESCALE = 1.0;
/** Procedural lean/crouch targets. */
const SLIDE_ROOT_DROP = 0.55; // meters the visual model sinks while sliding
const SLIDE_TORSO_LEAN = 0.7; // radians backward-ish lean on the spine
const DASH_TORSO_LEAN = 0.25; // slight forward lean while dashing
const POSE_SMOOTHING = 12; // 1/s exponential smoothing for procedural pose

// ---- Direction-aware locomotion (strafe / backpedal) ----
/** Below this horizontal speed the movement direction is meaningless. */
const MOVE_DIR_MIN_SPEED = 0.75;
/** Legs may turn at most this far away from the aim yaw (radians). */
const MAX_LEG_YAW = Math.PI / 2;
/** Hysteresis for the backpedal detection (radians from "forward"). */
const BACKPEDAL_ENTER = THREE.MathUtils.degToRad(105);
const BACKPEDAL_EXIT = THREE.MathUtils.degToRad(75);
/** 1/s exponential smoothing of the leg-yaw (no snapping legs). */
const LEG_YAW_SMOOTHING = 10;

/**
 * Drives one remote character's THREE.AnimationMixer from the sampled
 * network movement state. PURELY VISUAL: consumes interpolation output,
 * never network packets (animation state ≠ network snapshot).
 *
 * All transitions use crossFadeTo() — no instant pops, no per-frame
 * action re-creation (actions are created once and reused).
 *
 * DIRECTION-AWARE RUN: the run clip only exists for "forward", so the
 * LEGS (whole model root) rotate toward the actual movement direction
 * (clamped to ±90°) while the spine chain counter-twists so the torso
 * keeps facing the aim yaw. Backpedaling plays the run clip REVERSED
 * with the legs still facing forward — no more "sprinting forward while
 * strafing sideways".
 */
export class RemotePlayerAnimationController {
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions: Record<string, THREE.AnimationAction>;
  private current: THREE.AnimationAction;
  private currentState = NetworkMovementState.IDLE;

  // Bones for procedural pitch look + lean + strafe twist (found by name).
  private readonly spineBones: THREE.Bone[] = [];
  private smoothedPitch = 0;
  private smoothedLean = 0;
  private smoothedDrop = 0;

  // Direction-aware locomotion state.
  private smoothedLegYaw = 0;
  private backpedaling = false;

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
    const slide = make(clips.slidePose);
    slide.play();
    slide.paused = true;
    slide.time = clips.slidePose.duration * SLIDE_POSE_FRAC;
    slide.stop();

    // Real jump clip: ONE-SHOT — it must never loop (head-roll artifact)
    // and it clamps on its last frame as a safety net (the falling-pose
    // hold in update() normally freezes it before the landing frames).
    const jump = this.mixer.clipAction(clips.jump);
    jump.setLoop(THREE.LoopOnce, 1);
    jump.clampWhenFinished = true;
    jump.enabled = true;

    this.actions = { idle: make(clips.idle), run: make(clips.run), jump, slide };
    this.current = this.actions.idle;
    this.current.play();

    // Cache the upper-body chain for the procedural pitch/twist (root stays
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
   * `horizontalSpeed` the estimated remote speed (m/s), `moveLocalYaw` the
   * signed angle between the aim yaw and the actual movement direction
   * (radians, 0 = moving straight forward).
   */
  update(
    dt: number,
    state: NetworkMovementState,
    horizontalSpeed: number,
    verticalVelocity: number,
    pitch: number,
    moveLocalYaw: number,
  ): void {
    if (state !== this.currentState) this.transitionTo(state);
    this.currentState = state;

    // ---- Direction-aware legs (strafe / backpedal) ----
    const moving =
      (state === NetworkMovementState.RUNNING || state === NetworkMovementState.DASHING) &&
      horizontalSpeed > MOVE_DIR_MIN_SPEED;
    let targetLegYaw = 0;
    if (moving) {
      let angle = moveLocalYaw;
      const abs = Math.abs(angle);
      // Hysteresis: entering/leaving backpedal never flip-flops at ±90°.
      if (this.backpedaling) {
        if (abs < BACKPEDAL_EXIT) this.backpedaling = false;
      } else if (abs > BACKPEDAL_ENTER) {
        this.backpedaling = true;
      }
      // Backpedal: legs face forward-ish, the run clip plays REVERSED.
      if (this.backpedaling) angle = wrapAngle(angle + Math.PI);
      targetLegYaw = THREE.MathUtils.clamp(angle, -MAX_LEG_YAW, MAX_LEG_YAW);
    } else {
      this.backpedaling = false;
    }
    const lk = 1 - Math.exp(-LEG_YAW_SMOOTHING * dt);
    this.smoothedLegYaw += (targetLegYaw - this.smoothedLegYaw) * lk;
    this.model.rotation.y = this.smoothedLegYaw;

    // Run/dash playback speed follows the actual movement speed (clamped —
    // legs never spin at 800%). Backpedal reverses the clip.
    if (this.current === this.actions.run) {
      const scale = THREE.MathUtils.clamp(
        horizontalSpeed / RUN_REF_SPEED,
        RUN_SPEED_MIN,
        RUN_SPEED_MAX,
      );
      const magnitude = state === NetworkMovementState.DASHING ? DASH_TIMESCALE : scale;
      this.current.timeScale = this.backpedaling ? -magnitude : magnitude;
    }

    // Jump falling-pose hold: freeze BEFORE the landing-recovery frames so
    // long falls never play "landing" mid-air. The next transition (ground,
    // dash, slide…) crossfades the jump out and unfreezes on replay.
    const jumpAction = this.actions.jump;
    if (this.current === jumpAction && !jumpAction.paused) {
      if (jumpAction.time >= jumpAction.getClip().duration * JUMP_HOLD_FRAC) {
        jumpAction.paused = true;
      }
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
      // Counter-twist: the LEGS (model root) turned by smoothedLegYaw —
      // the torso twists back so the chest/weapon keep facing the aim.
      const perBoneTwist = -this.smoothedLegYaw / n;
      for (const bone of this.spineBones) {
        bone.rotation.x += perBonePitch + perBoneLean;
        if (perBoneTwist !== 0) {
          // Local Y of a standing humanoid spine bone ≈ ±world up: derive
          // the sign from the bone's last world matrix (Y column, index 5)
          // so the twist always happens around the WORLD vertical axis.
          const sign = bone.matrixWorld.elements[5] >= 0 ? 1 : -1;
          bone.rotation.y += perBoneTwist * sign;
        }
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
        next = this.actions.jump; // real one-shot jump clip
        fade = FADE.jump;
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
    if (next === this.actions.jump) {
      // Skip the grounded crouch anticipation: the player already left
      // the ground when the AIRBORNE state arrives.
      next.time = next.getClip().duration * JUMP_START_FRAC;
      next.timeScale = JUMP_TIMESCALE;
    } else if (next === this.actions.slide) {
      // Frozen pose: park the action at its pose time.
      next.paused = true;
      next.time = next.getClip().duration * SLIDE_POSE_FRAC;
    }
    next.play();
    this.current.crossFadeTo(next, fade, false);
    this.current = next;
  }
}

/** Wrap an unbounded angle into [-PI, PI]. */
function wrapAngle(angle: number): number {
  let a = angle % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}