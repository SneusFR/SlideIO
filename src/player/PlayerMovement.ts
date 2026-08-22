import * as THREE from "three";
import { InputManager } from "../input/InputManager";
import { FPSCamera } from "../camera/FPSCamera";
import { PlayerController } from "./PlayerController";
import { RAPIER } from "../physics/PhysicsWorld";
import { PhaseDash, PhaseResult, PhaseAttemptDebug } from "./PhaseDash";
import { MovementConfig as cfg } from "./MovementConfig";
import { HammerConfig as hc } from "../weapons/HammerConfig";
import { SpearConfig as sc } from "../weapons/SpearConfig";
import { MoleStrikeConfig as mole } from "../killstreaks/mole/MoleStrikeConfig";

/** Fired once per successful wall traversal — consumed by Game for VFX. */
export interface PhaseEvent {
  entryPoint: THREE.Vector3;
  exitPoint: THREE.Vector3;
  travelDir: THREE.Vector3;
}

/**
 * Optional audio hooks fired by the movement state machine. Pure
 * observation: gameplay behaves EXACTLY the same with or without them.
 */
export interface MovementSfxListener {
  jump(): void;
  wallJump(): void;
  /** @param fallSpeed vertical speed (m/s, positive down) at touchdown. */
  land(fallSpeed: number): void;
  slideStart(): void;
  slideEnd(): void;
  dash(): void;
}

export enum MoveState {
  GROUNDED = "GROUNDED",
  AIRBORNE = "AIRBORNE",
  SLIDING = "SLIDING",
  WALL_SLIDING = "WALL_SLIDING",
  DASHING = "DASHING",
  /** Hammer Ground Slam: vertical charge toward the ground. */
  GROUND_SLAMMING = "GROUND_SLAMMING",
  /** Astral Lance charged rush: fast forward charge, tip-first. */
  SPEAR_RUSHING = "SPEAR_RUSHING",
  /** MOLE STRIKE: burrowed under the surface, free horizontal steering. */
  UNDERGROUND = "UNDERGROUND",
}

/** Why a spear rush ended — consumed once by the Game for feedback/cooldown. */
export type SpearRushEndReason = "TIMEOUT" | "WALL" | "HIT";

/**
 * Momentum-based movement in the spirit of arena shooters:
 * quake-style ground/air acceleration, slides, slide hops,
 * wall slides and wall jumps — organized as a small state machine.
 */
export class PlayerMovement {
  state = MoveState.GROUNDED;
  readonly velocity = new THREE.Vector3();
  grounded = false;

  /** Optional audio listener (assigned by the Game — never gameplay). */
  sfx: MovementSfxListener | null = null;

  /** -1 wall on the left of view, +1 on the right, 0 when not wall sliding. */
  wallSide = 0;

  // Timers (seconds remaining)
  private coyoteTimer = 0;
  private jumpBufferTimer = 0;
  private slideBufferTimer = 0;
  private slideAirTimer = 0;
  private slideTimer = 0;
  private slideCooldownTimer = 0;
  private wallSlideTimer = cfg.wallSlideDuration;
  private wallRegrabTimer = 0;
  private dashTimer = 0;
  private dashCooldownTimer = 0;

  // ---- Hammer Ground Slam (vertical charge, driven by the melee input) ----
  /** Short hang before the dive accelerates downward. */
  private slamWindupTimer = 0;
  /** Set on the frame the dive touches valid ground — consumed by the Game. */
  private slamImpactPending = false;
  private readonly slamImpactPos = new THREE.Vector3();

  // ---- Spear charged rush (forward charge, driven by the melee hold) ----
  private spearRushTimer = 0;
  /** Charge direction (mostly horizontal, lightly steerable). */
  readonly spearRushDir = new THREE.Vector3(0, 0, -1);
  private spearRushEndReason: SpearRushEndReason | null = null;

  // ---- Phase dash (dash through phaseable walls) ----
  private readonly phaseDash: PhaseDash;
  /** Tolerance window after the dash ends: contact still counts as a dash hit. */
  private phaseGraceTimer = 0;
  /** Visual phase effect timer — movement itself never pauses. */
  private phaseTimer = 0;
  /** Blocks instantly re-phasing right after a traversal. */
  private phaseReentryTimer = 0;
  private readonly phaseEvent: PhaseEvent = {
    entryPoint: new THREE.Vector3(),
    exitPoint: new THREE.Vector3(),
    travelDir: new THREE.Vector3(),
  };
  private phaseEventPending = false;

  /** Horizontal speed just before the dash (used to preserve momentum on exit). */
  private preDashSpeed = 0;
  private readonly dashDir = new THREE.Vector3();

  /**
   * LOCAL KNOCKDOWN (§ ragdoll): while > 0 the player has been physically
   * knocked down by a huge impact — every INPUT is suppressed (no wishdir
   * acceleration, no jump/slide/dash) while the physics keeps integrating
   * the knockback velocity, gravity and world collisions normally. The
   * FPS player has no visible body, so the readable result is "the impact
   * carries you and you can't fight it for a moment" — never a spinning
   * camera glued to a ragdoll head.
   */
  private knockdownTimer = 0;

  private wallNormal = new THREE.Vector3();
  private touchingWall = false;

  // Scratch vectors (avoid per-frame allocations)
  private readonly wishDir = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly delta = new THREE.Vector3();
  private readonly corrected = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();

  private readonly posScratch = new THREE.Vector3();
  private readonly probeDir = new THREE.Vector3();

  constructor(
    private player: PlayerController,
    private input: InputManager,
    private fpsCamera: FPSCamera,
  ) {
    this.phaseDash = new PhaseDash(player.physics, player);
  }

  get horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  get isDashing(): boolean {
    return this.state === MoveState.DASHING;
  }

  get isGroundSlamming(): boolean {
    return this.state === MoveState.GROUND_SLAMMING;
  }

  get isSpearRushing(): boolean {
    return this.state === MoveState.SPEAR_RUSHING;
  }

  get isUnderground(): boolean {
    return this.state === MoveState.UNDERGROUND;
  }

  /** Charge speed: reference is the NORMAL RUN SPEED (never hardcoded). */
  get spearRushSpeed(): number {
    return cfg.walkSpeed * sc.spearRushSpeedMultiplier;
  }

  get dashCooldownRemaining(): number {
    return this.dashCooldownTimer;
  }

  get dashReady(): boolean {
    return this.dashCooldownTimer <= 0 && !this.isDashing;
  }

  /** True while control is suppressed by a knockdown impact. */
  get isKnockedDown(): boolean {
    return this.knockdownTimer > 0;
  }

  /**
   * Knockdown: suppress player control for `duration` seconds. Movement
   * physics (velocity, gravity, collisions) keeps running untouched — the
   * impact's momentum carries the capsule naturally.
   */
  applyKnockdown(duration: number): void {
    this.knockdownTimer = Math.max(this.knockdownTimer, duration);
    // Interrupt committed special moves cleanly.
    if (this.state === MoveState.DASHING) this.dashTimer = 0;
    if (this.state === MoveState.SLIDING) this.endSlide();
    if (this.state === MoveState.SPEAR_RUSHING) this.endSpearRush("TIMEOUT");
  }

  /** True during the short visual phase window right after a traversal. */
  get isPhasing(): boolean {
    return this.phaseTimer > 0;
  }

  /** 1 → 0 over phaseDuration; drives the FOV punch / screen overlay. */
  get phaseIntensity(): number {
    return cfg.phaseDuration > 0 ? this.phaseTimer / cfg.phaseDuration : 0;
  }

  /** True while a dash-that-just-ended can still trigger a traversal. */
  get phaseGraceActive(): boolean {
    return !this.isDashing && this.phaseGraceTimer > 0;
  }

  /** Would a phaseable wall contact trigger a traversal right now? */
  get phaseEligible(): boolean {
    return (
      cfg.phaseTraversalEnabled &&
      (this.isDashing || this.phaseGraceTimer > 0) &&
      this.phaseTimer <= 0 &&
      this.phaseReentryTimer <= 0
    );
  }

  /** Debug info about the latest traversal attempt (dev HUD). */
  get phaseDebug(): PhaseAttemptDebug {
    return this.phaseDash.lastAttempt;
  }

  /** Returns the pending traversal event once, then null. */
  consumePhaseEvent(): PhaseEvent | null {
    if (!this.phaseEventPending) return null;
    this.phaseEventPending = false;
    return this.phaseEvent;
  }

  /**
   * Start the hammer Ground Slam: interrupt whatever aerial movement is in
   * progress and charge toward the ground. NOT a teleport — a strong
   * downward velocity with collisions fully active.
   * - An active dash burst is cleanly interrupted (cooldown untouched,
   *   NO phase grace granted: the slam can never phase through walls).
   * - Horizontal momentum is mostly dropped: this is a vertical charge.
   */
  startGroundSlam(): void {
    if (this.state === MoveState.GROUND_SLAMMING) return;

    if (this.state === MoveState.DASHING) {
      this.dashTimer = 0; // interrupt the burst; dash cooldown stays as-is
    }
    if (this.state === MoveState.SLIDING) {
      this.endSlide(); // safety (slam normally starts airborne)
    }
    this.wallSide = 0;
    this.phaseGraceTimer = 0; // §31: the slam is NOT a phase mechanic

    this.velocity.x *= hc.groundSlamHorizontalRetention;
    this.velocity.z *= hc.groundSlamHorizontalRetention;
    if (this.velocity.y > 0) this.velocity.y *= 0.3;

    this.slamWindupTimer = hc.groundSlamWindup;
    this.state = MoveState.GROUND_SLAMMING;
  }

  /** Returns the slam impact point once (feet position), then null. */
  consumeSlamImpact(): THREE.Vector3 | null {
    if (!this.slamImpactPending) return null;
    this.slamImpactPending = false;
    return this.slamImpactPos;
  }

  /**
   * Start the Astral Lance charged rush: charge in the direction the player
   * is looking at trigger time, at 2× normal run speed, for at most
   * spearRushMaxDuration seconds. Works exactly the same on the ground and
   * in the air (airborne stays airborne — never snapped to the ground).
   * NOT a dash: no phase grace is ever granted (§ Phase Walls).
   */
  startSpearRush(): void {
    if (this.state === MoveState.SPEAR_RUSHING) return;

    if (this.state === MoveState.DASHING) this.dashTimer = 0;
    if (this.state === MoveState.SLIDING) this.endSlide();
    this.wallSide = 0;
    this.phaseGraceTimer = 0; // the rush can NEVER phase through walls

    // Charge direction = camera look, with a clamped vertical component
    // (no "look at the sky → rocket launch").
    this.fpsCamera.getLookDirection(this.spearRushDir);
    this.spearRushDir.y = THREE.MathUtils.clamp(
      this.spearRushDir.y,
      -sc.spearRushMaxVerticalComponent,
      sc.spearRushMaxVerticalComponent,
    );
    this.spearRushDir.normalize();

    this.velocity.copy(this.spearRushDir).multiplyScalar(this.spearRushSpeed);
    this.spearRushTimer = sc.spearRushMaxDuration;
    this.spearRushEndReason = null;
    this.state = MoveState.SPEAR_RUSHING;
  }

  /** External stop (the tip connected with a combatant, wall impact...). */
  stopSpearRush(reason: SpearRushEndReason): void {
    if (this.state !== MoveState.SPEAR_RUSHING) return;
    this.endSpearRush(reason);
  }

  /** Returns why the rush ended ONCE, then null (Game feedback/cooldown). */
  consumeSpearRushEnd(): SpearRushEndReason | null {
    const reason = this.spearRushEndReason;
    this.spearRushEndReason = null;
    return reason;
  }

  /**
   * MOLE STRIKE dive: exit any special state cleanly and switch to the
   * UNDERGROUND state (standing capsule kept — the "underground" feel is
   * pure camera/VFX; collisions with walls and bounds stay fully active).
   */
  startUnderground(): void {
    if (this.state === MoveState.UNDERGROUND) return;

    if (this.state === MoveState.DASHING) this.dashTimer = 0;
    if (this.state === MoveState.SLIDING) this.endSlide();
    if (this.state === MoveState.SPEAR_RUSHING) this.endSpearRush("TIMEOUT");
    this.slamWindupTimer = 0;
    this.wallSide = 0;
    this.phaseGraceTimer = 0; // burrowing is NEVER a phase mechanic
    this.jumpBufferTimer = 0; // eat buffered inputs from before the dive
    this.slideBufferTimer = 0;

    this.state = MoveState.UNDERGROUND;
  }

  /** MOLE STRIKE emergence: hand control back to the normal state machine. */
  stopUnderground(): void {
    if (this.state !== MoveState.UNDERGROUND) return;
    this.state = this.grounded ? MoveState.GROUNDED : MoveState.AIRBORNE;
  }

  update(dt: number): void {
    this.tickTimers(dt);
    this.readBufferedInputs();
    this.computeWishDir();

    // KNOCKDOWN: control fully suppressed — the physics owns the capsule.
    if (this.knockdownTimer > 0) {
      this.knockdownTimer = Math.max(0, this.knockdownTimer - dt);
      this.jumpBufferTimer = 0;
      this.slideBufferTimer = 0;
      this.wishDir.set(0, 0, 0);
    }

    // Dash triggers instantly from any state (except while already dashing).
    // While UNDERGROUND, E means "emerge" (handled by the Game) — never dash.
    if (this.input.wasPressed("KeyE") && this.knockdownTimer <= 0) {
      this.tryStartDash();
    }

    switch (this.state) {
      case MoveState.GROUNDED:
        this.updateGrounded(dt);
        break;
      case MoveState.SLIDING:
        this.updateSliding(dt);
        break;
      case MoveState.AIRBORNE:
        this.updateAirborne(dt);
        break;
      case MoveState.WALL_SLIDING:
        this.updateWallSliding(dt);
        break;
      case MoveState.DASHING:
        this.updateDashing(dt);
        break;
      case MoveState.GROUND_SLAMMING:
        this.updateGroundSlamming(dt);
        break;
      case MoveState.SPEAR_RUSHING:
        this.updateSpearRushing(dt);
        break;
      case MoveState.UNDERGROUND:
        this.updateUnderground(dt);
        break;
    }

    this.clampVelocity();
    this.applyMovement(dt);
    this.resolveStateTransitions(dt);
  }

  respawn(pos?: { x: number; y: number; z: number }): void {
    this.player.respawn(pos);
    this.velocity.set(0, 0, 0);
    this.state = MoveState.GROUNDED;
    this.knockdownTimer = 0;
    this.wallSide = 0;
    this.coyoteTimer = 0;
    this.jumpBufferTimer = 0;
    this.slideTimer = 0;
    this.dashTimer = 0;
    this.dashCooldownTimer = 0;
    this.slamWindupTimer = 0;
    this.slamImpactPending = false;
    this.spearRushTimer = 0;
    this.spearRushEndReason = null;
    this.phaseGraceTimer = 0;
    this.phaseTimer = 0;
    this.phaseReentryTimer = 0;
    this.phaseEventPending = false;
  }

  // ------------------------------------------------------------------
  // Per-state updates
  // ------------------------------------------------------------------

  private updateGrounded(dt: number): void {
    // Jump before friction so a buffered bhop keeps its momentum.
    if (this.jumpBufferTimer > 0) {
      this.doJump();
      return;
    }

    // Start a slide? (buffered Shift press)
    if (
      this.slideBufferTimer > 0 &&
      this.slideCooldownTimer <= 0 &&
      this.horizontalSpeed > cfg.slideMinSpeed
    ) {
      this.startSlide();
      return;
    }

    this.applyFriction(dt, cfg.groundFriction);
    this.accelerate(this.wishDir, cfg.walkSpeed, cfg.groundAcceleration, dt);

    // Keep gently pressed on the ground so slopes/steps stay grounded.
    this.velocity.y = -2;
  }

  private updateSliding(dt: number): void {
    if (this.jumpBufferTimer > 0 && this.player.canStandUp()) {
      this.doSlideJump();
      return;
    }

    this.applyFriction(dt, cfg.slideFriction);
    this.steerSlide(dt);
    this.velocity.y = -2;

    const shouldEnd =
      this.slideTimer <= 0 ||
      !this.shiftHeld() ||
      this.horizontalSpeed < cfg.slideEndSpeed;

    if (shouldEnd && this.player.canStandUp()) {
      this.endSlide();
    }
  }

  private updateAirborne(dt: number): void {
    // Coyote jump
    if (this.jumpBufferTimer > 0 && this.coyoteTimer > 0) {
      this.doJump();
      return;
    }

    this.applyGravity(dt, cfg.gravity);

    // Direct air control: responsive but can't push past walkSpeed by itself.
    this.accelerate(this.wishDir, cfg.walkSpeed, cfg.airAcceleration, dt);
    // Quake-style strafe acceleration: tiny wish-speed cap → skilled strafing gains speed.
    this.accelerate(this.wishDir, cfg.airStrafeMaxWishSpeed, cfg.airStrafeAcceleration, dt);
  }

  private updateDashing(dt: number): void {
    this.dashTimer -= dt;

    // Heavily reduced (or zero) gravity: the dash keeps its altitude for its
    // very short window. We never fake grounded state — physics stays honest.
    this.applyGravity(dt, cfg.gravity * cfg.dashGravityScale);

    // Jump can cancel the dash (dash → jump / slide hop → dash → jump).
    if (this.jumpBufferTimer > 0 && (this.grounded || this.coyoteTimer > 0)) {
      this.endDash();
      this.doJump();
      return;
    }

    // Collisions naturally interrupt the dash: if walls scrubbed most of the
    // dash velocity, end it early instead of grinding along the obstacle.
    const alongDash = this.velocity.dot(this.dashDir);
    if (this.dashTimer <= 0 || alongDash < cfg.dashSpeed * cfg.dashMinSpeedFraction) {
      this.endDash();
    }
  }

  private updateGroundSlamming(dt: number): void {
    if (this.slamWindupTimer > 0) {
      // Brief hang: the hammer is raised, all momentum damps toward zero.
      this.slamWindupTimer -= dt;
      const damp = Math.max(0, 1 - 10 * dt);
      this.velocity.multiplyScalar(damp);
      return;
    }

    // Vertical charge: strong constant downward speed, collisions active.
    this.velocity.y = -hc.groundSlamSpeed;

    // Heavily reduced air control — the slam is a charge, not a free dash.
    this.accelerate(
      this.wishDir,
      cfg.walkSpeed * hc.groundSlamAirControl,
      cfg.airAcceleration * hc.groundSlamAirControl,
      dt,
    );
  }

  /**
   * Astral Lance charged rush: constant forward speed (2× run speed) with
   * a very light steering. RUSH COMMITTED — nothing cancels it except a
   * wall, a combatant hit (external stop) or the 5 s timeout.
   * Airborne: gravity influence is heavily reduced during the charge (short
   * anti-nosedive), and resumes normally the instant the rush ends.
   */
  private updateSpearRushing(dt: number): void {
    this.spearRushTimer -= dt;

    // Wall stop: the capsule touched a near-vertical surface (Rapier's
    // swept character controller — no tunneling), or the obstacle scrubbed
    // most of the charge velocity.
    const alongDir =
      this.velocity.x * this.spearRushDir.x + this.velocity.z * this.spearRushDir.z;
    const hSpeedRef = this.spearRushSpeed * Math.hypot(this.spearRushDir.x, this.spearRushDir.z);
    if (this.touchingWall || alongDir < hSpeedRef * sc.spearRushMinSpeedFraction) {
      this.endSpearRush("WALL");
      return;
    }

    // Automatic stop after the max duration — even with no obstacle.
    if (this.spearRushTimer <= 0) {
      this.endSpearRush("TIMEOUT");
      return;
    }

    // Very light steering toward the current view (horizontal only —
    // the general direction stays the one of the initial charge).
    this.fpsCamera.getLookDirection(this.tmp);
    const currentAngle = Math.atan2(this.spearRushDir.z, this.spearRushDir.x);
    const targetAngle = Math.atan2(this.tmp.z, this.tmp.x);
    let diff = targetAngle - currentAngle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const maxTurn = sc.spearRushSteering * dt;
    const angle = currentAngle + THREE.MathUtils.clamp(diff, -maxTurn, maxTurn);
    const hLen = Math.hypot(this.spearRushDir.x, this.spearRushDir.z);
    this.spearRushDir.x = Math.cos(angle) * hLen;
    this.spearRushDir.z = Math.sin(angle) * hLen;

    // Horizontal charge speed is enforced every frame (fixed 2× run speed —
    // no infinite stacking with slide-hop momentum).
    this.velocity.x = this.spearRushDir.x * this.spearRushSpeed;
    this.velocity.z = this.spearRushDir.z * this.spearRushSpeed;

    // Vertical: reduced gravity while airborne (short charge, not flight);
    // grounded charges just hug the floor like normal ground movement.
    if (this.grounded) {
      this.velocity.y = -2;
    } else {
      this.applyGravity(dt, cfg.gravity * sc.spearAirRushGravityScale);
    }
  }

  /** End the rush: keep a reasonable part of the speed — never a hard 0. */
  private endSpearRush(reason: SpearRushEndReason): void {
    this.spearRushTimer = 0;
    this.spearRushEndReason = reason;

    const keep = this.spearRushSpeed * sc.spearRushMomentumRetention;
    const h = this.horizontalSpeed;
    if (h > keep && h > 0.001) {
      const scale = keep / h;
      this.velocity.x *= scale;
      this.velocity.z *= scale;
    }

    // Gravity + the normal state machine resume immediately.
    this.state = this.grounded ? MoveState.GROUNDED : MoveState.AIRBORNE;
  }

  /**
   * MOLE STRIKE burrowing: direct, responsive horizontal steering at a
   * fixed speed, constantly pressed onto the ground. Jumps, slides and
   * dashes are unreachable from here (buffers are eaten every frame).
   */
  private updateUnderground(dt: number): void {
    this.jumpBufferTimer = 0;
    this.slideBufferTimer = 0;

    // Quick exponential smoothing toward wishDir * burrow speed.
    const k = Math.min(1, 12 * dt);
    const tx = this.wishDir.x * mole.moleStrikeUndergroundSpeed;
    const tz = this.wishDir.z * mole.moleStrikeUndergroundSpeed;
    this.velocity.x += (tx - this.velocity.x) * k;
    this.velocity.z += (tz - this.velocity.z) * k;

    // Hug the ground (like normal grounded movement, slightly stronger).
    this.velocity.y = -3;
  }

  private updateWallSliding(dt: number): void {
    this.wallSlideTimer -= dt;

    // Wall jump
    if (this.jumpBufferTimer > 0) {
      this.doWallJump();
      return;
    }

    // Reduced gravity + capped fall speed while on the wall.
    this.applyGravity(dt, cfg.wallSlideGravity);
    if (this.velocity.y < -cfg.wallSlideMaxFallSpeed) {
      this.velocity.y = -cfg.wallSlideMaxFallSpeed;
    }

    // Gentle pull toward the wall to maintain contact.
    this.velocity.addScaledVector(this.wallNormal, -cfg.wallStickAccel * dt);

    // A little steering along the wall.
    this.accelerate(this.wishDir, cfg.walkSpeed, cfg.airAcceleration * 0.5, dt);
  }

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  private doJump(): void {
    this.velocity.y = cfg.jumpForce;
    this.consumeJump();
    this.sfx?.jump();
  }

  private doSlideJump(): void {
    // Slide hop: keep the slide's horizontal momentum and add a boost.
    const speed = this.horizontalSpeed;
    if (speed > 0.01) {
      const boost = cfg.slideJumpBoost * this.boostScale(speed);
      const inv = 1 / speed;
      this.velocity.x += this.velocity.x * inv * boost;
      this.velocity.z += this.velocity.z * inv * boost;
    }
    this.velocity.y = cfg.jumpForce;
    this.endSlide();
    this.consumeJump();
    this.sfx?.jump();
  }

  private doWallJump(): void {
    // Push away from the wall, restore vertical impulse, keep tangential speed.
    this.velocity.addScaledVector(this.wallNormal, cfg.wallJumpHorizontalForce);
    this.velocity.y = cfg.wallJumpVerticalForce;
    this.wallRegrabTimer = cfg.wallRegrabLock;
    this.state = MoveState.AIRBORNE;
    this.wallSide = 0;
    this.consumeJump();
    this.sfx?.wallJump();
  }

  private tryStartDash(): void {
    if (this.dashCooldownTimer > 0 || this.state === MoveState.DASHING) return;
    // No dashing out of a Ground Slam: the vertical charge must complete.
    if (this.state === MoveState.GROUND_SLAMMING) return;
    // RUSH COMMITTED: the spear charge cannot be canceled into a dash.
    if (this.state === MoveState.SPEAR_RUSHING) return;
    // Burrowed: E requests the emergence instead — never a dash.
    if (this.state === MoveState.UNDERGROUND) return;

    // Dashing out of a slide: stand back up first (skip if blocked by a ceiling).
    if (this.state === MoveState.SLIDING) {
      if (!this.player.canStandUp()) return;
      this.endSlide();
    }

    // Full 3D view direction (includes pitch): dash goes exactly where you look.
    this.fpsCamera.getLookDirection(this.dashDir);
    this.preDashSpeed = this.horizontalSpeed;

    // Momentum-aware impulse: keep part of the existing speed along the dash
    // direction on top of the base burst (diminishing via the exit cap, so
    // dash + slide hopping can't snowball into infinite acceleration).
    const along = Math.max(0, this.velocity.dot(this.dashDir));
    const burst = cfg.dashSpeed + along * cfg.dashMomentumRetention;
    this.velocity.copy(this.dashDir).multiplyScalar(burst);

    this.dashTimer = cfg.dashDuration;
    this.dashCooldownTimer = cfg.dashCooldown;
    this.wallSide = 0;
    this.phaseGraceTimer = 0;
    this.state = MoveState.DASHING;
    this.sfx?.dash();
  }

  private endDash(): void {
    this.dashTimer = 0;

    // Phase grace window: a wall touched within this short span after the
    // dash ends still triggers a traversal ("reached the wall thanks to
    // the dash"). This is a timing tolerance — never a speed condition.
    this.phaseGraceTimer = cfg.phaseGraceTime;

    // Momentum retention: fast players keep their pre-dash speed, slower
    // players exit with a moderate boost — never a hard reset to walk speed.
    const exitCap = Math.max(this.preDashSpeed, cfg.dashExitSpeed);
    const h = this.horizontalSpeed;
    if (h > exitCap) {
      const scale = exitCap / h;
      this.velocity.x *= scale;
      this.velocity.z *= scale;
    }
    if (this.velocity.y > cfg.dashExitMaxUpSpeed) {
      this.velocity.y = cfg.dashExitMaxUpSpeed;
    }

    // Gravity and normal movement resume; the state machine takes over again
    // (airborne → wall slide, landing → slide chaining, etc.).
    this.state = this.grounded ? MoveState.GROUNDED : MoveState.AIRBORNE;
  }

  private startSlide(): void {
    this.player.setCrouched(true);
    this.slideTimer = cfg.slideDuration;
    this.slideBufferTimer = 0;
    this.slideAirTimer = 0;
    this.velocity.y = -2;
    this.state = MoveState.SLIDING;

    // Slide boost along the current velocity, with diminishing returns.
    const speed = this.horizontalSpeed;
    if (speed > 0.01) {
      const boost = cfg.slideBoost * this.boostScale(speed);
      const inv = 1 / speed;
      this.velocity.x += this.velocity.x * inv * boost;
      this.velocity.z += this.velocity.z * inv * boost;
    }
    this.sfx?.slideStart();
  }

  private endSlide(): void {
    this.player.setCrouched(false);
    this.slideCooldownTimer = cfg.slideCooldown;
    if (this.state === MoveState.SLIDING) this.sfx?.slideEnd();
    if (this.state === MoveState.SLIDING) {
      this.state = this.grounded ? MoveState.GROUNDED : MoveState.AIRBORNE;
    }
  }

  private consumeJump(): void {
    this.jumpBufferTimer = 0;
    this.coyoteTimer = 0;
    this.grounded = false;
    if (this.state !== MoveState.AIRBORNE) this.state = MoveState.AIRBORNE;
  }

  // ------------------------------------------------------------------
  // Physics integration
  // ------------------------------------------------------------------

  private applyMovement(dt: number): void {
    // Phase dash: proactive probe just ahead of the capsule. Catching the
    // wall right before impact keeps the momentum 100% intact (the wall
    // never gets a chance to scrub velocity) and does not depend on the
    // character controller's collision report.
    if (this.tryProactivePhase(dt)) return;

    const wasGrounded = this.grounded;
    const fallSpeed = -this.velocity.y; // positive when falling

    this.delta.copy(this.velocity).multiplyScalar(dt);
    this.player.move(this.delta, this.corrected);

    // Ignore ground contact while moving upward (e.g., the frame right after
    // a jump) — otherwise the state machine re-grounds and kills the jump.
    this.grounded = this.player.isGrounded() && this.velocity.y <= 0.1;
    if (this.grounded) {
      this.coyoteTimer = cfg.coyoteTime;
    }

    // Landing feedback (the Ground Slam has its own dedicated impact sound).
    if (!wasGrounded && this.grounded && this.state !== MoveState.GROUND_SLAMMING) {
      this.sfx?.land(Math.max(0, fallSpeed));
    }

    this.collectContacts();

    // Landing: kill downward velocity.
    if (this.grounded && this.velocity.y < 0) this.velocity.y = 0;
  }

  /**
   * Raycast a short distance ahead along the current motion. If a valid
   * phaseable wall is about to be hit while the dash (or its grace
   * window) is active, traverse it immediately.
   * Authorization NEVER depends on speed — only on dash state + wall.
   */
  private tryProactivePhase(dt: number): boolean {
    if (!this.phaseEligible) return false;

    // Probe along the horizontal velocity; fall back to the dash
    // direction when nearly stationary (dash just started this frame).
    const d = this.probeDir.set(this.velocity.x, 0, this.velocity.z);
    if (d.lengthSq() < 0.01) d.set(this.dashDir.x, 0, this.dashDir.z);
    if (d.lengthSq() < 0.0001) return false;
    d.normalize();

    // Reach: capsule edge + this frame's travel + a small safety margin.
    const reach =
      cfg.capsuleRadius + Math.max(this.horizontalSpeed, 1) * dt + 0.15;

    const pos = this.player.getPosition(this.posScratch);
    const hit = this.player.physics.world.castRayAndGetNormal(
      new RAPIER.Ray(
        { x: pos.x, y: pos.y, z: pos.z },
        { x: d.x, y: d.y, z: d.z },
      ),
      reach,
      true,
      undefined,
      undefined,
      this.player.collider,
      this.player.body,
    );
    if (!hit || !hit.collider) return false;

    // Vertical surfaces only (the hit normal points back toward us).
    this.tmp.set(hit.normal.x, hit.normal.y, hit.normal.z);
    if (Math.abs(this.tmp.y) >= cfg.wallMaxNormalY) return false;
    this.tmp.setY(0).normalize();

    const res = this.phaseDash.tryPhase(hit.collider, pos, this.tmp);
    if (!res) return false;
    this.executePhase(res);
    return true;
  }

  /**
   * Read the character controller's contacts:
   * project velocity out of obstacles and detect valid walls.
   * Wall contacts made while dashing (or within the grace window) may
   * trigger a phase traversal instead of a normal collision.
   */
  private collectContacts(): void {
    this.touchingWall = false;
    const controller = this.player.controller;
    const n = controller.numComputedCollisions();

    for (let i = 0; i < n; i++) {
      const col = controller.computedCollision(i);
      if (!col) continue;

      // normal2 points from the obstacle toward the character.
      this.tmp.set(col.normal2.x, col.normal2.y, col.normal2.z);

      // Wall detection: near-vertical surfaces only.
      if (Math.abs(this.tmp.y) < cfg.wallMaxNormalY) {
        // Phase dash: authorization depends only on dash state + a valid
        // phaseable wall — NEVER on the player's speed.
        if (this.phaseEligible && col.collider) {
          this.wallNormal.copy(this.tmp).setY(0).normalize();
          const res = this.phaseDash.tryPhase(
            col.collider,
            this.player.getPosition(this.posScratch),
            this.wallNormal,
          );
          if (res) {
            // Traversal: skip the velocity scrub for this wall so the
            // player's momentum passes through 100% intact.
            this.executePhase(res);
            return;
          }
        }

        this.touchingWall = true;
        this.wallNormal.copy(this.tmp).setY(0).normalize();
      }

      // Slide velocity along the obstacle so we don't accumulate speed into walls.
      const into = this.velocity.dot(this.tmp);
      if (into < 0) this.velocity.addScaledVector(this.tmp, -into);
    }
  }

  /**
   * Execute a validated traversal: reposition the player on the far side
   * of the wall. Velocity is preserved (phaseMomentumRetention = 1 keeps
   * 100% of speed AND direction, including the vertical component), the
   * state machine is untouched (airborne stays airborne, an active dash
   * keeps dashing) and no collision is ever globally disabled.
   */
  private executePhase(res: PhaseResult): void {
    this.player.setNextPosition(res.exitPos.x, res.exitPos.y, res.exitPos.z);

    // Momentum: never reset, never recomputed — just carried through.
    this.velocity.multiplyScalar(cfg.phaseMomentumRetention);

    this.phaseTimer = cfg.phaseDuration;
    this.phaseReentryTimer = cfg.phaseDuration + cfg.phaseReentryCooldown;

    this.phaseEvent.entryPoint.copy(res.entryPoint);
    this.phaseEvent.exitPoint.copy(res.exitPoint);
    this.phaseEvent.travelDir.copy(res.travelDir);
    this.phaseEventPending = true;
  }

  private resolveStateTransitions(dt: number): void {
    switch (this.state) {
      case MoveState.GROUNDED:
        if (!this.grounded) {
          this.state = MoveState.AIRBORNE;
        }
        break;

      case MoveState.SLIDING:
        if (this.grounded) {
          this.slideAirTimer = 0;
        } else {
          // Grace window: a slide survives brief loss of ground contact.
          this.slideAirTimer += dt;
          if (this.slideAirTimer > cfg.slideAirGrace) {
            if (this.player.canStandUp()) this.player.setCrouched(false);
            this.slideCooldownTimer = cfg.slideCooldown;
            this.state = MoveState.AIRBORNE;
          }
        }
        break;

      case MoveState.AIRBORNE:
        if (this.grounded) {
          // Landing while holding Shift with speed → chain straight into a slide.
          if (
            this.shiftHeld() &&
            this.slideCooldownTimer <= 0 &&
            this.horizontalSpeed > cfg.slideMinSpeed
          ) {
            this.startSlide();
          } else {
            this.state = MoveState.GROUNDED;
          }
          this.wallSlideTimer = cfg.wallSlideDuration;
        } else if (this.canStartWallSlide()) {
          this.state = MoveState.WALL_SLIDING;
          this.updateWallSide();
        }
        break;

      case MoveState.WALL_SLIDING:
        if (this.grounded) {
          this.state = MoveState.GROUNDED;
          this.wallSide = 0;
          this.wallSlideTimer = cfg.wallSlideDuration;
        } else if (!this.touchingWall || this.wallSlideTimer <= 0) {
          this.state = MoveState.AIRBORNE;
          this.wallSide = 0;
        } else {
          this.updateWallSide();
        }
        break;

      case MoveState.DASHING:
        // Dash owns its own lifecycle (updateDashing); landing refreshes
        // the wall slide window like a normal touchdown.
        if (this.grounded) this.wallSlideTimer = cfg.wallSlideDuration;
        break;

      case MoveState.GROUND_SLAMMING:
        // The AoE triggers on REAL ground contact — never on a timer.
        if (this.grounded) {
          this.player.getPosition(this.slamImpactPos);
          this.slamImpactPos.y -= cfg.standHalfHeight + cfg.capsuleRadius; // feet
          this.slamImpactPending = true;

          // Weighty landing: kill most horizontal speed, eat buffered jumps.
          this.velocity.x *= hc.groundSlamLandingSpeedScale;
          this.velocity.z *= hc.groundSlamLandingSpeedScale;
          this.velocity.y = 0;
          this.jumpBufferTimer = 0;

          this.wallSlideTimer = cfg.wallSlideDuration;
          this.state = MoveState.GROUNDED;
        }
        // No wall-slide grabbing during the dive: slam → wall = plain collision.
        break;

      case MoveState.SPEAR_RUSHING:
        // The rush owns its own lifecycle (updateSpearRushing). Landing is
        // NEVER forced (air rush stays airborne); touching the ground during
        // a ground rush just refreshes the wall-slide window.
        if (this.grounded) this.wallSlideTimer = cfg.wallSlideDuration;
        break;

      case MoveState.UNDERGROUND:
        // Owned by MoleStrike (startUnderground/stopUnderground). Nothing
        // here may transition it — no wall slides, no landing chains.
        if (this.grounded) this.wallSlideTimer = cfg.wallSlideDuration;
        break;
    }
  }

  private canStartWallSlide(): boolean {
    return (
      this.touchingWall &&
      this.wallRegrabTimer <= 0 &&
      this.wallSlideTimer > 0 &&
      this.velocity.y < 3 &&
      this.horizontalSpeed > cfg.wallSlideMinSpeed
    );
  }

  private updateWallSide(): void {
    // Which side of the view is the wall on? (visual tilt only)
    this.fpsCamera.getRight(this.tmp);
    this.wallSide = this.tmp.dot(this.wallNormal) < 0 ? 1 : -1;
  }

  // ------------------------------------------------------------------
  // Velocity helpers (quake-style)
  // ------------------------------------------------------------------

  /** Classic accelerate: only adds speed along wishDir up to wishSpeed. */
  private accelerate(
    wishDir: THREE.Vector3,
    wishSpeed: number,
    accel: number,
    dt: number,
  ): void {
    if (wishDir.lengthSq() < 0.0001) return;
    const currentSpeed = this.velocity.x * wishDir.x + this.velocity.z * wishDir.z;
    const addSpeed = wishSpeed - currentSpeed;
    if (addSpeed <= 0) return;
    const accelSpeed = Math.min(accel * wishSpeed * dt, addSpeed);
    this.velocity.x += wishDir.x * accelSpeed;
    this.velocity.z += wishDir.z * accelSpeed;
  }

  private applyFriction(dt: number, friction: number): void {
    const speed = this.horizontalSpeed;
    if (speed < 0.001) {
      this.velocity.x = 0;
      this.velocity.z = 0;
      return;
    }
    const drop = speed * friction * dt;
    const scale = Math.max(speed - drop, 0) / speed;
    this.velocity.x *= scale;
    this.velocity.z *= scale;
  }

  private applyGravity(dt: number, gravity: number): void {
    this.velocity.y = Math.max(this.velocity.y - gravity * dt, -cfg.maxFallSpeed);
  }

  /** Small directional steering during a slide (no instant 180° turns). */
  private steerSlide(dt: number): void {
    if (this.wishDir.lengthSq() < 0.0001) return;
    const speed = this.horizontalSpeed;
    if (speed < 0.01) return;

    const currentAngle = Math.atan2(this.velocity.z, this.velocity.x);
    const targetAngle = Math.atan2(this.wishDir.z, this.wishDir.x);
    let diff = targetAngle - currentAngle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;

    const maxTurn = cfg.slideSteering * dt;
    const turn = THREE.MathUtils.clamp(diff, -maxTurn, maxTurn);
    const angle = currentAngle + turn;
    this.velocity.x = Math.cos(angle) * speed;
    this.velocity.z = Math.sin(angle) * speed;
  }

  /** Diminishing returns: boosts shrink as speed approaches the soft cap. */
  private boostScale(speed: number): number {
    const t = (speed - cfg.walkSpeed) / (cfg.softCapSpeed - cfg.walkSpeed);
    return THREE.MathUtils.clamp(1 - t, cfg.boostMinScale, 1);
  }

  private clampVelocity(): void {
    const speed = this.horizontalSpeed;
    if (speed > cfg.hardCapSpeed) {
      const scale = cfg.hardCapSpeed / speed;
      this.velocity.x *= scale;
      this.velocity.z *= scale;
    }
  }

  // ------------------------------------------------------------------
  // Input helpers
  // ------------------------------------------------------------------

  private tickTimers(dt: number): void {
    this.coyoteTimer = Math.max(0, this.coyoteTimer - dt);
    this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - dt);
    this.slideBufferTimer = Math.max(0, this.slideBufferTimer - dt);
    this.slideTimer = Math.max(0, this.slideTimer - dt);
    this.slideCooldownTimer = Math.max(0, this.slideCooldownTimer - dt);
    this.wallRegrabTimer = Math.max(0, this.wallRegrabTimer - dt);
    this.dashCooldownTimer = Math.max(0, this.dashCooldownTimer - dt);
    if (!this.isDashing) {
      this.phaseGraceTimer = Math.max(0, this.phaseGraceTimer - dt);
    }
    this.phaseTimer = Math.max(0, this.phaseTimer - dt);
    this.phaseReentryTimer = Math.max(0, this.phaseReentryTimer - dt);
  }

  private readBufferedInputs(): void {
    if (this.input.wasPressed("Space")) {
      this.jumpBufferTimer = cfg.jumpBufferTime;
    }
    if (this.input.wasPressed("ShiftLeft") || this.input.wasPressed("ShiftRight")) {
      this.slideBufferTimer = cfg.slideBufferTime;
    }
  }

  private shiftHeld(): boolean {
    return this.input.isDown("ShiftLeft") || this.input.isDown("ShiftRight");
  }

  private computeWishDir(): void {
    this.fpsCamera.getForward(this.fwd);
    this.fpsCamera.getRight(this.right);

    let f = 0;
    let s = 0;
    if (this.input.isDown("KeyW")) f += 1;
    if (this.input.isDown("KeyS")) f -= 1;
    if (this.input.isDown("KeyD")) s += 1;
    if (this.input.isDown("KeyA")) s -= 1;

    this.wishDir
      .set(0, 0, 0)
      .addScaledVector(this.fwd, f)
      .addScaledVector(this.right, s);
    if (this.wishDir.lengthSq() > 0.0001) this.wishDir.normalize();
  }
}