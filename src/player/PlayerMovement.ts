import * as THREE from "three";
import { InputManager } from "../input/InputManager";
import { FPSCamera } from "../camera/FPSCamera";
import { PlayerController } from "./PlayerController";
import { MovementConfig as cfg } from "./MovementConfig";

export enum MoveState {
  GROUNDED = "GROUNDED",
  AIRBORNE = "AIRBORNE",
  SLIDING = "SLIDING",
  WALL_SLIDING = "WALL_SLIDING",
  DASHING = "DASHING",
}

/**
 * Momentum-based movement in the spirit of arena shooters:
 * quake-style ground/air acceleration, slides, slide hops,
 * wall slides and wall jumps — organized as a small state machine.
 */
export class PlayerMovement {
  state = MoveState.GROUNDED;
  readonly velocity = new THREE.Vector3();
  grounded = false;

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

  /** Horizontal speed just before the dash (used to preserve momentum on exit). */
  private preDashSpeed = 0;
  private readonly dashDir = new THREE.Vector3();

  private wallNormal = new THREE.Vector3();
  private touchingWall = false;

  // Scratch vectors (avoid per-frame allocations)
  private readonly wishDir = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly delta = new THREE.Vector3();
  private readonly corrected = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();

  constructor(
    private player: PlayerController,
    private input: InputManager,
    private fpsCamera: FPSCamera,
  ) {}

  get horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  get isDashing(): boolean {
    return this.state === MoveState.DASHING;
  }

  get dashCooldownRemaining(): number {
    return this.dashCooldownTimer;
  }

  get dashReady(): boolean {
    return this.dashCooldownTimer <= 0 && !this.isDashing;
  }

  update(dt: number): void {
    this.tickTimers(dt);
    this.readBufferedInputs();
    this.computeWishDir();

    // Dash triggers instantly from any state (except while already dashing).
    if (this.input.wasPressed("KeyE")) {
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
    }

    this.clampVelocity();
    this.applyMovement(dt);
    this.resolveStateTransitions(dt);
  }

  respawn(): void {
    this.player.respawn();
    this.velocity.set(0, 0, 0);
    this.state = MoveState.GROUNDED;
    this.wallSide = 0;
    this.coyoteTimer = 0;
    this.jumpBufferTimer = 0;
    this.slideTimer = 0;
    this.dashTimer = 0;
    this.dashCooldownTimer = 0;
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
  }

  private doWallJump(): void {
    // Push away from the wall, restore vertical impulse, keep tangential speed.
    this.velocity.addScaledVector(this.wallNormal, cfg.wallJumpHorizontalForce);
    this.velocity.y = cfg.wallJumpVerticalForce;
    this.wallRegrabTimer = cfg.wallRegrabLock;
    this.state = MoveState.AIRBORNE;
    this.wallSide = 0;
    this.consumeJump();
  }

  private tryStartDash(): void {
    if (this.dashCooldownTimer > 0 || this.state === MoveState.DASHING) return;

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
    this.state = MoveState.DASHING;
  }

  private endDash(): void {
    this.dashTimer = 0;

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
  }

  private endSlide(): void {
    this.player.setCrouched(false);
    this.slideCooldownTimer = cfg.slideCooldown;
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
    this.delta.copy(this.velocity).multiplyScalar(dt);
    this.player.move(this.delta, this.corrected);

    // Ignore ground contact while moving upward (e.g., the frame right after
    // a jump) — otherwise the state machine re-grounds and kills the jump.
    this.grounded = this.player.isGrounded() && this.velocity.y <= 0.1;
    if (this.grounded) {
      this.coyoteTimer = cfg.coyoteTime;
    }

    this.collectContacts();

    // Landing: kill downward velocity.
    if (this.grounded && this.velocity.y < 0) this.velocity.y = 0;
  }

  /**
   * Read the character controller's contacts:
   * project velocity out of obstacles and detect valid walls.
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
        this.touchingWall = true;
        this.wallNormal.copy(this.tmp).setY(0).normalize();
      }

      // Slide velocity along the obstacle so we don't accumulate speed into walls.
      const into = this.velocity.dot(this.tmp);
      if (into < 0) this.velocity.addScaledVector(this.tmp, -into);
    }
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