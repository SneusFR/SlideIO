import * as THREE from "three";
import { Combatant } from "../../combat/Combatant";
import { KillMethod } from "../../combat/KillMethod";
import { HitZone } from "../../combat/HitZone";
import { HitFeedbackManager } from "../../combat/HitFeedbackManager";
import { TrainingTarget } from "../../targets/TrainingTarget";
import { ViewmodelSystem } from "../viewmodel/ViewmodelSystem";
import { PopcornShotgunProfile, POPCORN_SHOTGUN_TIMELINE, POPCORN_STRAIGHT_FIRE } from "../profiles/PopcornShotgunProfile";
import { prepareStraightFireClips } from "./PopcornStraightFire";
import { PopcornShotgunController, type PopcornShotgunEvents } from "./PopcornShotgunController";
import { PopcornProjectiles } from "./PopcornProjectiles";
import { loadPopcornShotgunGltf } from "./PopcornShotgunModel";
import {
  PopcornShotgunConfig as P,
  popcornAimDirection,
  popcornPelletDirections,
  popcornShotDamage,
  popcornShotIsHeadshot,
  randomPopcornSeed,
  type PopcornPelletHit,
} from "../../../shared/combat/PopcornShotgunRules";

/** Per-frame input snapshot handed by the Game (the weapon owns no input code). */
export interface PopcornShotgunFrameInput {
  /** LMB held (semi-auto: one shot per readyToFire window). */
  fireHeld: boolean;
  /** R edge → reload. */
  reloadPressed: boolean;
  /** F edge → one-hand inspection (visual only). */
  inspectPressed: boolean;
  /** RMB held → tight hip aim (authored Aim pose, crosshair stays free). */
  aimHeld: boolean;
  /** Alive, primary held, pointer locked, not melee / knockdown blocked. */
  canAct: boolean;
  /** Raycast candidates (statics + player proxy + bot models). */
  hittables: THREE.Object3D[];
  /** Static world geometry only (floor search under wall / character impacts — visual). */
  staticHittables: THREE.Object3D[];
  grounded: boolean;
  verticalVelocity: number;
  jumpSequence: number;
  sliding: boolean;
  speed: number;
}

/**
 * POPCORN SHOTGUN — local weapon (gameplay + FP presentation owner).
 *
 * Presentation: the pack's PopcornShotgunController (weapon clips + arms
 * actions on the SAME frame, popcorn tank physics, events) mounted on the
 * shared FP arms through the profile — exactly like the HexSniper.
 *
 * Gameplay (pack §6/§7 — shared/combat/PopcornShotgunRules): 12 seeded
 * pellets raycast from the GAME camera (screen centre) up to 40 m, owner
 * ignored; all pellets of one shot on one target are summed and applied
 * ONCE (one damage event, one hitmarker, clean kill attribution); a head
 * pellet raises the total to the remaining HP.
 *
 * MULTIPLAYER (`networkAuthority`): the shot is PREDICTED (clips, tank,
 * visual popcorns on the local raycasts) and reported with its seed
 * (onNetFire). The server recomputes the same pellets and owns every
 * damage — no local damage; hitmarkers come from HIT_CONFIRMED.
 */
export class PopcornShotgunWeapon {
  owner: Combatant | null = null;
  feedback: HitFeedbackManager | null = null;
  networkAuthority = false;
  /** Camera feedback hook (FPSCamera.addShake). */
  onCameraShake: ((amount: number) => void) | null = null;
  /** Network hooks (wired by the Game in multiplayer). */
  onNetFire: ((seed: number) => void) | null = null;
  onNetReload: (() => void) | null = null;
  onNetReloadCancel: (() => void) | null = null;
  /** Audio / HUD hooks (pure observers, wired by the Game). */
  sfx: PopcornShotgunEvents = {};

  readonly ready: Promise<void>;
  /** Visual popcorns: ONE pool for the local AND the remote shooters. */
  projectiles: PopcornProjectiles | null = null;

  private controller: PopcornShotgunController | null = null;
  private presentationOwner = false;
  private presentationToken = 0;
  private viewmodelVisible = false;
  private inspecting = false;

  private readonly raycaster = new THREE.Raycaster();
  /** Visual floor search under wall / character impacts (static world only). */
  private readonly floorRay = new THREE.Raycaster();
  private readonly pelletDirs = Array.from({ length: P.pellets }, () => new THREE.Vector3());
  private readonly visualTo = Array.from({ length: P.pellets }, () => new THREE.Vector3());
  private readonly visualNormals = Array.from({ length: P.pellets }, () => new THREE.Vector3());
  private readonly visualNormalRefs: (THREE.Vector3 | null)[] = new Array(P.pellets).fill(null);
  private readonly visualFloors: (number | null)[] = new Array(P.pellets).fill(null);
  private readonly camPos = new THREE.Vector3();
  private readonly camFwd = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly muzzleWorld = new THREE.Vector3();
  private readonly hitsByTarget = new Map<Combatant, { hits: PopcornPelletHit[]; point: THREE.Vector3 }>();
  private readonly targetHits = new Map<TrainingTarget, number>();

  constructor(
    private readonly camera: THREE.Camera,
    private readonly worldScene: THREE.Scene,
    private readonly viewmodel: ViewmodelSystem,
  ) {
    this.raycaster.firstHitOnly = true; // BVH map: nearest hit only
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      // The shots play the STRAIGHT fire clips (derived once into the cached
      // FP pose library) — they must exist before the profile is equipped.
      const [gltf] = await Promise.all([
        loadPopcornShotgunGltf(),
        prepareStraightFireClips(PopcornShotgunProfile.fpPosesUrl, POPCORN_STRAIGHT_FIRE.aim, POPCORN_STRAIGHT_FIRE.sources),
      ]);
      this.controller = new PopcornShotgunController(gltf, {
        firstPerson: true, // popcorn physics in the tank
        timeline: POPCORN_SHOTGUN_TIMELINE,
        // No separate muzzle puff: the 12 real popcorns ARE the muzzle effect
        // (one coherent visual — they leave the drawn muzzle pixel).
        burstParent: null,
        events: {
          onShot: (left) => this.sfx.onShot?.(left),
          onDryFire: () => this.sfx.onDryFire?.(),
          onPumpBack: () => this.sfx.onPumpBack?.(),
          onPumpForward: () => this.sfx.onPumpForward?.(),
          onLidOpen: () => this.sfx.onLidOpen?.(),
          onKernelsIn: () => this.sfx.onKernelsIn?.(),
          onLidClose: () => this.sfx.onLidClose?.(),
          onPop: (i, n) => this.sfx.onPop?.(i, n),
          onAmmoRefilled: () => this.sfx.onAmmoRefilled?.(),
          onReloadEnd: (cancelled) => this.sfx.onReloadEnd?.(cancelled),
        },
      });
      this.prepareViewmodelMaterials(this.controller.object);
      // ONE world pool: 256 instanced popcorns sharing the tank template
      // geometry + material (1 draw call, nothing cloned).
      this.projectiles = new PopcornProjectiles(this.controller.tank.popcornMesh, this.worldScene);
      if (this.presentationOwner) this.equipPresentation(true);
    } catch (err) {
      console.error("PopcornShotgun: failed to load the weapon GLB", err);
    }
  }

  /**
   * FP-pass materials: private clones so FP-only state never leaks to the
   * remote TP instances sharing the GLB (the enemy-outline stencil marking
   * is dropped here — the FP pass has no outline). Glass stays transparent.
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
    return this.controller?.ammo ?? P.shots;
  }

  get shots(): number {
    return P.shots;
  }

  get isReloading(): boolean {
    return this.controller?.reloading ?? false;
  }

  /** True while a fire / reload clip runs. */
  get isBusy(): boolean {
    return this.controller?.busy ?? false;
  }

  get isInspecting(): boolean {
    return this.inspecting;
  }

  // ------------------------------------------------------------------
  // Presentation ownership (arbitrated by the Game — HexSniper pattern)
  // ------------------------------------------------------------------

  /** Game → shotgun: take the shared FP arms (real Equip clip). */
  takePresentation(): void {
    if (this.presentationOwner) return;
    this.presentationOwner = true;
    this.equipPresentation(true);
  }

  /** Game → shotgun: release the shared FP arms (weapon switch). */
  releasePresentation(): void {
    this.presentationToken++;
    if (!this.presentationOwner) return;
    this.presentationOwner = false;
    this.cancelReload(); // pack §3: cancelReload() on a weapon switch
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
    void this.viewmodel.equip(PopcornShotgunProfile, c.object, { playEquipClip }).then(() => {
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

  /** Reload interrupted (weapon switch / death): undone before 1.75 s. */
  cancelReload(): void {
    const c = this.controller;
    if (!c || !c.reloading) return;
    c.cancelReload();
    this.onNetReloadCancel?.();
  }

  /**
   * Death / respawn / loadout change: drop the action in progress and
   * refill the tank instantly (the server resets its ammo on respawn too).
   */
  reset(): void {
    const c = this.controller;
    this.cancelInspection();
    if (!c) return;
    if (c.reloading) c.cancelReload();
    if (this.presentationOwner) this.viewmodel.cancelAction(true);
    c.setAmmo(P.shots);
    c.tank.resetMotion();
  }


  // ------------------------------------------------------------------
  // Per frame
  // ------------------------------------------------------------------

  /** Dry-fire click re-arms only after the trigger is released. */
  private dryFireReady = true;

  /**
   * Gameplay + the SINGLE arms-mixer advance while owning the arms. The
   * controller / tank update runs later in postCameraUpdate() — AFTER the
   * FP camera sync (pack §3: the tank reads the final world pose).
   */
  update(dt: number, input: PopcornShotgunFrameInput): void {
    const c = this.controller;
    if (!c || !this.presentationOwner) return;
    if (this.inspecting && (!input.canAct || input.aimHeld || !this.viewmodel.inspecting)) {
      this.cancelInspection();
    }
    if (input.canAct) {
      if (input.fireHeld && c.ammo <= 0 && !c.reloading && this.dryFireReady) {
        // Empty tank: click, then the automatic reload (pack §3 option).
        this.dryFireReady = false;
        c.fire(); // → onDryFire (refused, no state change)
        this.startReload();
      } else if (input.fireHeld && c.canFire) {
        this.fire(input.hittables, input.staticHittables);
      }
      if (!input.fireHeld) this.dryFireReady = true;
      if (input.reloadPressed) this.startReload();
      if (input.inspectPressed && !input.aimHeld && !c.busy && !this.inspecting && this.viewmodelVisible) {
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
   * After ViewmodelSystem.syncCamera (pack §3): weapon clips + tank physics
   * (every frame, even at rest — asleep = no cost) and the shared visual
   * popcorn pool (local + remote shooters).
   */
  postCameraUpdate(dt: number): void {
    if (this.controller && this.presentationOwner) this.controller.update(dt);
    const pool = this.projectiles;
    if (pool) {
      this.camera.getWorldPosition(this.camPos);
      pool.setCamera(this.camPos); // far popcorns get a readability bonus
      pool.update(dt);
    }
  }

  private fire(hittables: THREE.Object3D[], staticHittables: THREE.Object3D[]): void {
    const c = this.controller;
    if (!c) return;
    if (this.inspecting) this.cancelInspection(); // an attack always wins
    if (!c.fire()) return;
    // The trigger must be RELEASED before an empty-tank click (holding it
    // after the last load never clicks / auto-reloads mid FireLast).
    this.dryFireReady = false;
    this.onCameraShake?.(0.18);

    // Pellets from the GAME camera (screen centre). The aim is quantized
    // exactly like the network payload so the server (same seed + same
    // direction) rebuilds bit-identical pellets.
    const seed = randomPopcornSeed();
    this.camera.getWorldPosition(this.camPos);
    this.camera.getWorldDirection(this.camFwd);
    popcornAimDirection(this.camFwd, this.aim);
    popcornPelletDirections(this.aim, seed, this.pelletDirs);
    this.onNetFire?.(seed);

    this.hitsByTarget.clear();
    this.targetHits.clear();
    this.raycaster.far = P.maxRange;
    for (let i = 0; i < P.pellets; i++) {
      const dir = this.pelletDirs[i];
      const hit = this.castPellet(this.camPos, dir, hittables);
      const to = this.visualTo[i];
      if (!hit) {
        to.copy(this.camPos).addScaledVector(dir, P.maxRange);
        this.visualNormalRefs[i] = null;
        this.visualFloors[i] = null;
        continue;
      }
      to.copy(hit.point);
      const normal = (this.visualNormalRefs[i] = hit.face
        ? this.visualNormals[i].copy(hit.face.normal).transformDirection(hit.object.matrixWorld)
        : this.visualNormals[i].copy(dir).negate());
      const combatant = resolveUp<Combatant>(hit.object, "combatant");
      // Visual only: a popcorn hitting a wall / a character falls to the floor below.
      this.visualFloors[i] = combatant || normal.y < 0.6 ? findFloorBelow(this.floorRay, to, normal, staticHittables) : null;
      if (combatant) {
        let entry = this.hitsByTarget.get(combatant);
        if (!entry) {
          entry = { hits: [], point: hit.point.clone() };
          this.hitsByTarget.set(combatant, entry);
        }
        entry.hits.push({ distance: hit.distance, head: resolveZone(hit.object) === HitZone.HEAD });
      } else {
        const target = resolveUp<TrainingTarget>(hit.object, "trainingTarget");
        if (target) this.targetHits.set(target, (this.targetHits.get(target) ?? 0) + 1);
      }
    }

    // Visual popcorns: from the pixel of the DRAWN muzzle to the impacts.
    this.viewmodel.socketWorldForGameCamera(c.muzzle, this.camera, this.muzzleWorld);
    this.projectiles?.spawn(this.muzzleWorld, this.visualTo, this.visualNormalRefs, this.visualFloors);

    if (!this.networkAuthority) this.applyLocalDamage();
  }

  /**
   * GPU warm-up (Game.warmUpRendering): one popcorn of the world pool far
   * below the map so its instanced program compiles at load, never on the
   * first shot. Call `endWarmUp()` after the warm frames.
   */
  beginWarmUp(far: THREE.Vector3): void {
    this.visualTo[0].copy(far).y -= 1;
    this.projectiles?.spawn(far, [this.visualTo[0]], [null]);
    this.projectiles?.update(0.001);
  }

  endWarmUp(): void {
    this.projectiles?.clear(); // pool back at rest
  }

  /** Nearest valid hit of one pellet (owner / corpses skipped). */
  private castPellet(origin: THREE.Vector3, dir: THREE.Vector3, hittables: THREE.Object3D[]): THREE.Intersection | null {
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

  /** SOLO authority: ONE summed damage event per victim for this shot. */
  private applyLocalDamage(): void {
    for (const [target, entry] of this.hitsByTarget) {
      const h = target.health;
      if (!h.alive) continue;
      const amount = popcornShotDamage(entry.hits, h.max, h.current);
      const zone = popcornShotIsHeadshot(entry.hits) ? HitZone.HEAD : HitZone.BODY;
      target.registerImpact?.(this.camFwd.clone().multiplyScalar(2 + entry.hits.length * 0.5), entry.point);
      const applied = h.applyDamage(amount, this.owner, KillMethod.POPCORN_SHOTGUN, zone);
      if (!applied) continue;
      this.feedback?.registerHit({
        attacker: this.owner,
        target,
        hitZone: zone,
        damage: amount,
        position: entry.point,
        weapon: KillMethod.POPCORN_SHOTGUN,
        isKill: !h.alive,
      });
    }
    // Training targets (solo range): 1/8 of their 100 HP per pellet.
    for (const [target, pellets] of this.targetHits) target.applyDamage(pellets * 12.5);
  }
}

const _floorOrigin = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
/** How far below an impact the floor is searched (m) — beyond that the popcorn just vanishes. */
const FLOOR_SEARCH = 8;

/**
 * VISUAL floor height under an impact (wall / character): one downward ray
 * on the STATIC world only (never lands on a bot's head), started a few cm
 * off the surface along its normal. null = no floor within 8 m.
 * Shared by the local shooter and the remote replays (Game).
 */
export function findFloorBelow(
  ray: THREE.Raycaster,
  impact: THREE.Vector3,
  normal: THREE.Vector3,
  statics: THREE.Object3D[],
): number | null {
  _floorOrigin.copy(impact).addScaledVector(normal, 0.08);
  _floorOrigin.y += 0.05;
  ray.set(_floorOrigin, _down);
  ray.near = 0;
  ray.far = FLOOR_SEARCH;
  ray.firstHitOnly = true;
  const hits = ray.intersectObjects(statics, true);
  return hits.length > 0 ? hits[0].point.y : null;
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

