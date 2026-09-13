import * as THREE from "three";
import {
  GoofyBasketPresentation,
  createBasketPose,
  type BasketPose,
  type BasketView,
  type BasketCurveLibrary,
  type BasketSample,
} from "./GoofyBasketPresentation";
import type { GoofyClipKind } from "./GoofyBasketProfile";

/** Where the displayed ball pose comes from this frame. */
type BallSource = "none" | "grip" | "curve" | "gather";

/** Clip kinds whose FREE ball portions dribble on the ground (floor-corrected). */
const GROUND_KINDS = new Set<GoofyClipKind>(["Run", "Dribble", "Dribble_Start", "Dribble_Catch", "Inspect"]);
/** Pose handoff blend when the ball source switches (grip ↔ curve), seconds. */
const HANDOFF_SECONDS = 0.1;
/** Above this world offset the local floor is incompatible → the ball is kept in hand. */
const MAX_FLOOR_CORRECTION = 1.0;

/** Resolution of an arms clip name to its authored ball curve. */
export interface BallClipInfo {
  /** Full curve name in the motion library (view-prefixed), or null = no curve (ball in hand). */
  curve: string | null;
  kind: GoofyClipKind | null;
  /** Curve time = arms clip time × timeScale (retimed TP composites). */
  timeScale: number;
}

export interface BallDriverInput {
  /** Arms presentation clock: the clip driving the arms + its local time. */
  clip: string | null;
  time: number;
  /** Grip matrix (Weapon_R × mount) expressed in the ball parent's space, or null. */
  grip: THREE.Matrix4 | null;
  /** Ball parent → world matrix (for the floor correction). */
  parentToWorld: THREE.Matrix4;
  /** World Y of the local floor under the character, or null (airborne / unknown). */
  floorWorldY: number | null;
}

function copyPose(from: BasketPose, to: BasketPose): void {
  to.position[0] = from.position[0];
  to.position[1] = from.position[1];
  to.position[2] = from.position[2];
  to.quaternion[0] = from.quaternion[0];
  to.quaternion[1] = from.quaternion[1];
  to.quaternion[2] = from.quaternion[2];
  to.quaternion[3] = from.quaternion[3];
  to.visible = from.visible;
  to.attached = from.attached;
}

/**
 * Drives ONE cosmetic ball instance of a view (FP or TP) from the arms
 * presentation clock:
 *   - authored `attached` samples → the ball follows the REAL animated grip
 *     (Weapon_R × mount, full matrix incl. the ball scale);
 *   - authored free samples (dribble bounces, Catch descent) → the curve
 *     pose in the parent space (× freePresentationScale);
 *   - any interruption while the ball is free → Gather toward the moving
 *     grip (helper beginGather / sampleGather);
 *   - every visible/attached crossing of (previous, current] is reported
 *     through `onStateChange` (long frames included) with a per-phase cursor.
 * The driver never advances a clock of its own: the caller passes the arms
 * clip + time (one mixer per view). Never allocates per frame.
 */
export class GoofyBasketBallDriver {
  /** Cosmetic contact / release / catch notifications (audio, VFX). */
  onStateChange: ((sample: Readonly<BasketSample>, kind: GoofyClipKind | null) => void) | null = null;

  private readonly sampled = createBasketPose();
  private readonly displayed = createBasketPose();
  private readonly gripPose = createBasketPose();
  private readonly gatherOut = createBasketPose();
  private readonly previous = createBasketPose();
  private source: BallSource = "none";
  private lastClip: string | null = null;
  private lastCurveTime = 0;
  private readonly displayedVel = new THREE.Vector3();
  private clock = 0;
  /** Handoff offset (old displayed − new source) decaying to zero after a source switch. */
  private readonly handoffPos = new THREE.Vector3();
  private readonly handoffQuat = new THREE.Quaternion();
  private handoffT = HANDOFF_SECONDS;
  private floorIncompatible = false;
  /** Per-curve lowest free sample position (ground correction reference). */
  private readonly lowestFree = new Map<string, THREE.Vector3 | null>();

  // Scratch
  private readonly m = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly q2 = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();

  constructor(
    private readonly view: BasketView,
    private readonly presentation: GoofyBasketPresentation,
    private readonly library: BasketCurveLibrary,
    /** The single cosmetic ball of this view (already parented). */
    readonly ball: THREE.Object3D,
    /** Scale of the FREE ball in the parent space (0.88). */
    private readonly freeScale: number,
    /** Ball radius in the PARENT space when free (0.125 × freeScale). */
    private readonly freeRadiusParent: number,
    private readonly resolve: (clip: string) => BallClipInfo,
  ) {
    ball.matrixAutoUpdate = false;
    ball.visible = false;
  }

  /** True while the displayed ball is NOT in the hand (free curve / gather). */
  get isFree(): boolean {
    return this.source === "curve" || this.source === "gather";
  }

  /** True while a gather toward the grip is running. */
  get gathering(): boolean {
    return this.source === "gather";
  }

  /** Displayed pose (parent space) — read-only. */
  get pose(): Readonly<BasketPose> {
    return this.displayed;
  }

  /** Death / switch / reset: hide the ball, drop gathers and cursors. */
  reset(): void {
    this.presentation.reset(this.view);
    this.source = "none";
    this.lastClip = null;
    this.lastCurveTime = 0;
    this.previous.visible = false;
    this.displayed.visible = false;
    this.handoffT = HANDOFF_SECONDS;
    this.floorIncompatible = false;
    this.ball.visible = false;
  }

  /**
   * Force a gather from the CURRENT displayed pose toward the grip (an
   * interruption decided by the weapon controller: charge / throw entry
   * while dribbling). No-op when the ball is already in hand or hidden.
   */
  gatherNow(duration: number): void {
    if (this.source !== "curve" || !this.displayed.visible) return;
    this.beginGather(duration);
    this.source = "gather";
  }

  update(dt: number, input: BallDriverInput): void {
    this.clock += Math.max(0, dt);
    const info = input.clip ? this.resolve(input.clip) : null;
    const clipChanged = input.clip !== this.lastClip;
    copyPose(this.displayed, this.previous);

    // ---- Grip pose (parent space) from the REAL animated socket ----
    const hasGrip = input.grip !== null;
    if (input.grip) {
      input.grip.decompose(this.v, this.q, this.s);
      this.gripPose.position[0] = this.v.x;
      this.gripPose.position[1] = this.v.y;
      this.gripPose.position[2] = this.v.z;
      this.gripPose.quaternion[0] = this.q.x;
      this.gripPose.quaternion[1] = this.q.y;
      this.gripPose.quaternion[2] = this.q.z;
      this.gripPose.quaternion[3] = this.q.w;
      this.gripPose.visible = true;
      this.gripPose.attached = true;
    }

    // ---- Authored sample of the current clip at the arms time ----
    let curveName: string | null = null;
    let kind: GoofyClipKind | null = null;
    if (info?.curve) {
      curveName = info.curve;
      kind = info.kind;
      const curveTime = input.time * info.timeScale;
      this.presentation.sample(this.view, curveName, curveTime, this.sampled);
      if (clipChanged) {
        this.lastCurveTime = curveTime; // new cursor: never replays the previous phase
        this.floorIncompatible = false;
      } else if (curveTime > this.lastCurveTime && this.onStateChange) {
        // Every visible/attached crossing in (previous, current] — long frames too.
        this.presentation.forEachStateChange(this.view, curveName, this.lastCurveTime, curveTime, (_t, sample) => {
          this.onStateChange?.(sample, kind);
        });
      }
      if (curveTime >= this.lastCurveTime) this.lastCurveTime = curveTime;
    } else {
      // No curve for this clip (composite jump / dash / slide…): ball in hand.
      this.sampled.visible = hasGrip;
      this.sampled.attached = true;
      if (clipChanged) this.floorIncompatible = false;
    }
    this.lastClip = input.clip;

    const want = this.decideSource(hasGrip, curveName, clipChanged);
    this.resolveDisplayed(want, hasGrip);
    this.applyHandoff(dt);
    if (this.source === "curve" && kind && GROUND_KINDS.has(kind) && curveName && input.floorWorldY !== null) {
      this.applyFloorCorrection(curveName, input, hasGrip);
    }
    this.writeTransform(input);

    // ---- Displayed velocity (parent space) for the next gather ----
    if (this.previous.visible && this.displayed.visible && dt > 1e-6) {
      this.displayedVel
        .set(this.displayed.position[0], this.displayed.position[1], this.displayed.position[2])
        .sub(this.v.set(this.previous.position[0], this.previous.position[1], this.previous.position[2]))
        .multiplyScalar(1 / dt);
    } else {
      this.displayedVel.set(0, 0, 0);
    }
  }


  // ------------------------------------------------------------------

  /** Pick this frame's source and start gathers / handoffs on transitions. */
  private decideSource(hasGrip: boolean, curveName: string | null, clipChanged: boolean): BallSource {
    let want: BallSource = this.sampled.attached || this.floorIncompatible ? "grip" : "curve";
    if (!hasGrip) want = curveName ? "curve" : "none";
    const wasFreeCurve = this.source === "curve" && this.previous.visible;

    if (this.source === "gather") {
      // A running gather continues toward the moving grip until complete —
      // unless a NEW logical free ball starts (Catch from above): the curve wins.
      const freshFree = want === "curve" && this.sampled.visible && clipChanged;
      if (freshFree) this.presentation.cancelGather(this.view);
      else return "gather";
    } else if (wasFreeCurve && want === "grip" && this.sampled.visible && (clipChanged || this.floorIncompatible)) {
      // Interrupted while free (clip change to a held phase, incompatible
      // floor) → gather from the ACTUAL displayed pose toward the grip.
      this.beginGather(undefined);
      return "gather";
    } else if (wasFreeCurve && want === "grip" && this.sampled.visible) {
      // Authored hand contact at the end of a free portion: short handoff
      // (the curve ends at the authored grip; the real grip may differ a bit).
      this.startHandoff(this.gripPose);
    } else if (wasFreeCurve && clipChanged && want === "curve" && this.sampled.visible) {
      // Free → another free phase (Run ↔ Dribble seam, Inspect): handoff blend.
      this.startHandoff(this.sampled);
    } else if (this.source === "grip" && want === "curve" && this.sampled.visible && this.previous.visible) {
      // Hand → free: the authored release point vs the real grip.
      this.startHandoff(this.sampled);
    }
    return want;
  }

  private resolveDisplayed(want: BallSource, hasGrip: boolean): void {
    if (want === "gather") {
      const r = this.presentation.sampleGather(this.view, this.clock, this.gripPose, this.gatherOut);
      if (r === "gathering") {
        copyPose(this.gatherOut, this.displayed);
        this.displayed.attached = false;
        this.source = "gather";
        return;
      }
      want = hasGrip ? "grip" : "none"; // ends AT the grip: no handoff needed
    }
    if (want === "grip") {
      copyPose(this.gripPose, this.displayed);
      this.displayed.visible = this.sampled.visible;
    } else if (want === "curve") {
      copyPose(this.sampled, this.displayed);
    } else {
      this.displayed.visible = false;
    }
    this.source = want;
  }

  /** Decaying (old displayed − new source) offset: a source switch never pops. */
  private applyHandoff(dt: number): void {
    if (this.handoffT >= HANDOFF_SECONDS || (this.source !== "grip" && this.source !== "curve")) return;
    this.handoffT = Math.min(HANDOFF_SECONDS, this.handoffT + dt);
    const u = this.handoffT / HANDOFF_SECONDS;
    const keep = 1 - u * u * (3 - 2 * u);
    this.displayed.position[0] += this.handoffPos.x * keep;
    this.displayed.position[1] += this.handoffPos.y * keep;
    this.displayed.position[2] += this.handoffPos.z * keep;
    const dq = this.displayed.quaternion;
    this.q.set(dq[0], dq[1], dq[2], dq[3]);
    this.q2.copy(this.handoffQuat).multiply(this.q); // offset × source
    this.q2.slerp(this.q, 1 - keep);
    dq[0] = this.q2.x;
    dq[1] = this.q2.y;
    dq[2] = this.q2.z;
    dq[3] = this.q2.w;
  }

  private writeTransform(input: BallDriverInput): void {
    this.ball.visible = this.displayed.visible;
    if (!this.displayed.visible) return;
    if (this.source === "grip" && input.grip && this.handoffT >= HANDOFF_SECONDS) {
      // Full mount matrix: the ball scale is ALREADY inside (never × 0.88 again).
      this.ball.matrix.copy(input.grip);
    } else {
      const p = this.displayed.position;
      const r = this.displayed.quaternion;
      this.v.set(p[0], p[1], p[2]);
      this.q.set(r[0], r[1], r[2], r[3]);
      if (this.source === "grip" && input.grip) input.grip.decompose(this.v2, this.q2, this.s);
      else this.s.setScalar(this.freeScale);
      this.ball.matrix.compose(this.v, this.q, this.s);
    }
    this.ball.matrixWorldNeedsUpdate = true;
  }

  private beginGather(duration: number | undefined): void {
    this.presentation.beginGather(this.view, this.displayed, this.clock, {
      duration,
      initialVelocity: [this.displayedVel.x, this.displayedVel.y, this.displayedVel.z],
    });
    this.handoffT = HANDOFF_SECONDS; // a gather owns the continuity itself
  }

  /** Remember (previous displayed − new source pose) for the decaying handoff. */
  private startHandoff(src: BasketPose): void {
    if (!this.previous.visible || !src.visible) return;
    this.handoffPos.set(
      this.previous.position[0] - src.position[0],
      this.previous.position[1] - src.position[1],
      this.previous.position[2] - src.position[2],
    );
    const a = src.quaternion;
    const b = this.previous.quaternion;
    this.q.set(a[0], a[1], a[2], a[3]);
    this.q2.set(b[0], b[1], b[2], b[3]);
    this.handoffQuat.copy(this.q2).multiply(this.q.invert()); // delta × src = previous
    this.handoffT = 0;
  }


  /**
   * Cosmetic ground fit: the authored dribble touches the authored floor;
   * the REAL floor under the character may differ (stairs, slopes). The
   * correction is weighted 0 at the hand → 1 at the authored lowest point
   * (world heights), so hand contacts stay exact while the bounce bottom
   * meets the real ground. An incompatible floor (> 1 m off / none) brings
   * the ball back to the hand. Never moves the arm.
   */
  private applyFloorCorrection(curveName: string, input: BallDriverInput, hasGrip: boolean): void {
    const lowest = this.lowestFreeOf(curveName);
    if (!lowest) return;
    const worldScale = input.parentToWorld.getMaxScaleOnAxis();
    const rWorld = this.freeRadiusParent * worldScale;
    this.v2.copy(lowest).applyMatrix4(input.parentToWorld); // authored lowest center (world)
    const dy = input.floorWorldY! - (this.v2.y - rWorld);
    if (Math.abs(dy) > MAX_FLOOR_CORRECTION) {
      this.floorIncompatible = true;
      if (hasGrip && this.displayed.visible) {
        this.beginGather(undefined);
        this.source = "gather";
      }
      return;
    }
    if (Math.abs(dy) < 1e-4) return;
    const p = this.displayed.position;
    this.v.set(p[0], p[1], p[2]).applyMatrix4(input.parentToWorld);
    let w = 1;
    if (hasGrip) {
      const g = this.gripPose.position;
      this.v3.set(g[0], g[1], g[2]).applyMatrix4(input.parentToWorld);
      const span = this.v3.y - this.v2.y;
      w = span > 1e-4 ? THREE.MathUtils.clamp((this.v3.y - this.v.y) / span, 0, 1) : 1;
    }
    if (w <= 0) return;
    this.v.y += dy * w;
    this.m.copy(input.parentToWorld).invert();
    this.v.applyMatrix4(this.m);
    p[0] = this.v.x;
    p[1] = this.v.y;
    p[2] = this.v.z;
  }

  private lowestFreeOf(curveName: string): THREE.Vector3 | null {
    let cached = this.lowestFree.get(curveName);
    if (cached !== undefined) return cached;
    const clip = this.library.views[this.view].clips[curveName];
    cached = null;
    if (clip) {
      let best: THREE.Vector3 | null = null;
      for (const s of clip.samples) {
        if (s.attached || !s.visible) continue;
        if (!best || s.position[1] < best.y) best = new THREE.Vector3(s.position[0], s.position[1], s.position[2]);
      }
      cached = best;
    }
    this.lowestFree.set(curveName, cached);
    return cached;
  }
}

