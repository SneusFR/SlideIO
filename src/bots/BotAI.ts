import * as THREE from "three";
import { RAPIER } from "../physics/PhysicsWorld";
import { CombatConfig as cc } from "../combat/CombatConfig";
import { Combatant } from "../combat/Combatant";
import { HeatSystem } from "../weapons/HeatSystem";
import type { Bot, BotContext } from "./Bot";

export type BotState = "ROAMING" | "ENGAGING" | "SEARCHING";

export interface BotAIOutput {
  wishDir: THREE.Vector3;
  wantJump: boolean;
  wantSlide: boolean;
  wantDash: boolean;
  dashDir: THREE.Vector3;
  wantFire: boolean;
  aimDir: THREE.Vector3;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * Medium-difficulty FFA brain: perception (FOV + LOS), short memory,
 * stable target selection, human-like reaction time, imperfect tracking
 * aim, combat strafing/sliding/dashing, heat management and grid
 * navigation with stuck recovery. All timings use real seconds.
 */
export class BotAI {
  state: BotState = "ROAMING";
  lookYaw: number;
  lookPitch = 0;

  readonly out: BotAIOutput = {
    wishDir: new THREE.Vector3(),
    wantJump: false,
    wantSlide: false,
    wantDash: false,
    dashDir: new THREE.Vector3(),
    wantFire: false,
    aimDir: new THREE.Vector3(0, 0, -1),
  };

  // ---- Per-bot personality (medium difficulty band) ----
  private readonly aimSpeed = rand(cc.botAimSpeedMin, cc.botAimSpeedMax);
  private readonly aimError = rand(cc.botAimErrorMin, cc.botAimErrorMax);
  private readonly preferredRange = rand(cc.botPreferredRangeMin, cc.botPreferredRangeMax);
  private readonly aggression = Math.random();
  private readonly heatHold = rand(cc.botHeatHoldMin, cc.botHeatHoldMax);
  private readonly heatResume = rand(cc.botHeatResumeMin, cc.botHeatResumeMax);

  // ---- Target / perception state ----
  private target: Combatant | null = null;
  private timeSinceSeen = 999;
  private readonly lastKnownPos = new THREE.Vector3();
  private reactionTimer = 0;
  private switchCooldown = 0;
  private perceptionTimer = Math.random() * cc.botPerceptionInterval;
  private targetVisible = false;
  private lastAttacker: Combatant | null = null;
  private attackedTimer = 999;
  private holdingFire = false;

  // ---- Movement state ----
  private readonly path: THREE.Vector3[] = [];
  private pathCount = 0;
  private pathIndex = 0;
  private pathTimer = 0;
  private readonly pathGoal = new THREE.Vector3();
  private hasGoal = false;
  private strafeSign = Math.random() < 0.5 ? -1 : 1;
  private strafeTimer = rand(cc.botStrafeIntervalMin, cc.botStrafeIntervalMax);
  private dashDecisionTimer = 0;
  private searchScanTimer = 0;
  private stuckTimer = 0;
  private readonly lastPos = new THREE.Vector3();
  private progressTimer = 0;

  // ---- Aim state ----
  private readonly aimErrorOffset = new THREE.Vector3();
  private aimErrorTimer = 0;

  // scratch
  private readonly selfPos = new THREE.Vector3();
  private readonly selfEye = new THREE.Vector3();
  private readonly otherPos = new THREE.Vector3();
  private readonly otherEye = new THREE.Vector3();
  private readonly toTarget = new THREE.Vector3();
  private readonly desiredAim = new THREE.Vector3();
  private readonly perp = new THREE.Vector3();
  private readonly moveDir = new THREE.Vector3();

  constructor(private readonly bot: Bot, spawnYaw: number) {
    this.lookYaw = spawnYaw;
  }

  reset(yaw: number): void {
    this.state = "ROAMING";
    this.target = null;
    this.targetVisible = false;
    this.timeSinceSeen = 999;
    this.pathCount = 0;
    this.hasGoal = false;
    this.lookYaw = yaw;
    this.lookPitch = 0;
    this.out.wantFire = false;
    this.stuckTimer = 0;
    this.attackedTimer = 999;
  }

  notifyDamaged(attacker: Combatant | null): void {
    if (attacker && attacker !== this.bot) {
      this.lastAttacker = attacker;
      this.attackedTimer = 0;
      // Occasional dodge dash reaction.
      if (
        this.dashDecisionTimer <= 0 &&
        Math.random() < cc.botDashOnDamageChance
      ) {
        this.out.wantDash = true;
        this.perp.set(-Math.cos(this.lookYaw), 0, Math.sin(this.lookYaw));
        this.out.dashDir.copy(this.perp).multiplyScalar(this.strafeSign);
        this.out.dashDir.y = 0.05;
        this.dashDecisionTimer = cc.botDashDecisionCooldown;
      }
    }
  }

  notifyHeat(heat: HeatSystem): void {
    // Sloppy heat management for low-aggression bots is handled in fire logic.
    if (heat.overheated) this.holdingFire = true;
    else if (this.holdingFire && heat.ratio < this.heatResume) this.holdingFire = false;
  }

  update(dt: number, ctx: BotContext): void {
    const out = this.out;
    out.wantJump = false;
    out.wantSlide = false;
    // wantDash may have been set by notifyDamaged — consumed by Bot each frame.

    this.bot.getPosition(this.selfPos);
    this.bot.getEyePosition(this.selfEye);

    this.perceptionTimer -= dt;
    this.switchCooldown = Math.max(0, this.switchCooldown - dt);
    this.dashDecisionTimer = Math.max(0, this.dashDecisionTimer - dt);
    this.reactionTimer = Math.max(0, this.reactionTimer - dt);
    this.attackedTimer += dt;
    this.timeSinceSeen += dt;
    this.pathTimer -= dt;

    if (this.perceptionTimer <= 0) {
      this.perceptionTimer = cc.botPerceptionInterval;
      this.updatePerception(ctx);
    }

    // Drop dead targets instantly.
    if (this.target && !this.target.health.alive) {
      this.target = null;
      this.targetVisible = false;
      if (this.state === "ENGAGING") this.state = "ROAMING";
    }

    switch (this.state) {
      case "ENGAGING":
        this.updateEngaging(dt, ctx);
        break;
      case "SEARCHING":
        this.updateSearching(dt, ctx);
        break;
      default:
        this.updateRoaming(dt, ctx);
        break;
    }

    this.updateAim(dt);
    this.updateStuck(dt, ctx);
  }

  // ------------------------------------------------------------------
  // Perception + targeting (a few times per second, staggered)
  // ------------------------------------------------------------------

  private updatePerception(ctx: BotContext): void {
    const fovCos = Math.cos((cc.botFovDegrees * Math.PI) / 360);
    let best: Combatant | null = null;
    let bestDist = Infinity;
    this.targetVisible = false;

    for (const c of ctx.combatants) {
      if (c === this.bot || !c.health.alive) continue;
      c.getPosition(this.otherPos);
      const dist = this.otherPos.distanceTo(this.selfPos);
      if (dist > cc.botPerceptionRange) continue;

      // FOV check (skipped when recently attacked by them or very close).
      const recentlyAttackedByThem = this.lastAttacker === c && this.attackedTimer < 2;
      if (!recentlyAttackedByThem && dist > cc.botCloseHearingRange) {
        this.toTarget.subVectors(this.otherPos, this.selfPos).normalize();
        const fwdX = -Math.sin(this.lookYaw);
        const fwdZ = -Math.cos(this.lookYaw);
        if (this.toTarget.x * fwdX + this.toTarget.z * fwdZ < fovCos) continue;
      }

      if (!this.hasLos(ctx, c)) continue;

      if (c === this.target) {
        this.targetVisible = true;
        this.timeSinceSeen = 0;
        c.getPosition(this.lastKnownPos);
      }
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }

    // ---- Target selection with stability ----
    if (!this.target) {
      if (best) this.acquireTarget(best, true);
      return;
    }

    // Switch to a recent attacker if the current target is gone.
    if (
      this.lastAttacker &&
      this.lastAttacker !== this.target &&
      this.lastAttacker.health.alive &&
      this.attackedTimer < 1.5 &&
      !this.targetVisible
    ) {
      this.acquireTarget(this.lastAttacker, false);
      return;
    }

    // Opportunistic switch: visibly much closer candidate, rate limited.
    if (
      best &&
      best !== this.target &&
      this.switchCooldown <= 0 &&
      this.target.getPosition(this.otherPos).distanceTo(this.selfPos) *
        cc.botSwitchDistanceRatio >
        bestDist
    ) {
      this.acquireTarget(best, false);
    }
  }

  private acquireTarget(target: Combatant, fullReaction: boolean): void {
    this.target = target;
    this.targetVisible = true;
    this.timeSinceSeen = 0;
    target.getPosition(this.lastKnownPos);
    this.reactionTimer = fullReaction
      ? rand(cc.botReactionMin, cc.botReactionMax)
      : rand(0.1, 0.2);
    this.switchCooldown = cc.botTargetSwitchDelay;
    this.state = "ENGAGING";
    this.pathCount = 0;
  }

  private hasLos(ctx: BotContext, other: Combatant): boolean {
    other.getEyePosition(this.otherEye);
    const dx = this.otherEye.x - this.selfEye.x;
    const dy = this.otherEye.y - this.selfEye.y;
    const dz = this.otherEye.z - this.selfEye.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 0.01) return true;
    const inv = 1 / dist;
    // Only STATIC geometry blocks vision. Character capsules are kinematic
    // and must be excluded — otherwise the ray instantly hits the bot's own
    // capsule (the eye is inside it) and the bot is permanently blind.
    const hit = ctx.physics.world.castRay(
      new RAPIER.Ray(
        { x: this.selfEye.x, y: this.selfEye.y, z: this.selfEye.z },
        { x: dx * inv, y: dy * inv, z: dz * inv },
      ),
      Math.max(dist - 0.2, 0.05),
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC,
    );
    return hit === null;
  }

  // ------------------------------------------------------------------
  // States
  // ------------------------------------------------------------------

  private updateEngaging(dt: number, ctx: BotContext): void {
    const target = this.target;
    if (!target) {
      this.state = "ROAMING";
      return;
    }

    // Lost sight for too long → go look at the last known position.
    if (this.timeSinceSeen > cc.botLosLostToSearchTime) {
      this.state = "SEARCHING";
      this.searchScanTimer = 0;
      this.pathCount = 0;
      this.out.wantFire = false;
      return;
    }

    target.getPosition(this.otherPos);
    this.toTarget.subVectors(this.otherPos, this.selfPos);
    const dist = Math.hypot(this.toTarget.x, this.toTarget.z);
    this.toTarget.y = 0;
    if (dist > 0.01) this.toTarget.divideScalar(dist);

    // ---- Combat movement: strafe + keep preferred distance ----
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0 || this.bot.blockedAmount > 0.6) {
      this.strafeSign *= -1;
      this.strafeTimer = rand(cc.botStrafeIntervalMin, cc.botStrafeIntervalMax);
      if (Math.random() < cc.botJumpChancePerSecond) this.out.wantJump = true;
    }

    this.perp.set(-this.toTarget.z, 0, this.toTarget.x).multiplyScalar(this.strafeSign);

    let approach = 0;
    if (dist > this.preferredRange * 1.25) approach = 1;
    else if (dist < this.preferredRange * 0.6) approach = -0.9;

    this.moveDir
      .copy(this.perp)
      .addScaledVector(this.toTarget, approach)
      .normalize();
    this.out.wishDir.copy(this.moveDir);

    // Occasional slide while pushing forward at speed.
    if (
      approach > 0 &&
      this.bot.grounded &&
      Math.random() < cc.botSlideChancePerSecond * dt
    ) {
      this.out.wantSlide = true;
    }
    // Occasional reposition dash.
    if (this.dashDecisionTimer <= 0 && Math.random() < cc.botDashChancePerSecond * dt) {
      this.out.wantDash = true;
      this.out.dashDir.copy(this.moveDir);
      this.out.dashDir.y = 0.05;
      this.dashDecisionTimer = cc.botDashDecisionCooldown;
    }

    // If target far away and not visible right now, path toward it.
    if (!this.targetVisible && this.pathTimer <= 0) {
      this.computePath(ctx, this.lastKnownPos);
    }
    if (!this.targetVisible && this.pathCount > 0) {
      this.followPath();
    }

    // ---- Fire control ----
    const angle = this.out.aimDir.angleTo(
      this.desiredAim.subVectors(this.otherPos, this.selfEye).normalize(),
    );
    const heatOk = !this.holdingFire && !this.shouldHoldForHeat();
    this.out.wantFire =
      this.targetVisible &&
      this.reactionTimer <= 0 &&
      angle < (cc.botAimFireConeDegrees * Math.PI) / 180 &&
      heatOk;
  }

  private shouldHoldForHeat(): boolean {
    // Aggressive bots push their heat further (and sometimes overheat).
    const hold = this.aggression > 0.75 ? Math.min(this.heatHold + 0.15, 1) : this.heatHold;
    return this.bot.heat.ratio > hold && !this.bot.heat.overheated
      ? ((this.holdingFire = true), true)
      : this.holdingFire;
  }

  private updateSearching(dt: number, ctx: BotContext): void {
    this.out.wantFire = false;

    // Found someone again? Perception will flip us back to ENGAGING.
    if (this.targetVisible && this.target) {
      this.state = "ENGAGING";
      return;
    }

    // Forget after the memory window.
    if (this.timeSinceSeen > cc.botMemoryDuration) {
      this.target = null;
      this.state = "ROAMING";
      this.hasGoal = false;
      return;
    }

    const distToLastKnown = Math.hypot(
      this.lastKnownPos.x - this.selfPos.x,
      this.lastKnownPos.z - this.selfPos.z,
    );

    if (distToLastKnown > 1.6) {
      if (this.pathCount === 0 && this.pathTimer <= 0) {
        this.computePath(ctx, this.lastKnownPos);
      }
      this.followPath();
    } else {
      // Arrived: scan around briefly.
      this.out.wishDir.set(0, 0, 0);
      this.searchScanTimer += dt;
      this.lookYaw += dt * 2.2;
      if (this.searchScanTimer > cc.botSearchScanTime) {
        this.target = null;
        this.state = "ROAMING";
        this.hasGoal = false;
      }
    }
  }

  private updateRoaming(dt: number, ctx: BotContext): void {
    this.out.wantFire = false;

    // Need a (new) destination when: no goal yet, the path is finished, or
    // the last path computation failed. A short pathTimer avoids hammering
    // A* every frame when the bot is boxed in.
    const needGoal =
      !this.hasGoal || this.pathCount === 0 || this.pathIndex >= this.pathCount;
    if (needGoal && this.pathTimer <= 0) {
      if (ctx.nav.pickRoamGoal(this.selfPos, cc.botRoamMinGoalDistance, this.pathGoal)) {
        this.hasGoal = true;
        this.computePath(ctx, this.pathGoal);
        if (this.pathCount === 0) {
          // Unreachable goal — drop it and retry with a new one shortly.
          this.hasGoal = false;
          this.pathTimer = 0.4;
        }
      } else {
        this.pathTimer = 0.4;
      }
    }

    if (this.pathCount > 0 && this.pathIndex < this.pathCount) {
      this.followPath();
      // Movement flavor on long straights.
      const speed = Math.hypot(this.bot.velocity.x, this.bot.velocity.z);
      if (speed > 7 && this.bot.grounded) {
        if (Math.random() < cc.botSlideChancePerSecond * 0.4 * dt) this.out.wantSlide = true;
        if (this.dashDecisionTimer <= 0 && Math.random() < cc.botDashChancePerSecond * 0.4 * dt) {
          this.out.wantDash = true;
          this.out.dashDir.copy(this.out.wishDir);
          this.out.dashDir.y = 0.05;
          this.dashDecisionTimer = cc.botDashDecisionCooldown;
        }
      }
      if (Math.random() < cc.botJumpChancePerSecond * 0.25 * dt) this.out.wantJump = true;
    } else {
      this.out.wishDir.set(0, 0, 0);
    }

    // Reached the goal?
    if (
      this.hasGoal &&
      Math.hypot(this.pathGoal.x - this.selfPos.x, this.pathGoal.z - this.selfPos.z) < 1.5
    ) {
      this.hasGoal = false;
      this.pathCount = 0;
    }
  }

  // ------------------------------------------------------------------
  // Navigation helpers
  // ------------------------------------------------------------------

  private computePath(ctx: BotContext, dest: THREE.Vector3): void {
    this.pathCount = ctx.nav.findPath(this.selfPos, dest, this.path);
    this.pathIndex = 0;
    this.pathTimer = cc.botPathUpdateInterval * (0.8 + Math.random() * 0.5);
  }

  private followPath(): void {
    if (this.pathIndex >= this.pathCount) return;
    const wp = this.path[this.pathIndex];
    const dx = wp.x - this.selfPos.x;
    const dz = wp.z - this.selfPos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < cc.botWaypointReachDistance) {
      this.pathIndex++;
      return;
    }
    this.out.wishDir.set(dx / dist, 0, dz / dist);
    // While navigating, look where we're going.
    if (this.state !== "ENGAGING") {
      this.lookYaw = Math.atan2(-this.out.wishDir.x, -this.out.wishDir.z);
    }
  }

  private updateStuck(dt: number, _ctx: BotContext): void {
    this.progressTimer += dt;
    if (this.progressTimer < 0.5) return;
    const moved = Math.hypot(
      this.selfPos.x - this.lastPos.x,
      this.selfPos.z - this.lastPos.z,
    );
    const trying = this.out.wishDir.lengthSq() > 0.01;
    if (trying && moved / this.progressTimer < cc.botStuckSpeedThreshold) {
      this.stuckTimer += this.progressTimer;
    } else {
      this.stuckTimer = 0;
    }
    this.lastPos.copy(this.selfPos);
    this.progressTimer = 0;

    if (this.stuckTimer >= cc.botStuckTime) {
      this.stuckTimer = 0;
      this.out.wantJump = true;
      this.pathCount = 0;
      this.pathTimer = 0;
      if (this.state === "ROAMING") this.hasGoal = false;
      // Small random nudge to break symmetric jams.
      const a = Math.random() * Math.PI * 2;
      this.out.wishDir.set(Math.sin(a), 0, Math.cos(a));
    }
  }

  // ------------------------------------------------------------------
  // Aim: rate-limited tracking + wandering error (never weapon spread)
  // ------------------------------------------------------------------

  private updateAim(dt: number): void {
    if (this.state === "ENGAGING" && this.target) {
      this.target.getEyePosition(this.otherEye);
      const dist = this.otherEye.distanceTo(this.selfEye);

      // Re-roll the aim error offset periodically; error grows with target
      // speed and distance so good movement genuinely dodges damage.
      this.aimErrorTimer -= dt;
      if (this.aimErrorTimer <= 0) {
        this.aimErrorTimer = rand(cc.botAimErrorRepickMin, cc.botAimErrorRepickMax);
        const targetSpeed = this.target.velocity.length();
        const scale =
          this.aimError *
          (dist / cc.botAimErrorRefDistance) *
          (0.6 + Math.min(targetSpeed / 12, 1.2));
        this.aimErrorOffset.set(
          (Math.random() * 2 - 1) * scale,
          (Math.random() * 2 - 1) * scale * 0.6,
          (Math.random() * 2 - 1) * scale,
        );
      }

      this.desiredAim
        .copy(this.otherEye)
        .add(this.aimErrorOffset)
        .sub(this.selfEye)
        .normalize();

      // Rate-limited rotation toward the desired direction (tracking inertia).
      const angle = this.out.aimDir.angleTo(this.desiredAim);
      if (angle > 0.0001) {
        const maxStep = this.aimSpeed * dt;
        const t = Math.min(1, maxStep / angle);
        this.out.aimDir.lerp(this.desiredAim, t).normalize();
      }

      this.lookYaw = Math.atan2(-this.out.aimDir.x, -this.out.aimDir.z);
      this.lookPitch = Math.asin(THREE.MathUtils.clamp(this.out.aimDir.y, -1, 1));
    } else {
      // Aim follows the look direction while navigating.
      const cp = Math.cos(this.lookPitch * 0.5);
      this.out.aimDir
        .set(-Math.sin(this.lookYaw) * cp, this.lookPitch * 0.3, -Math.cos(this.lookYaw) * cp)
        .normalize();
      this.lookPitch = THREE.MathUtils.damp(this.lookPitch, 0, 6, dt);
    }
  }
}