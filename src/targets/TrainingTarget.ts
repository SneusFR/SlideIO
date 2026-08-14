import * as THREE from "three";
import { WeaponConfig as cfg } from "../weapons/WeaponConfig";

export type TargetBehaviorType =
  | "horizontal"
  | "vertical"
  | "strafe"
  | "circular"
  | "erratic";

export interface TargetOptions {
  /** Movement amplitude (m) for horizontal / vertical / strafe. */
  amplitude?: number;
  /** Movement speed (rad/s for sine-based, m/s for strafe/erratic). */
  speed?: number;
  /** Circle radius (m) for circular movement. */
  radius?: number;
  /** Half extents of the wander zone for erratic movement. */
  zone?: { x: number; y: number; z: number };
}

/**
 * A floating training drone with simple HP, a movement behavior,
 * hit feedback (emissive flash + scale pulse) and timed respawn.
 * Purely kinematic — no physics collider; the beam finds it via raycast.
 */
export class TrainingTarget {
  readonly group = new THREE.Group();
  hp = cfg.targetMaxHP;
  dead = false;

  /** Called once when HP reaches 0 (world position of the target). */
  onDestroyed?: (pos: THREE.Vector3) => void;

  private readonly anchor: THREE.Vector3;
  private readonly behavior: TargetBehaviorType;
  private readonly amplitude: number;
  private readonly speed: number;
  private readonly radius: number;
  private readonly zone: { x: number; y: number; z: number };

  private t = Math.random() * 100; // random phase so targets desync
  private respawnTimer = 0;
  private hitFlash = 0;

  // strafe state
  private strafeOffset = 0;
  private strafeDir = 1;
  private flipTimer = 0.6;

  // erratic state
  private readonly wanderTarget = new THREE.Vector3();
  private repickTimer = 0;

  // visuals
  private ring!: THREE.Mesh;
  private ringMat!: THREE.MeshStandardMaterial;
  private coreMat!: THREE.MeshBasicMaterial;
  private readonly ringBaseEmissive = new THREE.Color(0xff9a3c);
  private readonly ringHitEmissive = new THREE.Color(0xffffff);
  private readonly coreBaseColor = new THREE.Color(0xffb347);
  private readonly coreHitColor = new THREE.Color(0xe9d5ff);

  private readonly tmp = new THREE.Vector3();

  constructor(
    behavior: TargetBehaviorType,
    anchor: THREE.Vector3,
    opts: TargetOptions = {},
  ) {
    this.behavior = behavior;
    this.anchor = anchor.clone();
    this.amplitude = opts.amplitude ?? 5;
    this.speed = opts.speed ?? 1;
    this.radius = opts.radius ?? 4;
    this.zone = opts.zone ?? { x: 6, y: 2, z: 3 };
    this.wanderTarget.copy(this.anchor);

    this.buildVisual();
    this.group.position.copy(this.anchor);
    this.group.userData.trainingTarget = this;
  }

  private buildVisual(): void {
    // Dark faceted body
    const body = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.55, 1),
      new THREE.MeshStandardMaterial({
        color: 0x141a24,
        metalness: 0.5,
        roughness: 0.45,
      }),
    );
    body.castShadow = true;

    // Glowing orange ring facing the firing line (+Z)
    this.ringMat = new THREE.MeshStandardMaterial({
      color: 0x201408,
      emissive: this.ringBaseEmissive,
      emissiveIntensity: 1.4,
      metalness: 0.3,
      roughness: 0.5,
    });
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.78, 0.07, 8, 28),
      this.ringMat,
    );

    // Bright core
    this.coreMat = new THREE.MeshBasicMaterial({ color: this.coreBaseColor });
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), this.coreMat);

    this.group.add(body, this.ring, core);
  }

  applyDamage(amount: number): void {
    if (this.dead) return;
    this.hp -= amount;
    this.hitFlash = 1;
    if (this.hp <= 0) this.die();
  }

  private die(): void {
    this.dead = true;
    this.respawnTimer = cfg.targetRespawnTime;
    this.onDestroyed?.(this.tmp.copy(this.group.position));
    this.group.visible = false;
    this.group.position.set(this.anchor.x, -1000, this.anchor.z); // out of raycast reach
  }

  private respawn(): void {
    this.dead = false;
    this.hp = cfg.targetMaxHP;
    this.hitFlash = 0;
    this.group.visible = true;
    this.group.position.copy(this.anchor);
  }

  update(dt: number): void {
    if (this.dead) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawn();
      return;
    }

    this.t += dt;
    this.move(dt);

    // Hit feedback: emissive flash + slight scale pulse, decays quickly.
    if (this.hitFlash > 0) {
      this.hitFlash = Math.max(0, this.hitFlash - dt * 6);
    }
    this.ringMat.emissive.lerpColors(
      this.ringBaseEmissive,
      this.ringHitEmissive,
      this.hitFlash,
    );
    this.ringMat.emissiveIntensity = 1.4 + this.hitFlash * 2.2;
    this.coreMat.color.lerpColors(this.coreBaseColor, this.coreHitColor, this.hitFlash);
    const s = 1 + this.hitFlash * 0.12;
    this.group.scale.setScalar(s);

    // Idle life: slow ring spin.
    this.ring.rotation.z += dt * 0.8;
  }

  private move(dt: number): void {
    const p = this.group.position;

    switch (this.behavior) {
      case "horizontal":
        p.set(
          this.anchor.x + Math.sin(this.t * this.speed) * this.amplitude,
          this.anchor.y,
          this.anchor.z,
        );
        break;

      case "vertical":
        p.set(
          this.anchor.x,
          this.anchor.y + Math.sin(this.t * this.speed) * this.amplitude,
          this.anchor.z,
        );
        break;

      case "strafe": {
        // Constant-velocity strafing with hard flips (edges + random early flips).
        this.strafeOffset += this.strafeDir * this.speed * dt;
        if (Math.abs(this.strafeOffset) > this.amplitude) {
          this.strafeOffset = Math.sign(this.strafeOffset) * this.amplitude;
          this.strafeDir *= -1;
          this.flipTimer = 0.4 + Math.random() * 0.8;
        }
        this.flipTimer -= dt;
        if (this.flipTimer <= 0) {
          if (Math.random() < 0.45) this.strafeDir *= -1;
          this.flipTimer = 0.4 + Math.random() * 0.8;
        }
        p.set(this.anchor.x + this.strafeOffset, this.anchor.y, this.anchor.z);
        break;
      }

      case "circular":
        // Vertical circle facing the player — clean tracking loop.
        p.set(
          this.anchor.x + Math.cos(this.t * this.speed) * this.radius,
          this.anchor.y + Math.sin(this.t * this.speed) * this.radius,
          this.anchor.z,
        );
        break;

      case "erratic": {
        this.repickTimer -= dt;
        if (this.repickTimer <= 0) {
          this.repickTimer = 0.8 + Math.random() * 0.9;
          this.wanderTarget.set(
            this.anchor.x + (Math.random() * 2 - 1) * this.zone.x,
            this.anchor.y + (Math.random() * 2 - 1) * this.zone.y,
            this.anchor.z + (Math.random() * 2 - 1) * this.zone.z,
          );
        }
        // Move toward the wander target at constant speed (readable motion).
        this.tmp.subVectors(this.wanderTarget, p);
        const dist = this.tmp.length();
        if (dist > 0.05) {
          const step = Math.min(this.speed * dt, dist);
          p.addScaledVector(this.tmp.normalize(), step);
        }
        break;
      }
    }
  }
}