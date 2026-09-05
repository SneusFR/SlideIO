import * as THREE from "three";
import { PoisonConfig as cfg } from "./PoisonConfig";
import { PoisonTankDims } from "./PoisonModel";

/** One morph-driven mesh (liquid or meniscus) with cached target indices. */
interface MorphMesh {
  mesh: THREE.Mesh;
  drain: number;
  tiltX: number;
  tiltZ: number;
  waveSin: number;
  waveCos: number;
}

/** One decorative bubble (cached userData, driven procedurally). */
interface Bubble {
  mesh: THREE.Mesh;
  phase: number;
  sizeMeters: number;
  /** Local X/Z inside the tank (precomputed from tankU/tankV). */
  x: number;
  z: number;
  baseScale: number;
}

const GRAVITY = 9.81;

/**
 * Drives the voxel poison tank of the Lance-Poison viewmodel:
 *
 *   charge → `Drain` morph target (fill level, volume-true);
 *   player acceleration → damped-spring `TiltX`/`TiltZ` (surface inertia:
 *     accelerate LEFT → liquid piles up on the RIGHT, brake → opposite);
 *   motion energy → small `WaveSin`/`WaveCos` oscillation;
 *   bubbles → procedural rise between the tank floor and the surface.
 *
 * CONTRACT (contrat_liquide.json): the four surface deformations are
 * SIGNED and share a common budget `0.9 * min(fill, 1-fill)` — they are
 * scaled TOGETHER (never clamped individually) so the surface always
 * stays inside the closed tank and volume is conserved.
 *
 * All references and morph indices are cached at construction; the
 * per-frame update performs no searches and no allocations.
 */
export class PoisonLiquidController {
  private readonly morphMeshes: MorphMesh[] = [];
  private readonly bubbles: Bubble[] = [];
  private readonly tank: PoisonTankDims;
  /** The object whose LOCAL space the tank dims live in (PoisonWeapon). */
  private readonly weaponRoot: THREE.Object3D;

  // ---- Motion state (world space) ----
  private readonly prevVelocity = new THREE.Vector3();
  private readonly filteredAccel = new THREE.Vector3();
  private hasPrevVelocity = false;

  // ---- Damped springs (morph-weight space) ----
  private tiltXValue = 0;
  private tiltXVel = 0;
  private tiltZValue = 0;
  private tiltZVel = 0;

  // ---- Waves ----
  private wavePhase = 0;
  private motionEnergy = 0;

  // ---- Applied weights (kept for the bubble surface bound) ----
  private appliedWaveSum = 0;

  // Scratch (no per-frame allocations)
  private readonly worldAccel = new THREE.Vector3();
  private readonly localAccel = new THREE.Vector3();
  private readonly gravityLocal = new THREE.Vector3();
  private readonly invQuat = new THREE.Quaternion();

  constructor(weaponRoot: THREE.Object3D, tank: PoisonTankDims) {
    this.weaponRoot = weaponRoot;
    this.tank = tank;

    // Cache every role-tagged mesh ONCE. Names may resolve to groups after
    // import (multi-material splits) — walk descendants and keep the meshes
    // that actually own morph targets.
    const missing = new Set(["liquid", "meniscus"]);
    weaponRoot.traverse((obj) => {
      const role = obj.userData?.poisonRole as string | undefined;
      if (!role) return;
      if (role === "liquid" || role === "meniscus") {
        obj.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (!mesh.isMesh || !mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return;
          const dict = mesh.morphTargetDictionary;
          for (const name of ["Drain", "TiltX", "TiltZ", "WaveSin", "WaveCos"]) {
            if (!(name in dict)) {
              console.warn(`[Poison] morph target "${name}" missing on ${mesh.name}`);
              return;
            }
          }
          missing.delete(role);
          this.morphMeshes.push({
            mesh,
            drain: dict.Drain,
            tiltX: dict.TiltX,
            tiltZ: dict.TiltZ,
            waveSin: dict.WaveSin,
            waveCos: dict.WaveCos,
          });
        });
      } else if (role === "bubble") {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const u = Number(obj.userData.tankU);
        const v = Number(obj.userData.tankV);
        this.bubbles.push({
          mesh,
          phase: Number(obj.userData.phase) || 0,
          sizeMeters: Number(obj.userData.sizeMeters) || 0.008,
          // tankU: -X → +X, tankV: -Z → +Z (normalized 0..1). Keep the
          // bubble center strictly inside the walls (small margin).
          x: tank.centerX + (2 * (Number.isFinite(u) ? u : 0.5) - 1) * tank.halfX * 0.9,
          z: tank.centerZ + (2 * (Number.isFinite(v) ? v : 0.5) - 1) * tank.halfZ * 0.8,
          baseScale: mesh.scale.x,
        });
      }
    });

    for (const role of missing) {
      console.warn(`[Poison] no morph-capable mesh found for role "${role}" — liquid disabled for it`);
    }
  }

  /** Number of morph meshes found (diagnostics / warm-up checks). */
  get meshCount(): number {
    return this.morphMeshes.length;
  }

  /**
   * Zero the motion memory (equip / respawn / teleport / long pause) so
   * the next frame never injects an artificial acceleration impulse.
   */
  resetMotionState(): void {
    this.hasPrevVelocity = false;
    this.filteredAccel.set(0, 0, 0);
    this.tiltXValue = 0;
    this.tiltXVel = 0;
    this.tiltZValue = 0;
    this.tiltZVel = 0;
    this.motionEnergy = 0;
  }

  /**
   * Per-frame update.
   * @param dt        frame delta (s) — already clamped by the game loop
   * @param velocity  player velocity in WORLD space (physics controller)
   * @param fill      0..1 tank fill fraction (charge / capacity)
   */
  update(dt: number, velocity: THREE.Vector3, fill: number): void {
    if (this.morphMeshes.length === 0 || dt <= 0) return;
    const f = Number.isFinite(fill) ? THREE.MathUtils.clamp(fill, 0, 1) : 0;

    // ---- Empty tank: hide liquid + meniscus + bubbles (body stays). ----
    const liquidVisible = f > 0.001;
    for (const m of this.morphMeshes) m.mesh.visible = liquidVisible;
    if (!liquidVisible) {
      for (const b of this.bubbles) b.mesh.visible = false;
      // Bleed the springs so a refill doesn't start with stored energy.
      this.tiltXValue = 0;
      this.tiltXVel = 0;
      this.tiltZValue = 0;
      this.tiltZVel = 0;
      return;
    }

    // ---- World acceleration from the REAL controller velocity ----
    if (!this.hasPrevVelocity) {
      this.prevVelocity.copy(velocity);
      this.hasPrevVelocity = true;
    }
    this.worldAccel.subVectors(velocity, this.prevVelocity).divideScalar(dt);
    this.prevVelocity.copy(velocity);
    // Clamp spikes (teleports, hard landings) then low-pass filter.
    const mag = this.worldAccel.length();
    if (mag > cfg.accelClamp) this.worldAccel.multiplyScalar(cfg.accelClamp / mag);
    const alpha = 1 - Math.exp(-dt / cfg.accelFilterTau);
    this.filteredAccel.lerp(this.worldAccel, alpha);

    // ---- Transform into the PoisonWeapon local frame (viewmodel rotation
    // included) so left/right stays correct as the player turns. ----
    this.weaponRoot.getWorldQuaternion(this.invQuat).invert();
    this.localAccel.copy(this.filteredAccel).applyQuaternion(this.invQuat);

    // Apparent gravity (gravityWorld - accelWorld) in the local frame —
    // one formula covers BOTH the inertial reaction (accelerate left →
    // surface rises on the right) and the aim-pitch tilt of the tank.
    this.gravityLocal
      .set(-this.filteredAccel.x, -GRAVITY - this.filteredAccel.y, -this.filteredAccel.z)
      .applyQuaternion(this.invQuat);

    let targetTiltX: number;
    let targetTiltZ: number;
    if (this.gravityLocal.y < -1.5) {
      // Equilibrium slope of the surface under apparent gravity:
      // slope = -g.x / g.y, converted to a morph weight by tank geometry.
      const slopeX = THREE.MathUtils.clamp(-this.gravityLocal.x / this.gravityLocal.y, -2.5, 2.5);
      const slopeZ = THREE.MathUtils.clamp(-this.gravityLocal.z / this.gravityLocal.y, -2.5, 2.5);
      targetTiltX = slopeX * (this.tank.halfX / this.tank.height) * cfg.tiltGain;
      targetTiltZ = slopeZ * (this.tank.halfZ / this.tank.height) * cfg.tiltGain;
    } else {
      // Near/beyond vertical the y=f(x,z) surface model breaks down —
      // fall back to the pure inertial reaction (opposite of accel).
      targetTiltX =
        -this.localAccel.x * (this.tank.halfX / (GRAVITY * this.tank.height)) * cfg.tiltGain;
      targetTiltZ =
        -this.localAccel.z * (this.tank.halfZ / (GRAVITY * this.tank.height)) * cfg.tiltGain;
    }

    // ---- Damped spring toward the target (small fixed sub-steps) ----
    const omega = 2 * Math.PI * cfg.springFrequencyHz;
    let remaining = dt;
    while (remaining > 0) {
      const h = Math.min(remaining, cfg.maxSubstep);
      remaining -= h;
      this.tiltXVel +=
        (omega * omega * (targetTiltX - this.tiltXValue) -
          2 * cfg.springDamping * omega * this.tiltXVel) * h;
      this.tiltXValue += this.tiltXVel * h;
      this.tiltZVel +=
        (omega * omega * (targetTiltZ - this.tiltZValue) -
          2 * cfg.springDamping * omega * this.tiltZVel) * h;
      this.tiltZValue += this.tiltZVel * h;
    }

    // ---- Waves: amplitude follows the motion energy, phase runs ----
    const jolt = Math.abs(this.localAccel.x) + Math.abs(this.localAccel.z);
    this.motionEnergy = Math.max(
      this.motionEnergy - cfg.motionEnergyDecay * this.motionEnergy * dt,
      Math.min(jolt / cfg.accelClamp, 1),
    );
    this.wavePhase += dt * cfg.waveSpeed * (0.6 + this.motionEnergy);
    const waveAmp = cfg.idleAgitation + this.motionEnergy * cfg.waveAmplitude;
    const waveSin = Math.sin(this.wavePhase) * waveAmp;
    const waveCos = Math.cos(this.wavePhase * 0.83 + 1.3) * waveAmp;

    // ---- Common budget: scale the four SIGNED weights together ----
    const budget = 0.9 * Math.min(f, 1 - f);
    const sum =
      Math.abs(this.tiltXValue) + Math.abs(this.tiltZValue) + Math.abs(waveSin) + Math.abs(waveCos);
    const factor = sum > budget && sum > 0 ? budget / sum : 1;
    if (factor < 1) {
      // Anti-windup: never let the spring accumulate energy the output
      // can't express (release feels natural instead of snapping back).
      this.tiltXVel *= 0.9;
      this.tiltZVel *= 0.9;
    }

    const wTiltX = this.tiltXValue * factor;
    const wTiltZ = this.tiltZValue * factor;
    const wSin = waveSin * factor;
    const wCos = waveCos * factor;
    this.appliedWaveSum = Math.abs(wTiltX) + Math.abs(wTiltZ) + Math.abs(wSin) + Math.abs(wCos);

    const drain = 1 - f;
    for (const m of this.morphMeshes) {
      const inf = m.mesh.morphTargetInfluences!;
      inf[m.drain] = drain;
      inf[m.tiltX] = wTiltX;
      inf[m.tiltZ] = wTiltZ;
      inf[m.waveSin] = wSin;
      inf[m.waveCos] = wCos;
    }

    this.updateBubbles(dt, f);
  }

  // ------------------------------------------------------------------
  // Bubbles: procedural rise between the floor and the (conservative)
  // surface height. Fewer + hidden bubbles at low charge.
  // ------------------------------------------------------------------

  private updateBubbles(dt: number, fill: number): void {
    const t = this.tank;
    // Conservative surface bound: mean level minus every applied wave
    // amplitude — a bubble below this line can never poke out.
    const surfaceY = t.bottomY + t.height * Math.max(fill - this.appliedWaveSum, 0);
    const visibleCount =
      fill < cfg.bubbleMinFill ? 0 : Math.ceil(this.bubbles.length * Math.min(fill * 1.6, 1));

    for (let i = 0; i < this.bubbles.length; i++) {
      const b = this.bubbles[i];
      if (i >= visibleCount) {
        b.mesh.visible = false;
        continue;
      }
      b.phase = (b.phase + dt / cfg.bubbleCycleSeconds) % 1;

      const half = b.sizeMeters * 0.5;
      const minY = t.bottomY + half;
      const maxY = surfaceY - half;
      if (maxY <= minY) {
        b.mesh.visible = false; // not enough liquid to submerge this bubble
        continue;
      }
      b.mesh.visible = true;
      const y = minY + (maxY - minY) * b.phase;
      b.mesh.position.set(b.x, y, b.z);
      // Shrink near birth/death to hide the wrap-around to the floor;
      // slightly smaller bubbles at low charge.
      const edge = Math.min(b.phase / 0.15, (1 - b.phase) / 0.15, 1);
      const fillScale = 0.6 + 0.4 * Math.min(fill * 2, 1);
      b.mesh.scale.setScalar(b.baseScale * Math.max(edge, 0.01) * fillScale);
    }
  }
}

