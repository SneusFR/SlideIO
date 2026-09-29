import * as THREE from "three";
import { PhysicsWorld, RAPIER } from "../../physics/PhysicsWorld";
import { Combatant } from "../../combat/Combatant";
import { KillMethod } from "../../combat/KillMethod";
import { HitZone } from "../../combat/HitZone";
import { HitFeedbackManager } from "../../combat/HitFeedbackManager";
import { ViewmodelSystem } from "../viewmodel/ViewmodelSystem";
import { FrisbeeLauncherProfile, FRISBEE_LAUNCHER_TIMELINE } from "../profiles/FrisbeeLauncherProfile";
import {
  FrisbeeLauncherController,
  type FrisbeeCageDrop,
  type FrisbeeLauncherEvents,
} from "./FrisbeeLauncherController";
import { FrisbeeProjectiles, type FrisbeeCastHit, type FrisbeeHit } from "./FrisbeeProjectiles";
import { DroppedCages } from "./DroppedCages";
import { loadFrisbeeLauncherGltf } from "./FrisbeeLauncherModel";
import {
  FrisbeeLauncherConfig as F,
  frisbeeAimDirection,
  frisbeeDirection,
  frisbeeWireCoord,
  randomFrisbeeSeed,
} from "../../../shared/combat/FrisbeeLauncherRules";
import { sweepFrisbeePlayer } from "../../../shared/combat/FrisbeeSim";

/** Member of everything; collides with the STATIC world bit only (never characters / ragdolls). */
const WORLD_ONLY_GROUPS = (0xffff << 16) | 0x0001;
/** Ownership key of the local shooter's discs. */
export const FRISBEE_LOCAL_OWNER = "local";

/** Per-frame input snapshot handed by the Game (the weapon owns no input code). */
export interface FrisbeeLauncherFrameInput {
  /** LMB went down THIS frame (ONE disc per pull — holding never re-fires). */
  firePressed: boolean;
  /** R edge → cage swap. */
  reloadPressed: boolean;
  /** F edge → two-hand inspection (visual only). */
  inspectPressed: boolean;
  /** RMB held → sight picture (authored Aim pose, tighter cone). */
  aimHeld: boolean;
  /** Alive, primary held, pointer locked, not melee / knockdown blocked. */
  canAct: boolean;
  grounded: boolean;
  verticalVelocity: number;
  jumpSequence: number;
  sliding: boolean;
  speed: number;
}

/** Audio hooks (pure observers, wired by the Game): the controller events + the disc knocks. */
export interface FrisbeeLauncherSfx extends FrisbeeLauncherEvents {
  /** A disc bounced on the scenery (local sim, every displayed disc). */
  onBounce?: (point: THREE.Vector3, speed: number) => void;
}

/** A combatant a disc can touch, seen as the SHARED server capsule / head sphere. */
export interface FrisbeeTargetSource {
  /** Every alive combatant except the owner: key + capsule center + resolver (null = remote avatar). */
  forEach(cb: (key: string, center: THREE.Vector3, combatant: Combatant | null) => void): void;
}

/**
 * FRISBEE LAUNCHER — local weapon (gameplay + FP presentation owner). One REAL projectile per
 * trigger pull: simulated from the EYE (like the server) with the pack's fixed-step FrisbeeSim
 * (same rule as shared/combat/FrisbeeSim); the visible disc leaves the drawn LaunchSocket.
 * SOLO: the first touch applies 45 / 68 (x0.6 after a bounce) + a small knockback.
 * MULTIPLAYER (`networkAuthority`): the disc is PREDICTED (no damage); the server simulates the
 * same disc, owns every touch and corrects the copy (bounce / touch / end).
 */
export class FrisbeeLauncherWeapon {
  owner: Combatant | null = null;
  feedback: HitFeedbackManager | null = null;
  networkAuthority = false;
  /** Camera feedback hook (FPSCamera.addShake). */
  onCameraShake: ((amount: number) => void) | null = null;
  /** Network hooks (wired by the Game in multiplayer). */
  onNetFire: ((seed: number, aiming: boolean) => void) | null = null;
  onNetReload: (() => void) | null = null;
  onNetReloadCancel: (() => void) | null = null;
  /** Audio / HUD hooks (pure observers, wired by the Game). */
  sfx: FrisbeeLauncherSfx = {};
  /** The local cage was thrown away (FP): the Game plays the landing clack. */
  onLocalCageDrop: ((point: THREE.Vector3) => void) | null = null;

  readonly ready: Promise<void>;
  /** Discs in flight for EVERY shooter (ONE pool) + the thrown cages (ONE pool). */
  projectiles: FrisbeeProjectiles | null = null;
  droppedCages: DroppedCages | null = null;

  private controller: FrisbeeLauncherController | null = null;
  private presentationOwner = false;
  private presentationToken = 0;
  private viewmodelVisible = false;
  private inspecting = false;
  private targets: FrisbeeTargetSource | null = null;
  /** Server disc id → local simulation id (prediction / replay reconciliation). */
  private readonly serverToLocal = new Map<number, number>();
  /** Local discs fired by THIS player and not yet confirmed by the server (FIFO). */
  private readonly pendingLocal: { id: number; seed: number }[] = [];
  private readonly hitCombatants = new Map<string, Combatant | null>();
  private readonly ballShape = new RAPIER.Ball(F.tuning.radius);
  private readonly identityRot = { x: 0, y: 0, z: 0, w: 1 };
  private readonly rayOrigin = { x: 0, y: 0, z: 0 };
  private readonly rayVel = { x: 0, y: 0, z: 0 };
  private readonly camPos = new THREE.Vector3();
  private readonly camFwd = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly launchDir = new THREE.Vector3();
  private readonly visualFrom = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  /** Seed of the shot being fired (read by onShot, called from inside controller.fire()). */
  private shotSeed = 0;

  constructor(
    private readonly camera: THREE.Camera,
    private readonly worldScene: THREE.Scene,
    private readonly viewmodel: ViewmodelSystem,
    private readonly physics: PhysicsWorld,
  ) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      const gltf = await loadFrisbeeLauncherGltf();
      this.controller = new FrisbeeLauncherController(gltf, {
        firstPerson: true,
        timeline: FRISBEE_LAUNCHER_TIMELINE,
        reloadSpeed: F.reloadSpeed,
        events: {
          onShot: (aiming) => this.onShot(aiming),
          onDryFire: () => this.sfx.onDryFire?.(),
          onCocked: () => this.sfx.onCocked?.(),
          onDiscTaken: () => this.sfx.onDiscTaken?.(),
          onDiscSeated: () => this.sfx.onDiscSeated?.(),
          onCageOut: () => this.sfx.onCageOut?.(),
          onCageDrop: (d) => this.onCageDrop(d),
          onCageIn: () => this.sfx.onCageIn?.(),
          onReloadEnd: (cancelled) => this.sfx.onReloadEnd?.(cancelled),
        },
      });
      this.prepareViewmodelMaterials(this.controller.object);
      // ONE world pool for every shooter: discs share the launcher's disc mesh (geometry + material).
      this.projectiles = new FrisbeeProjectiles(
        this.worldScene,
        this.controller.discTemplate,
        (from, dir, maxDist, radius, ignore) => this.cast(from, dir, maxDist, radius, ignore),
        {
          onHit: (e) => this.onDiscHit(e),
          onBounce: (_id, point, _normal, speed) => this.sfx.onBounce?.(point, speed),
        },
        // Visible radius = the collision radius (F.tuning.radius, 0.4 m): the drawn disc IS the projectile's hitbox.
        { visualRadius: F.tuning.radius, max: F.maxDiscs },
      );
      this.droppedCages = new DroppedCages(this.worldScene, this.controller.cageTemplate, {
        ground: (x, z) => this.groundY(x, z),
      });
      if (this.presentationOwner) this.equipPresentation(true);
    } catch (err) {
      console.error("FrisbeeLauncher: failed to load the weapon GLB", err);
    }
  }

  /**
   * FP-pass materials: private clones so FP-only state never leaks to the remote TP instances
   * sharing the GLB (the enemy-outline stencil marking is dropped — the FP pass has no outline).
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
    return this.controller?.ammo ?? F.capacity;
  }
  get capacity(): number {
    return F.capacity;
  }
  get deckLoaded(): boolean {
    return this.controller?.deckLoaded ?? true;
  }
  get cageCount(): number {
    return this.controller?.cageCount ?? F.cageCapacity;
  }
  get isReloading(): boolean {
    return this.controller?.reloading ?? false;
  }
  /** True while a shot's re-cock or a cage swap runs. */
  get isBusy(): boolean {
    return this.controller?.busy ?? false;
  }
  get isInspecting(): boolean {
    return this.inspecting;
  }
  get ownsPresentation(): boolean {
    return this.presentationOwner;
  }
  /** The FP launcher controller (its disc / cage templates feed the shared pools). */
  get launcher(): FrisbeeLauncherController | null {
    return this.controller;
  }

  /** Register the combatant roster (solo: bots; multiplayer: the visible remote avatars). */
  setTargets(targets: FrisbeeTargetSource | null): void {
    this.targets = targets;
  }

  // ------------------------------------------------------------------
  // Presentation ownership (arbitrated by the Game — Popcorn / FAMAS pattern)
  // ------------------------------------------------------------------

  /** Game → launcher: take the shared FP arms (real Equip clip). */
  takePresentation(): void {
    if (this.presentationOwner) return;
    this.presentationOwner = true;
    this.equipPresentation(true);
  }

  /** Game → launcher: release the shared FP arms (weapon switch). */
  releasePresentation(): void {
    this.presentationToken++;
    if (!this.presentationOwner) return;
    this.presentationOwner = false;
    this.cancelReload(); // a cage swap is undone before cageIn; a re-cock in progress is completed
    this.inspecting = false;
    this.controller?.attachViewmodel(null);
    this.viewmodel.unequip();
    this.viewmodel.setVisible(false);
  }

  private equipPresentation(playEquipClip: boolean): void {
    const c = this.controller;
    if (!c) return; // load() equips once the GLB is mounted
    const token = ++this.presentationToken;
    c.attachViewmodel(this.viewmodel);
    void this.viewmodel.equip(FrisbeeLauncherProfile, c.object, { playEquipClip }).then(() => {
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

  /**
   * Weapon switch / death / knockdown: a cage swap is undone before cageIn (the server is told),
   * a re-cock in progress is completed at once (the disc ends on the deck — the server does the same).
   */
  cancelReload(): void {
    const c = this.controller;
    if (!c || !c.busy) return;
    const wasReloading = c.reloading;
    c.cancelAction();
    if (wasReloading) this.onNetReloadCancel?.();
  }

  /** Death / respawn / loadout change: drop the action in progress, loaded deck + full cage. */
  reset(): void {
    const c = this.controller;
    this.cancelInspection();
    if (!c) return;
    if (this.presentationOwner) this.viewmodel.cancelAction(true);
    c.cancelAction();
    c.setAmmo(true, F.cageCapacity);
  }

  // ------------------------------------------------------------------
  // Per frame
  // ------------------------------------------------------------------

  /**
   * Gameplay + the SINGLE arms-mixer advance while owning the arms. The controller update runs
   * later in postCameraUpdate() — AFTER the FP camera sync (pack order: the launch socket and
   * the cage read the final world pose).
   */
  update(dt: number, input: FrisbeeLauncherFrameInput): void {
    const c = this.controller;
    if (!c || !this.presentationOwner) return;
    if (this.inspecting && (!input.canAct || input.aimHeld || !this.viewmodel.inspecting)) {
      this.cancelInspection();
    }
    if (input.canAct) {
      if (input.firePressed) {
        if (c.canFire) this.fire(input.aimHeld);
        else if (!c.deckLoaded && !c.reloading) {
          // Empty deck: click, then the automatic cage swap ("TOUCHE R — OU TIR À VIDE").
          c.fire(); // → onDryFire (refused, no state change)
          this.startReload();
        }
      }
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
   * After ViewmodelSystem.syncCamera (pack order): weapon clips + cage discs, then the shared
   * discs in flight and the thrown cages (they keep flying / falling after a weapon switch).
   */
  postCameraUpdate(dt: number): void {
    const c = this.controller;
    if (c && this.presentationOwner) c.update(dt);
    this.projectiles?.update(dt);
    this.droppedCages?.update(dt);
  }

  /** One trigger pull = one disc (the controller calls onShot inside this call). */
  private fire(aiming: boolean): void {
    const c = this.controller;
    if (!c) return;
    if (this.inspecting) this.cancelInspection(); // an attack always wins
    this.shotSeed = randomFrisbeeSeed();
    c.fire(aiming);
  }

  /**
   * The disc leaves NOW. Simulation from the EYE (rounded like the wire — the server rebuilds the
   * same origin / direction), visible disc from the drawn LaunchSocket. Network + HUD + audio here.
   */
  private onShot(aiming: boolean): void {
    const c = this.controller;
    const projectiles = this.projectiles;
    this.sfx.onShot?.(aiming);
    if (!c || !projectiles) return;
    this.camera.getWorldPosition(this.camPos);
    this.camera.getWorldDirection(this.camFwd);
    frisbeeAimDirection(this.camFwd, this.aim);
    frisbeeDirection(this.aim, aiming, this.shotSeed, this.launchDir);
    this.tmp.set(frisbeeWireCoord(this.camPos.x), frisbeeWireCoord(this.camPos.y), frisbeeWireCoord(this.camPos.z));
    this.viewmodel.socketWorldForGameCamera(c.launchSocket, this.camera, this.visualFrom);
    const id = projectiles.fire({
      origin: this.tmp,
      direction: this.launchDir,
      owner: FRISBEE_LOCAL_OWNER,
      seed: this.shotSeed,
      roll: aiming ? 0 : -0.1,
      visualFrom: this.visualFrom,
    });
    if (this.networkAuthority) {
      this.pendingLocal.push({ id, seed: this.shotSeed });
      if (this.pendingLocal.length > 8) this.pendingLocal.shift(); // a refused shot never confirms
    }
    this.onCameraShake?.(aiming ? 0.02 : 0.05);
    this.onNetFire?.(this.shotSeed, aiming);
  }

  // ------------------------------------------------------------------
  // Collision (the pack's FrisbeeSim asks for it 120 times a second per disc)
  // ------------------------------------------------------------------

  private readonly worldHit: FrisbeeCastHit = { distance: 0, point: new THREE.Vector3(), normal: new THREE.Vector3() };
  private readonly playerHit: FrisbeeCastHit = { distance: 0, point: new THREE.Vector3(), normal: new THREE.Vector3() };

  /** Sphere sweep: Rapier on the static world + the SHARED server player volumes (head / body). */
  private cast(
    from: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number,
    radius: number,
    ignore: string | null,
  ): FrisbeeCastHit | null {
    let best: FrisbeeCastHit | null = null;
    this.rayOrigin.x = from.x;
    this.rayOrigin.y = from.y;
    this.rayOrigin.z = from.z;
    this.rayVel.x = dir.x * maxDist;
    this.rayVel.y = dir.y * maxDist;
    this.rayVel.z = dir.z * maxDist;
    const shape = radius === F.tuning.radius ? this.ballShape : new RAPIER.Ball(radius);
    const hit = this.physics.world.castShape(
      this.rayOrigin,
      this.identityRot,
      this.rayVel,
      shape,
      0, // exact contact
      1, // whole segment
      true, // starting inside → contact at 0 (pushed out by the sim clearance)
      undefined,
      WORLD_ONLY_GROUPS,
    );
    if (hit) {
      const n = hit.normal1;
      const w = this.worldHit;
      w.distance = hit.time_of_impact * maxDist;
      w.normal.set(n.x, n.y, n.z);
      w.point.copy(dir).multiplyScalar(w.distance).add(from);
      w.target = null;
      w.headshot = false;
      best = w;
    }
    if (!this.targets) return best;
    this.targets.forEach((key, center, combatant) => {
      if (key === ignore) return;
      if (combatant && (!combatant.health.alive || combatant.targetable === false)) return;
      const c = sweepFrisbeePlayer(from, dir, radius, center, maxDist);
      if (!c || (best !== null && c.t >= best.distance)) return;
      const p = this.playerHit;
      p.distance = c.t;
      p.normal.set(c.normal.x, c.normal.y, c.normal.z);
      p.point.copy(dir).multiplyScalar(c.t).add(from);
      p.target = key;
      p.headshot = c.head;
      this.hitCombatants.set(key, combatant);
      best = p;
    });
    return best;
  }

  /** Height of the STATIC floor under (x, z) (the thrown cages land on it). */
  private groundY(x: number, z: number): number {
    const hit = this.physics.world.castRay(
      new RAPIER.Ray({ x, y: 60, z }, { x: 0, y: -1, z: 0 }),
      200,
      true,
      undefined,
      WORLD_ONLY_GROUPS,
    );
    return hit ? 60 - hit.timeOfImpact : -1e6;
  }

  // ------------------------------------------------------------------
  // Touches
  // ------------------------------------------------------------------

  /**
   * A disc of this client's simulation touched a player. SOLO: the damage is applied HERE (75 / 100,
   * x0.6 after a bounce) + a small knockback. MULTIPLAYER: nothing — the server owns the touch
   * (HIT_CONFIRMED gives the hitmarker); the local disc just rebounds softly and marks itself spent.
   */
  private onDiscHit(e: FrisbeeHit): void {
    if (this.networkAuthority) return;
    if (e.owner !== FRISBEE_LOCAL_OWNER) return;
    const target = this.hitCombatants.get(e.target) ?? null;
    if (!target || !target.health.alive) return;
    const zone = e.headshot ? HitZone.HEAD : HitZone.BODY;
    target.registerImpact?.(this.tmp2.copy(e.impulse), e.point);
    const applied = target.health.applyDamage(e.damage, this.owner, KillMethod.FRISBEE_LAUNCHER, zone);
    if (!applied) return;
    if (target.health.alive) target.applyImpulse(this.tmp2.copy(e.impulse));
    this.feedback?.registerHit({
      attacker: this.owner,
      target,
      hitZone: zone,
      damage: e.damage,
      position: e.point.clone(),
      weapon: KillMethod.FRISBEE_LAUNCHER,
      isKill: !target.health.alive,
    });
  }

  // ------------------------------------------------------------------
  // Network reconciliation (the server simulates the SAME disc; these only correct the copy)
  // ------------------------------------------------------------------

  /**
   * Server FRISBEE_FIRE confirm of OUR shot: link the predicted disc to the server id, matched by its
   * SEED (a shot the server refused never confirms: the older pending entries are dropped).
   */
  onLocalFireConfirmed(serverId: number, seed: number | undefined): void {
    const i = this.pendingLocal.findIndex((p) => p.seed === seed);
    if (i < 0) return;
    this.serverToLocal.set(serverId, this.pendingLocal[i].id);
    this.pendingLocal.splice(0, i + 1);
  }

  /**
   * ANOTHER player's shot (server confirm): replay the SAME disc — origin = the server's validated
   * eye, direction = the FINAL launch direction (spread applied, used AS IS), the visible disc
   * leaves that avatar's real LaunchSocket. `elapsed` = seconds since the server accepted the shot.
   */
  spawnRemote(
    serverId: number,
    ownerKey: string,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    visualFrom: THREE.Vector3 | null,
    elapsed: number,
  ): void {
    const projectiles = this.projectiles;
    if (!projectiles) return;
    const id = projectiles.fire({ origin, direction, owner: ownerKey, seed: serverId, roll: -0.1, visualFrom: visualFrom ?? undefined });
    this.serverToLocal.set(serverId, id);
    if (elapsed > 0.02) projectiles.catchUp(id, elapsed);
  }

  /** Server BOUNCE #`bounces`: snap the copy only when it drifted (tolerance 0.15 m / 0.5 m/s). */
  onServerBounce(serverId: number, pos: THREE.Vector3, vel: THREE.Vector3, bounces: number): void {
    const local = this.serverToLocal.get(serverId);
    if (local === undefined) return;
    this.projectiles?.snap(local, pos, vel, { bounces, tolerance: 0.15 });
  }

  /** Server TOUCH: the disc rebounds softly off the victim and is spent (never a second touch). */
  onServerHit(serverId: number, pos: THREE.Vector3, vel: THREE.Vector3): void {
    const local = this.serverToLocal.get(serverId);
    if (local === undefined) return;
    this.projectiles?.snap(local, pos, vel, { spent: true, tolerance: 0.3 });
  }

  /** Server END (rest / expiry): remove the copy (duplicates are no-ops). */
  onServerEnd(serverId: number): void {
    const local = this.serverToLocal.get(serverId);
    if (local === undefined) return;
    this.projectiles?.end(local);
    this.serverToLocal.delete(serverId);
  }

  // ------------------------------------------------------------------
  // Thrown cages
  // ------------------------------------------------------------------

  /**
   * FP: the clip already makes the cage leave the screen through the bottom, so a copy is dropped UNDER
   * the view (left of the feet) — the player finds it on the floor when looking down. TP (remote):
   * handled by spawnRemoteCage().
   */
  private onCageDrop(d: FrisbeeCageDrop): void {
    const cages = this.droppedCages;
    if (!cages || d.world) return;
    this.camera.getWorldPosition(this.camPos);
    this.camera.getWorldDirection(this.camFwd);
    const fwd = this.tmp.set(this.camFwd.x, 0, this.camFwd.z);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const right = this.tmp2.set(-fwd.z, 0, fwd.x);
    const feetY = this.groundY(this.camPos.x, this.camPos.z);
    const p = this.camPos.clone().addScaledVector(right, -0.22).addScaledVector(fwd, 0.18);
    p.y = (feetY > -1e5 ? feetY : this.camPos.y - 1.6) + 0.42;
    const v = right.clone().multiplyScalar(-0.6).addScaledVector(fwd, 0.4).setY(-1.0);
    cages.spawnAt(p, new THREE.Quaternion().setFromAxisAngle(fwd, 0.5), v, d.discs);
    this.onLocalCageDrop?.(p);
  }

  /** Remote avatar threw its empty cage: the world copy takes over its exact pose and speed. */
  spawnRemoteCage(d: FrisbeeCageDrop): void {
    if (d.world) this.droppedCages?.spawn(d.world, d.velocity, d.discs);
  }

  /** Round change / disconnect: drop every disc in flight and every thrown cage. */
  clear(): void {
    this.projectiles?.clear();
    this.droppedCages?.clear();
    this.serverToLocal.clear();
    this.pendingLocal.length = 0;
    this.hitCombatants.clear();
  }

  /** GPU warm-up (Game.warmUpRendering): one disc far below the map so its program compiles at load. */
  beginWarmUp(far: THREE.Vector3): void {
    const c = this.controller;
    const projectiles = this.projectiles;
    if (!c || !projectiles) return;
    projectiles.fire({ origin: far, direction: new THREE.Vector3(0, -1, 0), owner: FRISBEE_LOCAL_OWNER, visualFrom: far });
    projectiles.update(0.001);
  }

  endWarmUp(): void {
    this.projectiles?.clear();
  }
}

