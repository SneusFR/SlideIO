import * as THREE from "three";
import { NetworkMovementState } from "../NetworkMovementState";
import { RemoteInterpolationConfig as cfg } from "../interpolation/RemoteInterpolationConfig";
import { MovementConfig as moveCfg } from "../../player/MovementConfig";

/**
 * Shared animation clips for the remote POTATO character. Loaded/derived
 * ONCE (see PotatoCharacter.loadCharacterAsset) and reused by every
 * per-player mixer:
 *
 *   Character asset loaded once → clips cached → mixer per RemotePlayer.
 *
 * Base locomotion (Potato_TP_Character.glb, authored in place — the game
 * position provides all world travel):
 *   "Run_Goofy" (0.8 s loop) / "Jump" (1.3 s) / "Dash" (0.8 s) /
 *   "Slide" (1.1 s). `idle` is a DERIVED constant clip (no unarmed Idle
 *   ships with the pack — see buildConstantPoseClip).
 *
 * Armed presentation (HexSniper_TP_Poses.glb + derived masked variants):
 * the two-hand grip layer for a character holding the HexSniper.
 */
export interface RemoteCharacterClips {
  /** Derived constant idle pose (never a T-pose, never run-in-place). */
  idle: THREE.AnimationClip;
  run: THREE.AnimationClip;
  jump: THREE.AnimationClip;
  dash: THREE.AnimationClip;
  slide: THREE.AnimationClip;
  // ---- HexSniper TP presentation (armed avatars) ----
  /** TP_Hold_HexSniper — looping two-hand hold (armed idle). */
  armedHold: THREE.AnimationClip;
  /** TP_Run_HexSniper — calibrated armed run (full-body, used directly). */
  armedRun: THREE.AnimationClip;
  /** TP_Aim_HexSniper — weapon held straight (ADS / active attack). */
  armedAim: THREE.AnimationClip;
  /** TP_Raise_HexSniper — hold → aim transition (0.3 s, one-shot). */
  armedRaise: THREE.AnimationClip;
  /** TP_Lower_HexSniper — aim → hold transition (0.3 s, one-shot). */
  armedLower: THREE.AnimationClip;
  /** Derived masked composites: body clip + constant two-hand grip. */
  armedJump: THREE.AnimationClip;
  armedDash: THREE.AnimationClip;
  armedSlide: THREE.AnimationClip;
}

/** Blend durations (seconds) — short: SlideIO is a fast FPS. */
const FADE = { idle: 0.18, run: 0.12, jump: 0.08, slide: 0.08, dash: 0.06 };
/**
 * Snappier fade when LEAVING the airborne state: the avatar must read as
 * "on the ground" immediately at landing — no lingering mid-air pose.
 */
const LANDING_FADE = 0.1;
/** Run-clip playback speed mapping from horizontal speed (m/s). */
const RUN_REF_SPEED = 9; // horizontal speed at which run plays at 1.0×
const RUN_SPEED_MIN = 0.75;
const RUN_SPEED_MAX = 1.6;
/**
 * JUMP clip landmarks in SECONDS (authored at 30 fps, t = (frame-1)/30):
 * anticipation f8, TAKEOFF f12 = 0.3667 s, APEX f20 = 0.6333 s, landing
 * f29 = 0.9333 s, end f40 = 1.3 s.
 *
 *  - START at the takeoff: the player already LEFT the ground when the
 *    AIRBORNE state arrives (the physics impulse happened) — playing the
 *    grounded anticipation mid-air reads as feet glued to the sky.
 *  - HOLD at the apex pose while airborne (variable-duration jumps and
 *    platform falls both stay in the aerial pose). The LANDING frames
 *    only play through the crossfade back to a grounded state — they are
 *    never triggered by clip time while still in the air.
 */
const JUMP_START_TIME = 11 / 30; // takeoff (frame 12)
const JUMP_HOLD_TIME = 19 / 30; // apex (frame 20)
/**
 * SLIDE clip landmarks in SECONDS (Potato_Slide_Integration.json):
 * entry 0 → 0.2667 s (frames 1–9), hold section 0.2667 → 0.7 s (equal
 * endpoint poses — holding the 0.2667 s pose is explicitly allowed),
 * exit 0.7 → 1.1 s. The entry plays ONCE, the low pose is then held for
 * as long as SLIDING lasts; the exit is handled by the state crossfade
 * (jump/dash interrupts included). The old Meshy 17%/42% fractions are
 * intentionally gone.
 */
const SLIDE_HOLD_TIME = 8 / 30; // frame 9 — deep slide pose
/**
 * While sliding the LOCAL capsule shrinks and its center settles LOWER
 * (slide half-height + radius above the ground instead of stand
 * half-height + radius). The remote model root hangs at the STANDING feet
 * offset below the capsule center, so it must be RAISED by the difference
 * or the feet sink underground during every slide. This is a CAPSULE
 * compensation — the crouch itself comes from the clip's hips drop.
 */
const SLIDE_MODEL_RAISE = moveCfg.standHalfHeight - moveCfg.slideHalfHeight;
/** 1/s exponential smoothing for procedural pose adjustments. */
const POSE_SMOOTHING = 12;

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

/** Locomotion slots the controller can occupy (armed variants map 1:1). */
type Slot = "idle" | "run" | "jump" | "dash" | "slide";

/**
 * Drives one remote character's THREE.AnimationMixer from the sampled
 * network movement state. PURELY VISUAL: consumes interpolation output,
 * never network packets (animation state ≠ network snapshot).
 *
 * All transitions use crossFadeTo() — no instant pops, no per-frame
 * action re-creation (actions are created once and reused).
 *
 * ARMED PRESENTATION: setArmed(true) (character holding the HexSniper)
 * swaps every slot to its armed variant — TP_Hold/TP_Run directly, and
 * masked jump/dash/slide composites that keep the two-hand grip during
 * airborne/dash/slide states. The network protocol does not currently
 * transmit ADS, so remote avatars stay on Hold/Run (documented
 * limitation — `setAiming` is the ready presentation hook).
 */
export class RemotePlayerAnimationController {
  private readonly mixer: THREE.AnimationMixer;
  private readonly unarmed: Record<Slot, THREE.AnimationAction>;
  private readonly armedSet: Record<Slot, THREE.AnimationAction>;
  private readonly armedAim: THREE.AnimationAction;
  private current: THREE.AnimationAction;
  private currentSlot: Slot = "idle";
  private currentState = NetworkMovementState.IDLE;
  private armed = false;
  private aiming = false;

  // Bones for procedural pitch look + lean + strafe twist (found by name).
  private readonly spineBones: THREE.Bone[] = [];
  /**
   * Per-bone twist-axis sign, computed ONCE from the REST pose (an
   * animated matrixWorld flips sign near-horizontal — a rest constant
   * never does; recalibrated on the Potato rig's rest bases).
   */
  private readonly spineTwistSigns: number[] = [];
  private smoothedPitch = 0;
  private smoothedLean = 0;
  private smoothedRaise = 0;

  // Direction-aware locomotion state.
  private smoothedLegYaw = 0;
  private backpedaling = false;

  /**
   * Extra model raise applied while SLIDING. Remote players need it (their
   * network capsule center drops while sliding); solo BOTS keep a fixed
   * capsule, so they pass 0 (the crouch comes from the clip alone).
   */
  private readonly slideRaise: number;

  constructor(
    private readonly model: THREE.Object3D,
    /** Model's rest local Y (feet offset) — raise is applied relative to it. */
    private readonly modelRestY: number,
    clips: RemoteCharacterClips,
    options: { slideRaise?: number } = {},
  ) {
    this.slideRaise = options.slideRaise ?? SLIDE_MODEL_RAISE;
    this.mixer = new THREE.AnimationMixer(model);

    const loop = (clip: THREE.AnimationClip): THREE.AnimationAction => {
      const a = this.mixer.clipAction(clip);
      a.setLoop(THREE.LoopRepeat, Infinity);
      a.enabled = true;
      return a;
    };
    /**
     * One-shot pose clips (jump, dash, slide): they must NEVER loop (a
     * looping jump/slide would replay anticipation/recovery frames
     * mid-state) and they clamp on their last frame as a safety net —
     * the pose hold in update() normally freezes them much earlier.
     */
    const oneShot = (clip: THREE.AnimationClip): THREE.AnimationAction => {
      const a = this.mixer.clipAction(clip);
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.enabled = true;
      return a;
    };

    this.unarmed = {
      idle: loop(clips.idle),
      run: loop(clips.run),
      jump: oneShot(clips.jump),
      dash: oneShot(clips.dash),
      slide: oneShot(clips.slide),
    };
    this.armedSet = {
      idle: loop(clips.armedHold),
      run: loop(clips.armedRun),
      jump: oneShot(clips.armedJump),
      dash: oneShot(clips.armedDash),
      slide: oneShot(clips.armedSlide),
    };
    this.armedAim = loop(clips.armedAim);
    this.current = this.unarmed.idle;
    this.current.play();

    // Cache the upper-body chain for the procedural pitch/twist (root
    // stays upright — only Spine/Spine_1/Chest/Neck/Head bend, clamped).
    // Cosmetic sockets (Head_Socket, Face_Socket) and the plant are
    // EXCLUDED — they follow their parent untouched.
    model.updateMatrixWorld(true); // rest pose (mixer hasn't run yet)
    model.traverse((obj) => {
      const bone = obj as THREE.Bone;
      if (
        bone.isBone &&
        /spine|chest|neck|head/i.test(bone.name) &&
        !/socket|plant/i.test(bone.name)
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
   * Armed presentation toggle: true while the avatar holds the HexSniper.
   * Swaps the whole slot set (Hold/TP_Run/masked composites) and refreshes
   * the current pose without waiting for the next state change.
   */
  setArmed(armed: boolean): void {
    if (this.armed === armed) return;
    this.armed = armed;
    this.refreshCurrentSlot();
  }

  /**
   * Straight-weapon presentation (TP_Aim): kept for a future ADS network
   * field / bot aiming state. Only affects grounded idle (aim replaces
   * hold); locomotion keeps the calibrated armed clips.
   */
  setAiming(aiming: boolean): void {
    if (this.aiming === aiming) return;
    this.aiming = aiming;
    if (this.armed && this.currentSlot === "idle") this.refreshCurrentSlot();
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

    // Run playback speed follows the actual movement speed (clamped —
    // legs never spin at 800%). Backpedal reverses the clip. The DASH
    // state now has its own real clip — no accelerated-run substitution.
    if (this.currentSlot === "run") {
      const scale = THREE.MathUtils.clamp(
        horizontalSpeed / RUN_REF_SPEED,
        RUN_SPEED_MIN,
        RUN_SPEED_MAX,
      );
      this.current.timeScale = this.backpedaling ? -scale : scale;
    }

    // One-shot pose hold in SECONDS (jump: apex pose, slide: deep slide
    // pose): freeze strictly BEFORE the clip's landing/stand-up frames so
    // a long fall / long slide never plays a recovery mid-state. The next
    // transition (ground, dash, slide…) crossfades the action out and
    // unfreezes on replay. Dash plays through (0.8 s clip, interruptible
    // by any state change).
    const holdTime =
      this.currentSlot === "jump"
        ? JUMP_HOLD_TIME
        : this.currentSlot === "slide"
          ? SLIDE_HOLD_TIME
          : 0;
    if (holdTime > 0 && !this.current.paused) {
      if (this.current.time >= holdTime) {
        this.current.time = holdTime;
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
    const targetRaise = state === NetworkMovementState.SLIDING ? this.slideRaise : 0;
    this.smoothedRaise += (targetRaise - this.smoothedRaise) * k;
    this.model.position.y = this.modelRestY + this.smoothedRaise;

    // DASH lean is gone: the delivered Dash clip carries its own body
    // motion — layering a procedural lean would double the inclination.
    this.smoothedLean += (0 - this.smoothedLean) * k;

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
    // AIRBORNE + SLIDING + DASHING: procedural pitch/lean/counter-twist
    // are DISABLED — these clips animate the spine chain themselves;
    // layering additive Euler offsets on top made the head/torso roll on
    // the old rig and the same conflict exists on the Potato clips (Jump,
    // Dash and Slide all carry Spine/Chest/Neck/Head tracks). The offsets
    // below are applied to the MIXER OUTPUT of this frame (never
    // accumulated onto the previous frame's rotations).
    const proceduralSpineOff =
      state === NetworkMovementState.AIRBORNE ||
      state === NetworkMovementState.SLIDING ||
      state === NetworkMovementState.DASHING;
    if (n > 0 && !proceduralSpineOff) {
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

  // ------------------------------------------------------------------

  /** Action for a slot under the CURRENT armed/aiming presentation. */
  private actionFor(slot: Slot): THREE.AnimationAction {
    if (!this.armed) return this.unarmed[slot];
    if (slot === "idle" && this.aiming) return this.armedAim;
    return this.armedSet[slot];
  }

  /** Re-resolve the current slot's action after an armed/aiming change. */
  private refreshCurrentSlot(): void {
    const next = this.actionFor(this.currentSlot);
    if (next === this.current) return;
    next.reset();
    this.seekEntry(next);
    next.play();
    this.current.crossFadeTo(next, FADE.idle, false);
    this.current = next;
  }

  /** Start one-shot clips past their grounded anticipation frames. */
  private seekEntry(action: THREE.AnimationAction): void {
    if (this.currentSlot === "jump") {
      // Skip the grounded anticipation: the physics impulse already
      // happened when AIRBORNE arrives (never delay gameplay for anim).
      action.time = JUMP_START_TIME;
    }
    // Slide starts at 0: the authored entry (frames 1–9) IS the dive.
    // Dash starts at 0: the clip is the dash action itself.
  }

  private transitionTo(state: NetworkMovementState): void {
    let slot: Slot;
    let fade: number;
    switch (state) {
      case NetworkMovementState.RUNNING:
        slot = "run";
        fade = FADE.run;
        break;
      case NetworkMovementState.DASHING:
        // Real Dash clip — even when the dash starts mid-air (the sender's
        // state machine already prioritizes DASHING over !grounded).
        slot = "dash";
        fade = FADE.dash;
        break;
      case NetworkMovementState.AIRBORNE:
        slot = "jump";
        fade = FADE.jump;
        break;
      case NetworkMovementState.SLIDING:
        slot = "slide";
        fade = FADE.slide;
        break;
      default:
        slot = "idle";
        fade = FADE.idle;
        break;
    }
    const wasAirborne = this.currentSlot === "jump";
    this.currentSlot = slot;
    const next = this.actionFor(slot);
    if (next === this.current) return;

    // Landing must read INSTANTLY on other clients: leaving the airborne
    // pose toward any grounded state uses the snappiest safe fade.
    if (wasAirborne && fade > LANDING_FADE) fade = LANDING_FADE;

    // Restart the incoming action then crossfade — supports rapid
    // slide-hop chains (SLIDE→AIR→RUN→SLIDE…) without T-poses or a stuck
    // mixer, because the outgoing action keeps playing during the fade.
    next.reset();
    this.seekEntry(next);
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
