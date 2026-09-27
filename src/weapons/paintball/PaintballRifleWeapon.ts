import * as THREE from "three";
import { Combatant } from "../../combat/Combatant";
import { KillMethod } from "../../combat/KillMethod";
import { HitZone } from "../../combat/HitZone";
import { HitFeedbackManager } from "../../combat/HitFeedbackManager";
import { TrainingTarget } from "../../targets/TrainingTarget";
import { ViewmodelSystem } from "../viewmodel/ViewmodelSystem";
import { PaintballRifleProfile, PAINTBALL_RIFLE_TIMELINE, PAINTBALL_STRAIGHT_FIRE } from "../profiles/PaintballRifleProfile";
import { preparePaintballStraightFire } from "./PaintballStraightFire";
import { PaintballRifleController, type PaintballEvents } from "./PaintballRifleController";
import { loadPaintballRifleGltf } from "./PaintballRifleModel";
import { PaintballFX } from "./PaintballFX";
import type { PaintHit } from "./PaintballProjectiles";
import {
  PaintballRifleConfig as P,
  PaintballBloomState,
  paintballAimDirection,
  paintballBallDirection,
  paintballDamage,
  quantizePaintballSpread,
  randomPaintballSeed,
} from "../../../shared/combat/PaintballRifleRules";

/** Per-frame input snapshot handed by the Game (the weapon owns no input code). */
export interface PaintballRifleFrameInput {
  /** LMB held (AUTOMATIC: one ball every 0.1 s while held). */
  fireHeld: boolean;
  /** R edge → hopper swap. */
  reloadPressed: boolean;
  /** F edge → one-hand inspection (visual only). */
  inspectPressed: boolean;
  /** RMB held → tight hip aim (authored Aim pose, tighter cone). */
  aimHeld: boolean;
  /** Alive, primary held, pointer locked, not melee / knockdown blocked. */
  canAct: boolean;
  /** Raycast candidates (statics + player proxy + bot models). */
  hittables: THREE.Object3D[];
  grounded: boolean;
  verticalVelocity: number;
  jumpSequence: number;
  sliding: boolean;
  speed: number;
}

/**
 * PAINTBALL RIFLE — local weapon (gameplay + FP presentation owner).
 *
 * Presentation: the pack's PaintballRifleController (weapon clips + arms
 * actions on the SAME frame, hopper physics, fire loop / FireEnd, hopper
 * swap events) mounted on the shared FP arms through the profile — exactly
 * like the Popcorn Shotgun.
 *
 * Gameplay (pack §7 — shared/combat/PaintballRifleRules): AUTOMATIC
 * hitscan, one seeded ball per 0.1 s from the GAME camera (screen centre),
 * no max range (first wall / player / map bounds), owner ignored; 12 body /
 * 18 head applied IMMEDIATELY (no falloff).
 * The visible ball (PaintballFX) leaves the DRAWN muzzle and paints the
 * wall / the character on arrival — purely visual.
 *
 * MULTIPLAYER (`networkAuthority`): the shot is PREDICTED (clips, hopper,
 * visual ball + paint on the local raycast) and reported with its seed +
 * spread + colour (onNetFire). The server rebuilds the same ray and owns
 * every damage — no local damage; hitmarkers come from HIT_CONFIRMED.
 */
export class PaintballRifleWeapon {
  owner: Combatant | null = null;
  feedback: HitFeedbackManager | null = null;
  networkAuthority = false;
  /** Camera feedback hook (FPSCamera.addShake). */
  onCameraShake: ((amount: number) => void) | null = null;
  /** Network hooks (wired by the Game in multiplayer). */
  onNetFire: ((seed: number, spreadDeg: number, colorIndex: number) => void) | null = null;
  onNetReload: (() => void) | null = null;
  onNetReloadCancel: (() => void) | null = null;
  /** Audio / HUD hooks (pure observers, wired by the Game). */
  sfx: PaintballEvents = {};
  /**
   * Solo: the skinned character clone of a hit combatant (bot) — the
   * visual paint target. Wired by the Game (bots only; the local player
   * never paints himself).
   */
  resolveCharacterRoot: ((combatant: Combatant) => THREE.Object3D | null) | null = null;
  /**
   * MULTIPLAYER: nearest remote avatar on the ball ray (the SHARED server
   * hit volumes) — remote players have no local hitbox, so without it the
   * predicted ball would fly through them and splat the wall behind.
   * Returns the distance + the avatar's skinned clone (paint target).
   */
  resolveRemoteHit:
    | ((origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number) => { distance: number; root: THREE.Object3D | null } | null)
    | null = null;

  readonly ready: Promise<void>;
  /** Visual balls + splats + character paint: ONE instance for everybody. */
  readonly fx: PaintballFX;

  private controller: PaintballRifleController | null = null;
  private presentationOwner = false;
  private presentationToken = 0;
  private viewmodelVisible = false;
  private inspecting = false;
  private readonly bloom = new PaintballBloomState();
  /** Colour of the ball that just left (set by the controller's onShot). */
  private readonly shotColor = new THREE.Color();

  private readonly raycaster = new THREE.Raycaster();
  private readonly camPos = new THREE.Vector3();
  private readonly camFwd = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly ballDir = new THREE.Vector3();
  private readonly muzzleWorld = new THREE.Vector3();
  private readonly endPoint = new THREE.Vector3();
  /** Drawn muzzle (WORLD) of the current frame — live anchor of the local balls. */
  private readonly liveMuzzle = new THREE.Vector3();
  private liveMuzzleValid = false;

  constructor(
    private readonly camera: THREE.Camera,
    worldScene: THREE.Scene,
    private readonly viewmodel: ViewmodelSystem,
  ) {
    this.raycaster.firstHitOnly = true; // BVH map: nearest hit only
    this.fx = new PaintballFX(worldScene);
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      // The burst plays the STRAIGHT fire clips (derived once into the cached
      // FP pose library) — they must exist before the profile is equipped.
      const [gltf] = await Promise.all([
        loadPaintballRifleGltf(),
        preparePaintballStraightFire(
          PaintballRifleProfile.fpPosesUrl,
          PAINTBALL_STRAIGHT_FIRE.aim,
          PAINTBALL_STRAIGHT_FIRE.fire,
          PAINTBALL_STRAIGHT_FIRE.fireEnd,
        ),
      ]);
      this.fx.init(gltf);
      this.controller = new PaintballRifleController(gltf, {
        firstPerson: true, // real ball physics in the hopper
        timeline: PAINTBALL_RIFLE_TIMELINE,
        // The empty hopper dropped during the swap: cosmetic copy in the FP scene.
        dropParent: this.viewmodel.scene,
        events: {
          onShot: (left, color) => {
            this.shotColor.copy(color);
            this.sfx.onShot?.(left, color);
          },
          onDryFire: () => this.sfx.onDryFire?.(),
          onBurstStart: () => this.sfx.onBurstStart?.(),
          onBurstEnd: () => this.sfx.onBurstEnd?.(),
          onHopperRelease: () => this.sfx.onHopperRelease?.(),
          onHopperDrop: () => this.sfx.onHopperDrop?.(),
          onHopperIn: () => this.sfx.onHopperIn?.(),
          onAmmoRefilled: () => this.sfx.onAmmoRefilled?.(),
          onSlap: () => this.sfx.onSlap?.(),
          onChargeBack: () => this.sfx.onChargeBack?.(),
          onChargeRelease: () => this.sfx.onChargeRelease?.(),
          onReloadEnd: (cancelled) => this.sfx.onReloadEnd?.(cancelled),
        },
      });
      this.prepareViewmodelMaterials(this.controller.object);
      if (this.presentationOwner) this.equipPresentation(true);
    } catch (err) {
      console.error("PaintballRifle: failed to load the weapon GLB", err);
    }
  }

  /**
   * FP-pass materials: private clones so FP-only state never leaks to the
   * remote TP instances sharing the GLB (the enemy-outline stencil marking
   * is dropped — the FP pass has no outline). The hopper balls are an
   * InstancedMesh added by the controller: it gets the same treatment.
   */
  private prepareViewmodelMaterials(root: THREE.Object3D): void {
    const cloned = new Map<THREE.Material, THREE.Material>();
    const fpClone = (mat: THREE.Material): THREE.Material => {
      let copy = cloned.get(mat);
      if (!copy) {
        copy = mat.clone();
        copy.stencilWrite = false;
        cloned.set(mat, copy);
      }
      return copy;
    };
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(fpClone) : fpClone(mesh.material);
    });
  }

  // ------------------------------------------------------------------
  // State (HUD / Game)
  // ------------------------------------------------------------------

  get ammo(): number {
    return this.controller?.ammo ?? P.capacity;
  }

  get capacity(): number {
    return P.capacity;
  }

  get isReloading(): boolean {
    return this.controller?.reloading ?? false;
  }

  /** True while a burst or a hopper swap runs. */
  get isBusy(): boolean {
    return (this.controller?.busy ?? false) || (this.controller?.firing ?? false);
  }

  get isInspecting(): boolean {
    return this.inspecting;
  }

  /** Current cone (degrees) — crosshair bloom readout. */
  get spreadDeg(): number {
    return this.bloom.spreadDeg;
  }

  // ------------------------------------------------------------------
  // Presentation ownership (arbitrated by the Game — Popcorn pattern)
  // ------------------------------------------------------------------

  /** Game → rifle: take the shared FP arms (real Equip clip). */
  takePresentation(): void {
    if (this.presentationOwner) return;
    this.presentationOwner = true;
    this.equipPresentation(true);
  }

  /** Game → rifle: release the shared FP arms (weapon switch). */
  releasePresentation(): void {
    this.presentationToken++;
    if (!this.presentationOwner) return;
    this.presentationOwner = false;
    this.cancelReload(); // pack: cancelReload() on a weapon switch
    this.inspecting = false;
    this.controller?.attachViewmodel(null);
    this.viewmodel.unequip();
    this.viewmodel.setVisible(false);
  }

  get ownsPresentation(): boolean {
    return this.presentationOwner;
  }

  private equipPresentation(playEquipClip: boolean): void {
    const c = this.controller;
    if (!c) return; // load() equips once the GLB is mounted
    const token = ++this.presentationToken;
    c.attachViewmodel(this.viewmodel);
    c.hopper.resetMotion();
    void this.viewmodel.equip(PaintballRifleProfile, c.object, { playEquipClip }).then(() => {
      if (token !== this.presentationToken || !this.presentationOwner) return;
      this.viewmodel.setVisible(this.viewmodelVisible);
    });
  }

  setViewmodelHidden(hidden: boolean): void {
    if (this.viewmodelVisible === !hidden) return;
    this.viewmodelVisible = !hidden;
    if (this.presentationOwner) this.viewmodel.setVisible(this.viewmodelVisible);
    if (hidden) this.cancelInspection();
  }

  private cancelInspection(): void {
    if (!this.inspecting) return;
    this.inspecting = false;
    if (this.presentationOwner) this.viewmodel.cancelInspect();
  }

  /** Swap interrupted (weapon switch / death / knockdown): undone before 1.52 s. */
  cancelReload(): void {
    const c = this.controller;
    if (!c || !c.reloading) return;
    c.cancelReload();
    this.onNetReloadCancel?.();
  }

  /**
   * Death / respawn / loadout change: drop the action in progress and
   * refill the hopper instantly (the server resets its ammo on respawn too).
   */
  reset(): void {
    const c = this.controller;
    this.cancelInspection();
    this.bloom.reset();
    if (!c) return;
    if (c.reloading) c.cancelReload();
    if (this.presentationOwner) this.viewmodel.cancelAction(true);
    c.setAmmo(P.capacity);
    c.hopper.resetMotion();
  }

  // ------------------------------------------------------------------
  // Per frame
  // ------------------------------------------------------------------

  /** Dry-fire click re-arms only after the trigger is released. */
  private dryFireReady = true;

  /**
   * Gameplay + the SINGLE arms-mixer advance while owning the arms. The
   * controller / hopper update runs later in postCameraUpdate() — AFTER the
   * FP camera sync (pack: the hopper reads the final world pose).
   */
  update(dt: number, input: PaintballRifleFrameInput): void {
    this.bloom.update(dt, input.aimHeld && input.canAct);
    const c = this.controller;
    if (!c || !this.presentationOwner) return;
    if (this.inspecting && (!input.canAct || input.aimHeld || !this.viewmodel.inspecting)) {
      this.cancelInspection();
    }
    if (input.canAct) {
      if (input.fireHeld && c.ammo <= 0 && !c.reloading && this.dryFireReady) {
        // Empty hopper: click, then the automatic swap.
        this.dryFireReady = false;
        c.fire(); // → onDryFire (refused, no state change)
        this.startReload();
      } else if (input.fireHeld && c.canFire) {
        this.fire(input.hittables);
      }
      if (!input.fireHeld) this.dryFireReady = true;
      if (input.reloadPressed) this.startReload();
      if (input.inspectPressed && !input.aimHeld && !this.isBusy && !this.inspecting && this.viewmodelVisible) {
        this.inspecting = c.inspect();
      }
    }
    this.viewmodel.update(dt, {
      straight: input.aimHeld && input.canAct,
      running: input.grounded && !input.sliding && input.speed > 1.5,
      sliding: input.sliding,
      speed: input.speed,
      grounded: input.grounded,
      verticalVelocity: input.verticalVelocity,
      jumpSequence: input.jumpSequence,
    });
  }

  private startReload(): void {
    const c = this.controller;
    if (!c || !c.canReload) return;
    this.cancelInspection();
    if (c.reload()) this.onNetReload?.();
  }

  /**
   * After ViewmodelSystem.syncCamera (pack order): weapon clips + hopper
   * physics (every frame, asleep = no cost), then the shared visual balls
   * (local + remote shooters).
   */
  postCameraUpdate(dt: number): void {
    const c = this.controller;
    if (c && this.presentationOwner) c.update(dt);
    // Live muzzle of the DRAWN gun for this frame (final camera pose): every
    // local ball still in flight starts its line here — strafing / turning /
    // sliding never leaves a ball behind the gun (hitscan feel).
    this.liveMuzzleValid = !!c && this.presentationOwner && this.viewmodelVisible;
    if (this.liveMuzzleValid) this.viewmodel.socketWorldForGameCamera(c!.muzzle, this.camera, this.liveMuzzle);
    this.camera.getWorldPosition(this.camPos);
    this.fx.update(dt, this.camPos);
  }

  /** Anchor handed to the local balls: the drawn muzzle of the current frame. */
  private readonly muzzleAnchor = (out: THREE.Vector3): boolean => {
    if (!this.liveMuzzleValid) return false;
    out.copy(this.liveMuzzle);
    return true;
  };

  /** One ball: seeded hitscan from the camera + visual ball from the drawn muzzle. */
  private fire(hittables: THREE.Object3D[]): void {
    const c = this.controller;
    if (!c) return;
    if (this.inspecting) this.cancelInspection(); // an attack always wins
    if (!c.fire()) return; // → onShot(ammoLeft, color) filled shotColor
    this.dryFireReady = false;
    this.onCameraShake?.(0.035);

    // Ray from the GAME camera (screen centre). Aim + spread quantized
    // exactly like the network payload: the server rebuilds the same ray.
    const seed = randomPaintballSeed();
    const spread = quantizePaintballSpread(this.bloom.spreadDeg);
    this.bloom.onShot();
    this.camera.getWorldPosition(this.camPos);
    this.camera.getWorldDirection(this.camFwd);
    paintballAimDirection(this.camFwd, this.aim);
    paintballBallDirection(this.aim, spread, seed, this.ballDir);
    this.onNetFire?.(seed, spread, this.fx.indexOf(this.shotColor));

    this.raycaster.far = P.maxRange;
    const hit = this.castBall(this.camPos, this.ballDir, hittables);
    let paint: PaintHit | null = null;
    let combatant: Combatant | null = null;
    const remote = this.resolveRemoteHit?.(this.camPos, this.ballDir, hit ? hit.distance : P.maxRange) ?? null;
    if (remote) {
      // A remote player in front of everything: the ball lands on HIM.
      this.endPoint.copy(this.camPos).addScaledVector(this.ballDir, remote.distance);
      paint = remote.root ? this.fx.characterHit(remote.root, this.camPos, this.ballDir, this.endPoint) : null;
    } else if (!hit) {
      this.endPoint.copy(this.camPos).addScaledVector(this.ballDir, P.maxRange);
    } else {
      this.endPoint.copy(hit.point);
      combatant = resolveUp<Combatant>(hit.object, "combatant");
      if (combatant) {
        const root = this.resolveCharacterRoot?.(combatant) ?? null;
        paint = root ? this.fx.characterHit(root, this.camPos, this.ballDir, hit.point) : null;
      } else if (!resolveUp<TrainingTarget>(hit.object, "trainingTarget")) {
        paint = this.fx.surfaceHit(hit, this.ballDir, seed); // static level geometry
      }
    }

    // The real ball: from the pixel of the DRAWN muzzle straight to the
    // hitscan impact, its line start glued to the live muzzle.
    this.viewmodel.socketWorldForGameCamera(c.muzzle, this.camera, this.muzzleWorld);
    this.fx.spawn(this.muzzleWorld, this.endPoint, this.shotColor, paint, this.muzzleAnchor);

    if (!this.networkAuthority && hit && !remote) this.applyLocalDamage(hit, combatant);
  }

  /** Nearest valid hit of one ball (owner / corpses skipped). */
  private castBall(origin: THREE.Vector3, dir: THREE.Vector3, hittables: THREE.Object3D[]): THREE.Intersection | null {
    this.raycaster.set(origin, dir);
    const hits = this.raycaster.intersectObjects(hittables, true);
    for (const h of hits) {
      const combatant = resolveUp<Combatant>(h.object, "combatant");
      if (combatant && combatant === this.owner) continue; // never hit yourself
      if (combatant && !combatant.health.alive) continue; // corpses don't block
      return h;
    }
    return null;
  }

  /** SOLO authority: 12 / 18 immediately (hitscan — never at the ball's arrival). */
  private applyLocalDamage(hit: THREE.Intersection, combatant: Combatant | null): void {
    if (!combatant) {
      const target = resolveUp<TrainingTarget>(hit.object, "trainingTarget");
      if (target) target.applyDamage(P.bodyDamage);
      return;
    }
    const h = combatant.health;
    if (!h.alive) return;
    const zone = resolveZone(hit.object);
    const amount = paintballDamage(zone === HitZone.HEAD);
    combatant.registerImpact?.(this.ballDir.clone().multiplyScalar(0.6), hit.point.clone());
    const applied = h.applyDamage(amount, this.owner, KillMethod.PAINTBALL_RIFLE, zone);
    if (!applied) return;
    this.feedback?.registerHit({
      attacker: this.owner,
      target: combatant,
      hitZone: zone,
      damage: amount,
      position: hit.point.clone(),
      weapon: KillMethod.PAINTBALL_RIFLE,
      isKill: !h.alive,
    });
  }

  /**
   * GPU warm-up (Game.warmUpRendering): one ball of the world pool + one
   * splat far below the map so their programs compile at load, never on
   * the first shot. `endWarmUp()` clears them after the warm frames.
   */
  beginWarmUp(far: THREE.Vector3): void {
    const to = far.clone();
    to.y -= 1;
    const color = new THREE.Color(1, 0.2, 0.2);
    this.fx.spawn(far, to, color, null);
    this.fx.update(0.001);
    this.fx.splats.splatSurface(to, new THREE.Vector3(0, 1, 0), color, undefined, 1);
  }

  endWarmUp(): void {
    this.fx.update(10); // the warm ball (a miss) fades out
    this.fx.update(10);
    this.fx.clearAll();
  }
}

/** Walk up the parent chain looking for a userData tag. */
function resolveUp<T>(object: THREE.Object3D, key: string): T | null {
  let o: THREE.Object3D | null = object;
  while (o) {
    const v = o.userData[key] as T | undefined;
    if (v) return v;
    o = o.parent;
  }
  return null;
}

/** Hit zone of the struck mesh (stops at the combatant root — BeamCombat rule). */
function resolveZone(object: THREE.Object3D): HitZone {
  let o: THREE.Object3D | null = object;
  while (o) {
    const z = o.userData.hitZone as HitZone | undefined;
    if (z) return z;
    if (o.userData.combatant) break;
    o = o.parent;
  }
  return HitZone.BODY;
}
