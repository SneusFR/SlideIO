import * as THREE from "three";
import type { BrickMaulEyesConfig } from "./BrickMaulProfile";

/**
 * MOVING PUPILS of the Brick Maul (cosmetic only).
 *
 * The weapon GLB ships two pupil bones (Pupil_L / Pupil_R) sitting on the
 * eye whites. This controller is the ONLY writer of those bones: it keeps
 * each pupil inside its white (authored center + radius, weapon-local
 * space) and makes it lag behind the weapon's motion like a googly eye —
 * a damped 2D spring driven by the weapon's world acceleration expressed
 * in weapon-local space, plus explicit `kick()` impulses at the start of
 * an attack and at the real smash impact.
 *
 * No new geometry, no rigid bodies, no animation clip on these bones. The
 * pose libraries never target them, so the mixer and this controller
 * never fight. `update(dt)` must run AFTER the arms/character mixer and
 * after the world matrices are refreshed (it reads the weapon root's
 * matrixWorld to measure motion).
 */
export class BrickMaulEyes {
  private readonly eyes: EyeState[] = [];
  private readonly prevWorld = new THREE.Vector3();
  private readonly prevVel = new THREE.Vector3();
  private hasPrev = false;
  private pendingKick = 0;
  private driveX = 0;
  private driveY = 0;

  // Scratch (no per-frame allocations)
  private readonly pos = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private readonly accel = new THREE.Vector3();
  private readonly local = new THREE.Vector3();
  private readonly invRoot = new THREE.Matrix4();
  private readonly toParent = new THREE.Matrix4();
  private readonly offset = new THREE.Vector3();

  constructor(
    /** The rendered weapon scene (SkeletonUtils clone — its own bones). */
    private readonly weaponRoot: THREE.Object3D,
    config: BrickMaulEyesConfig,
  ) {
    for (const side of ["L", "R"] as const) {
      const c = config[side];
      const bone = weaponRoot.getObjectByName(c.bone);
      if (!bone) {
        if (import.meta.env.DEV) console.warn(`[BrickMaulEyes] bone "${c.bone}" missing`);
        continue;
      }
      // The authored pupil rests at restOffset2D from the white center:
      // the free travel is what remains inside the white around that point.
      const travel = Math.max(0, c.radius - Math.hypot(c.restOffset2D[0], c.restOffset2D[1]) * 0.35);
      this.eyes.push({ bone, restPosition: bone.position.clone(), travel, x: 0, y: 0, vx: 0, vy: 0 });
    }
  }

  /** Equip / teleport / respawn / visibility resume: pupils back at rest. */
  reset(): void {
    this.hasPrev = false;
    this.prevVel.set(0, 0, 0);
    this.pendingKick = 0;
    for (const e of this.eyes) {
      e.x = e.y = e.vx = e.vy = 0;
      e.bone.position.copy(e.restPosition);
    }
  }

  /** Impulse (1 = attack start, 1.5 = real smash impact). */
  kick(strength: number): void {
    this.pendingKick = Math.max(this.pendingKick, strength);
  }

  update(dt: number): void {
    if (this.eyes.length === 0 || dt <= 0) return;
    const step = Math.min(dt, 0.1);
    this.measureDrive(step);
    const kick = this.pendingKick;
    this.pendingKick = 0;
    for (const e of this.eyes) this.integrateEye(e, step, kick);
  }

  /** Weapon world acceleration → weapon-local 2D drive (+ gravity sag). */
  private measureDrive(step: number): void {
    this.weaponRoot.matrixWorld.decompose(this.pos, TMP_Q, TMP_S);
    this.accel.set(0, 0, 0);
    if (this.hasPrev) {
      this.vel.subVectors(this.pos, this.prevWorld).divideScalar(step);
      if (this.vel.lengthSq() > 40 * 40) {
        this.prevVel.set(0, 0, 0); // teleport / respawn jump: no impulse
      } else {
        this.accel.subVectors(this.vel, this.prevVel).divideScalar(step);
        this.prevVel.copy(this.vel);
      }
    }
    this.prevWorld.copy(this.pos);
    this.hasPrev = true;

    this.invRoot.copy(this.weaponRoot.matrixWorld).invert();
    this.local.copy(this.accel).transformDirection(this.invRoot);
    // Pupils LAG behind the motion (inertia): drive opposite to the
    // acceleration, clamped so a violent swing saturates cleanly.
    const ACCEL_GAIN = 0.0009;
    const MAX_DRIVE = 0.06;
    this.driveX = THREE.MathUtils.clamp(-this.local.x * ACCEL_GAIN, -MAX_DRIVE, MAX_DRIVE);
    this.driveY = THREE.MathUtils.clamp(-this.local.y * ACCEL_GAIN, -MAX_DRIVE, MAX_DRIVE);
    // Gentle sag toward the bottom of the white (world -Y in local space).
    this.local.set(0, -1, 0).transformDirection(this.invRoot);
    this.driveX += this.local.x * 0.006;
    this.driveY += this.local.y * 0.006;
  }

  private integrateEye(e: EyeState, step: number, kick: number): void {
    if (kick > 0) {
      const a = Math.random() * Math.PI * 2;
      e.vx += Math.cos(a) * 0.9 * kick;
      e.vy += Math.sin(a) * 0.9 * kick;
    }
    // Under-damped spring toward the drive (a bit of wobble reads alive).
    const K = 160;
    const D = 14;
    let remaining = step;
    while (remaining > 1e-8) {
      const h = Math.min(remaining, 1 / 120);
      e.vx += (K * (this.driveX - e.x) - D * e.vx) * h;
      e.vy += (K * (this.driveY - e.y) - D * e.vy) * h;
      e.x += e.vx * h;
      e.y += e.vy * h;
      remaining -= h;
    }
    // Stay inside the white: radial clamp with a soft bounce.
    const r = Math.hypot(e.x, e.y);
    if (r > e.travel && r > 1e-9) {
      const s = e.travel / r;
      e.x *= s;
      e.y *= s;
      e.vx *= -0.25;
      e.vy *= -0.25;
    }
    // Weapon-local 2D offset (eye plane = local XY, pupils face +Z) → the
    // bone's PARENT space, applied on top of the authored rest position.
    this.offset.set(e.x, e.y, 0);
    const len = this.offset.length();
    const parent = e.bone.parent;
    if (parent && len > 0) {
      this.toParent.copy(parent.matrixWorld).invert().multiply(this.weaponRoot.matrixWorld);
      this.offset.transformDirection(this.toParent).multiplyScalar(len * scaleOf(this.toParent));
    }
    e.bone.position.copy(e.restPosition).add(this.offset);
  }
}

interface EyeState {
  bone: THREE.Object3D;
  restPosition: THREE.Vector3;
  /** Max pupil travel from its rest point (weapon-local units). */
  travel: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const TMP_Q = new THREE.Quaternion();
const TMP_S = new THREE.Vector3();
const TMP_SCALE = new THREE.Vector3();

/** Uniform scale factor of a matrix (weapon-local → bone-parent units). */
function scaleOf(m: THREE.Matrix4): number {
  TMP_SCALE.setFromMatrixColumn(m, 0);
  return TMP_SCALE.length();
}
