import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PaintballHopper } from "./PaintballHopper";

/**
 * Timeline of the authored clips (seconds). Arms (FP_/TP_ clips) and weapon clips share the SAME clock:
 * both are started the same frame and advanced with the same dt.
 * Comes from WeaponProfile_PaintballRifle.json → `actions` (see PaintballRifleProfile.ts).
 */
export interface PaintballTimeline {
  fire: { interval: number; endDuration: number };
  reload: {
    duration: number;
    events: {
      hopperRelease: number; hopperDrop: number; hopperIn: number; hopperSeat: number; slap: number;
      chargeBack: number; chargeRelease: number; readyToFire: number;
    };
  };
  inspect: { duration: number };
}

/** Minimal structural view of the common ViewmodelSystem (no import-path coupling). */
export interface ViewmodelLike {
  playAction(key: string, options?: { startAt?: number; fadeIn?: number; exitFade?: number; onFinished?: () => void }): boolean;
  cancelAction(immediate?: boolean): void;
  startInspect(onDone: (cancelled: boolean) => void): boolean;
  cancelInspect(): void;
  addRecoil(amount: number): void;
  readonly activeActionKey: string | null;
}

/** Gameplay / audio / VFX hooks (all optional). */
export interface PaintballEvents {
  /** One ball fired. `color` = the paint colour of that ball (projectile + splat). */
  onShot?: (ammoLeft: number, color: THREE.Color) => void;
  onDryFire?: () => void;
  /** First shot of a burst (TP: play the character's "fire" loop). */
  onBurstStart?: () => void;
  /** Trigger released / empty (TP: play the character's "fireEnd"). */
  onBurstEnd?: () => void;
  /** Thumb on the release button (click). */
  onHopperRelease?: () => void;
  /** The empty hopper leaves the hand (a dropped copy falls). */
  onHopperDrop?: () => void;
  /** The full hopper appears in the hand (off screen in FP). */
  onHopperIn?: () => void;
  /** New hopper clicked onto the gun: gameplay ammo is full from here. */
  onAmmoRefilled?: () => void;
  onSlap?: () => void;
  onChargeBack?: () => void;
  onChargeRelease?: () => void;
  onReloadEnd?: (cancelled: boolean) => void;
}

export interface PaintballRifleOptions {
  /** true = local player viewmodel (physics); false = remote / TP (baked layouts, no physics). */
  firstPerson: boolean;
  timeline: PaintballTimeline;
  events?: PaintballEvents;
  /** Parent of the dropped empty hopper (FP: viewmodel.scene, TP: the world scene). None = no drop. */
  dropParent?: THREE.Object3D | null;
  /** Optional ground height under a world point (TP): the dropped hopper bounces on it. */
  groundY?: ((x: number, z: number) => number) | null;
  /** Cosmetic viewmodel recoil added per ball (ViewmodelSystem.addRecoil). Default 0.05 (v2 was 0.12). */
  recoilPerShot?: number;
}

type Mode = "idle" | "fire" | "fireEnd" | "reload" | "inspect";

const _v = new THREE.Vector3();
const _c = new THREE.Color();

/**
 * PAINTBALL RIFLE — weapon-side controller (one per weapon instance).
 *
 * Owns the cloned weapon scene (pass `object` to ViewmodelSystem.equip), the weapon's own mixer (trigger,
 * charging handle, hopper swap), the ammo ⇄ hopper logic (32 balls, one per shot, the one nearest the feed),
 * the automatic-fire loop (arms + weapon loop while shots keep coming, settle clip when they stop), the
 * reload (hopper swap) timeline and the ball physics. Gameplay (damage, raycasts, fire-rate authority) stays in
 * your weapon class: call fire() at your fire rate while the trigger is held; read the events for SFX / VFX.
 */
export class PaintballRifleController {
  readonly object: THREE.Object3D;
  readonly muzzle: THREE.Object3D;
  readonly hopper: PaintballHopper;
  readonly hopperNode: THREE.Object3D;
  readonly mixer: THREE.AnimationMixer;
  readonly capacity: number;
  ammo: number;

  private readonly tl: PaintballTimeline;
  private readonly ev: PaintballEvents;
  private readonly firstPerson: boolean;
  private readonly clips: Record<string, THREE.AnimationAction>;
  private current: THREE.AnimationAction | null = null;
  private mode: Mode = "idle";
  private clock = 0;
  private sinceShot = 1e9;
  private fired = new Set<string>();
  private vm: ViewmodelLike | null = null;
  private ammoBeforeReload = 0;
  private readonly drops: HopperDrop[] = [];
  private readonly dropParent: THREE.Object3D | null;
  private readonly groundY: ((x: number, z: number) => number) | null;
  private readonly recoilPerShot: number;
  private readonly lastHopperWorld = new THREE.Matrix4();

  constructor(gltf: GLTF, options: PaintballRifleOptions) {
    this.tl = options.timeline;
    this.ev = options.events ?? {};
    this.firstPerson = options.firstPerson;
    this.dropParent = options.dropParent ?? null;
    this.groundY = options.groundY ?? null;
    this.recoilPerShot = options.recoilPerShot ?? 0.05;
    // Plain clone (no skinned meshes in this weapon): geometry / materials stay shared.
    this.object = gltf.scene.clone(true);
    this.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = !options.firstPerson;
        mesh.receiveShadow = false;
        if (options.firstPerson) mesh.frustumCulled = false;
        mesh.raycast = () => {};
      }
    });
    const glass = this.object.getObjectByName("HopperGlass");
    if (glass) glass.renderOrder = 2;
    const hopperNode = this.object.getObjectByName("Hopper");
    const muzzle = this.object.getObjectByName("Muzzle");
    if (!hopperNode || !muzzle) throw new Error("PaintballRifle GLB: Hopper / Muzzle node missing");
    this.hopperNode = hopperNode;
    this.muzzle = muzzle;
    this.hopper = new PaintballHopper(hopperNode, { physics: options.firstPerson });
    this.capacity = this.hopper.data.capacity;
    this.ammo = this.capacity;

    this.mixer = new THREE.AnimationMixer(this.object);
    this.clips = {};
    for (const clip of gltf.animations) {
      const a = this.mixer.clipAction(clip);
      if (clip.name === "Idle" || clip.name === "Fire") a.setLoop(THREE.LoopRepeat, Infinity);
      else { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      this.clips[clip.name] = a;
    }
    this.playWeaponClip("Idle");
  }

  /** Remember the viewmodel (FP) so actions drive the arms the same frame as the weapon. */
  attachViewmodel(vm: ViewmodelLike | null): void {
    this.vm = vm;
  }

  get reloading(): boolean { return this.mode === "reload"; }
  /** A burst is running (the fire loop plays). */
  get firing(): boolean { return this.mode === "fire"; }
  get busy(): boolean { return this.mode === "reload"; }

  /** true when a ball can leave now: ammo, not mid-reload, and the fire interval elapsed. */
  get canFire(): boolean {
    if (this.ammo <= 0) return false;
    if (this.mode === "reload") return this.fired.has("hopperSeat") && this.clock >= this.tl.reload.events.readyToFire;
    return this.sinceShot >= this.tl.fire.interval - 1e-4;
  }

  get canReload(): boolean { return this.ammo < this.capacity && this.mode !== "reload"; }

  /**
   * One shot (call it at the gameplay fire rate while the trigger is held; 0.1 s = the authored 600 rpm).
   * First shot of a burst: the arms + weapon fire LOOP starts; later shots only feed a ball and kick.
   * Returns false (and onDryFire) when empty.
   */
  fire(): boolean {
    if (this.ammo <= 0) { this.ev.onDryFire?.(); return false; }
    if (this.mode === "reload") {
      if (!(this.fired.has("hopperSeat") && this.clock >= this.tl.reload.events.readyToFire)) return false;
      this.finishReload(false);
    }
    if (this.mode === "inspect") { this.vm?.cancelInspect(); }
    if (this.mode !== "fire") {
      this.mode = "fire";
      this.clock = 0;
      this.fired.clear();
      this.playWeaponClip("Fire");
      this.vm?.playAction("fire", { fadeIn: 0.03, exitFade: 0.1 });
      this.ev.onBurstStart?.();
    }
    this.ammo--;
    this.sinceShot = 0;
    this.vm?.addRecoil(this.recoilPerShot);
    const slot = this.hopper.feedOne();
    this.hopper.colorOf(slot >= 0 ? slot : 0, _c);
    this.ev.onShot?.(this.ammo, _c);
    return true;
  }

  /** Swap the hopper (2.45 s). */
  reload(): boolean {
    if (!this.canReload) return false;
    if (this.mode === "fire") this.endBurst(false);
    this.ammoBeforeReload = this.ammo;
    this.mode = "reload";
    this.clock = 0;
    this.fired.clear();
    this.playWeaponClip(this.firstPerson || !this.clips["Reload_TP"] ? "Reload" : "Reload_TP");
    this.vm?.playAction("reload", { fadeIn: 0.08, exitFade: 0.15, onFinished: () => this.finishReload(false) });
    return true;
  }

  /** Weapon switch / death during a reload: before the new hopper clicks in, the old ammo is kept. */
  cancelReload(): void {
    if (this.mode !== "reload") return;
    this.vm?.cancelAction(true);
    this.finishReload(true);
  }

  /** One-handed inspection (arms clip + weapon clip on the same frame). */
  inspect(): boolean {
    if (this.mode === "reload" || this.mode === "fire" || !this.vm) return false;
    if (!this.vm.startInspect(() => { if (this.mode === "inspect") this.toIdle(); })) return false;
    this.mode = "inspect";
    this.clock = 0;
    this.playWeaponClip("Inspect");
    return true;
  }

  /** Network / respawn sync: force the ammo count (instant hopper fill, no animation). */
  setAmmo(n: number): void {
    if (this.mode === "reload") this.finishReload(true);
    this.ammo = Math.max(0, Math.min(this.capacity, Math.round(n)));
    this.hopper.setAmmo(this.ammo);
  }

  /**
   * Remote players: mirror an action decided by the server (the TP arms clips are played by the character on
   * onBurstStart / onBurstEnd / reload). Never refused for a local ammo mismatch — the server is right.
   */
  playRemote(action: "fire" | "reload"): void {
    if (action === "fire") {
      if (this.mode === "reload") this.finishReload(false);
      if (this.ammo <= 0) this.setAmmo(1);
      this.sinceShot = 1e9;
      this.fire();
    } else {
      if (this.ammo >= this.capacity) this.setAmmo(this.capacity - 1);
      this.reload();
    }
  }

  private playWeaponClip(name: string): void {
    const a = this.clips[name];
    if (!a) return;
    if (this.current && this.current !== a) this.current.stop();
    a.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
    this.current = a;
  }

  private toIdle(): void {
    this.mode = "idle";
    this.playWeaponClip("Idle");
  }

  private endBurst(playEnd: boolean): void {
    if (this.mode !== "fire") return;
    this.ev.onBurstEnd?.();
    if (playEnd) {
      this.mode = "fireEnd";
      this.clock = 0;
      this.playWeaponClip("Fire_End");
      this.vm?.playAction("fireEnd", { fadeIn: 0.04, exitFade: 0.12 });
    } else {
      this.toIdle();
    }
  }

  private once(key: string, at: number, fn?: () => void): void {
    if (this.clock >= at && !this.fired.has(key)) {
      this.fired.add(key);
      fn?.();
    }
  }

  private finishReload(cancelled: boolean): void {
    if (this.mode !== "reload") return;
    if (cancelled && !this.fired.has("hopperSeat")) {
      this.ammo = this.ammoBeforeReload;
      this.hopper.setAmmo(this.ammo);
    } else {
      this.ammo = this.capacity;
      if (!this.fired.has("hopperIn")) this.hopper.setAmmo(this.capacity);
    }
    this.hopper.resetMotion();
    this.toIdle();
    this.ev.onReloadEnd?.(cancelled);
  }

  private spawnDrop(): void {
    if (!this.dropParent) return;
    const frame = this.object.getObjectByName("HopperFrame") as THREE.Mesh | undefined;
    const glass = this.object.getObjectByName("HopperGlass") as THREE.Mesh | undefined;
    if (!frame || !glass) return;
    const g = new THREE.Group();
    g.name = "DroppedHopper";
    for (const src of [frame, glass]) {
      const m = new THREE.Mesh(src.geometry, src.material);
      m.renderOrder = src.renderOrder;
      m.raycast = () => {};
      m.frustumCulled = false;
      g.add(m);
    }
    const balls = this.hopper.snapshotBalls();
    if (balls) g.add(balls);
    this.lastHopperWorld.decompose(g.position, g.quaternion, g.scale);
    this.dropParent.updateWorldMatrix(true, false);
    const inv = new THREE.Matrix4().copy(this.dropParent.matrixWorld).invert();
    g.applyMatrix4(inv);
    this.dropParent.add(g);
    _v.copy(this.hopper.worldVelocity);
    this.drops.push(new HopperDrop(g, _v, this.groundY));
  }

  /** Per frame (same dt as the ViewmodelSystem), after the FP camera sync. */
  update(dt: number): void {
    // remember the hopper pose while it is visible (the drop starts from the last visible pose)
    this.hopperNode.updateWorldMatrix(true, false);
    const vis = this.hopperNode.scale.x > 1e-4;
    if (vis) this.lastHopperWorld.copy(this.hopperNode.matrixWorld);
    this.mixer.update(dt);
    this.clock += dt;
    this.sinceShot += dt;
    const tl = this.tl;
    switch (this.mode) {
      case "fire":
        if (this.sinceShot > tl.fire.interval * 1.6 || this.ammo <= 0 && this.sinceShot > tl.fire.interval) this.endBurst(true);
        break;
      case "fireEnd":
        if (this.clock >= tl.fire.endDuration) this.toIdle();
        break;
      case "reload": {
        const e = tl.reload.events;
        this.once("hopperRelease", e.hopperRelease, () => this.ev.onHopperRelease?.());
        this.once("hopperDrop", e.hopperDrop, () => {
          this.spawnDrop();
          this.hopper.setAmmo(0);
          this.ev.onHopperDrop?.();
        });
        this.once("hopperIn", e.hopperIn, () => {
          this.hopper.setAmmo(this.capacity);
          this.hopper.resetMotion();
          this.ev.onHopperIn?.();
        });
        this.once("hopperSeat", e.hopperSeat, () => {
          this.ammo = this.capacity;
          this.hopper.shake(0.8);
          this.ev.onAmmoRefilled?.();
        });
        this.once("slap", e.slap, () => { this.hopper.shake(1.2); this.ev.onSlap?.(); });
        this.once("chargeBack", e.chargeBack, () => this.ev.onChargeBack?.());
        this.once("chargeRelease", e.chargeRelease, () => { this.hopper.shake(0.5); this.ev.onChargeRelease?.(); });
        if (!this.vm && this.clock >= tl.reload.duration) this.finishReload(false);   // remote: no arms callback
        break;
      }
      case "inspect":
        if (!this.vm && this.clock >= tl.inspect.duration) this.toIdle();
        break;
      default:
        break;
    }
    this.hopper.update(dt);
    for (let i = this.drops.length - 1; i >= 0; i--) {
      if (!this.drops[i].update(dt)) { this.drops[i].dispose(); this.drops.splice(i, 1); }
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.hopper.dispose();
    for (const d of this.drops) d.dispose();
    this.drops.length = 0;
    this.object.removeFromParent();
  }
}

/** The empty hopper thrown away during a reload: cosmetic, world space, fades out (no collision unless groundY). */
class HopperDrop {
  private readonly vel = new THREE.Vector3();
  private readonly spin = new THREE.Vector3();
  private readonly baseScale: number;
  private readonly obj: THREE.Object3D;
  private readonly groundY: ((x: number, z: number) => number) | null;
  private life = 0;
  private landed = false;
  static readonly LIFE = 1.1;

  constructor(obj: THREE.Object3D, vel: THREE.Vector3, groundY: ((x: number, z: number) => number) | null) {
    this.obj = obj;
    this.groundY = groundY;
    this.vel.copy(vel).multiplyScalar(0.8);
    this.vel.y -= 0.3;
    this.spin.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 3, -2 - Math.random() * 3);
    this.baseScale = obj.scale.x;
  }

  update(dt: number): boolean {
    this.life += dt;
    if (this.life > HopperDrop.LIFE) return false;
    if (!this.landed) {
      this.vel.y -= 9.81 * dt;
      this.obj.position.addScaledVector(this.vel, dt);
      this.obj.rotateX(this.spin.x * dt); this.obj.rotateY(this.spin.y * dt); this.obj.rotateZ(this.spin.z * dt);
      if (this.groundY) {
        const gy = this.groundY(this.obj.position.x, this.obj.position.z);
        if (this.obj.position.y < gy + 0.02) {
          this.obj.position.y = gy + 0.02;
          if (Math.abs(this.vel.y) > 1.2) { this.vel.y = -this.vel.y * 0.3; this.vel.x *= 0.5; this.vel.z *= 0.5; this.spin.multiplyScalar(0.4); }
          else this.landed = true;
        }
      }
    }
    const fade = Math.min(1, (HopperDrop.LIFE - this.life) / 0.25);
    this.obj.scale.setScalar(this.baseScale * Math.max(0.001, fade));
    return true;
  }

  dispose(): void {
    this.obj.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose(); });
    this.obj.removeFromParent();
  }
}
