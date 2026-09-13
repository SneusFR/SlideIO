import * as THREE from "three";
import { SlidePresentation, SLIDE_POSE } from "../../characters/SlidePresentation";
import { JumpPresentation, JUMP_POSE } from "../../characters/JumpPresentation";
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
 *   "Slide" (1.5 s). `idle` is a DERIVED constant clip (no unarmed Idle
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
  jumpVariants?: THREE.AnimationClip[];
  armedJumpVariants?: THREE.AnimationClip[];
  dash: THREE.AnimationClip;
  slide: THREE.AnimationClip;
  // ---- HexSniper TP presentation (armed avatars) ----
  /** Armed idle grip — TP_Aim_HexSniper (weapon straight, FP parity). */
  armedHold: THREE.AnimationClip;
  /** Armed run — TP_Run_HexSniper body + the constant straight grip. */
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
  /**
   * PROFILE-keyed armed pose sets (WeaponViewProfile.id → clips) for
   * weapons migrated to the shared presentation system with their own TP
   * library (Brick Maul: "brickmaul"). The HexSniper keeps the dedicated
   * `armed*` fields above (selected through the "hexsniper" id).
   */
  profiles?: Record<string, ArmedProfileClips>;
}

/** One weapon profile's TP pose set (locomotion composites + actions). */
export interface ArmedProfileClips {
  /** Looping hold (full clip). */
  hold: THREE.AnimationClip;
  /** Masked run composite (body from locomotion, weapon layer animated). */
  run: THREE.AnimationClip;
  /** Masked composites with the hold grip frozen at its first sample. */
  jump: THREE.AnimationClip;
  jumpVariants: THREE.AnimationClip[];
  dash: THREE.AnimationClip;
  slide: THREE.AnimationClip;
  /** Full-body one-shots (played through the override API). */
  equip: THREE.AnimationClip | null;
  unequip: THREE.AnimationClip | null;
  inspect: THREE.AnimationClip | null;
  /**
   * OPTIONAL layered inspection (inspection that survives movement): the
   * Inspect clip reduced to its upper-body tracks + the locomotion
   * composites WITHOUT those tracks. Both present → "inspect" plays the
   * upper layer on top of the lower-body locomotion of the real state
   * instead of a full-body override. Absent → full-body inspect.
   */
  inspectUpper?: THREE.AnimationClip | null;
  lowerBody?: {
    hold: THREE.AnimationClip;
    run: THREE.AnimationClip;
    jump: THREE.AnimationClip;
    jumpVariants: THREE.AnimationClip[];
    dash: THREE.AnimationClip;
    slide: THREE.AnimationClip;
  } | null;
  /**
   * Attack / phase clips by profile action key (whirlwind, slamStart…).
   * `loop` comes EXPLICITLY from the profile (never inferred from the key).
   * `layered` = the clip is an UPPER-BODY layer (tracks reduced to the
   * profile mask) played over the lower-body locomotion of the real state
   * — GoofyBasket charge / throw / catch / dribble keep the legs running.
   */
  actions: Record<string, { clip: THREE.AnimationClip; loop: boolean; layered?: boolean }>;
}

/** Profile id of the HexSniper's dedicated TP set (RemoteCharacterClips.armed*). */
export const HEXSNIPER_PROFILE_ID = "hexsniper";

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
// Jump pose time follows vertical velocity; landing is played on real contact.
// SlidePresentation repeats the authored glide segment and plays recovery on exit.
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
const landingClips = new WeakMap<THREE.AnimationClip, THREE.AnimationClip>();
function landingClip(source: THREE.AnimationClip): THREE.AnimationClip {
  let clip = landingClips.get(source);
  if (!clip) {
    clip = new THREE.AnimationClip(`${source.name}_Landing`, source.duration, source.tracks);
    landingClips.set(source, clip);
  }
  return clip;
}

type Slot = "idle" | "run" | "jump" | "land" | "dash" | "slide" | "slideExit";

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
  /** Active armed PROFILE id (null = unarmed locomotion). */
  private armedProfile: string | null = null;
  private aiming = false;
  private readonly jumpPose = new JumpPresentation();
  private readonly slidePose = new SlidePresentation();
  private readonly jumpsUnarmed: THREE.AnimationAction[];
  private readonly jumpsArmed: THREE.AnimationAction[];
  private readonly landingsUnarmed: THREE.AnimationAction[];
  private readonly landingsArmed: THREE.AnimationAction[];
  private jumpVariant = -1;

  /** Per-profile action sets (built once per avatar from the cached clips). */
  private readonly profileSets = new Map<string, ProfileActionSet>();
  /**
   * FULL-BODY OVERRIDE (attack / smash phase / inspection / equip): the
   * clip owns every bone it animates with priority over the locomotion
   * slot; procedural spine offsets are suspended meanwhile. Movement keeps
   * driving the world position. Cleared explicitly or when a one-shot
   * ends (then the locomotion matching the real state comes back).
   */
  private override: {
    action: THREE.AnimationAction;
    onFinished: (() => void) | null;
    exitFade: number;
  } | null = null;
  /**
   * LAYERED INSPECTION (profile sets shipping `inspectUpper` + `lowerBody`):
   * the upper-body inspect clip plays on top of the LOWER-body variant of
   * the real locomotion — the avatar keeps running / jumping / sliding
   * while it flips the weapon, exactly like the local FP arms do. Track
   * sets are disjoint, so both actions run at full weight. The layer ends
   * with its one-shot (then the full locomotion variant comes back) or is
   * cleared by clearOverride / a full-body override / a profile change.
   */
  private inspectLayer: {
    action: THREE.AnimationAction;
    onFinished: (() => void) | null;
    exitFade: number;
  } | null = null;

  // Bones for procedural pitch look + lean + strafe twist (found by name).
  private readonly spineBones: THREE.Bone[] = [];
  /**
   * Per-bone twist-axis sign, computed ONCE from the REST pose (an
   * animated matrixWorld flips sign near-horizontal — a rest constant
   * never does; recalibrated on the Potato rig's rest bases).
   */
  private readonly spineTwistSigns: number[] = [];
  /**
   * Procedural offsets applied to each spine bone LAST frame (X = pitch +
   * lean, Y = counter-twist). Reverted right before the next mixer update:
   * the mixer only rewrites bones the ACTIVE clips have tracks for, and
   * several pack clips skip parts of the chain (TP_Hold/TP_Aim animate
   * only Spine_1; Run_Goofy skips Spine_1 and Neck) — an un-reverted
   * additive offset on such a bone survives into the next frame's "+="
   * and ACCUMULATES (visible as a continuous torso/head roll).
   */
  private readonly appliedSpineX: number[] = [];
  private readonly appliedSpineY: number[] = [];
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
      land: oneShot(landingClip(clips.jump)),
      dash: oneShot(clips.dash),
      slide: oneShot(clips.slide),
      slideExit: oneShot(landingClip(clips.slide)),
    };
    this.armedSet = {
      idle: loop(clips.armedHold),
      run: loop(clips.armedRun),
      jump: oneShot(clips.armedJump),
      land: oneShot(landingClip(clips.armedJump)),
      dash: oneShot(clips.armedDash),
      slide: oneShot(clips.armedSlide),
      slideExit: oneShot(landingClip(clips.armedSlide)),
    };
    const unarmedJumps = clips.jumpVariants?.length ? clips.jumpVariants : [clips.jump];
    const armedJumps = clips.armedJumpVariants?.length ? clips.armedJumpVariants : [clips.armedJump];
    this.jumpsUnarmed = unarmedJumps.map(oneShot);
    this.jumpsArmed = armedJumps.map(oneShot);
    this.landingsUnarmed = unarmedJumps.map(c => oneShot(landingClip(c)));
    this.landingsArmed = armedJumps.map(c => oneShot(landingClip(c)));
    this.armedAim = loop(clips.armedAim);

    // Profile-keyed sets (Brick Maul…): locomotion composites + one action
    // per clip (LoopOnce+clamp for one-shots, LoopRepeat for loops such as
    // Slam_Dive). Each clip gets ITS OWN action — never shared.
    for (const [id, p] of Object.entries(clips.profiles ?? {})) {
      const jumps = p.jumpVariants.length ? p.jumpVariants : [p.jump];
      const actions = new Map<string, THREE.AnimationAction>();
      const layeredActions = new Set<string>();
      for (const [key, def] of Object.entries(p.actions)) {
        // EXPLICIT loop flag from the profile (Slam_Dive, Charge_Hold_Ln,
        // Dribble loop; Whirlwind / Throw / Catch are one-shots).
        actions.set(key, def.loop ? loop(def.clip) : oneShot(def.clip));
        if (def.layered) layeredActions.add(key);
      }
      const lb = p.lowerBody ?? null;
      const lbJumps = lb ? (lb.jumpVariants.length ? lb.jumpVariants : [lb.jump]) : [];
      this.profileSets.set(id, {
        slots: {
          idle: loop(p.hold),
          run: loop(p.run),
          jump: oneShot(p.jump),
          land: oneShot(landingClip(p.jump)),
          dash: oneShot(p.dash),
          slide: oneShot(p.slide),
          slideExit: oneShot(landingClip(p.slide)),
        },
        jumps: jumps.map(oneShot),
        landings: jumps.map((c) => oneShot(landingClip(c))),
        equip: p.equip ? oneShot(p.equip) : null,
        unequip: p.unequip ? oneShot(p.unequip) : null,
        inspect: p.inspect ? oneShot(p.inspect) : null,
        inspectUpper: p.inspectUpper && lb ? oneShot(p.inspectUpper) : null,
        lowerSlots: lb
          ? {
              idle: loop(lb.hold),
              run: loop(lb.run),
              jump: oneShot(lb.jump),
              land: oneShot(landingClip(lb.jump)),
              dash: oneShot(lb.dash),
              slide: oneShot(lb.slide),
              slideExit: oneShot(landingClip(lb.slide)),
            }
          : null,
        lowerJumps: lbJumps.map(oneShot),
        lowerLandings: lbJumps.map((c) => oneShot(landingClip(c))),
        actions,
        layeredActions,
      });
    }

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
        this.appliedSpineX.push(0);
        this.appliedSpineY.push(0);
      }
    });
  }

  /**
   * Armed presentation toggle: true while the avatar holds the HexSniper.
   * Swaps the whole slot set (Hold/TP_Run/masked composites) and refreshes
   * the current pose without waiting for the next state change.
   */
  setArmed(armed: boolean): void {
    this.setArmedProfile(armed ? HEXSNIPER_PROFILE_ID : null);
  }

  /**
   * Select the armed pose set BY PROFILE (HexSniper two-hand set, Brick
   * Maul one-hand masked set…) or null for the unarmed locomotion. Any
   * running full-body override is dropped (a weapon change cancels it).
   */
  setArmedProfile(id: string | null): void {
    if (id !== null && id !== HEXSNIPER_PROFILE_ID && !this.profileSets.has(id)) id = null;
    if (this.armedProfile === id) return;
    this.armedProfile = id;
    this.clearOverride(0.1);
    this.refreshCurrentSlot();
  }

  /** Active armed profile id (null = unarmed). */
  get armedProfileId(): string | null {
    return this.armedProfile;
  }

  /** True while a full-body override (attack / equip) or a layered inspection plays. */
  get overriding(): boolean {
    return this.override !== null || this.inspectLayer !== null;
  }

  /**
   * Straight-weapon presentation (TP_Aim): kept for a future ADS network
   * field / bot aiming state. Only affects grounded idle (aim replaces
   * hold); locomotion keeps the calibrated armed clips.
   */
  setAiming(aiming: boolean): void {
    if (this.aiming === aiming) return;
    this.aiming = aiming;
    if (this.armedProfile === HEXSNIPER_PROFILE_ID && this.currentSlot === "idle") {
      this.refreshCurrentSlot();
    }
  }

  // ------------------------------------------------------------------
  // FULL-BODY OVERRIDE API (profile actions / inspect / equip)
  // ------------------------------------------------------------------

  /**
   * Play a profile clip with priority over the locomotion: `kind` selects
   * an action key ("whirlwind", "slamStart"…) or one of "equip" /
   * "unequip" / "inspect". `startAt` = entry time (late arrivals resume at
   * the elapsed phase). One-shots fire `onFinished` once at their end (never
   * after a cancel / replacement). Returns false if the clip is unknown.
   */
  playOverride(
    kind: string,
    options: {
      startAt?: number;
      fadeIn?: number;
      exitFade?: number;
      /** Playback rate (default 1) — e.g. the sped-up Equip clip. */
      timeScale?: number;
      onFinished?: () => void;
    } = {},
  ): boolean {
    if (!this.armedProfile) return false;
    const set = this.profileSets.get(this.armedProfile);
    if (!set) return false;
    // Layered inspection when the profile ships the split clips: the
    // upper-body layer goes over the lower-body locomotion of the real
    // state (idle included — the split pose equals the full clip there).
    if (kind === "inspect" && set.inspectUpper && set.lowerSlots) {
      return this.playInspectLayer(set.inspectUpper, options, false);
    }
    // Layered profile ACTIONS (GoofyBasket charge / throw / catch / dribble):
    // the masked upper clip plays over the lower-body locomotion — the legs
    // keep running / jumping / sliding. Loops stay until cleared / replaced.
    if (set.layeredActions.has(kind) && set.lowerSlots) {
      const layer = set.actions.get(kind);
      if (!layer) return false;
      return this.playInspectLayer(layer, options, true);
    }
    const action =
      kind === "equip" ? set.equip : kind === "unequip" ? set.unequip : kind === "inspect" ? set.inspect : set.actions.get(kind) ?? null;
    if (!action) return false;
    if (this.override) this.override.onFinished = null; // invalidate stale end
    // A full-body override replaces a layered inspection (attack wins).
    this.dropInspectLayer(0);
    const fade = options.fadeIn ?? 0.1;
    action.reset();
    action.time = Math.max(0, Math.min(options.startAt ?? 0, action.getClip().duration - 1e-3));
    action.setEffectiveTimeScale(Math.max(0.05, options.timeScale ?? 1)).setEffectiveWeight(1);
    action.paused = false;
    if (this.current !== action) {
      if (fade > 0) this.current.fadeOut(fade);
      else this.current.stop();
    }
    if (fade > 0) action.fadeIn(fade);
    action.play();
    this.current = action;
    this.override = { action, onFinished: options.onFinished ?? null, exitFade: options.exitFade ?? 0.12 };
    // Reset the procedural spine offsets right away — the clip owns the
    // torso for its whole duration.
    this.revertSpineOffsets();
    return true;
  }

  /** Drop the override and return to the locomotion of the real state. */
  clearOverride(fade = 0.12): void {
    if (this.inspectLayer) this.dropInspectLayer(fade);
    if (!this.override) return;
    this.override.onFinished = null;
    this.override = null;
    const next = this.actionFor(this.currentSlot);
    next.reset();
    this.seekEntry(next);
    next.play();
    if (fade > 0) this.current.crossFadeTo(next, fade, false);
    else this.current.stop();
    this.current = next;
  }

  /**
   * Presentation clock of the arm-owning clip: the running override or
   * layer (priority) else the locomotion slot action. Cosmetic objects
   * synchronized with the arms (GoofyBasket TP ball) read it AFTER
   * update() — never a second mixer advance.
   */
  presentationClock(): { clip: string | null; time: number } {
    if (this.override) return { clip: this.override.action.getClip().name, time: this.override.action.time };
    if (this.inspectLayer) return { clip: this.inspectLayer.action.getClip().name, time: this.inspectLayer.action.time };
    return { clip: this.current.getClip().name, time: this.current.time };
  }

  /** Elapsed time of the running override / inspection layer (s), or -1. */
  get overrideTime(): number {
    if (this.override) return this.override.action.time;
    if (this.inspectLayer) return this.inspectLayer.action.time;
    return -1;
  }

  /**
   * Start the upper-body inspection layer: the layer clip plays on its own
   * clock while the locomotion slot swaps to its lower-body variant (same
   * phase — the run keeps its stride, the jump/slide keep their sampled
   * time through seekEntry / the per-frame pose holds).
   */
  private playInspectLayer(
    layer: THREE.AnimationAction,
    options: { startAt?: number; fadeIn?: number; exitFade?: number; onFinished?: () => void },
    /** Priority action layer: replaces a running layer / full override (an attack wins). */
    priority: boolean,
  ): boolean {
    if (this.override) {
      // An attack / equip in progress keeps the body (mirror of the
      // sender: an inspection never interrupts an attack) — a priority
      // layer (charge / throw) does replace the full-body override.
      if (!priority) return false;
      this.override.onFinished = null;
      this.override = null;
      const back = this.actionFor(this.currentSlot);
      back.reset();
      this.seekEntry(back);
      back.play();
      this.current.crossFadeTo(back, 0.08, false);
      this.current = back;
    }
    const prev = this.inspectLayer;
    if (prev) prev.onFinished = null;
    const fade = options.fadeIn ?? 0.1;
    const wasLayered = prev !== null;
    this.inspectLayer = { action: layer, onFinished: options.onFinished ?? null, exitFade: options.exitFade ?? 0.12 };
    if (prev && prev.action !== layer) {
      if (fade > 0) prev.action.fadeOut(fade);
      else prev.action.stop();
    }
    layer.reset();
    const isLoop = layer.loop !== THREE.LoopOnce;
    const start = Math.max(0, options.startAt ?? 0);
    layer.time = isLoop ? start % layer.getClip().duration : Math.min(start, layer.getClip().duration - 1e-3);
    layer.setEffectiveTimeScale(1).setEffectiveWeight(1);
    layer.paused = false;
    if (fade > 0) layer.fadeIn(fade);
    layer.play();
    // Swap the locomotion to its lower-body variant, keeping the phase.
    if (!wasLayered) this.swapLocomotion(this.actionFor(this.currentSlot), fade);
    return true;
  }

  /**
   * End the inspection layer (one-shot finished / cancel / replaced): the
   * full locomotion variant of the current slot comes back at the same
   * phase and the layer fades out.
   */
  private dropInspectLayer(fade: number): void {
    const layer = this.inspectLayer;
    if (!layer) return;
    layer.onFinished = null;
    this.inspectLayer = null;
    if (fade > 0) layer.action.fadeOut(fade);
    else layer.action.stop();
    if (!this.override) this.swapLocomotion(this.actionFor(this.currentSlot), fade);
  }

  /**
   * Replace the running locomotion action by `next` at the SAME phase
   * (used by the layered inspection: full ↔ lower-body variants of one
   * slot share their duration, so the time carries over 1:1).
   */
  private swapLocomotion(next: THREE.AnimationAction, fade: number): void {
    if (next === this.current) return;
    const prev = this.current;
    next.reset();
    next.time = Math.min(prev.time, Math.max(0, next.getClip().duration - 1e-4));
    next.timeScale = prev.timeScale;
    next.paused = prev.paused;
    next.play();
    if (fade > 0) prev.crossFadeTo(next, fade, false);
    else prev.stop();
    this.current = next;
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
    const enteredAir = state === NetworkMovementState.AIRBORNE && state !== this.currentState;
    if (enteredAir) {
      this.jumpVariant++;
      this.jumpPose.start(verticalVelocity);
    }
    if (state === NetworkMovementState.SLIDING && state !== this.currentState) this.slidePose.start();

    // ---- FULL-BODY OVERRIDE: the clip has priority over the locomotion.
    // The real state keeps being tracked (slot bookkeeping only, no
    // crossfade) so the exit lands on the locomotion of the ACTUAL state.
    if (this.override) {
      if (state !== this.currentState) this.currentSlot = slotForState(state);
      this.currentState = state;
      if (this.currentSlot === "jump") this.jumpPose.update(dt, verticalVelocity);
      else if (this.currentSlot === "slide") this.slidePose.update(dt, horizontalSpeed);
      const ov = this.override;
      const clip = ov.action.getClip();
      const oneShot = ov.action.loop === THREE.LoopOnce;
      if (oneShot && ov.action.time >= clip.duration - 1e-4) {
        const cb = ov.onFinished;
        this.clearOverride(ov.exitFade);
        cb?.();
      }
      // Procedural spine offsets are SUSPENDED (the clip owns the torso);
      // the strafe leg-yaw eases back to 0 (the Root rotates visually in
      // Whirlwind — never rotated a second time here).
      this.revertSpineOffsets();
      const lk = 1 - Math.exp(-LEG_YAW_SMOOTHING * dt);
      this.smoothedLegYaw += (0 - this.smoothedLegYaw) * lk;
      this.model.rotation.y = this.smoothedLegYaw;
      this.mixer.update(dt);
      const k = 1 - Math.exp(-POSE_SMOOTHING * dt);
      const targetRaise = state === NetworkMovementState.SLIDING ? this.slideRaise : 0;
      this.smoothedRaise += (targetRaise - this.smoothedRaise) * k;
      this.model.position.y = this.modelRestY + this.smoothedRaise;
      return;
    }

    // ---- LAYERED INSPECTION end: the upper one-shot ran out → the full
    // locomotion variant comes back (the real state is untouched).
    if (this.inspectLayer) {
      const layer = this.inspectLayer;
      const oneShot = layer.action.loop === THREE.LoopOnce;
      if (oneShot && layer.action.time >= layer.action.getClip().duration - 1e-4) {
        const cb = layer.onFinished;
        this.dropInspectLayer(layer.exitFade);
        cb?.();
      }
    }

    if (state !== this.currentState) this.transitionTo(state);
    this.currentState = state;
    if (this.currentSlot === "jump") {
      if (this.jumpPose.update(dt, verticalVelocity)) {
        this.jumpVariant++;
        this.refreshCurrentSlot(0.05);
      }
      this.current.time = this.jumpPose.time;
      this.current.paused = true; // sampled explicitly, never runs into landing in air
    } else if (this.currentSlot === "land" && this.current.time >= JUMP_POSE.recovery) {
      this.transitionTo(state);
    }

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

    if (this.currentSlot === "slide") {
      this.slidePose.update(dt, horizontalSpeed);
      this.current.time = this.slidePose.time;
      this.current.paused = true; // sample the central loop, never repeat entry
    } else if (this.currentSlot === "slideExit") {
      this.slidePose.updateRecovery(dt);
      this.current.time = this.slidePose.time;
      this.current.paused = true;
      if (this.slidePose.time >= SLIDE_POSE.recovery) this.transitionTo(state);
    }

    // UNDO last frame's procedural spine offsets BEFORE the mixer runs:
    // clips that don't carry a track for a given spine bone leave it
    // untouched, so the leftover "+=" from the previous frame would stack
    // forever (the continuous-roll bug). Reverting first makes the offsets
    // truly per-frame for tracked AND untracked bones alike (tracked bones
    // simply get overwritten by the mixer right after — harmless).
    this.revertSpineOffsets();

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

    // The new descent pose already owns its small torso inclination.
    const fallLean = 0;

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
    // SLIDING + DASHING: procedural pitch/lean/counter-twist are DISABLED —
    // the body is pitched near-horizontal by these clips, so layering the
    // aim pitch on top breaks the pose. AIRBORNE keeps the procedural
    // pitch: the head must HOLD the aim direction through a jump instead
    // of snapping back to the raw Jump-clip pose. Safe since the
    // per-frame offsets are reverted before every mixer update — they can
    // never accumulate on top of the clip (see appliedSpineX/Y).
    const proceduralSpineOff =
      state === NetworkMovementState.SLIDING ||
      this.currentSlot === "slideExit" ||
      state === NetworkMovementState.DASHING;
    if (n > 0 && !proceduralSpineOff) {
      const perBonePitch = (this.smoothedPitch * cfg.remotePitchBoneSign) / n;
      const perBoneLean = (this.smoothedLean + fallLean) / n;
      // Counter-twist: the LEGS (model root) turned by smoothedLegYaw —
      // the torso twists back so the chest/weapon keep facing the aim.
      const perBoneTwist = -this.smoothedLegYaw / n;
      for (let i = 0; i < n; i++) {
        const bone = this.spineBones[i];
        const offX = perBonePitch + perBoneLean;
        const offY = perBoneTwist !== 0 ? perBoneTwist * this.spineTwistSigns[i] : 0;
        bone.rotation.x += offX;
        bone.rotation.y += offY;
        // Remember the exact offsets so next frame reverts them BEFORE the
        // mixer — bones without a track in the active clips never stack.
        this.appliedSpineX[i] = offX;
        this.appliedSpineY[i] = offY;
      }
    }
  }

  dispose(): void {
    if (this.override) this.override.onFinished = null;
    this.override = null;
    if (this.inspectLayer) this.inspectLayer.onFinished = null;
    this.inspectLayer = null;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
  }

  // ------------------------------------------------------------------

  /** Undo the procedural spine offsets applied last frame (see fields). */
  private revertSpineOffsets(): void {
    for (let i = 0; i < this.spineBones.length; i++) {
      const bone = this.spineBones[i];
      bone.rotation.x -= this.appliedSpineX[i];
      bone.rotation.y -= this.appliedSpineY[i];
      this.appliedSpineX[i] = 0;
      this.appliedSpineY[i] = 0;
    }
  }

  /** Action for a slot under the CURRENT armed profile / aiming presentation. */
  private actionFor(slot: Slot): THREE.AnimationAction {
    const profile = this.armedProfile ? this.profileSets.get(this.armedProfile) ?? null : null;
    const hex = this.armedProfile === HEXSNIPER_PROFILE_ID;
    // Layered inspection running → lower-body variants of the profile set.
    const lower = this.inspectLayer && profile?.lowerSlots ? profile : null;
    if (slot === "jump" || slot === "land") {
      const list = slot === "jump"
        ? (lower ? lower.lowerJumps : profile ? profile.jumps : hex ? this.jumpsArmed : this.jumpsUnarmed)
        : (lower ? lower.lowerLandings : profile ? profile.landings : hex ? this.landingsArmed : this.landingsUnarmed);
      return list[Math.max(0, this.jumpVariant) % list.length];
    }
    if (lower) return lower.lowerSlots![slot];
    if (profile) return profile.slots[slot];
    if (!hex) return this.unarmed[slot];
    if (slot === "idle" && this.aiming) return this.armedAim;
    return this.armedSet[slot];
  }

  /** Re-resolve the current slot's action after an armed/aiming change. */
  private refreshCurrentSlot(fade = FADE.idle): void {
    if (this.override) return; // the override keeps the body until it ends
    const next = this.actionFor(this.currentSlot);
    if (next === this.current) return;
    next.reset();
    this.seekEntry(next);
    next.play();
    this.current.crossFadeTo(next, fade, false);
    this.current = next;
  }

  /** Start one-shot clips past their grounded anticipation frames. */
  private seekEntry(action: THREE.AnimationAction): void {
    if (this.currentSlot === "jump") {
      action.time = this.jumpPose.time;
      action.paused = true;
    } else if (this.currentSlot === "land") {
      action.time = JUMP_POSE.preLand;
      action.timeScale = 1.8; // brief compression; next jump can interrupt immediately
    }
    if (this.currentSlot === "slide" || this.currentSlot === "slideExit") {
      action.time = this.slidePose.time;
      action.paused = true;
    }
    // Slide starts at 0; changing weapon presentation keeps its current phase.
    // Dash starts at 0: the clip is the dash action itself.
  }

  private transitionTo(state: NetworkMovementState): void {
    let slot: Slot = slotForState(state);
    let fade: number;
    switch (slot) {
      case "run":
        fade = FADE.run;
        break;
      case "dash":
        // Real Dash clip — even when the dash starts mid-air (the sender's
        // state machine already prioritizes DASHING over !grounded).
        fade = FADE.dash;
        break;
      case "jump":
        fade = FADE.jump;
        break;
      case "slide":
        fade = FADE.slide;
        break;
      default:
        fade = FADE.idle;
        break;
    }
    const wasAirborne = this.currentSlot === "jump";
    if (wasAirborne && (slot === "idle" || slot === "run")) {
      slot = "land";
      fade = 0.045;
    }
    if (this.currentSlot === "slide" && this.slidePose.time >= SLIDE_POSE.loopStart &&
        (slot === "idle" || slot === "run")) {
      slot = "slideExit";
      this.slidePose.recover();
      fade = 0.075; // blend out from the actual loop phase, then recover
    }
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

/** Base locomotion slot of a network movement state. */
function slotForState(state: NetworkMovementState): Slot {
  switch (state) {
    case NetworkMovementState.RUNNING:
      return "run";
    case NetworkMovementState.DASHING:
      return "dash";
    case NetworkMovementState.AIRBORNE:
      return "jump";
    case NetworkMovementState.SLIDING:
      return "slide";
    default:
      return "idle";
  }
}

/** Per-avatar actions of one armed profile (built once in the constructor). */
interface ProfileActionSet {
  slots: Record<Slot, THREE.AnimationAction>;
  jumps: THREE.AnimationAction[];
  landings: THREE.AnimationAction[];
  equip: THREE.AnimationAction | null;
  unequip: THREE.AnimationAction | null;
  inspect: THREE.AnimationAction | null;
  /** Layered inspection (null → full-body `inspect` override). */
  inspectUpper: THREE.AnimationAction | null;
  /** Lower-body locomotion variants played under `inspectUpper`. */
  lowerSlots: Record<Slot, THREE.AnimationAction> | null;
  lowerJumps: THREE.AnimationAction[];
  lowerLandings: THREE.AnimationAction[];
  actions: Map<string, THREE.AnimationAction>;
  /** Action keys played as an UPPER layer over the lower-body locomotion. */
  layeredActions: Set<string>;
}

/** Wrap an unbounded angle into [-PI, PI]. */
function wrapAngle(angle: number): number {
  let a = angle % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}
