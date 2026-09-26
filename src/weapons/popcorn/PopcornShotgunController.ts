import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PopcornTank } from "./PopcornTank";
import { PState } from "./PopcornTankSim";

/**
 * Timeline of the authored clips (seconds). Arms (FP_/TP_ clips) and weapon clips share the
 * SAME clock: both are started the same frame and advanced with the same dt.
 * Comes from WeaponProfile_PopcornShotgun.json → `actions` (see PopcornShotgunProfile.ts).
 */
export interface PopcornTimeline {
  fire: { duration: number; events: { shot: number; pumpBack: number; pumpForward: number; readyToFire: number } };
  fireLast: { duration: number; events: { shot: number; readyToFire: number } };
  reload: {
    duration: number;
    events: {
      lidOpen: number; kernelsIn: readonly number[]; lidClose: number; pops: readonly number[];
      ammoRefilled: number; pumpBack: number; pumpForward: number; readyToFire: number;
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

/** Gameplay / audio hooks (all optional). */
export interface PopcornShotgunEvents {
  onShot?: (shotsLeft: number) => void;
  onDryFire?: () => void;
  onPumpBack?: () => void;
  onPumpForward?: () => void;
  /** The left hand flicks the tank lid open. */
  onLidOpen?: () => void;
  /** The fist starts sprinkling kernels into the open tank. */
  onKernelsIn?: () => void;
  /** The lid is pulled shut (click). */
  onLidClose?: () => void;
  /** One kernel popped (up to 72 per reload — rate-limit the SFX, e.g. ≤ 25 voices/s). */
  onPop?: (index: number, total: number) => void;
  /** Gameplay ammo is back to 2 (reload can no longer be cancelled for free). */
  onAmmoRefilled?: () => void;
  onReloadEnd?: (cancelled: boolean) => void;
}

export interface PopcornShotgunOptions {
  /** true = local player viewmodel (physics); false = remote / TP (baked layouts, no physics). */
  firstPerson: boolean;
  timeline: PopcornTimeline;
  events?: PopcornShotgunEvents;
  /** Optional parent (FP scene / world) for the cosmetic popcorn burst at the muzzle. */
  burstParent?: THREE.Object3D | null;
}

type Mode = "idle" | "fire" | "fireLast" | "reload" | "inspect";

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _fwd = new THREE.Vector3();
const _rq = new THREE.Quaternion();

/**
 * POPCORN SHOTGUN — weapon-side controller (one per weapon instance).
 *
 * Owns the cloned weapon scene (pass `object` to ViewmodelSystem.equip), the weapon's own mixer
 * (pump / lid / trigger clips), the ammo ⇄ tank fill logic (2 = full, 1 = half, 0 = empty), the
 * reload timeline (side button, kernels appear, pops, pump rack) and the popcorn physics.
 * Gameplay (damage, pellets, cooldown authority) stays in your weapon class: call fire() /
 * reload() when gameplay accepts the action, read the events for SFX / VFX.
 */
export class PopcornShotgunController {
  readonly object: THREE.Object3D;
  readonly muzzle: THREE.Object3D;
  readonly tank: PopcornTank;
  readonly mixer: THREE.AnimationMixer;
  readonly shots: number;
  ammo: number;

  private readonly tl: PopcornTimeline;
  private readonly ev: PopcornShotgunEvents;
  private readonly clips: Record<string, THREE.AnimationAction>;
  private current: THREE.AnimationAction | null = null;
  private mode: Mode = "idle";
  private clock = 0;
  private fired = new Set<string>();
  private vm: ViewmodelLike | null = null;
  // reload bookkeeping
  private kernelSlots: number[] = [];
  private kernelsSpawned = 0;
  private popTimes: number[] = [];
  private popsDone = 0;
  private ammoBeforeReload = 0;
  private readonly burst: PopcornBurst | null;

  constructor(gltf: GLTF, options: PopcornShotgunOptions) {
    this.tl = options.timeline;
    this.ev = options.events ?? {};
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
    const glass = this.object.getObjectByName("TankGlass");
    if (glass) glass.renderOrder = 2;
    const tankNode = this.object.getObjectByName("Tank");
    const muzzle = this.object.getObjectByName("Muzzle");
    if (!tankNode || !muzzle) throw new Error("PopcornShotgun GLB: Tank / Muzzle node missing");
    this.muzzle = muzzle;
    this.tank = new PopcornTank(tankNode, { physics: options.firstPerson });
    this.shots = this.tank.data.shots;
    this.ammo = this.shots;

    this.mixer = new THREE.AnimationMixer(this.object);
    this.clips = {};
    for (const clip of gltf.animations) {
      const a = this.mixer.clipAction(clip);
      if (clip.name === "Idle") a.setLoop(THREE.LoopRepeat, Infinity);
      else { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      this.clips[clip.name] = a;
    }
    this.playWeaponClip("Idle");
    this.burst = options.burstParent ? new PopcornBurst(this.tank, options.burstParent) : null;
  }

  /** Remember the viewmodel (FP) so actions drive the arms the same frame as the weapon. */
  attachViewmodel(vm: ViewmodelLike | null): void {
    this.vm = vm;
    this.tank.resetMotion();
  }

  get reloading(): boolean { return this.mode === "reload"; }
  get busy(): boolean { return this.mode === "fire" || this.mode === "fireLast" || this.mode === "reload"; }
  /** True once the current action reached its authored "readyToFire" point. */
  get canFire(): boolean {
    if (this.ammo <= 0) return false;
    if (this.mode === "fire") return this.clock >= this.tl.fire.events.readyToFire;
    if (this.mode === "fireLast") return this.clock >= this.tl.fireLast.events.readyToFire;
    if (this.mode === "reload") return this.fired.has("ammoRefilled") && this.clock >= this.tl.reload.events.readyToFire;
    return true;
  }
  get canReload(): boolean { return this.ammo < this.shots && this.mode !== "reload"; }

  /**
   * Fire one shot (call when gameplay accepted it). Plays FP_Fire (recoil + pump) or
   * FP_FireLast (last popcorn load: recoil only — the pump rack happens at the end of the reload).
   */
  fire(): boolean {
    if (this.ammo <= 0) { this.ev.onDryFire?.(); return false; }
    if (this.mode === "reload") return false;
    this.ammo--;
    const last = this.ammo === 0;
    const key = last ? "fireLast" : "fire";
    this.start(key, last ? "Fire_Last" : "Fire");
    this.vm?.playAction(key, { fadeIn: 0.02, exitFade: 0.12 });
    this.vm?.addRecoil(0.35);
    this.tank.consumeShot();
    this.burst?.emit(this.muzzle);
    this.fired.add("shot");
    this.ev.onShot?.(this.ammo);
    return true;
  }

  /** Start the popcorn reload (side button, kernels appear, pops, pump rack). */
  reload(): boolean {
    if (!this.canReload) return false;
    this.ammoBeforeReload = this.ammo;
    this.start("reload", "Reload");
    this.vm?.playAction("reload", { fadeIn: 0.08, exitFade: 0.15, onFinished: () => this.finishReload(false) });
    // kernels needed to refill the tank
    this.tank.freeSlots(this.kernelSlots);
    this.kernelsSpawned = 0;
    this.popsDone = 0;
    const p0 = this.tl.reload.events.pops[0], p1 = this.tl.reload.events.pops[1];
    const n = this.kernelSlots.length;
    this.popTimes.length = 0;
    for (let k = 0; k < n; k++) {
      // crescendo: inverse smoothstep distribution (few pops, a rush, the last stragglers)
      const u = Math.min(0.999, (k + this.tank.sim.rand()) / n);
      this.popTimes.push(p0 + (p1 - p0) * (0.5 - Math.sin(Math.asin(1 - 2 * u) / 3)));
    }
    this.popTimes.sort((a, b) => a - b);
    return true;
  }

  /** Weapon switch / death during a reload: before the refill point the reload is undone. */
  cancelReload(): void {
    if (this.mode !== "reload") return;
    this.vm?.cancelAction(true);
    this.finishReload(true);
  }

  /** One-handed inspection (arms clip + weapon clip on the same frame). */
  inspect(): boolean {
    if (this.busy || !this.vm) return false;
    if (!this.vm.startInspect(() => { if (this.mode === "inspect") this.toIdle(); })) return false;
    this.start("inspect", "Inspect");
    return true;
  }

  /** Network / respawn sync: force the ammo count (instant tank fill, no animation). */
  setAmmo(ammo: number): void {
    if (this.mode === "reload") this.finishReload(true);
    this.ammo = Math.max(0, Math.min(this.shots, Math.round(ammo)));
    this.tank.clearKernels();
    this.tank.setAmmo(this.ammo);
  }

  /**
   * Remote players: mirror an action decided by the server (the TP arms clip is played by the
   * character the same frame). Never refused for a local ammo mismatch — the server is right.
   */
  playRemote(action: "fire" | "reload"): void {
    if (action === "fire") {
      if (this.mode === "reload") this.finishReload(false);
      if (this.ammo <= 0) this.setAmmo(1);
      this.fire();
    } else {
      if (this.ammo >= this.shots) this.setAmmo(this.shots - 1);
      this.reload();
    }
  }

  private start(mode: Mode, weaponClip: string): void {
    if (this.mode === "reload" && mode !== "reload") this.finishReload(true);
    this.mode = mode;
    this.clock = 0;
    this.fired.clear();
    this.playWeaponClip(weaponClip);
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

  private once(key: string, at: number, fn?: () => void): void {
    if (this.clock >= at && !this.fired.has(key)) {
      this.fired.add(key);
      fn?.();
    }
  }

  private finishReload(cancelled: boolean): void {
    if (this.mode !== "reload") return;
    if (cancelled && !this.fired.has("ammoRefilled")) {
      // undo: back to the pre-reload fill, no kernel left
      this.tank.clearKernels();
      this.tank.setAmmo(this.ammoBeforeReload);
      this.ammo = this.ammoBeforeReload;
    } else {
      this.popAll();
      this.ammo = this.shots;
    }
    this.toIdle();
    this.ev.onReloadEnd?.(cancelled);
  }

  private popAll(): void {
    for (const slot of this.kernelSlots) {
      if (this.tank.sim.state[slot] === PState.Hidden) this.tank.spawnKernel(slot);
      if (this.tank.popKernel(slot)) this.ev.onPop?.(this.popsDone++, this.kernelSlots.length);
    }
  }

  /** Per frame (same dt as the ViewmodelSystem), after the FP camera sync. */
  update(dt: number): void {
    this.mixer.update(dt);
    this.clock += dt;
    const tl = this.tl;
    switch (this.mode) {
      case "fire": {
        const e = tl.fire.events;
        this.once("pumpBack", e.pumpBack, () => this.ev.onPumpBack?.());
        this.once("pumpForward", e.pumpForward, () => { this.ev.onPumpForward?.(); this.tank.shake(0.8); });
        if (this.clock >= tl.fire.duration) this.toIdle();
        break;
      }
      case "fireLast":
        if (this.clock >= tl.fireLast.duration) this.toIdle();
        break;
      case "reload": {
        const e = tl.reload.events;
        this.once("lidOpen", e.lidOpen, () => this.ev.onLidOpen?.());
        // kernels sprinkled by the left fist: they appear under the rim and drop onto the pile
        const k0 = e.kernelsIn[0], k1 = e.kernelsIn[1];
        if (this.clock >= k0 && this.kernelsSpawned < this.kernelSlots.length) {
          if (this.kernelsSpawned === 0) this.ev.onKernelsIn?.();
          const u = Math.min(1, (this.clock - k0) / Math.max(1e-3, k1 - k0));
          const target = Math.ceil(u * this.kernelSlots.length);
          while (this.kernelsSpawned < target) this.tank.spawnKernel(this.kernelSlots[this.kernelsSpawned++]);
        }
        this.once("lidClose", e.lidClose, () => { this.ev.onLidClose?.(); this.tank.shake(1.0); });
        // pops
        while (this.popsDone < this.popTimes.length && this.clock >= this.popTimes[this.popsDone]) {
          const slot = this.kernelSlots[this.popsDone];
          if (this.tank.sim.state[slot] === PState.Hidden) this.tank.spawnKernel(slot);
          this.tank.popKernel(slot);
          this.ev.onPop?.(this.popsDone, this.popTimes.length);
          this.popsDone++;
        }
        this.once("ammoRefilled", e.ammoRefilled, () => {
          this.popAll();
          this.ammo = this.shots;
          this.ev.onAmmoRefilled?.();
        });
        this.once("pumpBack", e.pumpBack, () => this.ev.onPumpBack?.());
        this.once("pumpForward", e.pumpForward, () => { this.ev.onPumpForward?.(); this.tank.shake(0.6); });
        // without a viewmodel (remote) nobody calls onFinished → end on the clock
        if (!this.vm && this.clock >= tl.reload.duration) this.finishReload(false);
        break;
      }
      case "inspect":
        if (!this.vm && this.clock >= tl.inspect.duration) this.toIdle();
        break;
    }
    this.tank.update(dt);
    this.burst?.update(dt);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.object);
    this.tank.dispose();
    this.burst?.dispose();
    this.object.removeFromParent();
  }
}

/**
 * Cosmetic popcorn puff at the muzzle (10 instanced pieces, 0.35 s, 1 draw call). Lives in the
 * given parent's space (FP scene = world coordinates). Gameplay pellets are NOT handled here.
 */
class PopcornBurst {
  private readonly mesh: THREE.InstancedMesh;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly rot: Float32Array;
  private readonly life: Float32Array;
  private readonly n = 10;
  private unit = 0.076;
  private active = false;

  private readonly tank: PopcornTank;

  constructor(tank: PopcornTank, parent: THREE.Object3D) {
    this.tank = tank;
    this.mesh = new THREE.InstancedMesh(tank.popcornMesh.geometry, tank.popcornMesh.material, this.n);
    this.mesh.name = "PopcornMuzzleBurst";
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.raycast = () => {};
    parent.add(this.mesh);
    this.pos = new Float32Array(this.n * 3);
    this.vel = new Float32Array(this.n * 3);
    this.rot = new Float32Array(this.n * 4);
    this.life = new Float32Array(this.n);
  }

  emit(muzzle: THREE.Object3D): void {
    // piece size = the tank's world scale at shot time (FP ≈ 0.076 m/unit, TP ≈ 0.067)
    this.tank.node.updateWorldMatrix(true, false);
    this.tank.node.matrixWorld.decompose(_v, _q, _s);
    this.unit = _s.x;
    muzzle.updateWorldMatrix(true, false);
    muzzle.getWorldPosition(_v);
    muzzle.getWorldQuaternion(_q);
    _fwd.set(-1, 0, 0).applyQuaternion(_q); // weapon forward = -X
    for (let i = 0; i < this.n; i++) {
      const sp = 2.5 + Math.random() * 2.5;
      this.pos[i * 3] = _v.x; this.pos[i * 3 + 1] = _v.y; this.pos[i * 3 + 2] = _v.z;
      this.vel[i * 3] = _fwd.x * sp + (Math.random() - 0.5) * 1.2;
      this.vel[i * 3 + 1] = _fwd.y * sp + (Math.random() - 0.2) * 1.2;
      this.vel[i * 3 + 2] = _fwd.z * sp + (Math.random() - 0.5) * 1.2;
      _rq.random();
      this.rot[i * 4] = _rq.x; this.rot[i * 4 + 1] = _rq.y; this.rot[i * 4 + 2] = _rq.z; this.rot[i * 4 + 3] = _rq.w;
      this.life[i] = 0.25 + Math.random() * 0.15;
    }
    this.active = true;
  }

  update(dt: number): void {
    if (!this.active) return;
    let alive = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= 9.81 * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.life[i] <= 0) continue;
      _v.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      _q.set(this.rot[i * 4], this.rot[i * 4 + 1], this.rot[i * 4 + 2], this.rot[i * 4 + 3]);
      _s.setScalar(this.unit * Math.min(1, this.life[i] * 6));
      _m.compose(_v, _q, _s);
      this.mesh.setMatrixAt(alive++, _m);
    }
    this.mesh.count = alive;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (alive === 0) this.active = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}
