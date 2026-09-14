import * as THREE from "three";
import { Combatant } from "../../combat/Combatant";
import { HitFeedbackManager } from "../../combat/HitFeedbackManager";
import { PhysicsWorld } from "../../physics/PhysicsWorld";
import { ViewmodelSystem } from "../viewmodel/ViewmodelSystem";
import { NetworkWeaponConfig, goofyBasketLevelForHold } from "../../../shared/combat/NetworkWeapons";
import { resolveBasketLaunch } from "../../../shared/combat/BasketProjectileSim";
import { GOOFY_TIMING } from "./GoofyBasketProfile";
import { GoofyBasketViewmodel, type GoofyViewmodelMotion } from "./GoofyBasketViewmodel";
import { GoofyBasketProjectileSystem, type BasketTargetSource } from "./GoofyBasketProjectile";
import { DEFAULT_WEAPON_SKIN, sanitizeWeaponSkin } from "../../../shared/combat/WeaponSkins";
import { NetworkWeaponId } from "../../../shared/combat/NetworkWeapons";

const B = NetworkWeaponConfig.goofyBasket;

export interface GoofyBasketFrameInput {
  /** Throw input held this frame (LMB). */
  fireHeld: boolean;
  /** F pressed (inspection) — the Game already applied the terminal priority. */
  inspectPressed: boolean;
  /** Alive, primary held, pointer locked, not melee/knockdown-blocked. */
  canAct: boolean;
  motion: GoofyViewmodelMotion;
  /** Shooter WORLD velocity this frame (m/s) — the thrown ball inherits it. */
  velocity: THREE.Vector3;
}

/** Gameplay sequence of the ball in hand (independent from the presentation). */
type Sequence =
  | { kind: "ready" }
  | { kind: "charging"; since: number }
  /** Release accepted: the throw starts after a short gather (ball was dribbling). */
  | { kind: "gathering"; level: 1 | 2 | 3; until: number }
  | { kind: "throwing"; level: 1 | 2 | 3; elapsed: number; released: boolean; predictedId: number | null; serverId: number | null }
  | { kind: "catching"; elapsed: number };

/**
 * GOOFY BASKET weapon controller — owns charge / level lock / release
 * marker / catch availability and the projectiles. The presentation
 * (arms + cosmetic ball) is delegated to GoofyBasketViewmodel; the two
 * never share state: the controller REQUESTS phases, the viewmodel plays
 * them (and resumes them if the clips attach late).
 *
 * Input: press = charge start (level 1 available at once); hold raises the
 * level at 0.58 / 1.00 s; release locks the level and engages Throw_Ln.
 * The projectile leaves ONCE at the authored marker (0.14 / 0.16 / 0.18 s)
 * — counted on the controller's own clock so a late animation never
 * doubles or skips it. After the Throw recovery, Catch (0.58 s) brings a
 * new ball; the next charge is only available at its end.
 *
 * MULTIPLAYER (`networkAuthority`): CHARGE_START / THROW_REQUEST are sent;
 * the local sequence predicts the same timeline; the server's THROW confirm
 * carries the locked level + projectile id (reconciled), LAUNCH/BOUNCE/END
 * drive corrections. No local damage, no local hitmarker.
 */
export class GoofyBasketWeapon {
  owner: Combatant | null = null;
  /** Camera feedback hook (wired to FPSCamera.addShake by the Game). */
  onCameraShake: ((amount: number) => void) | null = null;
  /** Network hooks (wired by the Game in multiplayer). */
  onNetChargeStart: (() => void) | null = null;
  onNetChargeCancel: (() => void) | null = null;
  /** Release → server: gather flag + the shooter velocity the ball inherits. */
  onNetThrowRequest: ((gatherDelayed: boolean, shooterVelocity: THREE.Vector3) => void) | null = null;
  /** Cosmetic: a ball left the hand (audio). */
  onRelease: ((level: 1 | 2 | 3) => void) | null = null;
  networkAuthority = false;

  readonly viewmodel: GoofyBasketViewmodel;
  readonly projectiles: GoofyBasketProjectileSystem;

  private seq: Sequence = { kind: "ready" };
  private clock = 0;
  private viewmodelVisible = false;
  private inspecting = false;
  private ownerKey: string | null = null;
  /**
   * COSMETIC skin id of the held ball (validated). Captured into every
   * projectile at ITS creation — a later skin change never recolors a ball
   * already in flight (predicted or server-launched).
   */
  private skinId: string = DEFAULT_WEAPON_SKIN;
  /** Aim captured at the release (the marker launches along it, never re-aimed). */
  private readonly aimOrigin = new THREE.Vector3();
  private readonly aimDir = new THREE.Vector3();
  /** Shooter velocity captured at the release (the ball inherits it). */
  private readonly aimShooterVel = new THREE.Vector3();
  /** Latest shooter velocity fed by the Game (read at the release). */
  private readonly frameVelocity = new THREE.Vector3();
  private readonly tmpOrigin = new THREE.Vector3();
  private readonly tmpVel = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.Camera,
    scene: THREE.Scene,
    physics: PhysicsWorld,
    viewmodelSystem: ViewmodelSystem,
  ) {
    this.viewmodel = new GoofyBasketViewmodel(viewmodelSystem);
    this.projectiles = new GoofyBasketProjectileSystem(scene, physics);
  }

  get ready(): Promise<void> {
    return this.viewmodel.ready;
  }

  setFeedback(feedback: HitFeedbackManager): void {
    this.projectiles.feedback = feedback;
  }

  setOwner(owner: Combatant, key: string | null): void {
    this.owner = owner;
    this.ownerKey = key;
    this.projectiles.owner = owner;
  }

  setTargets(targets: BasketTargetSource | null): void {
    this.projectiles.setTargets(targets);
  }

  /**
   * Equip a COSMETIC skin on the held ball. Pure presentation: no reset,
   * no sequence change, no network attack cancel — a skin change alone
   * must never behave like a weapon swap. Balls already flying keep the
   * skin captured at their creation.
   */
  setSkin(skinId: string): void {
    const valid = sanitizeWeaponSkin(NetworkWeaponId.GOOFY_BASKET, skinId);
    if (valid === this.skinId) return;
    this.skinId = valid;
    this.viewmodel.setSkin(valid);
  }

  /** Validated cosmetic skin id currently equipped on the held ball. */
  get skin(): string {
    return this.skinId;
  }

  /** True while a charge / throw / catch sequence is engaged (blocks slot switches like other weapons' busy states). */
  get isBusy(): boolean {
    return this.seq.kind !== "ready";
  }

  get isCharging(): boolean {
    return this.seq.kind === "charging";
  }

  /** Charge level the release WOULD lock right now (HUD), or 0 when not charging. */
  get chargeLevel(): 0 | 1 | 2 | 3 {
    return this.seq.kind === "charging" ? goofyBasketLevelForHold(this.clock - this.seq.since) : 0;
  }

  /** Normalized charge progress 0..1 (HUD). */
  get chargeProgress(): number {
    if (this.seq.kind !== "charging") return 0;
    return THREE.MathUtils.clamp((this.clock - this.seq.since) / B.maxChargeSeconds, 0, 1);
  }

  get isInspecting(): boolean {
    return this.inspecting;
  }

  get inspectTime(): number {
    return this.viewmodel.inspectTime;
  }

  // ------------------------------------------------------------------
  // Presentation ownership (arbitrated by the Game)
  // ------------------------------------------------------------------

  /** True while this weapon owns the shared FP presentation (Game-arbitrated). */
  private presentationOwner = false;

  /** Game → basket: take the shared FP arms (real Equip clip). */
  takePresentation(): void {
    this.presentationOwner = true;
    void this.viewmodel.equip(true);
  }

  /** Game → basket: release the shared FP arms (another weapon takes them). */
  releasePresentation(): void {
    this.presentationOwner = false;
    this.cancelInspection();
    this.viewmodel.hide();
  }

  setViewmodelHidden(hidden: boolean): void {
    if (this.viewmodelVisible === !hidden) return;
    this.viewmodelVisible = !hidden;
    if (hidden) this.cancelInspection();
  }

  /**
   * Death / weapon swap / reset: the local presentation is cancelled and
   * its ball hidden; a charge is dropped (CHARGE_CANCEL), a throw not yet
   * released never creates a projectile. Already flying balls keep their
   * lifecycle (solo: they still bounce; multi: server-owned).
   */
  reset(): void {
    if (this.seq.kind === "charging") this.onNetChargeCancel?.();
    this.seq = { kind: "ready" };
    this.cancelInspection();
    this.viewmodel.cancelPhase();
    // Death / knockdown while we STILL own the arms (the Game keeps the
    // same owner across a respawn): drop the presentation, then re-equip
    // right away so a fresh ball is in the hand at the respawn. A reset
    // caused by a weapon swap runs with the ownership already released.
    this.viewmodel.hide();
    if (this.presentationOwner) void this.viewmodel.equip(false);
  }

  /** Loadout swap / leaving the match: also drop every flying ball. */
  clearProjectiles(): void {
    this.projectiles.clear();
  }

  private cancelInspection(): void {
    if (!this.inspecting) return;
    this.inspecting = false;
    this.viewmodel.cancelInspect();
  }

  // ------------------------------------------------------------------
  // Server confirms (our own actions, multiplayer)
  // ------------------------------------------------------------------

  /** BASKET_THROW: the server locked `level` and assigned `pid`; resync the timeline. */
  onNetworkThrow(level: 1 | 2 | 3, pid: number, elapsed: number): void {
    if (this.seq.kind === "throwing") {
      this.seq.serverId = pid;
      if (this.seq.level !== level) {
        // Disagreement (clock skew at a threshold): the server level wins,
        // presentation re-requested at the elapsed time; the marker keeps
        // the already-released ball if it left (never a second one).
        this.seq.level = level;
        if (!this.seq.released) this.viewmodel.setPhase({ kind: "throw", level, startAt: Math.max(0, elapsed) });
      }
      return;
    }
    if (this.seq.kind === "gathering") {
      this.seq.level = level;
      return;
    }
    if (this.seq.kind === "catching") return;
    // Confirm arrived for a sequence we no longer predict (reset meanwhile):
    // replay it so the presentation matches the server (hands / ball).
    this.seq = { kind: "throwing", level, elapsed: Math.max(0, elapsed), released: false, predictedId: null, serverId: pid };
    this.viewmodel.setPhase({ kind: "throw", level, startAt: Math.max(0, elapsed) });
  }

  /** BASKET_LAUNCH: authoritative start of our ball → reconcile the predicted one. */
  onNetworkLaunch(pid: number, level: 1 | 2 | 3, origin: THREE.Vector3, velocity: THREE.Vector3): void {
    const s = this.seq;
    if (s.kind === "throwing" && s.serverId === pid && s.predictedId !== null) {
      this.projectiles.reconcileLocal(s.predictedId, pid, origin, velocity);
      s.predictedId = pid;
      return;
    }
    if (s.kind === "throwing" && s.serverId === pid && !s.released) {
      // Server marker before ours (latency): launch now on the server data.
      s.released = true;
      s.predictedId = this.projectiles.launch(origin, velocity, level, this.ownerKey, pid, this.skinId);
      this.onRelease?.(level);
      return;
    }
    if (!this.projectiles.has(pid)) this.projectiles.launch(origin, velocity, level, this.ownerKey, pid, this.skinId);
  }

  onNetworkBounce(pid: number, index: number, pos: THREE.Vector3, vel: THREE.Vector3, normal: THREE.Vector3): void {
    this.projectiles.applyServerBounce(pid, index, pos, vel, normal);
  }

  /** BASKET_REST: our ball came to rest on the server — snap it there until END. */
  onNetworkRest(pid: number, pos: THREE.Vector3): void {
    this.projectiles.applyServerRest(pid, pos);
  }

  onNetworkEnd(pid: number, point: THREE.Vector3): void {
    this.projectiles.applyServerEnd(pid, point);
  }


  // ------------------------------------------------------------------
  // Per-frame (gameplay + the single FP mixer advance when owner)
  // ------------------------------------------------------------------

  /**
   * `ownsPresentation` = the Game handed us the FP arms this frame (we then
   * advance the shared mixer ONCE through the viewmodel). Gameplay
   * (sequence clock, marker launch, projectiles) runs regardless.
   */
  update(dt: number, input: GoofyBasketFrameInput, ownsPresentation: boolean): void {
    this.clock += dt;
    this.frameVelocity.copy(input.velocity);
    const held = input.canAct && input.fireHeld;

    // ---- Input → sequence ----
    switch (this.seq.kind) {
      case "ready":
        if (held) this.startCharge();
        break;
      case "charging": {
        const level = goofyBasketLevelForHold(this.clock - this.seq.since);
        if (!input.canAct) {
          // Blocked mid-charge (death / knockdown / stow): dropped, no throw.
          this.seq = { kind: "ready" };
          this.viewmodel.cancelPhase();
          this.onNetChargeCancel?.();
          break;
        }
        const shown = this.viewmodel.currentPhase;
        if (shown.kind !== "charge" || shown.level !== level) {
          this.viewmodel.setPhase({ kind: "charge", level }); // thresholds are timers, never fade ends
        }
        if (!held) this.release(level);
        break;
      }
      case "gathering":
        if (this.clock >= this.seq.until) this.beginThrow(this.seq.level);
        break;
      case "throwing": {
        this.seq.elapsed += dt;
        const def = GOOFY_TIMING.throws[this.seq.level - 1];
        // The ball leaves ONCE when the controller clock crosses the marker
        // (never at the press, never again at an animation callback).
        if (!this.seq.released && this.seq.elapsed >= def.releaseAt) {
          this.seq.released = true;
          this.launchLocal(this.seq);
        }
        if (this.seq.elapsed >= def.duration) {
          this.seq = { kind: "catching", elapsed: this.seq.elapsed - def.duration };
          // The viewmodel chains Throw → Catch itself; resync only when its
          // phase drifted (late equip / cancelled action).
          if (this.viewmodel.currentPhase.kind !== "catch") {
            this.viewmodel.setPhase({ kind: "catch", startAt: this.seq.elapsed });
          }
        }
        break;
      }
      case "catching":
        this.seq.elapsed += dt;
        // The 0.34 s hand contact is cosmetic: availability waits the full 0.58 s.
        if (this.seq.elapsed >= GOOFY_TIMING.catch) {
          this.seq = { kind: "ready" };
          if (held) this.startCharge(); // held through the catch: a NEW charge starts now
        }
        break;
    }

    // ---- Inspection (F): visual only, refused while the sequence runs ----
    if (this.inspecting && (!input.canAct || !this.viewmodel.isInspecting)) this.inspecting = false;
    if (input.inspectPressed && input.canAct && this.seq.kind === "ready" && ownsPresentation && !this.inspecting) {
      this.inspecting = this.viewmodel.startInspect(() => {
        this.inspecting = false;
      });
    }

    // ---- Presentation (single mixer advance) ----
    if (ownsPresentation && this.viewmodel.isAttached) this.viewmodel.update(dt, input.motion);
    // Cosmetic skin effects follow the ball EVERY frame (charge = the same
    // normalized progress the HUD shows; visible = the real ball flag).
    this.viewmodel.updateSkin(dt, this.chargeProgress);

    // ---- Flying balls (world) ----
    this.projectiles.update(dt);
  }

  // ------------------------------------------------------------------

  private startCharge(): void {
    this.seq = { kind: "charging", since: this.clock };
    this.cancelInspection();
    // A dribbling ball gathers into the hand while the charge pose starts.
    this.viewmodel.gatherBall();
    this.viewmodel.setPhase({ kind: "charge", level: 1 });
    this.onNetChargeStart?.();
  }

  /** Release: lock the level NOW; a dribble gather (if any) precedes the throw. */
  private release(level: 1 | 2 | 3): void {
    this.camera.getWorldPosition(this.aimOrigin);
    this.camera.getWorldDirection(this.aimDir);
    // The shooter momentum of THIS frame rides on the ball (shared rule);
    // the same vector goes to the server so both compute the same launch.
    this.aimShooterVel.copy(this.frameVelocity);
    const gatherDelayed = this.viewmodel.ballFree;
    if (gatherDelayed) {
      this.seq = { kind: "gathering", level, until: this.clock + GOOFY_TIMING.gather };
      this.viewmodel.gatherBall();
    } else {
      this.beginThrow(level);
    }
    this.onNetThrowRequest?.(gatherDelayed, this.aimShooterVel);
  }

  private beginThrow(level: 1 | 2 | 3): void {
    const prev = this.seq;
    this.seq = {
      kind: "throwing",
      level,
      elapsed: 0,
      released: false,
      predictedId: null,
      serverId: prev.kind === "throwing" ? prev.serverId : null,
    };
    this.viewmodel.setPhase({ kind: "throw", level, startAt: 0 });
  }

  /**
   * Launch along the aim captured at the release with the SHARED rule
   * (resolveBasketLaunch): the ball leaves the RIGHT HAND point (eye +
   * right/down/forward offsets), converging on the crosshair line, at the
   * level speed plus the shooter's own momentum. If the hand is inside
   * geometry the eye (+ radius) is used instead — never a start inside a
   * wall, never a tunnel (the first swept step resolves any contact).
   */
  private launchLocal(seq: Extract<Sequence, { kind: "throwing" }>): void {
    const { start, vel } = resolveBasketLaunch(
      { x: this.aimOrigin.x, y: this.aimOrigin.y, z: this.aimOrigin.z },
      { x: this.aimDir.x, y: this.aimDir.y, z: this.aimDir.z },
      seq.level,
      { x: this.aimShooterVel.x, y: this.aimShooterVel.y, z: this.aimShooterVel.z },
      (from, dir, maxDist) => this.projectiles.raycastWorld(from, dir, maxDist),
    );
    this.tmpOrigin.set(start.x, start.y, start.z);
    this.tmpVel.set(vel.x, vel.y, vel.z);
    seq.predictedId = this.projectiles.launch(this.tmpOrigin, this.tmpVel, seq.level, this.ownerKey, seq.serverId, this.skinId);
    this.onRelease?.(seq.level);
    this.onCameraShake?.(0.1 + 0.1 * seq.level);
  }
}
