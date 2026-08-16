import * as THREE from "three";
import { audio, LoopHandle } from "../../audio/AudioManager";
import { PlasmaBeam } from "../../weapons/PlasmaBeam";
import {
  NetworkWeaponConfig as W,
  NetworkWeaponId,
  WeaponActionType,
  WeaponActionConfirmedEvent,
  PLAYER_EYE_OFFSET,
} from "../../../shared/combat/NetworkWeapons";
import { loadRemoteWeaponTemplate } from "./RemoteWeaponController";
import type { RemotePlayerManager } from "../RemotePlayerManager";

/** Server-only extra action ids (broadcast in confirms, never sent by us). */
const ACTION_REVOLVER_EXPLODE = "REVOLVER_EXPLODE";
const ACTION_OBLITERREUR_STOP = "OBLITERREUR_STOP";

/** Tracer visual lifetime (seconds). */
const TRACER_LIFE = 0.12;

interface RemotePlasma {
  beam: PlasmaBeam;
  loop: LoopHandle | null;
  active: boolean;
}

interface RemoteProjectile {
  group: THREE.Group;
  vel: THREE.Vector3;
  age: number;
}

interface RemoteOblit {
  /** Anchor meshes by server index (0 = A, 1 = B). */
  anchors: (THREE.Group | null)[];
  tube: THREE.Group | null;
  tubeTimer: number;
}

interface Tracer {
  line: THREE.Line;
  mat: THREE.LineBasicMaterial;
  age: number;
}

/** Generic short-lived expanding + fading mesh (explosions, slam rings). */
interface Burst {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  age: number;
  life: number;
  fromScale: number;
  toScale: number;
}

/**
 * Replays SERVER-CONFIRMED weapon actions of REMOTE players as pure
 * visuals + spatial audio (Phase 5): plasma beams that follow the
 * interpolated aim, revolver tracers / thrown projectiles / explosions,
 * melee swings, obliterreur anchors + vortex tube.
 *
 * NEVER runs for the LOCAL player (local prediction already renders those)
 * and NEVER computes damage — the server owns every gameplay result.
 */
export class RemoteCombatVFXController {
  private readonly plasma = new Map<string, RemotePlasma>();
  private readonly projectiles = new Map<string, RemoteProjectile>();
  private readonly oblits = new Map<string, RemoteOblit>();
  private readonly tracers: Tracer[] = [];
  private readonly bursts: Burst[] = [];

  /** Static world meshes the remote plasma beam visually stops on. */
  private raycastTargets: THREE.Object3D[] = [];
  private readonly raycaster = new THREE.Raycaster();

  private elapsed = 0;
  private disposed = false;

  /** One-frame shader/pipeline warm-up (removed shortly after start). */
  private warmupBeam: PlasmaBeam | null = null;
  private warmupTimer = 0;

  // Scratch
  private readonly poseScratch = { pos: new THREE.Vector3(), yaw: 0, pitch: 0 };
  private readonly originScratch = new THREE.Vector3();
  private readonly dirScratch = new THREE.Vector3();
  private readonly endScratch = new THREE.Vector3();
  private readonly vecScratch = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly remotes: RemotePlayerManager,
    private readonly getLocalId: () => string | null,
  ) {}

  /** World meshes remote plasma beams get visually blocked by (optional). */
  setRaycastTargets(targets: THREE.Object3D[]): void {
    this.raycastTargets = targets;
  }

  /**
   * Pre-compile every VFX material/pipeline by rendering one instance of
   * each far below the map for a few frames. Without this, the FIRST
   * remote shot / explosion would trigger shader compilation mid-fight
   * (a visible one-time hitch).
   */
  warmUp(): void {
    if (this.disposed || this.warmupBeam) return;
    const far = { x: 0, y: -400, z: 0 };

    // Plasma beam (core + halo additive cylinders).
    this.warmupBeam = new PlasmaBeam(this.scene);
    this.warmupBeam.setActive(true);
    this.warmupBeam.update(
      new THREE.Vector3(far.x, far.y, far.z),
      new THREE.Vector3(far.x + 2, far.y, far.z),
      0,
    );
    this.warmupTimer = 0.5;

    // Additive transparent MeshBasicMaterial family (bursts / rings /
    // anchors / tube glow all share this program).
    this.spawnBurst(new THREE.SphereGeometry(0.5, 8, 6), 0xc084fc, far, 0.5, 1, 0.4);
    this.spawnGroundRing(far, 2, 0.4, 0xa855f7);

    // Opaque MeshBasicMaterial (obliterreur tube core).
    const coreMat = new THREE.MeshBasicMaterial({ color: 0x0a0312 });
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), coreMat);
    core.position.set(far.x, far.y, far.z);
    core.frustumCulled = false;
    this.scene.add(core);
    this.bursts.push({ mesh: core, mat: coreMat, age: 0, life: 0.4, fromScale: 1, toScale: 1 });

    // Additive LineBasicMaterial (revolver tracer).
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(far.x, far.y, far.z),
      new THREE.Vector3(far.x + 2, far.y, far.z),
    ]);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0xffe2a8,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const line = new THREE.Line(lineGeo, lineMat);
    line.frustumCulled = false;
    this.scene.add(line);
    this.tracers.push({ line, mat: lineMat, age: 0 });
  }

  // ------------------------------------------------------------------
  // Server event entry point
  // ------------------------------------------------------------------

  handleAction(ev: WeaponActionConfirmedEvent): void {
    if (this.disposed) return;
    // NEVER double the local shooter's VFX — local prediction covers it.
    if (ev.playerId === this.getLocalId()) return;

    switch (ev.action) {
      case WeaponActionType.PLASMA_START:
        this.startPlasma(ev);
        return;
      case WeaponActionType.PLASMA_STOP:
        this.stopPlasma(ev.playerId, { x: ev.ox, y: ev.oy, z: ev.oz });
        return;
      case WeaponActionType.REVOLVER_FIRE:
        this.revolverFire(ev);
        return;
      case WeaponActionType.REVOLVER_THROW:
        this.revolverThrow(ev);
        return;
      case ACTION_REVOLVER_EXPLODE:
        this.revolverExplode(ev);
        return;
      case WeaponActionType.HAMMER_SWEEP:
        this.remotes.triggerMeleeSwing(ev.playerId, NetworkWeaponId.HAMMER, "sweep");
        this.playSwingSound(ev);
        return;
      case WeaponActionType.SPEAR_SWEEP:
        this.remotes.triggerMeleeSwing(ev.playerId, NetworkWeaponId.SPEAR, "sweep");
        this.playSwingSound(ev);
        return;
      case WeaponActionType.HAMMER_SLAM_START:
        this.remotes.triggerMeleeSwing(ev.playerId, NetworkWeaponId.HAMMER, "slam");
        audio.playAt("hammer_slam_descent", { x: ev.ox, y: ev.oy, z: ev.oz }, {
          bus: "weapons",
          volume: 0.7,
        });
        return;
      case WeaponActionType.HAMMER_SLAM_IMPACT:
        this.hammerSlamImpact(ev);
        return;
      case WeaponActionType.SPEAR_RUSH_START:
        this.remotes.triggerMeleeSwing(ev.playerId, NetworkWeaponId.SPEAR, "sweep");
        audio.playAt("dash_energy", { x: ev.ox, y: ev.oy, z: ev.oz }, {
          bus: "movement",
          volume: 0.8,
        });
        return;
      case WeaponActionType.SPEAR_RUSH_STOP:
        return; // movement itself already reads as the feedback
      case WeaponActionType.OBLITERREUR_PLACE:
        this.obliterreurPlace(ev);
        return;
      case WeaponActionType.OBLITERREUR_FIRE:
        this.obliterreurFire(ev);
        return;
      case ACTION_OBLITERREUR_STOP:
        this.removeOblitTube(ev.playerId);
        return;
      default:
        return; // unknown action — silently ignored
    }
  }

  /** A player died: no ghost beams / anchors from corpses. */
  onPlayerDied(playerId: string): void {
    this.stopPlasma(playerId, null);
    // The server clears its anchors on death without a broadcast — mirror.
    this.removeOblitTube(playerId);
    this.clearOblitAnchors(playerId);
    // NOTE: thrown revolver projectiles legitimately survive their owner.
  }

  /** Drop every per-player VFX whose owner left the room. */
  prune(validIds: ReadonlySet<string>): void {
    for (const id of [...this.plasma.keys()]) {
      if (!validIds.has(id)) this.removePlasma(id);
    }
    for (const id of [...this.projectiles.keys()]) {
      if (!validIds.has(id)) this.removeProjectile(id);
    }
    for (const id of [...this.oblits.keys()]) {
      if (!validIds.has(id)) {
        this.removeOblitTube(id);
        this.clearOblitAnchors(id);
        this.oblits.delete(id);
      }
    }
  }

  // ------------------------------------------------------------------
  // Per-frame animation
  // ------------------------------------------------------------------

  update(dt: number): void {
    if (this.disposed) return;
    this.elapsed += dt;

    // Warm-up beam: rendered for a few frames, then removed for good.
    if (this.warmupBeam) {
      this.warmupTimer -= dt;
      if (this.warmupTimer <= 0) {
        this.warmupBeam.setActive(false);
        this.scene.remove(this.warmupBeam.group);
        this.warmupBeam = null;
      }
    }

    // ---- Plasma beams follow the INTERPOLATED remote aim ----
    for (const [id, p] of this.plasma) {
      if (!p.active) continue;
      const pose = this.poseScratch;
      if (!this.remotes.getPose(id, pose)) {
        p.beam.setActive(false);
        continue;
      }
      p.beam.setActive(true);

      // Beam start: real in-hand weapon if ready, else the eye position.
      if (!this.remotes.getMuzzleWorldPosition(id, this.originScratch)) {
        this.originScratch.copy(pose.pos);
        this.originScratch.y += PLAYER_EYE_OFFSET;
      }
      aimDirection(pose.yaw, pose.pitch, this.dirScratch);

      // Aim ray anchored at the EYE (matches the server); the visual beam
      // then stretches from the muzzle to that end point.
      this.vecScratch.copy(pose.pos);
      this.vecScratch.y += PLAYER_EYE_OFFSET;
      let dist: number = W.plasma.range;
      if (this.raycastTargets.length > 0) {
        this.raycaster.set(this.vecScratch, this.dirScratch);
        this.raycaster.far = W.plasma.range;
        const hit = this.raycaster.intersectObjects(this.raycastTargets, true)[0];
        if (hit) dist = hit.distance;
      }
      this.endScratch.copy(this.vecScratch).addScaledVector(this.dirScratch, dist);
      p.beam.update(this.originScratch, this.endScratch, this.elapsed);

      // Spatial loop follows the muzzle; retry if the context was locked.
      if (!p.loop || p.loop.stopped) {
        p.loop = audio.loop("plasma_loop", {
          bus: "weapons",
          volume: 0.55,
          spatial: true,
          refDistance: 6,
          maxDistance: 90,
        });
      }
      p.loop?.setPosition(this.originScratch.x, this.originScratch.y, this.originScratch.z);
    }

    // ---- Thrown revolver projectiles (client-side visual sim) ----
    for (const [id, proj] of this.projectiles) {
      proj.age += dt;
      // Safety cap: the server explosion event normally removes it first.
      if (proj.age > W.revolver.projectileMaxLifetime + 1) {
        this.removeProjectile(id);
        continue;
      }
      proj.vel.y -= W.revolver.throwGravity * dt;
      proj.group.position.addScaledVector(proj.vel, dt);
      proj.group.rotation.x += dt * 9; // fast end-over-end spin
      proj.group.rotation.z += dt * 4;
    }

    // ---- Tracers fade out ----
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.age += dt;
      const k = 1 - t.age / TRACER_LIFE;
      if (k <= 0) {
        this.scene.remove(t.line);
        t.line.geometry.dispose();
        t.mat.dispose();
        this.tracers.splice(i, 1);
      } else {
        t.mat.opacity = k;
      }
    }

    // ---- Generic bursts (explosion flash / slam ring) ----
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.age += dt;
      const p = Math.min(b.age / b.life, 1);
      const eased = 1 - (1 - p) * (1 - p); // ease-out
      const s = b.fromScale + (b.toScale - b.fromScale) * eased;
      b.mesh.scale.setScalar(Math.max(s, 0.0001));
      b.mat.opacity = (1 - p) * 0.85;
      if (p >= 1) {
        this.scene.remove(b.mesh);
        b.mesh.geometry.dispose();
        b.mat.dispose();
        this.bursts.splice(i, 1);
      }
    }

    // ---- Obliterreur: anchor pulse + tube expiry ----
    for (const [id, o] of this.oblits) {
      const pulse = 1 + 0.14 * Math.sin(this.elapsed * 6);
      for (const anchor of o.anchors) anchor?.scale.setScalar(pulse);
      if (o.tube) {
        o.tubeTimer -= dt;
        if (o.tubeTimer <= 0) this.removeOblitTube(id);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.warmupBeam) {
      this.scene.remove(this.warmupBeam.group);
      this.warmupBeam = null;
    }
    for (const id of [...this.plasma.keys()]) this.removePlasma(id);
    for (const id of [...this.projectiles.keys()]) this.removeProjectile(id);
    for (const id of [...this.oblits.keys()]) {
      this.removeOblitTube(id);
      this.clearOblitAnchors(id);
    }
    this.oblits.clear();
    for (const t of this.tracers) {
      this.scene.remove(t.line);
      t.line.geometry.dispose();
      t.mat.dispose();
    }
    this.tracers.length = 0;
    for (const b of this.bursts) {
      this.scene.remove(b.mesh);
      b.mesh.geometry.dispose();
      b.mat.dispose();
    }
    this.bursts.length = 0;
  }

  // ------------------------------------------------------------------
  // Plasma
  // ------------------------------------------------------------------

  private startPlasma(ev: WeaponActionConfirmedEvent): void {
    let p = this.plasma.get(ev.playerId);
    if (!p) {
      p = { beam: new PlasmaBeam(this.scene), loop: null, active: false };
      this.plasma.set(ev.playerId, p);
    }
    p.active = true;
    p.beam.setActive(true);
    audio.playAt("plasma_start", { x: ev.ox, y: ev.oy, z: ev.oz }, { bus: "weapons", volume: 0.7 });
  }

  private stopPlasma(playerId: string, at: { x: number; y: number; z: number } | null): void {
    const p = this.plasma.get(playerId);
    if (!p || !p.active) return;
    p.active = false;
    p.beam.setActive(false);
    p.loop?.stop();
    p.loop = null;
    if (at) audio.playAt("plasma_stop", at, { bus: "weapons", volume: 0.6 });
  }

  private removePlasma(playerId: string): void {
    const p = this.plasma.get(playerId);
    if (!p) return;
    p.loop?.stop(0.05);
    p.beam.setActive(false);
    this.scene.remove(p.beam.group);
    this.plasma.delete(playerId);
  }

  // ------------------------------------------------------------------
  // Revolver
  // ------------------------------------------------------------------

  private revolverFire(ev: WeaponActionConfirmedEvent): void {
    // Tracer start: the real in-hand revolver if ready, else the eye.
    if (!this.remotes.getMuzzleWorldPosition(ev.playerId, this.originScratch)) {
      this.originScratch.set(ev.ox, ev.oy, ev.oz);
    }
    const end =
      typeof ev.hx === "number"
        ? this.endScratch.set(ev.hx, ev.hy ?? 0, ev.hz ?? 0)
        : this.endScratch
            .set(ev.dx, ev.dy, ev.dz)
            .multiplyScalar(W.revolver.range)
            .add(this.originScratch);

    const geo = new THREE.BufferGeometry().setFromPoints([
      this.originScratch.clone(),
      end.clone(),
    ]);
    const mat = new THREE.LineBasicMaterial({
      color: 0xffe2a8,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    this.scene.add(line);
    this.tracers.push({ line, mat, age: 0 });

    audio.playAt("revolver_shot", { x: ev.ox, y: ev.oy, z: ev.oz }, {
      bus: "weapons",
      volume: 0.85,
      rateVar: 0.04,
    });
  }

  private revolverThrow(ev: WeaponActionConfirmedEvent): void {
    this.removeProjectile(ev.playerId); // server allows one at a time
    const group = new THREE.Group();
    group.position.set(ev.ox, ev.oy, ev.oz);
    this.scene.add(group);
    const proj: RemoteProjectile = {
      group,
      vel: new THREE.Vector3(ev.dx, ev.dy, ev.dz).multiplyScalar(W.revolver.throwSpeed),
      age: 0,
    };
    this.projectiles.set(ev.playerId, proj);

    // Real revolver GLB (shared cached template — never a box).
    void loadRemoteWeaponTemplate(NetworkWeaponId.REVOLVER).then((template) => {
      if (this.disposed || this.projectiles.get(ev.playerId) !== proj) return;
      group.add(template.clone(true));
    });

    audio.playAt("phase_warp", { x: ev.ox, y: ev.oy, z: ev.oz }, {
      bus: "weapons",
      volume: 0.4,
      rate: 1.25,
    });
  }

  private revolverExplode(ev: WeaponActionConfirmedEvent): void {
    this.removeProjectile(ev.playerId);
    const at = { x: ev.ox, y: ev.oy, z: ev.oz };
    // Expanding additive flash sphere up to the real AoE radius.
    this.spawnBurst(
      new THREE.SphereGeometry(1, 18, 14),
      0xc084fc,
      at,
      0.4,
      W.revolver.explosionRadius,
      0.38,
    );
    this.spawnGroundRing(at, W.revolver.explosionRadius * 1.15, 0.42, 0xa855f7);
    audio.playAt("hammer_slam_impact", at, { bus: "weapons", volume: 0.95 });
    audio.playAt("hammer_slam_sub", at, { bus: "weapons", volume: 0.8, rate: 1.1 });
  }

  private removeProjectile(playerId: string): void {
    const proj = this.projectiles.get(playerId);
    if (!proj) return;
    this.scene.remove(proj.group);
    this.projectiles.delete(playerId);
  }

  // ------------------------------------------------------------------
  // Melee
  // ------------------------------------------------------------------

  private playSwingSound(ev: WeaponActionConfirmedEvent): void {
    const keys = ["hammer_swing_01", "hammer_swing_02", "hammer_swing_03"];
    audio.playAt(keys[Math.floor(Math.random() * keys.length)], { x: ev.ox, y: ev.oy, z: ev.oz }, {
      bus: "weapons",
      volume: 0.7,
      rateVar: 0.05,
    });
  }

  private hammerSlamImpact(ev: WeaponActionConfirmedEvent): void {
    // The confirm carries the validated impact point in ox/oy/oz.
    const at = { x: ev.ox, y: ev.oy, z: ev.oz };
    this.spawnGroundRing(at, W.hammer.slamRadius, 0.5, 0xd8b4fe);
    audio.playAt("hammer_slam_impact", at, { bus: "weapons", volume: 1 });
    audio.playAt("hammer_slam_sub", at, { bus: "weapons", volume: 0.85 });
  }

  // ------------------------------------------------------------------
  // Obliterreur
  // ------------------------------------------------------------------

  private oblitOf(playerId: string): RemoteOblit {
    let o = this.oblits.get(playerId);
    if (!o) {
      o = { anchors: [null, null], tube: null, tubeTimer: 0 };
      this.oblits.set(playerId, o);
    }
    return o;
  }

  private obliterreurPlace(ev: WeaponActionConfirmedEvent): void {
    if (typeof ev.hx !== "number") return;
    const o = this.oblitOf(ev.playerId);
    const index = ev.px === 1 ? 1 : 0;

    // Mirror the server alternation: placing A again clears BOTH anchors
    // (and any active tube was already cancelled by an OBLITERREUR_STOP).
    if (index === 0) this.clearOblitAnchors(ev.playerId);

    const anchor = this.makeOblitAnchor();
    anchor.position.set(ev.hx, ev.hy ?? 0, ev.hz ?? 0);
    this.scene.add(anchor);
    this.disposeOblitAnchor(o.anchors[index]);
    o.anchors[index] = anchor;

    audio.playAt("phase_warp", anchor.position, { bus: "weapons", volume: 0.5, rate: 1.45 });
  }

  private obliterreurFire(ev: WeaponActionConfirmedEvent): void {
    if (typeof ev.px !== "number") return;
    const o = this.oblitOf(ev.playerId);
    this.removeOblitTube(ev.playerId);

    const a = new THREE.Vector3(ev.ox, ev.oy, ev.oz);
    const b = new THREE.Vector3(ev.px, ev.py ?? 0, ev.pz ?? 0);
    // EXACT same curve as the server damage volume (shared constants).
    const chord = a.distanceTo(b);
    const handle = Math.min(
      Math.max(chord * W.obliterreur.curveStrength, W.obliterreur.curveHandleMin),
      W.obliterreur.curveHandleMax,
    );
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.y += handle;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);

    const tube = new THREE.Group();
    const coreGeo = new THREE.TubeGeometry(
      curve,
      W.obliterreur.curveSampleCount,
      W.obliterreur.beamRadius * 0.55,
      10,
      false,
    );
    const coreMat = new THREE.MeshBasicMaterial({ color: 0x0a0312 });
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.frustumCulled = false;

    const glowGeo = new THREE.TubeGeometry(
      curve,
      W.obliterreur.curveSampleCount,
      W.obliterreur.beamRadius * 0.85,
      10,
      false,
    );
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x7c3aed,
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.frustumCulled = false;

    tube.add(core, glow);
    this.scene.add(tube);
    o.tube = tube;
    o.tubeTimer = W.obliterreur.beamDuration;

    audio.playAt("hammer_slam_sub", mid, { bus: "weapons", volume: 0.95, rate: 0.7 });
    audio.playAt("phase_warp", mid, { bus: "weapons", volume: 0.55, rate: 0.8 });
  }

  private removeOblitTube(playerId: string): void {
    const o = this.oblits.get(playerId);
    if (!o?.tube) return;
    this.scene.remove(o.tube);
    for (const child of o.tube.children) {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material)?.dispose();
    }
    o.tube = null;
    o.tubeTimer = 0;
  }

  private clearOblitAnchors(playerId: string): void {
    const o = this.oblits.get(playerId);
    if (!o) return;
    this.disposeOblitAnchor(o.anchors[0]);
    this.disposeOblitAnchor(o.anchors[1]);
    o.anchors[0] = null;
    o.anchors[1] = null;
  }

  private makeOblitAnchor(): THREE.Group {
    const group = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x05010a }),
    );
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(0.44, 16, 12),
      new THREE.MeshBasicMaterial({
        color: 0x7c3aed,
        transparent: true,
        opacity: 0.4,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    core.frustumCulled = false;
    shell.frustumCulled = false;
    group.add(core, shell);
    return group;
  }

  private disposeOblitAnchor(anchor: THREE.Group | null): void {
    if (!anchor) return;
    this.scene.remove(anchor);
    for (const child of anchor.children) {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material)?.dispose();
    }
  }

  // ------------------------------------------------------------------
  // Generic short-lived VFX helpers
  // ------------------------------------------------------------------

  private spawnBurst(
    geometry: THREE.BufferGeometry,
    color: number,
    at: { x: number; y: number; z: number },
    fromScale: number,
    toScale: number,
    life: number,
  ): void {
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(at.x, at.y, at.z);
    mesh.scale.setScalar(fromScale);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.bursts.push({ mesh, mat, age: 0, life, fromScale, toScale });
  }

  /** Flat expanding shockwave-style ring (unit radius, scaled per frame). */
  private spawnGroundRing(
    at: { x: number; y: number; z: number },
    radius: number,
    life: number,
    color: number,
  ): void {
    const geo = new THREE.RingGeometry(0.82, 1, 48);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(at.x, at.y + 0.06, at.z);
    mesh.scale.setScalar(0.2);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.bursts.push({ mesh, mat, age: 0, life, fromScale: 0.2, toScale: radius });
  }
}

/** yaw/pitch (game convention: yaw 0 → -Z, pitch + → up) → unit direction. */
function aimDirection(yaw: number, pitch: number, out: THREE.Vector3): THREE.Vector3 {
  const cp = Math.cos(pitch);
  out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  return out;
}