import * as THREE from "three";
import { MovementConfig as cfg } from "../player/MovementConfig";

export interface CameraFeel {
  /** Horizontal speed of the player (m/s), drives dynamic FOV. */
  speed: number;
  /** Lateral velocity relative to view direction (m/s), drives strafe tilt. */
  lateralSpeed: number;
  /** -1 wall on left, +1 wall on right, 0 no wall slide. */
  wallSide: number;
  /** 0 standing → 1 fully sliding, drives eye height. */
  crouchAmount: number;
  /** 1 while dashing, 0 otherwise — small extra FOV kick. */
  dashKick: number;
}

/**
 * First-person camera: mouse look (yaw/pitch), dynamic FOV,
 * subtle roll tilt and crouch/slide eye offset.
 * Purely visual — has no influence on physics.
 */
export class FPSCamera {
  readonly camera: THREE.PerspectiveCamera;

  yaw = cfg.spawnYaw;
  pitch = 0;

  private roll = 0;
  private fov = cfg.baseFov;
  private eyeOffset = cfg.eyeOffsetStand;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(cfg.baseFov, aspect, 0.1, 400);
    this.camera.rotation.order = "YXZ";
  }

  handleMouse(dx: number, dy: number): void {
    this.yaw -= dx * cfg.mouseSensitivity;
    this.pitch -= dy * cfg.mouseSensitivity;
    const limit = Math.PI / 2 - 0.001;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -limit, limit);
  }

  /** Flat forward direction (XZ plane). */
  getForward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  /** Flat right direction (XZ plane). */
  getRight(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  /** Full 3D view direction (includes pitch) — used by the dash. */
  getLookDirection(out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(
      -Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * cp,
    );
  }

  /** Position camera at the player's eye and apply feel effects. */
  update(dt: number, playerCenter: THREE.Vector3, feel: CameraFeel): void {
    // Dynamic FOV: widen with speed for a real sense of acceleration.
    const speedT = THREE.MathUtils.clamp(
      (feel.speed - cfg.fovSpeedStart) / (cfg.fovSpeedFull - cfg.fovSpeedStart),
      0,
      1,
    );
    // Dash: brief extra FOV punch on top of the speed FOV.
    const targetFov =
      THREE.MathUtils.lerp(cfg.baseFov, cfg.maxSpeedFov, speedT) +
      feel.dashKick * cfg.dashFovBoost;
    this.fov = THREE.MathUtils.damp(this.fov, targetFov, cfg.fovLerpSpeed, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    // Roll: subtle strafe tilt + lean toward the wall during wall slides.
    let targetRoll = THREE.MathUtils.clamp(
      (-feel.lateralSpeed / cfg.walkSpeed) * cfg.strafeTiltMax,
      -cfg.strafeTiltMax,
      cfg.strafeTiltMax,
    );
    targetRoll += feel.wallSide * cfg.wallSlideTilt;
    this.roll = THREE.MathUtils.damp(this.roll, targetRoll, cfg.tiltLerpSpeed, dt);

    // Eye height: dip while sliding.
    const targetEye = THREE.MathUtils.lerp(
      cfg.eyeOffsetStand,
      cfg.eyeOffsetSlide,
      feel.crouchAmount,
    );
    this.eyeOffset = THREE.MathUtils.damp(this.eyeOffset, targetEye, cfg.crouchLerpSpeed, dt);

    this.camera.position.set(
      playerCenter.x,
      playerCenter.y + this.eyeOffset,
      playerCenter.z,
    );
    this.camera.rotation.set(this.pitch, this.yaw, this.roll);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}