import * as THREE from "three";
import { BassBlasterConfig as cfg } from "./BassBlasterConfig";
import { BassBlasterViewmodel } from "./BassBlasterViewmodel";
import { BassBlasterProjectileSystem } from "./BassBlasterProjectile";
import { MusicTrackPlayer, MusicTrackDef } from "./MusicTrackPlayer";
import { NoteDef, noteForShot } from "./BassBlasterNotes";
import { Combatant } from "../../combat/Combatant";
import { HitFeedbackManager } from "../../combat/HitFeedbackManager";
import { castBeam, BeamCastResult } from "../BeamCombat";
import { ParticleSystem } from "../../effects/ParticleSystem";

/** Per-frame input snapshot handed by the Game (weapon owns no input code). */
export interface BassBlasterFrameInput {
  /** LMB held → full-auto fire (SMG). */
  fireHeld: boolean;
  /** R pressed this frame (edge) → manual reload. */
  reloadPressed: boolean;
  /** False while dead / melee busy / mole strike → inputs ignored. */
  canAct: boolean;
  /** Raycast candidates: statics + player proxy + bot models. */
  hittables: THREE.Object3D[];
  time: number;
}

/**
 * BASS BLASTER — the musical SMG (LOCAL-ONLY, not networked yet).
 *
 * Gameplay: classic SMG — full-auto, low damage per bullet, 30-round
 * magazine, manual reload (R) + auto-reload when empty.
 *
 * Identity: every bullet is a colored MUSICAL NOTE projectile cycling
 * through the scale (Do→Do'), each shot plays a tiny positional fragment
 * of the selected music track (granular playback carried BY the note),
 * and reloading summons a swirl of notes into the weapon.
 *
 * Accuracy model: the projectile is fired from the muzzle but converges
 * on the camera-center crosshair point (standard FPS projectile aim) —
 * no bloom, no spread; imprecision comes only from projectile travel time.
 */
export class BassBlasterWeapon {
  /** Hit-confirmation sink (hitmarkers / sounds / medals — local player). */
  feedback: HitFeedbackManager | null = null;

  /** Camera feedback hook (wired to FPSCamera.addShake by the Game). */
  onCameraShake: ((amount: number) => void) | null = null;
  /** Audio hooks (pure observers, wired by the Game). */
  onShot: ((note: NoteDef) => void) | null = null;
  onReloadStart: (() => void) | null = null;
  onReloadEnd: (() => void) | null = null;

  /** Music library + granular playback engine (also drives the selector UI). */
  readonly music = new MusicTrackPlayer();

  private ownerRef: Combatant | null = null;

  private ammo = cfg.magazineSize;
  private fireCooldown = 0;
  private reloadTimer = 0; // > 0 while reloading (weapon locked)
  /** Grain cadence timer while reloading — the music NEVER stops mid-song. */
  private reloadGrainTimer = 0;
  /** Global shot counter → cyclic note/color selection (never resets). */
  private shotCounter = 0;

  /** Resolves once the viewmodel GLB is loaded (Game GPU warm-up). */
  readonly ready: Promise<void>;

  private readonly camera: THREE.Camera;
  private readonly viewmodel: BassBlasterViewmodel;
  private readonly projectiles: BassBlasterProjectileSystem;

  private readonly raycaster = new THREE.Raycaster();
  private readonly aimResult = new BeamCastResult();
  private static readonly SCREEN_CENTER = new THREE.Vector2(0, 0);

  // Scratch (no per-frame allocations)
  private readonly muzzleWorld = new THREE.Vector3();
  private readonly shotDir = new THREE.Vector3();

  constructor(scene: THREE.Scene, camera: THREE.Camera, particles: ParticleSystem) {
    this.camera = camera;
    this.projectiles = new BassBlasterProjectileSystem(scene, particles);
    this.viewmodel = new BassBlasterViewmodel(camera, particles);
    this.ready = this.viewmodel.ready;
    // Decode the music library early so the first shot already sings.
    this.music.preload();
  }

  /** The combatant wielding this blaster (owner-immune everywhere). */
  set owner(value: Combatant | null) {
    this.ownerRef = value;
    this.projectiles.owner = value;
  }
  get owner(): Combatant | null {
    return this.ownerRef;
  }

  /** Feedback must also reach the projectiles (kills / hitmarkers). */
  setFeedback(feedback: HitFeedbackManager): void {
    this.feedback = feedback;
    this.projectiles.feedback = feedback;
  }

  /** World-impact observer for musical "plink" SFX on walls. */
  set onWorldImpact(cb: ((pos: THREE.Vector3, note: NoteDef) => void) | null) {
    this.projectiles.onWorldImpact = cb;
  }

  // ---- HUD state ----
  get currentAmmo(): number {
    return this.ammo;
  }
  get maxAmmo(): number {
    return cfg.magazineSize;
  }
  get isReloading(): boolean {
    return this.reloadTimer > 0;
  }
  /** 0..1 reload progress (HUD bar). */
  get reloadProgress(): number {
    if (this.reloadTimer <= 0) return 0;
    return 1 - this.reloadTimer / cfg.reloadDuration;
  }
  get currentTrack(): MusicTrackDef {
    return this.music.currentTrack;
  }

  setViewmodelHidden(hidden: boolean): void {
    this.viewmodel.setHidden(hidden);
  }

  /** Track selector arrows (wired to ↑/↓ by the Game). */
  cycleTrack(delta: number): MusicTrackDef {
    return this.music.selectByOffset(delta);
  }

  /**
   * Clean slate (death / loadout swap): reload cancelled instantly, full
   * magazine, in-flight notes removed silently (their grains stop too).
   */
  reset(): void {
    this.reloadTimer = 0;
    this.reloadGrainTimer = 0;
    this.fireCooldown = 0;
    this.ammo = cfg.magazineSize;
    this.viewmodel.cancelReload();
    this.projectiles.clear();
  }

  update(dt: number, input: BassBlasterFrameInput): void {
    // World-side systems always tick (notes fly even while the player
    // is dead or a melee weapon is out).
    this.projectiles.update(dt, input.hittables);
    this.viewmodel.update(dt, input.time);
    if (this.fireCooldown > 0) this.fireCooldown -= dt;

    // Reload lock: no fire until the musical swirl completes.
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      // The music keeps playing during the reload: emit grains at the same
      // cadence as sustained fire so the song continues uninterrupted
      // (fire → music, reload → music, idle → silence).
      this.reloadGrainTimer -= dt;
      if (this.reloadGrainTimer <= 0) {
        this.viewmodel.getMuzzleWorldPosition(this.muzzleWorld);
        this.music.playFragmentAt(this.muzzleWorld);
        this.reloadGrainTimer += cfg.fireInterval;
      }
      if (this.reloadTimer <= 0) {
        this.reloadTimer = 0;
        this.ammo = cfg.magazineSize; // fresh magazine → READY
        this.onReloadEnd?.();
      }
      return;
    }

    if (!input.canAct) return;

    // R — manual reload (only when it actually gains bullets).
    if (input.reloadPressed && this.ammo < cfg.magazineSize) {
      this.startReload();
      return;
    }

    // LMB held — full-auto (SMG cadence).
    if (input.fireHeld && this.fireCooldown <= 0 && this.ammo > 0) {
      this.fireOne(input.hittables);
      this.fireCooldown = cfg.fireInterval;
      if (this.ammo <= 0) this.startReload(); // empty → auto-reload
    }
  }

  // ------------------------------------------------------------------
  // One shot: one note projectile + one music grain
  // ------------------------------------------------------------------

  private fireOne(hittables: THREE.Object3D[]): void {
    this.ammo--;
    const note = noteForShot(this.shotCounter++);

    // Aim: camera-center ray finds the crosshair point, the note flies
    // from the muzzle and converges on it (no spread — SMG feel comes
    // from cadence, not RNG dispersion).
    this.raycaster.setFromCamera(BassBlasterWeapon.SCREEN_CENTER, this.camera);
    castBeam(
      this.raycaster,
      this.raycaster.ray.origin,
      this.raycaster.ray.direction,
      cfg.aimRange,
      hittables,
      this.ownerRef,
      this.aimResult,
    );

    this.viewmodel.getMuzzleWorldPosition(this.muzzleWorld);
    this.shotDir.subVectors(this.aimResult.point, this.muzzleWorld);
    if (this.shotDir.lengthSq() < 1e-6) {
      this.camera.getWorldDirection(this.shotDir);
    }
    this.shotDir.normalize();

    // The music grain starts at the muzzle and RIDES the note projectile.
    const grain = this.music.playFragmentAt(this.muzzleWorld);
    this.projectiles.spawn(this.muzzleWorld, this.shotDir, this.shotCounter - 1, grain);

    // Feedback (visual-only — never displaces the aim).
    this.viewmodel.triggerShot(note);
    this.onCameraShake?.(cfg.shotCameraShake);
    this.onShot?.(note);
  }

  private startReload(): void {
    this.reloadTimer = cfg.reloadDuration;
    // Seamless hand-off from the last shot's grain to the reload grains.
    this.reloadGrainTimer = cfg.fireInterval;
    this.viewmodel.startReload(cfg.reloadDuration);
    this.onReloadStart?.();
  }
}