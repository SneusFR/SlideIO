import * as THREE from "three";
import type RAPIER_API from "@dimforge/rapier3d-compat";
import { PhysicsWorld, RAPIER, CollisionGroups } from "../physics/PhysicsWorld";
import { MovementConfig as mc } from "../player/MovementConfig";
import { RagdollController } from "../ragdoll/RagdollController";
import { RagdollConfig as rc } from "../ragdoll/RagdollConfig";
import { buildBotRagdollParts } from "../ragdoll/BotRagdollFactory";
import { CorpseManager } from "../ragdoll/CorpseManager";
import { WeaponConfig as wc } from "../weapons/WeaponConfig";
import { CombatConfig as cc } from "../combat/CombatConfig";
import { Combatant, Health } from "../combat/Combatant";
import { KillMethod } from "../combat/KillMethod";
import { HitZone } from "../combat/HitZone";
import { SpawnManager } from "../combat/SpawnManager";
import { NavGrid } from "../navigation/NavGrid";
import { ParticleSystem } from "../effects/ParticleSystem";
import { HeatSystem } from "../weapons/HeatSystem";
import { PlasmaBeam } from "../weapons/PlasmaBeam";
import { castBeam, BeamCastResult } from "../weapons/BeamCombat";
import { BotModel } from "./BotModel";
import { BotAI } from "./BotAI";

/** Shared context handed to every bot each frame. */
export interface BotContext {
  combatants: Combatant[];
  physics: PhysicsWorld;
  nav: NavGrid;
  spawner: SpawnManager;
  particles: ParticleSystem;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * A full FFA combatant: kinematic capsule + character controller,
 * simplified quake-style movement (run/jump/slide/dash), the SAME
 * Plasma Rifle logic as the player (HeatSystem + beam raycast + DPS),
 * a low-poly model and an AI brain.
 */
export class Bot implements Combatant {
  readonly health = new Health(cc.botMaxHealth);
  readonly velocity = new THREE.Vector3();
  readonly model: BotModel;
  readonly ai: BotAI;
  readonly heat = new HeatSystem();

  // Per-bot variation
  readonly speedScale = rand(cc.botSpeedScaleMin, cc.botSpeedScaleMax);

  grounded = false;
  sliding = false;
  dashing = false;
  /**
   * TEMPORARY RAGDOLL state: the bot is alive but physically knocked down —
   * no AI, no locomotion, no firing; the Rapier ragdoll is the single
   * source of truth for the body until recovery.
   */
  ragdolled = false;
  /** World position of the last death (loot drops read this). */
  readonly deathPosition = new THREE.Vector3();
  /** Fraction of intended horizontal movement that was blocked last frame. */
  blockedAmount = 0;
  respawnTimer = 0;

  /** True while the plasma beam is actually emitting (read by game audio). */
  isFiring = false;

  private readonly body: RAPIER_API.RigidBody;
  private readonly collider: RAPIER_API.Collider;
  private readonly controller: RAPIER_API.KinematicCharacterController;
  private readonly physics: PhysicsWorld;
  private readonly scene: THREE.Scene;
  private readonly particles: ParticleSystem;
  private readonly beam: PlasmaBeam;

  private slideTimer = 0;
  private slideCooldown = 0;
  private dashTimer = 0;
  private dashCooldown = 0;
  private readonly dashDir = new THREE.Vector3();

  private impactAccum = 0;
  private readonly beamResult = new BeamCastResult();
  private readonly raycaster = new THREE.Raycaster();

  // ---- Ragdoll (temporary knockdown + death corpse handoff) ----
  private ragdoll: RagdollController | null = null;
  /** Latest reported combat impact (impulse m/s + world point). */
  private readonly pendingImpulse = new THREE.Vector3();
  private readonly pendingPoint = new THREE.Vector3();
  private pendingHasPoint = false;
  private pendingImpactAt = -Infinity; // performance.now() ms
  /** Guards the single-death flow (kill() + manual onDeath call paths). */
  private deathHandled = false;
  private readonly ragdollRootPos = new THREE.Vector3();
  private readonly ragdollRootVel = new THREE.Vector3();
  private readonly rayDown = { x: 0, y: -1, z: 0 };

  // scratch
  private readonly tmp = new THREE.Vector3();
  private readonly delta = new THREE.Vector3();
  private readonly corrected = new THREE.Vector3();
  private readonly muzzleWorld = new THREE.Vector3();
  private readonly eyePos = new THREE.Vector3();
  private readonly sparkColor = new THREE.Color(0xc084fc);
  private readonly deathColorA = new THREE.Color(0xc084fc);
  private readonly deathColorB = new THREE.Color(0xffffff);

  constructor(
    readonly id: number,
    readonly name: string,
    scene: THREE.Scene,
    physics: PhysicsWorld,
    particles: ParticleSystem,
    spawner: SpawnManager,
    combatants: Combatant[],
    /** Death ragdoll sink (corpse snapshots) — owned by the Game. */
    private readonly corpses: CorpseManager | null = null,
  ) {
    this.scene = scene;
    this.physics = physics;
    this.particles = particles;

    const spawn = spawner.pickSpawn(combatants, null);

    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        spawn.pos.x,
        spawn.pos.y,
        spawn.pos.z,
      ),
    );
    this.collider = physics.world.createCollider(
      RAPIER.ColliderDesc.capsule(mc.standHalfHeight, mc.capsuleRadius)
        .setFriction(0)
        .setRestitution(0)
        // CHARACTER group: ragdolls/corpses explicitly ignore capsules.
        .setCollisionGroups(CollisionGroups.CHARACTER),
      this.body,
    );
    this.controller = physics.world.createCharacterController(0.06);
    this.controller.enableAutostep(0.45, 0.25, true);
    this.controller.enableSnapToGround(0.35);
    this.controller.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
    this.controller.setSlideEnabled(true);

    this.model = new BotModel(id);
    this.model.group.position.copy(spawn.pos);
    this.model.group.userData.combatant = this;
    scene.add(this.model.group);

    this.beam = new PlasmaBeam(scene);
    this.ai = new BotAI(this, spawn.yaw);
    this.health.protectionTimer = cc.spawnProtectionDuration;

    this.health.onDamaged = (_a, attacker) => {
      this.model.flash();
      this.ai.notifyDamaged(attacker);
    };
  }

  // ---- Combatant ----
  getPosition(out: THREE.Vector3): THREE.Vector3 {
    const t = this.body.translation();
    return out.set(t.x, t.y, t.z);
  }

  getEyePosition(out: THREE.Vector3): THREE.Vector3 {
    const t = this.body.translation();
    return out.set(t.x, t.y + 0.55, t.z);
  }

  /**
   * PHYSICAL hit description reported by weapons BEFORE the damage: kept
   * briefly so a lethal blow can hand the exact impulse + impact point to
   * the death ragdoll, and a big non-lethal blow to the knockdown ragdoll.
   */
  registerImpact(impulse: THREE.Vector3, point: THREE.Vector3 | null): void {
    this.pendingImpulse.copy(impulse);
    this.pendingHasPoint = point !== null;
    if (point) this.pendingPoint.copy(point);
    this.pendingImpactAt = performance.now();
  }

  /** True while the last registered impact is fresh enough to trust. */
  private get pendingImpactFresh(): boolean {
    return performance.now() - this.pendingImpactAt < 300;
  }

  /**
   * Knockback: added ON TOP of the current velocity (never a reset).
   * Lifting the bot off the ground lets gravity + the character controller
   * integrate the shove naturally over the next frames.
   *
   * KNOCKDOWN: an impulse at/above the configurable ragdoll threshold
   * (Hammer sweep, Ground Slam, Spear Rush, Mole eruption — never plasma)
   * knocks the LIVING bot into a temporary physical ragdoll instead of
   * shoving a perfectly standing capsule at 17 m/s.
   */
  applyImpulse(impulse: THREE.Vector3): void {
    if (!this.health.alive) return;

    // Already down: feed the extra hit straight into the simulation.
    if (this.ragdolled && this.ragdoll?.active) {
      this.ragdoll.applyImpact({
        impulse,
        point: this.pendingImpactFresh && this.pendingHasPoint ? this.pendingPoint : null,
      });
      return;
    }

    if (impulse.length() >= rc.knockdownImpulseThreshold) {
      if (this.enterTemporaryRagdoll(impulse)) return;
    }

    this.velocity.add(impulse);
    if (impulse.y > 0.5) this.grounded = false;
    this.sliding = false;
  }

  // ---- Temporary ragdoll (alive knockdown) ----

  /**
   * Animation → ragdoll with zero visual discontinuity: the physical
   * skeleton is built from the CURRENT pose, inherits the bot's velocity
   * and receives the triggering impulse at the impact point. The gameplay
   * capsule is disabled (single source of truth = the ragdoll) and the AI
   * is fully suspended until recovery.
   */
  private enterTemporaryRagdoll(impulse: THREE.Vector3): boolean {
    const parts = buildBotRagdollParts(this.model.group);
    if (!parts) return false;

    if (!this.ragdoll) this.ragdoll = new RagdollController(this.physics, this.scene);

    // Enemy UI/outline reads wrong on a tumbling body — hidden until up.
    this.model.setSeen(false);
    this.sliding = false;
    this.dashing = false;
    this.isFiring = false;
    this.beam.setActive(false);
    this.collider.setEnabled(false); // no invisible standing capsule fights

    this.ragdoll.activate(this.model.group, parts, {
      mode: "TEMPORARY",
      velocity: this.velocity,
      impact: {
        impulse,
        point: this.pendingImpactFresh && this.pendingHasPoint ? this.pendingPoint : null,
      },
    });
    this.ragdolled = true;
    return true;
  }

  /**
   * GET-UP: reposition the capsule at the settled body, restore the pose
   * (the procedural animation takes over from there) and give control back
   * to the AI, keeping part of the pelvis momentum.
   */
  private recoverFromRagdoll(): void {
    if (!this.ragdoll || !this.ragdolled) return;
    this.ragdoll.getRootPosition(this.ragdollRootPos);
    this.ragdoll.getRootVelocity(this.ragdollRootVel);
    this.ragdoll.deactivate();
    this.ragdoll.restorePose();
    this.ragdolled = false;

    // Valid capsule position: ground raycast below the pelvis, feet on the
    // floor. Fallback: pelvis height + a safe margin (the character
    // controller resolves the rest on the next steps).
    const standCenter = mc.standHalfHeight + mc.capsuleRadius;
    let y = this.ragdollRootPos.y + standCenter * 0.75;
    const hit = this.physics.world.castRay(
      new RAPIER.Ray(
        { x: this.ragdollRootPos.x, y: this.ragdollRootPos.y + 0.4, z: this.ragdollRootPos.z },
        this.rayDown,
      ),
      3,
      true,
      undefined,
      undefined,
      this.collider,
      this.body,
    );
    if (hit) {
      const groundY = this.ragdollRootPos.y + 0.4 - hit.timeOfImpact;
      y = groundY + standCenter + 0.05;
    }
    this.body.setTranslation(
      { x: this.ragdollRootPos.x, y, z: this.ragdollRootPos.z },
      true,
    );
    this.collider.setEnabled(true);

    // Keep a share of the body's momentum — never a hard velocity reset.
    this.velocity.copy(this.ragdollRootVel).multiplyScalar(rc.recoveryMomentumRetention);
    this.grounded = false;
  }

  // ---- Death / respawn ----
  onDeath(): void {
    // Health.kill() fires the manager's onDeath callback which calls this
    // method, and some code paths ALSO call it directly — run exactly once.
    if (this.deathHandled) return;
    this.deathHandled = true;

    this.getPosition(this.tmp);
    this.deathPosition.copy(this.tmp);
    this.model.setSeen(false); // enemy UI/outline never lingers on a corpse

    // ---- CORPSE SNAPSHOT (death ragdoll) ----
    // Clone the body at its CURRENT pose (running / jumping / mid-ragdoll)
    // and hand it to the CorpseManager with the full momentum + the fatal
    // hit's impulse. The corpse is independent: the bot respawns elsewhere
    // while the body keeps simulating for several seconds.
    if (this.corpses) {
      const corpseVisual = this.model.createCorpseVisual();
      const parts = buildBotRagdollParts(corpseVisual);
      if (parts) {
        const velocity = this.ragdolled && this.ragdoll?.active
          ? this.ragdoll.getRootVelocity(this.ragdollRootVel)
          : this.velocity;
        this.corpses.spawn(corpseVisual, parts, {
          velocity,
          impact: this.pendingImpactFresh
            ? {
                impulse: this.pendingImpulse,
                point: this.pendingHasPoint ? this.pendingPoint : null,
              }
            : null,
        });
      }
    }

    // Exit any live knockdown ragdoll AFTER the corpse captured its pose.
    if (this.ragdolled && this.ragdoll) {
      this.ragdoll.deactivate();
      this.ragdoll.restorePose();
      this.ragdolled = false;
    }
    this.collider.setEnabled(true);

    this.particles.burst(this.tmp, 30, 8, 0.9, this.deathColorA, 5);
    this.particles.burst(this.tmp, 14, 3.5, 0.5, this.deathColorB, 2);
    this.model.group.visible = false;
    this.beam.setActive(false);
    this.body.setTranslation({ x: this.id * 3, y: -1000, z: 0 }, true);
    this.velocity.set(0, 0, 0);
    this.respawnTimer = rand(cc.botRespawnDelayMin, cc.botRespawnDelayMax);
  }

  private respawn(ctx: BotContext): void {
    const spawn = ctx.spawner.pickSpawn(ctx.combatants, this);
    this.body.setTranslation({ x: spawn.pos.x, y: spawn.pos.y, z: spawn.pos.z }, true);
    this.velocity.set(0, 0, 0);
    this.sliding = false;
    this.dashing = false;
    this.deathHandled = false;
    this.pendingImpactAt = -Infinity;
    this.heat.heat = 0;
    this.heat.overheated = false;
    this.health.reset(cc.spawnProtectionDuration);
    this.model.group.visible = true;
    this.ai.reset(spawn.yaw);
  }

  // ---- Frame update (AI + movement, before physics.step) ----
  /**
   * Cosmetic reaction to a confirmed hit from the LOCAL player (routed by
   * the HitFeedbackManager). Zone-aware: a headshot lights ONLY the head.
   */
  onHitVisual(zone: HitZone, _position: THREE.Vector3 | null): void {
    if (this.health.alive) this.model.hitFlash(zone);
  }

  update(dt: number, ctx: BotContext): void {
    this.health.update(dt);

    if (!this.health.alive) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawn(ctx);
      return;
    }

    // RAGDOLLED: no AI, no locomotion — the physics owns the body. The
    // kinematic body itself follows the pelvis (see postStep) so weapons /
    // other AIs keep targeting the real position.
    if (this.ragdolled) {
      if (this.ragdoll && this.ragdoll.getRootPosition(this.tmp).y < mc.killPlaneY) {
        this.health.kill(null);
        this.onDeath();
      }
      return;
    }

    // Kill plane safety.
    if (this.body.translation().y < mc.killPlaneY) {
      this.health.kill(null);
      this.onDeath();
      return;
    }

    this.ai.update(dt, ctx);
    this.updateMovement(dt, ctx);
  }

  private updateMovement(dt: number, _ctx: BotContext): void {
    const out = this.ai.out;
    const v = this.velocity;

    this.slideCooldown = Math.max(0, this.slideCooldown - dt);
    this.dashCooldown = Math.max(0, this.dashCooldown - dt);

    const hspeed = Math.hypot(v.x, v.z);

    // ---- Dash ----
    if (out.wantDash && !this.dashing && this.dashCooldown <= 0) {
      this.dashing = true;
      this.dashTimer = mc.dashDuration;
      this.dashCooldown = mc.dashCooldown;
      this.dashDir.copy(out.dashDir).normalize();
      v.copy(this.dashDir).multiplyScalar(mc.dashSpeed * 0.85);
      this.sliding = false;
    }

    if (this.dashing) {
      this.dashTimer -= dt;
      if (this.dashTimer <= 0) {
        this.dashing = false;
        const hs = Math.hypot(v.x, v.z);
        if (hs > mc.dashExitSpeed) {
          const s = mc.dashExitSpeed / hs;
          v.x *= s;
          v.z *= s;
        }
        v.y = Math.min(v.y, mc.dashExitMaxUpSpeed);
      }
    } else {
      // ---- Slide ----
      if (
        out.wantSlide &&
        !this.sliding &&
        this.grounded &&
        hspeed > mc.slideMinSpeed &&
        this.slideCooldown <= 0
      ) {
        this.sliding = true;
        this.slideTimer = mc.slideDuration;
        if (hspeed > 0.1) {
          const boost = mc.slideBoost * Math.max(0.3, 1 - hspeed / mc.softCapSpeed);
          v.x += (v.x / hspeed) * boost;
          v.z += (v.z / hspeed) * boost;
        }
      }
      if (this.sliding) {
        this.slideTimer -= dt;
        const hs = Math.hypot(v.x, v.z);
        if (this.slideTimer <= 0 || hs < mc.slideEndSpeed || !this.grounded) {
          this.sliding = false;
          this.slideCooldown = mc.slideCooldown;
        } else {
          // low friction glide
          const f = Math.max(0, 1 - mc.slideFriction * dt);
          v.x *= f;
          v.z *= f;
        }
      }

      if (!this.sliding) {
        const maxSpeed = mc.walkSpeed * this.speedScale;
        if (this.grounded) {
          // friction
          const f = Math.max(0, 1 - mc.groundFriction * dt);
          v.x *= f;
          v.z *= f;
        }
        // accelerate toward wish direction
        const wish = out.wishDir;
        if (wish.lengthSq() > 0.001) {
          const accel = (this.grounded ? mc.groundAcceleration : mc.airAcceleration) * dt;
          v.x += wish.x * accel;
          v.z += wish.z * accel;
          const hs = Math.hypot(v.x, v.z);
          if (hs > maxSpeed && this.grounded) {
            const s = maxSpeed / hs;
            v.x *= s;
            v.z *= s;
          } else if (hs > mc.hardCapSpeed) {
            const s = mc.hardCapSpeed / hs;
            v.x *= s;
            v.z *= s;
          }
        }
      }

      // ---- Gravity / jump ----
      if (this.grounded) {
        v.y = -2;
        if (out.wantJump) v.y = mc.jumpForce;
      } else {
        v.y = Math.max(v.y - mc.gravity * dt, -mc.maxFallSpeed);
      }
    }

    // ---- Move through the character controller ----
    this.delta.copy(v).multiplyScalar(dt);
    this.controller.computeColliderMovement(this.collider, {
      x: this.delta.x,
      y: this.delta.y,
      z: this.delta.z,
    });
    const cm = this.controller.computedMovement();
    this.corrected.set(cm.x, cm.y, cm.z);
    const t = this.body.translation();
    this.body.setNextKinematicTranslation({
      x: t.x + cm.x,
      y: t.y + cm.y,
      z: t.z + cm.z,
    });
    this.grounded = this.controller.computedGrounded();

    // Blocked detection (for AI stuck logic / strafe flips).
    const intended = Math.hypot(this.delta.x, this.delta.z);
    const actual = Math.hypot(cm.x, cm.z);
    this.blockedAmount = intended > 0.0005 ? 1 - actual / intended : 0;

    // Project velocity when blocked so bots don't push into walls forever.
    if (dt > 0) {
      const inv = 1 / dt;
      if (this.blockedAmount > 0.15) {
        v.x = cm.x * inv;
        v.z = cm.z * inv;
      }
      if (Math.abs(cm.y) < Math.abs(this.delta.y) * 0.5 && v.y > 0) v.y = 0;
    }
  }

  /** Sync visuals after the physics step. */
  postStep(dt: number, camQuat: THREE.Quaternion, camPos: THREE.Vector3, time: number): void {
    if (!this.health.alive) return;

    // ---- Temporary ragdoll: physics → visuals, then recovery checks ----
    if (this.ragdolled && this.ragdoll) {
      // Root group follows the pelvis so culling / targeting / joint math
      // all track the real body (children are world-corrected anyway).
      this.ragdoll.getRootPosition(this.ragdollRootPos);
      this.model.group.position.copy(this.ragdollRootPos);
      this.body.setTranslation(
        { x: this.ragdollRootPos.x, y: this.ragdollRootPos.y, z: this.ragdollRootPos.z },
        true,
      );
      this.model.group.visible = true;
      this.ragdoll.update(dt);

      // Recovery: min duration + physically settled (or hard timeout /
      // corrupted sim safety) → stand back up and resume the AI.
      if (this.ragdoll.corrupted || this.ragdoll.shouldRecover) {
        this.recoverFromRagdoll();
      }
      return;
    }

    const t = this.body.translation();
    this.model.group.position.set(t.x, t.y, t.z);
    const dist = camPos.distanceTo(this.model.group.position);
    this.model.group.visible = dist < 200;
    this.model.update(
      dt,
      Math.hypot(this.velocity.x, this.velocity.z),
      this.ai.lookYaw,
      this.ai.lookPitch,
      this.sliding,
      this.health.ratio,
      camQuat,
      this.health.protected,
      time,
    );
  }

  /**
   * Fire the Plasma Rifle — SAME rules as the player: continuous beam,
   * heat/overheat, DPS on the first combatant hit, blocked by walls.
   * Bot inaccuracy comes only from where the AI is aiming.
   */
  updateWeapon(dt: number, hittables: THREE.Object3D[], time: number): void {
    const wantFire = this.health.alive && !this.ragdolled && this.ai.out.wantFire;
    const firing = wantFire && this.heat.canFire;
    this.isFiring = firing;
    this.heat.update(dt, firing);
    this.ai.notifyHeat(this.heat);

    if (this.heat.consumeOverheatEvent()) {
      this.model.getMuzzleWorld(this.muzzleWorld);
      this.particles.burst(this.muzzleWorld, 14, 3, 0.6, this.sparkColor, 2);
    }

    if (!firing) {
      this.beam.setActive(false);
      return;
    }

    this.getEyePosition(this.eyePos);
    castBeam(
      this.raycaster,
      this.eyePos,
      this.ai.out.aimDir,
      wc.beamRange,
      hittables,
      this,
      this.beamResult,
    );

    if (this.beamResult.combatant) {
      this.beamResult.combatant.health.applyDamage(
        wc.plasmaDamagePerSecond * dt,
        this,
        KillMethod.PLASMA,
      );
    } else if (this.beamResult.trainingTarget) {
      this.beamResult.trainingTarget.applyDamage(wc.plasmaDamagePerSecond * dt);
    }

    // Beam from the model's muzzle to the actual hit point.
    this.model.getMuzzleWorld(this.muzzleWorld);
    this.beam.setActive(true);
    this.beam.update(this.muzzleWorld, this.beamResult.point, time);

    // Light impact sparks (no point lights — performance with 8 bots).
    if (this.beamResult.hit) {
      this.impactAccum += cc.botImpactParticleRate * dt;
      while (this.impactAccum >= 1) {
        this.impactAccum -= 1;
        this.tmp
          .set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
          .multiplyScalar(2)
          .addScaledVector(this.beamResult.normal, 1.5 + Math.random() * 2);
        this.particles.spawn(
          this.beamResult.point,
          this.tmp,
          0.25 + Math.random() * 0.15,
          this.sparkColor,
          4,
          2,
        );
      }
    }
  }

  dispose(): void {
    this.ragdoll?.dispose();
    this.ragdoll = null;
    this.ragdolled = false;
    this.scene.remove(this.model.group);
    this.model.dispose();
    this.beam.setActive(false);
    this.beam.group.removeFromParent();
    this.physics.world.removeCharacterController(this.controller);
    this.physics.world.removeCollider(this.collider, false);
    this.physics.world.removeRigidBody(this.body);
  }
}