import * as THREE from "three";
import type RAPIER_API from "@dimforge/rapier3d-compat";
import { PhysicsWorld, RAPIER } from "../physics/PhysicsWorld";
import { MovementConfig as mc } from "../player/MovementConfig";
import { WeaponConfig as wc } from "../weapons/WeaponConfig";
import { CombatConfig as cc } from "../combat/CombatConfig";
import { Combatant, Health } from "../combat/Combatant";
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
  /** Fraction of intended horizontal movement that was blocked last frame. */
  blockedAmount = 0;
  respawnTimer = 0;

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
        .setRestitution(0),
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
   * Knockback: added ON TOP of the current velocity (never a reset).
   * Lifting the bot off the ground lets gravity + the character controller
   * integrate the shove naturally over the next frames.
   */
  applyImpulse(impulse: THREE.Vector3): void {
    if (!this.health.alive) return;
    this.velocity.add(impulse);
    if (impulse.y > 0.5) this.grounded = false;
    this.sliding = false;
  }

  // ---- Death / respawn ----
  onDeath(): void {
    this.getPosition(this.tmp);
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
    this.heat.heat = 0;
    this.heat.overheated = false;
    this.health.reset(cc.spawnProtectionDuration);
    this.model.group.visible = true;
    this.ai.reset(spawn.yaw);
  }

  // ---- Frame update (AI + movement, before physics.step) ----
  update(dt: number, ctx: BotContext): void {
    this.health.update(dt);

    if (!this.health.alive) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawn(ctx);
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
    const wantFire = this.health.alive && this.ai.out.wantFire;
    const firing = wantFire && this.heat.canFire;
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
      this.beamResult.combatant.health.applyDamage(wc.plasmaDamagePerSecond * dt, this);
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
    this.scene.remove(this.model.group);
    this.model.dispose();
    this.beam.setActive(false);
    this.beam.group.removeFromParent();
    this.physics.world.removeCharacterController(this.controller);
    this.physics.world.removeCollider(this.collider, false);
    this.physics.world.removeRigidBody(this.body);
  }
}