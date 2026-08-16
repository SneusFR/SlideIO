import * as THREE from "three";
import { ObliterreurConfig as oc } from "./ObliterreurConfig";
import { ObliterreurMarkers } from "./ObliterreurMarkers";
import { ObliterreurBeamVFX } from "./ObliterreurBeamVFX";
import { ObliterreurViewmodel } from "./ObliterreurViewmodel";
import { Combatant } from "../../combat/Combatant";
import { KillMethod } from "../../combat/KillMethod";
import { HitZone } from "../../combat/HitZone";
import { HitFeedbackManager } from "../../combat/HitFeedbackManager";
import { ParticleSystem } from "../../effects/ParticleSystem";

export interface ObliterreurInput {
  /** RMB edge — place / redefine an anchor point (cancels an active beam). */
  placePressed: boolean;
  /** LMB edge — fire the vortex beam between the two anchors. */
  firePressed: boolean;
  /** Static map meshes + targets for the placement raycast (never bots). */
  staticHittables: THREE.Object3D[];
  /** Elapsed game time in seconds (drives all shader animation). */
  time: number;
}

/**
 * The OBLITERREUR — anchored black-vortex weapon.
 *
 * RMB cycles anchor placement P1 → P2 → P1 → … on STATIC surfaces only
 * (camera-center raycast; a miss changes nothing). LMB with both anchors
 * placed opens a huge curved black-vortex beam between them for a few
 * seconds. Every combatant inside the curved tube volume takes 50% max-HP/s
 * — THROUGH WALLS, no occlusion check by design. No cooldown. RMB during
 * an active beam instantly cancels it, then places. Anchors persist after
 * the beam expires naturally.
 */
export class ObliterreurWeapon {
  /** The combatant wielding this weapon (never damaged by its own vortex). */
  owner: Combatant | null = null;

  /** Hit-confirmation feedback sink (local player's weapon only). */
  feedback: HitFeedbackManager | null = null;

  // ---- Hooks (wired by Game) ----
  onCameraShake: ((amount: number) => void) | null = null;
  onPointPlaced: ((index: number) => void) | null = null;
  onBeamStart: (() => void) | null = null;
  onBeamEnd: ((cancelled: boolean) => void) | null = null;

  /** True while the vortex beam is dealing damage. */
  beamActive = false;

  private readonly markers: ObliterreurMarkers;
  private readonly vfx: ObliterreurBeamVFX;
  private readonly viewmodel: ObliterreurViewmodel;

  private nextPointIndex: 0 | 1 = 0;
  private beamTimer = 0;
  private damageTickTimer = 0;
  private damageAccum = 0;
  private particleAccum = 0;
  private sparkAccum = 0;

  /** Sampled centerline of the active beam (damage polyline + audio anchor). */
  private readonly samples: THREE.Vector3[] = [];

  private readonly raycaster = new THREE.Raycaster();
  private static readonly SCREEN_CENTER = new THREE.Vector2(0, 0);

  // Scratch objects (no per-frame allocations)
  private readonly p1 = new THREE.Vector3();
  private readonly n1 = new THREE.Vector3();
  private readonly p2 = new THREE.Vector3();
  private readonly n2 = new THREE.Vector3();
  private readonly hitNormal = new THREE.Vector3();
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpVel = new THREE.Vector3();
  private readonly tmpPos = new THREE.Vector3();
  private readonly segDir = new THREE.Vector3();
  private readonly toPoint = new THREE.Vector3();
  private readonly particleColors = [
    new THREE.Color(0xa855f7),
    new THREE.Color(0x7c3aed),
    new THREE.Color(0x4c1d95),
  ];
  private readonly sparkColors = [
    new THREE.Color(0xe9d5ff),
    new THREE.Color(0xc084fc),
    new THREE.Color(0xa855f7),
  ];

  constructor(
    scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly combatants: Combatant[],
    private readonly particles: ParticleSystem,
  ) {
    this.markers = new ObliterreurMarkers(scene);
    this.vfx = new ObliterreurBeamVFX(scene);
    this.viewmodel = new ObliterreurViewmodel(camera);
    for (let i = 0; i <= oc.obliterreurCurveSampleCount; i++) {
      this.samples.push(new THREE.Vector3());
    }
    this.raycaster.far = oc.obliterreurPlacementRange;
  }

  /** Hide/show the view model (weapon swap, melee busy…). Purely visual. */
  setViewmodelHidden(hidden: boolean): void {
    this.viewmodel.setHidden(hidden);
  }

  // ------------------------------------------------------------------
  // Per-frame update
  // ------------------------------------------------------------------

  update(dt: number, input: ObliterreurInput): void {
    if (input.placePressed) this.handlePlace(input.staticHittables);
    if (input.firePressed) this.tryFire();

    if (this.beamActive) {
      this.beamTimer -= dt;
      this.updateDamage(dt);
      this.emitSuctionParticles(dt);
      if (this.beamTimer <= 0) this.endBeam(false);
    }

    this.markers.setBeamIntensity(this.beamActive ? 1 : 0);
    this.markers.update(dt, input.time);
    this.vfx.update(dt, input.time);
    this.viewmodel.update(dt);
  }

  // ------------------------------------------------------------------
  // RMB — anchor placement
  // ------------------------------------------------------------------

  private handlePlace(staticHittables: THREE.Object3D[]): void {
    // An active beam is instantly cancelled by a redefine attempt.
    if (this.beamActive) this.endBeam(true);

    // Camera-center raycast against STATIC geometry only — bots, players
    // and pickups are automatically excluded from anchoring.
    this.raycaster.setFromCamera(ObliterreurWeapon.SCREEN_CENTER, this.camera);
    const hits = this.raycaster.intersectObjects(staticHittables, true);
    const h = hits.length > 0 ? hits[0] : null;
    if (!h) return; // miss → nothing changes

    if (h.face) {
      this.hitNormal.copy(h.face.normal).transformDirection(h.object.matrixWorld);
    } else {
      this.hitNormal.set(0, 1, 0);
    }

    const index = this.nextPointIndex;
    this.markers.setPoint(index, h.point, this.hitNormal);
    this.nextPointIndex = index === 0 ? 1 : 0;

    this.viewmodel.playPlace();
    this.onCameraShake?.(oc.obliterreurPlaceShake);
    this.onPointPlaced?.(index);
  }

  // ------------------------------------------------------------------
  // LMB — open the vortex
  // ------------------------------------------------------------------

  private tryFire(): void {
    if (this.beamActive) return;
    if (!this.markers.hasPoint(0) || !this.markers.hasPoint(1)) return;

    this.markers.getPoint(0, this.p1, this.n1);
    this.markers.getPoint(1, this.p2, this.n2);

    // Curved spine: bezier handles push away from each surface, scaled by
    // the chord length so short beams stay tight and long ones arc wide.
    const chord = this.p1.distanceTo(this.p2);
    const h = THREE.MathUtils.clamp(
      chord * oc.obliterreurCurveStrength,
      oc.obliterreurCurveHandleMin,
      oc.obliterreurCurveHandleMax,
    );
    const curve = new THREE.CubicBezierCurve3(
      this.p1.clone(),
      this.p1.clone().addScaledVector(this.n1, h),
      this.p2.clone().addScaledVector(this.n2, h),
      this.p2.clone(),
    );

    // Sample the centerline once — reused every damage tick.
    const n = oc.obliterreurCurveSampleCount;
    for (let i = 0; i <= n; i++) {
      curve.getPoint(i / n, this.samples[i]);
    }

    this.vfx.activate(curve, curve.getLength());
    this.beamActive = true;
    this.beamTimer = oc.obliterreurBeamDuration;
    this.damageTickTimer = 0;
    this.damageAccum = 0;
    this.particleAccum = 0;
    this.sparkAccum = 0;

    this.viewmodel.startFire();
    this.onCameraShake?.(oc.obliterreurFireShake);
    this.onBeamStart?.();
  }

  private endBeam(cancelled: boolean): void {
    if (!this.beamActive) return;
    this.beamActive = false;
    this.vfx.deactivate(cancelled);
    this.viewmodel.endFire();
    // Anchor points REMAIN after the beam — placement cycle keeps going.
    this.onBeamEnd?.(cancelled);
  }

  // ------------------------------------------------------------------
  // Damage volume — curved tube, through walls, framerate-independent
  // ------------------------------------------------------------------

  private updateDamage(dt: number): void {
    this.damageAccum += dt;
    this.damageTickTimer -= dt;
    if (this.damageTickTimer > 0) return;
    this.damageTickTimer = 1 / oc.obliterreurDamageTickRate;

    const hitDist = oc.obliterreurBeamRadius + oc.obliterreurTargetHitRadius;
    const hitDistSq = hitDist * hitDist;
    const seconds = this.damageAccum;
    this.damageAccum = 0;
    if (seconds <= 0) return;

    for (const target of this.combatants) {
      if (target === this.owner) continue; // self-immunity
      if (!target.health.alive) continue;
      if (target.targetable === false) continue;
      target.getPosition(this.tmpPos);
      if (this.distSqToPolyline(this.tmpPos) <= hitDistSq) {
        // AoE weapon: always BODY, never a headshot multiplier.
        const damage = target.health.max * oc.obliterreurDamagePerSecondFraction * seconds;
        const applied = target.health.applyDamage(damage, this.owner, KillMethod.OBLITERREUR);
        if (applied) {
          this.feedback?.registerHit({
            attacker: this.owner,
            target,
            hitZone: HitZone.BODY,
            damage,
            position: this.tmpPos,
            weapon: KillMethod.OBLITERREUR,
            isKill: !target.health.alive,
          });
        }
      }
    }
  }

  /** Squared distance from a point to the sampled beam polyline. */
  private distSqToPolyline(p: THREE.Vector3): number {
    let best = Infinity;
    const n = oc.obliterreurCurveSampleCount;
    for (let i = 0; i < n; i++) {
      const a = this.samples[i];
      const b = this.samples[i + 1];
      this.segDir.subVectors(b, a);
      this.toPoint.subVectors(p, a);
      const lenSq = this.segDir.lengthSq();
      const t = lenSq > 0
        ? THREE.MathUtils.clamp(this.toPoint.dot(this.segDir) / lenSq, 0, 1)
        : 0;
      this.tmpVec.copy(a).addScaledVector(this.segDir, t);
      const d = p.distanceToSquared(this.tmpVec);
      if (d < best) best = d;
    }
    return best;
  }

  // ------------------------------------------------------------------
  // Suction VFX — matter dragged into the vortex
  // ------------------------------------------------------------------

  private emitSuctionParticles(dt: number): void {
    this.particleAccum += oc.obliterreurParticleRate * dt;
    while (this.particleAccum >= 1) {
      this.particleAccum -= 1;
      const sample = this.samples[
        Math.floor(Math.random() * (oc.obliterreurCurveSampleCount + 1))
      ];
      // Random radial offset 1.5–3 m away from the spine…
      this.tmpVec
        .set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .normalize()
        .multiplyScalar(1.5 + Math.random() * 1.5);
      this.tmpPos.copy(sample).add(this.tmpVec);
      // …sucked back toward it.
      this.tmpVel
        .subVectors(sample, this.tmpPos)
        .normalize()
        .multiplyScalar(6 + Math.random() * 4);
      const color = this.particleColors[
        Math.floor(Math.random() * this.particleColors.length)
      ];
      this.particles.spawn(this.tmpPos, this.tmpVel, 0.4, color, 0, 0);
    }

    // Bright electric sparks violently ejected from the beam surface —
    // short-lived crackles that break the smoothness of the tube.
    this.sparkAccum += oc.obliterreurSparkRate * dt;
    while (this.sparkAccum >= 1) {
      this.sparkAccum -= 1;
      const sample = this.samples[
        Math.floor(Math.random() * (oc.obliterreurCurveSampleCount + 1))
      ];
      // Spawn right at the ragged tube surface…
      this.tmpVec
        .set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .normalize();
      this.tmpPos
        .copy(sample)
        .addScaledVector(this.tmpVec, oc.obliterreurBeamRadius * (0.9 + Math.random() * 0.6));
      // …and whip OUTWARD with a jittered direction (electric arc snap).
      this.tmpVel
        .copy(this.tmpVec)
        .multiplyScalar(3 + Math.random() * 5);
      this.tmpVel.x += (Math.random() - 0.5) * 3;
      this.tmpVel.y += (Math.random() - 0.5) * 3;
      this.tmpVel.z += (Math.random() - 0.5) * 3;
      const color = this.sparkColors[
        Math.floor(Math.random() * this.sparkColors.length)
      ];
      this.particles.spawn(this.tmpPos, this.tmpVel, 0.12 + Math.random() * 0.2, color, 0, 2);
    }
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /** Full silent reset (death, loadout switch): beam off, anchors cleared. */
  reset(): void {
    if (this.beamActive) {
      this.beamActive = false;
      this.vfx.deactivate(true);
      this.viewmodel.endFire();
    }
    this.markers.clearAll();
    this.markers.setBeamIntensity(0);
    this.nextPointIndex = 0;
    this.beamTimer = 0;
    this.damageAccum = 0;
  }

  /**
   * Position for the spatial beam-audio emitter: the closest point of the
   * beam spine to the player (midpoint fallback when inactive).
   */
  getAudioEmitterPos(playerPos: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    let best = Infinity;
    out.copy(this.samples[Math.floor(oc.obliterreurCurveSampleCount / 2)]);
    for (const s of this.samples) {
      const d = playerPos.distanceToSquared(s);
      if (d < best) {
        best = d;
        out.copy(s);
      }
    }
    return out;
  }
}