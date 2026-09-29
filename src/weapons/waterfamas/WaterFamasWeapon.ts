import * as THREE from "three";
import { Combatant } from "../../combat/Combatant";
import { KillMethod } from "../../combat/KillMethod";
import { HitZone } from "../../combat/HitZone";
import { HitFeedbackManager } from "../../combat/HitFeedbackManager";
import { TrainingTarget } from "../../targets/TrainingTarget";
import { ViewmodelSystem } from "../viewmodel/ViewmodelSystem";
import { WaterFamasProfile, WATER_FAMAS_TIMELINE, WATER_FAMAS_STRAIGHT_FIRE } from "../profiles/WaterFamasProfile";
import { prepareWaterFamasStraightFire } from "./WaterFamasStraightFire";
import { WaterFamasController, type WaterFamasEvents } from "./WaterFamasController";
import { loadWaterFamasGltf } from "./WaterFamasModel";
import { WaterFamasFX } from "./WaterFamasFX";
import type { WaterJetHit } from "./WaterJets";
import {
  WaterFamasConfig as W,
  randomWaterFamasSeed,
  waterFamasAimDirection,
  waterFamasJetDamage,
  waterFamasJetDirection,
  waterFamasJetSeed,
} from "../../../shared/combat/WaterFamasRules";

/** Per-frame input snapshot handed by the Game (the weapon owns no input code). */
export interface WaterFamasFrameInput {
  /** LMB went down THIS frame (ONE burst per pull — holding never re-fires). */
  firePressed: boolean;
  /** LMB held (only used to click / auto-refill on an empty tank). */
  fireHeld: boolean;
  /** R edge → refill. */
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
 * WATER FAMAS — local weapon (gameplay + FP presentation owner).
 *
 * Presentation: the pack's WaterFamasController (weapon clips + arms actions
 * on the SAME frame, live tank water, burst timing, refill events) mounted on
 * the shared FP arms through the profile — like the Paintball Rifle, but
 * ONE-HANDED (the left arm only comes to the gun for the refill).
 *
 * Gameplay (shared/combat/WaterFamasRules): ONE burst per trigger pull, 3 jets
 * at 0 / 0.075 / 0.15 s. EVERY jet is its own instant hitscan from the GAME
 * camera (screen centre), cast in `onJet` = the instant the jet leaves the
 * barrel (so a burst dragged across a target can touch 3 points), no range limit,
 * seeded cone, owner ignored, 24 body / 36 head applied IMMEDIATELY (no
 * falloff). The visible jet (WaterFamasFX) leaves the DRAWN muzzle and wets
 * the wall / the character on arrival — purely visual.
 *
 * MULTIPLAYER (`networkAuthority`): each jet is PREDICTED (clips, tank, visible
 * jet + wet mark on the local raycast) and reported with its seed / index /
 * ADS flag (onNetFire, one message per jet). The server rebuilds the same ray,
 * hitscans it (lag-compensated) and owns every damage — no local damage. The
 * hitmarker + hit sound fire at the jet on a predicted remote hit
 * (onPredictedRemoteHit); HIT_CONFIRMED adds the damage number (and kills).
 */
export class WaterFamasWeapon {
  owner: Combatant | null = null;
  feedback: HitFeedbackManager | null = null;
  networkAuthority = false;
  /** Network hooks (wired by the Game in multiplayer). */
  onNetFire: ((seed: number, jet: number, aiming: boolean) => void) | null = null;
  onNetReload: (() => void) | null = null;
  onNetReloadCancel: (() => void) | null = null;
  /** Audio / HUD hooks (pure observers, wired by the Game). */
  sfx: WaterFamasEvents = {};
  /**
   * Solo: the skinned character clone of a hit combatant (bot) — the visual
   * wet target. Wired by the Game (bots only; the local player never wets himself).
   */
  resolveCharacterRoot: ((combatant: Combatant) => THREE.Object3D | null) | null = null;
  /**
   * MULTIPLAYER: nearest remote avatar on the jet ray (the SHARED server hit
   * volumes) — remote players have no local hitbox, so without it the
   * predicted jet would fly through them and wet the wall behind.
   */
  resolveRemoteHit:
    | ((
        origin: THREE.Vector3,
        dir: THREE.Vector3,
        maxDist: number,
      ) => { distance: number; root: THREE.Object3D | null; head: boolean } | null)
    | null = null;
  /** MULTIPLAYER: the predicted jet hit a remote avatar (hitmarker + sound at the jet). */
  onPredictedRemoteHit: ((zone: HitZone) => void) | null = null;

  readonly ready: Promise<void>;
  /** Visible jets + wet marks + character wetness: ONE instance for everybody. */
  readonly fx: WaterFamasFX;

  private controller: WaterFamasController | null = null;
  private presentationOwner = false;
  private presentationToken = 0;
  private viewmodelVisible = false;
  private inspecting = false;
  /** Jet hitscan scratch. */
  private readonly raycaster = new THREE.Raycaster();
  private readonly camPos = new THREE.Vector3();
  private readonly camFwd = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly jetDir = new THREE.Vector3();
  private readonly muzzleWorld = new THREE.Vector3();
  private readonly endPoint = new THREE.Vector3();
  /** Seed of the running burst (jet k uses waterFamasJetSeed(burstSeed, k)). */
  private burstSeed = 0;
  /** Drawn muzzle (WORLD) of the current frame — live anchor of the local jets. */
  private readonly liveMuzzle = new THREE.Vector3();
  private liveMuzzleValid = false;
  /** Hittables of the frame (jets 1 / 2 are cast from update(), after fire()). */
  private frameHittables: THREE.Object3D[] = [];

  constructor(
    private readonly camera: THREE.Camera,
    worldScene: THREE.Scene,
    private readonly viewmodel: ViewmodelSystem,
  ) {
    this.raycaster.firstHitOnly = true; // BVH map: nearest hit only
    this.fx = new WaterFamasFX(worldScene);
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      // The hip burst plays the STRAIGHT clip (derived once into the cached FP
      // pose library) — it must exist before the profile is equipped.
      const [gltf] = await Promise.all([
        loadWaterFamasGltf(),
        prepareWaterFamasStraightFire(
          WaterFamasProfile.fpPosesUrl,
          WATER_FAMAS_STRAIGHT_FIRE.aim,
          WATER_FAMAS_STRAIGHT_FIRE.fire,
        ),
      ]);
      this.controller = new WaterFamasController(gltf, {
        firstPerson: true, // live tank water + viewmodel recoil
        timeline: WATER_FAMAS_TIMELINE,
        events: {
          onBurstStart: (aiming) => this.sfx.onBurstStart?.(aiming),
          onJet: (k, left) => this.onJet(k, left),
          onBurstEnd: () => this.sfx.onBurstEnd?.(),
          onDryFire: () => this.sfx.onDryFire?.(),
          onCapGrab: () => this.sfx.onCapGrab?.(),
          onCapOff: () => this.sfx.onCapOff?.(),
          onHingeOpen: () => this.sfx.onHingeOpen?.(),
          onBottleIn: () => this.sfx.onBottleIn?.(),
          onPourStart: () => this.sfx.onPourStart?.(),
          onAmmoRefilled: () => this.sfx.onAmmoRefilled?.(),
          onBottleOut: () => this.sfx.onBottleOut?.(),
          onHingeClose: () => this.sfx.onHingeClose?.(),
          onCapScrewed: () => this.sfx.onCapScrewed?.(),
          onReloadEnd: (cancelled) => this.sfx.onReloadEnd?.(cancelled),
        },
      });
      this.prepareViewmodelMaterials(this.controller.object);
      if (this.presentationOwner) this.equipPresentation(true);
    } catch (err) {
      console.error("WaterFamas: failed to load the weapon GLB", err);
    }
  }

  /**
   * FP-pass materials: private clones so FP-only state never leaks to the
   * remote TP instances sharing the GLB (the enemy-outline stencil marking is
   * dropped — the FP pass has no outline). The tank liquid / pour materials
   * are already private to the controller and are left untouched.
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
    const tank = this.controller?.tank;
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh === tank?.body || mesh === tank?.surface || mesh === tank?.stream) return;
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(fpClone) : fpClone(mesh.material);
    });
  }

  // ------------------------------------------------------------------
  // State (HUD / Game)
  // ------------------------------------------------------------------

  get ammo(): number {
    return this.controller?.ammo ?? W.capacity;
  }

  get capacity(): number {
    return W.capacity;
  }

  get isReloading(): boolean {
    return this.controller?.reloading ?? false;
  }

  /** True while a burst or a refill runs. */
  get isBusy(): boolean {
    return this.controller?.busy ?? false;
  }

  get isInspecting(): boolean {
    return this.inspecting;
  }

  // ------------------------------------------------------------------
  // Presentation ownership (arbitrated by the Game — Popcorn / Paintball pattern)
  // ------------------------------------------------------------------

  /** Game → FAMAS: take the shared FP arms (real Equip clip). */
  takePresentation(): void {
    if (this.presentationOwner) return;
    this.presentationOwner = true;
    this.equipPresentation(true);
  }

  /** Game → FAMAS: release the shared FP arms (weapon switch). */
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
    void this.viewmodel.equip(WaterFamasProfile, c.object, { playEquipClip }).then(() => {
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

  /** Refill interrupted (weapon switch / death / knockdown): undone before the end of the pour. */
  cancelReload(): void {
    const c = this.controller;
    if (!c || !c.reloading) return;
    c.cancelReload();
    this.onNetReloadCancel?.();
  }

  /**
   * Death / respawn / loadout change: drop the action in progress and refill
   * the tank instantly (the server resets its ammo on respawn too).
   */
  reset(): void {
    const c = this.controller;
    this.cancelInspection();
    if (!c) return;
    if (c.reloading) c.cancelReload();
    if (this.presentationOwner) this.viewmodel.cancelAction(true);
    c.setAmmo(W.capacity);
    c.tank.resetMotion();
  }


  // ------------------------------------------------------------------
  // Per frame
  // ------------------------------------------------------------------

  /** Dry-fire click re-arms only after the trigger is released. */
  private dryFireReady = true;

  /**
   * Gameplay + the SINGLE arms-mixer advance while owning the arms. The
   * controller / tank update runs later in postCameraUpdate() — AFTER the FP
   * camera sync (pack: the water reads the final world pose; jets 1 / 2 of a
   * burst are emitted from there, so their raycast uses the FINAL camera).
   */
  update(dt: number, input: WaterFamasFrameInput): void {
    const c = this.controller;
    if (!c || !this.presentationOwner) return;
    this.frameHittables = input.hittables;
    if (this.inspecting && (!input.canAct || input.aimHeld || !this.viewmodel.inspecting)) {
      this.cancelInspection();
    }
    if (input.canAct) {
      if (input.fireHeld && c.ammo <= 0 && !c.reloading && this.dryFireReady) {
        // Empty tank: click, then the automatic refill.
        this.dryFireReady = false;
        c.fire(); // → onDryFire (refused, no state change)
        this.startReload();
      } else if (input.firePressed && c.canFire) {
        this.fire(input.aimHeld);
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
   * After ViewmodelSystem.syncCamera (pack order): weapon clips + tank water +
   * the jets 1 / 2 of the running burst (every frame, even at rest — asleep =
   * no cost), then the shared visible jets / wet marks (local + remote).
   */
  postCameraUpdate(dt: number): void {
    const c = this.controller;
    // Live muzzle of the DRAWN gun for this frame (final camera pose): every
    // local jet still leaving the barrel starts its line here.
    this.liveMuzzleValid = !!c && this.presentationOwner && this.viewmodelVisible;
    if (c && this.presentationOwner) c.update(dt);
    if (this.liveMuzzleValid) this.viewmodel.socketWorldForGameCamera(c!.muzzle, this.camera, this.liveMuzzle);
    this.fx.update(dt);
  }

  /** Anchor handed to the local jets: the drawn muzzle of the current frame. */
  private readonly muzzleAnchor = (out: THREE.Vector3): boolean => {
    if (!this.liveMuzzleValid) return false;
    out.copy(this.liveMuzzle);
    return true;
  };

  /** One trigger pull = one burst (the controller emits the 3 jets through onJet). */
  private fire(aiming: boolean): void {
    const c = this.controller;
    if (!c) return;
    if (this.inspecting) this.cancelInspection(); // an attack always wins
    this.burstSeed = randomWaterFamasSeed();
    c.fire(aiming); // → onBurstStart, then onJet(0) inside this call; jets 1 / 2 from update()
    this.dryFireReady = false;
  }


  /**
   * ONE jet leaves the barrel NOW (k = 0 / 1 / 2): its own seeded hitscan from
   * the GAME camera, quantized exactly like the network payload (the server
   * rebuilds the same ray), then the visible jet from the DRAWN muzzle. The
   * damage is applied HERE (solo), never at the visible jet's arrival.
   */
  private onJet(k: number, ammoLeft: number): void {
    const c = this.controller;
    if (!c) return;
    this.sfx.onJet?.(k, ammoLeft);
    const aiming = c.burstIsAimed;
    const seed = waterFamasJetSeed(this.burstSeed, k);
    this.camera.getWorldPosition(this.camPos);
    this.camera.getWorldDirection(this.camFwd);
    waterFamasAimDirection(this.camFwd, this.aim);
    waterFamasJetDirection(this.aim, k, aiming, seed, this.jetDir);
    this.onNetFire?.(seed, k, aiming);

    this.raycaster.far = W.maxRange;
    const hit = this.castJet(this.camPos, this.jetDir, this.frameHittables);
    let wet: WaterJetHit | null = null;
    let combatant: Combatant | null = null;
    const reach = hit ? hit.distance : W.maxRange;
    const remote = this.resolveRemoteHit?.(this.camPos, this.jetDir, reach) ?? null;
    if (remote) {
      // A remote player in front of everything: the jet lands on HIM.
      this.endPoint.copy(this.camPos).addScaledVector(this.jetDir, remote.distance);
      wet = remote.root ? this.fx.characterHit(remote.root, this.camPos, this.jetDir, this.endPoint) : null;
      // Hitscan feel: hitmarker + hit sound NOW (same shapes + same exact ray
      // as the server) — the server confirm only adds the damage number.
      this.onPredictedRemoteHit?.(remote.head ? HitZone.HEAD : HitZone.BODY);
    } else if (!hit) {
      this.endPoint.copy(this.camPos).addScaledVector(this.jetDir, W.maxRange);
    } else {
      this.endPoint.copy(hit.point);
      combatant = resolveUp<Combatant>(hit.object, "combatant");
      if (combatant) {
        const root = this.resolveCharacterRoot?.(combatant) ?? null;
        wet = root ? this.fx.characterHit(root, this.camPos, this.jetDir, hit.point) : null;
      } else if (!resolveUp<TrainingTarget>(hit.object, "trainingTarget")) {
        wet = this.fx.surfaceHit(hit, this.jetDir, seed); // static level geometry
      }
    }

    // The visible jet: from the pixel of the DRAWN muzzle straight to the
    // hitscan impact, its start glued to the live muzzle while the water leaves.
    this.viewmodel.socketWorldForGameCamera(c.muzzle, this.camera, this.muzzleWorld);
    this.fx.spawn(this.muzzleWorld, this.endPoint, wet, this.muzzleAnchor);

    if (!this.networkAuthority && hit && !remote) this.applyLocalDamage(hit, combatant);
  }

  /** Nearest valid hit of one jet (owner / corpses skipped). */
  private castJet(origin: THREE.Vector3, dir: THREE.Vector3, hittables: THREE.Object3D[]): THREE.Intersection | null {
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


  /** SOLO authority: 23 / 34.5 immediately (hitscan — never at the jet's arrival). */
  private applyLocalDamage(hit: THREE.Intersection, combatant: Combatant | null): void {
    if (!combatant) {
      const target = resolveUp<TrainingTarget>(hit.object, "trainingTarget");
      if (target) target.applyDamage(W.bodyDamage);
      return;
    }
    const h = combatant.health;
    if (!h.alive) return;
    const zone = resolveZone(hit.object);
    const amount = waterFamasJetDamage(zone === HitZone.HEAD);
    combatant.registerImpact?.(this.jetDir.clone().multiplyScalar(0.3), hit.point.clone());
    const applied = h.applyDamage(amount, this.owner, KillMethod.WATER_FAMAS, zone);
    if (!applied) return;
    this.feedback?.registerHit({
      attacker: this.owner,
      target: combatant,
      hitZone: zone,
      damage: amount,
      position: hit.point.clone(),
      weapon: KillMethod.WATER_FAMAS,
      isKill: !h.alive,
    });
  }

  /**
   * GPU warm-up (Game.warmUpRendering): one jet far below the map so its
   * programs compile at load, never on the first shot. `endWarmUp()` clears
   * it after the warm frames.
   */
  beginWarmUp(far: THREE.Vector3): void {
    const to = far.clone();
    to.y -= 1;
    this.fx.spawn(far, to, { normal: new THREE.Vector3(0, 1, 0), seed: 1 }, null);
    this.fx.update(0.001);
  }

  endWarmUp(): void {
    this.fx.update(10); // the warm jet fades out
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

