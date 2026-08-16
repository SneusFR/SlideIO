import * as THREE from "three";
import { NetworkMovementState } from "../NetworkMovementState";
import { RemoteInterpolationConfig as cfg } from "../interpolation/RemoteInterpolationConfig";
import { MovementConfig as moveCfg } from "../../player/MovementConfig";

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
 *   "Armature|slide_right|baselayer"  → SLIDING (forward travel stripped,
 *                                       the baked hips CROUCH is kept)
 */
export interface RemoteCharacterClips {
  idle: THREE.AnimationClip;
  run: THREE.AnimationClip;
  /** Real jump clip (launch→apex window, apex pose held while airborne). */
  jump: THREE.AnimationClip;
  /** Real slide clip (dive→deep-slide window, deep pose held). */
  slide: THREE.AnimationClip;
}

/** Blend durations (seconds) — short: SlideIO is a fast FPS. */
const FADE = { idle: 0.18, run: 0.12, jump: 0.08, slide: 0.08, dash: 0.08 };
/**
 * Snappier fade when LEAVING the airborne state: the avatar must read as
 * "on the ground" immediately at landing — no lingering mid-air pose.
 */
const LANDING_FADE = 0.1;
/** Run-clip playback speed mapping from horizontal speed (m/s). */
const RUN_REF_SPEED = 9; // horizontal speed at which run plays at 1.0×
const RUN_SPEED_MIN = 0.75;
const RUN_SPEED_MAX = 1.6;
const DASH_TIMESCALE = 1.8;
/**
 * JUMP clip windows (fractions of the ~1.9 s Regular_Jump clip, measured
 * from the baked hips arc — crouch bottom ≈ 15%, APEX ≈ 43%, landing
 * recovery starts ≈ 58%):
 *  - START begins at the LAUNCH (legs extending, already past the grounded
 *    crouch anticipation — the player left the ground when AIRBORNE
 *    arrives; showing the crouch mid-air reads as a glitch);
 *  - HOLD freezes exactly at the APEX pose, i.e. strictly BEFORE any
 *    landing-absorption/recovery frames. Those frames (head/torso pitching
 *    hard forward, legs tucking) are what previously looked like the torso
 *    and head "rolling" and like the avatar hovering above the ground.
 *    The hold is released by the next state transition (ground / dash /
 *    slide…), which crossfades the jump out — it NEVER plays past the apex.
 */
const JUMP_START_FRAC = 0.29;
const JUMP_HOLD_FRAC = 0.43;
const JUMP_TIMESCALE = 1.0;
/**
 * SLIDE clip windows (fractions of the ~1.8 s slide_right clip): the dive
 * begins ≈ 15% and the DEEP slide plateau spans ≈ 33–50% (hips lowest).
 * Play the dive, then hold the deep pose for as long as the slide lasts —
 * the recovery/stand-up half of the clip is never shown (the exit
 * crossfade handles standing back up).
 */
const SLIDE_START_FRAC = 0.17;
const SLIDE_HOLD_FRAC = 0.42;
/** Slightly accelerated dive so the remote pose catches up with the slide. */
const SLIDE_TIMESCALE = 1.3;
/**
 * While sliding the LOCAL capsule shrinks and its center settles LOWER
 * (slide half-height + radius above the ground instead of stand
 * half-height + radius). The remote model root hangs at the STANDING feet
 * offset below the capsule center, so it must be RAISED by the difference
 * or the feet sink underground during every slide.
 */
const SLIDE_MODEL_RAISE = moveCfg.standHalfHeight - moveCfg.slideHalfHeight;
/** Procedural lean targets. */
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
 * ONE-SHOT SAFETY (jump + slide): these clips are LoopOnce and are frozen
 * at a curated pose fraction BEFORE their recovery frames. They can never
 * loop, never play landing/stand-up frames at the wrong time, and are
 * always released by a crossfade — the source of the old "rolling
 * torso/head" and "hovering above the ground" artifacts.
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
  /**
   * Per-bone twist-axis sign, computed ONCE from the REST pose.
   *
   * It used to be re-derived every frame from the bone's animated
   * matrixWorld — but mid-jump poses lean bones near horizontal, where
   * the sign flips between frames. Alternating the twist direction every
   * frame violently oscillated the whole upper body ("distorted torso"
   * while falling). A rest-pose constant can never flip.
   */
  private readonly spineTwistSigns: number[] = [];
  private smoothedPitch = 0;
  private smoothedLean = 0;
  private smoothedRaise = 0;

  // Direction-aware locomotion state.
  private smoothedLegYaw = 0;
  private backpedaling = false;

  constructor(
    private readonly model: THREE.Object3D,
    /** Model's rest local Y (feet offset) — raise is applied relative to it. */
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
    /**
     * One-shot pose clips (jump, slide): they must NEVER loop (a looping
     * jump/slide replays crouch/recovery frames mid-state = rolling
     * torso/head artifact) and they clamp on their last frame as a safety
     * net — the pose hold in update() normally freezes them much earlier.
     */
    const makeOneShot = (clip: THREE.AnimationClip): THREE.AnimationAction => {
      const a = this.mixer.clipAction(clip);
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.enabled = true;
      return a;
    };

    this.actions = {
      idle: make(clips.idle),
      run: make(clips.run),
      jump: makeOneShot(clips.jump),
      slide: makeOneShot(clips.slide),
    };
    this.current = this.actions.idle;
    this.current.play();

    // Cache the upper-body chain for the procedural pitch/twist (root stays
    // upright — only spine/chest/neck/head bend, clamped). Helper end bones
    // (head_end, headfront) are EXCLUDED: bending them adds nothing and
    // amplifies artifacts at the tip of the chain.
    model.updateMatrixWorld(true); // rest pose (mixer hasn't run yet)
    model.traverse((obj) => {
      const bone = obj as THREE.Bone;
      if (
        bone.isBone &&
        /spine|chest|neck|head/i.test(bone.name) &&
        !/end|front/i.test(bone.name)
      ) {
        this.spineBones.push(bone);
        // Local Y of a standing humanoid spine bone ≈ ±world up: derive the
        // sign from the REST-pose world matrix (Y column, index 5) so the
        // counter-twist always happens around the world vertical axis.
        this.spineTwistSigns.push(bone.matrixWorld.elements[5] >= 0 ? 1 : -1);
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

    // One-shot pose hold (jump: APEX pose, slide: DEEP slide pose): freeze
    // strictly BEFORE the clip's recovery frames so a long fall/slide never
    // plays "landing"/"standing up" mid-state. The next transition (ground,
    // dash, slide…) crossfades the action out and unfreezes on replay.
    const holdFrac =
      this.current === this.actions.jump
        ? JUMP_HOLD_FRAC
        : this.current === this.actions.slide
          ? SLIDE_HOLD_FRAC
          : 0;
    if (holdFrac > 0 && !this.current.paused) {
      const clip = this.current.getClip();
      if (this.current.time >= clip.duration * holdFrac) {
        this.current.time = clip.duration * holdFrac;
        this.current.paused = true;
      }
    }

    this.mixer.update(dt);

    // ---- Procedural adjustments AFTER the mixer (it would otherwise
    // overwrite the bone rotations set here) ----
    const k = 1 - Math.exp(-POSE_SMOOTHING * dt);

    // Slide capsule compensation: the network capsule center sits LOWER
    // while sliding — raise the model root so the feet stay on the ground.
    // The crouch itself comes from the REAL slide clip (baked hips drop).
    const targetRaise = state === NetworkMovementState.SLIDING ? SLIDE_MODEL_RAISE : 0;
    this.smoothedRaise += (targetRaise - this.smoothedRaise) * k;
    this.model.position.y = this.modelRestY + this.smoothedRaise;

    const targetLean = state === NetworkMovementState.DASHING ? DASH_TORSO_LEAN : 0;
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
      for (let i = 0; i < n; i++) {
        const bone = this.spineBones[i];
        bone.rotation.x += perBonePitch + perBoneLean;
        if (perBoneTwist !== 0) {
          bone.rotation.y += perBoneTwist * this.spineTwistSigns[i];
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
        next = this.actions.slide; // real one-shot slide clip
        fade = FADE.slide;
        break;
      default:
        next = this.actions.idle;
        fade = FADE.idle;
        break;
    }
    if (next === this.current) return;

    // Landing must read INSTANTLY on other clients: leaving the airborne
    // pose toward any grounded state uses the snappiest safe fade.
    if (this.current === this.actions.jump && fade > LANDING_FADE) fade = LANDING_FADE;

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
      // Start at the dive (past the upright run-in frames) and play
      // toward the deep-slide pose, where update() freezes it.
      next.time = next.getClip().duration * SLIDE_START_FRAC;
      next.timeScale = SLIDE_TIMESCALE;
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