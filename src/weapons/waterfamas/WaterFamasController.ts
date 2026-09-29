import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { WaterTank, type WaterTankOptions } from "./WaterTank";

/**
 * Timeline of the authored clips (seconds). Comes from WeaponProfile_WaterFamas.json → `actions`
 * (see WaterFamasProfile.ts). Arms and weapon clips share the SAME clock.
 */
export interface WaterFamasTimeline {
  fire: { jets: readonly number[]; burstDuration: number; burstInterval: number };
  reload: {
    duration: number;
    events: {
      capGrab: number; capOff: number; hingeOpen: number; bottleIn: number; pourStart: number;
      pourEnd: number; bottleOut: number; hingeClose: number; capScrewed: number; readyToFire: number;
    };
  };
  inspect: { duration: number; sloshKicks?: readonly number[] };
}

/** Minimal structural view of the common ViewmodelSystem (no import-path coupling). */
export interface ViewmodelLike {
  playAction(key: string, options?: { startAt?: number; fadeIn?: number; exitFade?: number; onFinished?: () => void }): boolean;
  cancelAction(immediate?: boolean): void;
  startInspect(onDone: (cancelled: boolean) => void): boolean;
  cancelInspect(): void;
  addRecoil(amount: number): void;
}

/** Gameplay / audio / VFX hooks (all optional). */
export interface WaterFamasEvents {
  /** A burst starts (TP: play the character's "fire" action; network: burst message). */
  onBurstStart?: (aiming: boolean) => void;
  /** One jet leaves the barrel (k = 0..2): the hitscan raycast of that jet goes here. */
  onJet?: (k: number, ammoLeft: number) => void;
  onBurstEnd?: () => void;
  onDryFire?: () => void;
  onCapGrab?: () => void;
  onCapOff?: () => void;
  onHingeOpen?: () => void;
  onBottleIn?: () => void;
  onPourStart?: () => void;
  /** End of the pour: gameplay ammo is full from here. */
  onAmmoRefilled?: () => void;
  onBottleOut?: () => void;
  onHingeClose?: () => void;
  onCapScrewed?: () => void;
  onReloadEnd?: (cancelled: boolean) => void;
}

export interface WaterFamasOptions {
  /** true = local player viewmodel; false = remote / TP. */
  firstPerson: boolean;
  timeline: WaterFamasTimeline;
  events?: WaterFamasEvents;
  /** Cosmetic viewmodel recoil added per jet (ViewmodelSystem.addRecoil). Default 0.035. */
  recoilPerJet?: number;
  /** ViewmodelSystem action key used for a burst fired while aiming. Default "fireAim". */
  aimFireKey?: string;
  tank?: WaterTankOptions;
}

type Mode = "idle" | "fire" | "reload" | "inspect";

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
/**
 * WATER FAMAS — weapon-side controller (one per weapon instance, FP or TP).
 *
 * Owns the cloned weapon scene (pass `object` to ViewmodelSystem.equip), the weapon's own mixer (trigger, cap,
 * retainer, bottle), the ammo (9 jets = 3 bursts of 3) ⇄ the live water tank, the burst timing (the 3 jets are
 * emitted by update() at 0 / 0.075 / 0.15 s: onJet is where your hitscan goes), the reload timeline (cap, pour,
 * screw) with the pour stream, and the inspection. Gameplay (damage, raycasts, authority) stays in your weapon
 * class. ONE-HANDED: the left arm only comes to the gun for the reload.
 */
export class WaterFamasController {
    readonly object: THREE.Object3D;
    readonly muzzle: THREE.Object3D;
    readonly tank: WaterTank;
    readonly mixer: THREE.AnimationMixer;
    readonly capacity: number;
    readonly jetsPerBurst: number;
    ammo: number;
    private readonly tl: WaterFamasTimeline;
    private readonly ev: WaterFamasEvents;
    private readonly firstPerson: boolean;
    private readonly clips: Record<string, THREE.AnimationAction>;
    private readonly recoilPerJet: number;
    private readonly aimFireKey: string;
    private readonly nozzle: THREE.Object3D | null;
    private readonly fillPoint: THREE.Object3D | null;
    private readonly bottle: THREE.Object3D | null;
    private current: THREE.AnimationAction | null = null;
    private mode: Mode = "idle";
    private clock = 0;
    private sinceBurst = 1e9;
    private burstJets = 0;
    private burstAiming = false;
    private fired = new Set<string>();
    private vm: ViewmodelLike | null = null;
    private ammoBeforeReload = 0;    constructor(gltf: GLTF, options: WaterFamasOptions) {
        this.tl = options.timeline;
        this.ev = options.events ?? {};
        this.firstPerson = options.firstPerson;
        this.recoilPerJet = options.recoilPerJet ?? 0.035;
        this.aimFireKey = options.aimFireKey ?? "fireAim";
        // Plain clone (no skinned meshes in this weapon): geometry shared; the tank gets its own liquid materials.
        this.object = gltf.scene.clone(true);
        this.object.traverse((o: THREE.Object3D) => {
            const mesh = o as THREE.Mesh;
            if (mesh.isMesh) {
                mesh.castShadow = !options.firstPerson;
                mesh.receiveShadow = false;
                if (options.firstPerson)
                    mesh.frustumCulled = false;
                mesh.raycast = () => { };
            }
        });
        const glass = this.object.getObjectByName("TankGlass");
        if (glass)
            glass.renderOrder = 3;
        const tankNode = this.object.getObjectByName("Tank");
        const muzzle = this.object.getObjectByName("Muzzle");
        if (!tankNode || !muzzle)
            throw new Error("WaterFamas GLB: Tank / Muzzle node missing");
        this.muzzle = muzzle;
        this.tank = new WaterTank(tankNode, this.object, options.tank);
        this.capacity = this.tank.data.capacity;
        this.jetsPerBurst = this.tank.data.jetsPerShot;
        this.ammo = this.capacity;
        this.tank.setAmmo(this.ammo);
        this.tank.snap();
        this.nozzle = this.object.getObjectByName("BottleNozzle") ?? null;
        this.fillPoint = this.object.getObjectByName("FillPoint") ?? null;
        this.bottle = this.object.getObjectByName("Bottle") ?? null;
        this.mixer = new THREE.AnimationMixer(this.object);
        this.clips = {} as Record<string, THREE.AnimationAction>;
        for (const clip of gltf.animations) {
            const a = this.mixer.clipAction(clip);
            if (clip.name === "Idle")
                a.setLoop(THREE.LoopRepeat, Infinity);
            else {
                a.setLoop(THREE.LoopOnce, 1);
                a.clampWhenFinished = true;
            }
            this.clips[clip.name] = a;
        }
        this.playWeaponClip("Idle");
    }
    /** Remember the viewmodel (FP) so actions drive the arms the same frame as the weapon. */
    attachViewmodel(vm: ViewmodelLike | null): void {
        this.vm = vm;
        this.tank.resetMotion();
    }
    get reloading(): boolean { return this.mode === "reload"; }
    /** A burst is running (its 3 jets are being emitted / the burst clip plays). */
    get firing(): boolean { return this.mode === "fire"; }
    get busy(): boolean { return this.mode === "reload" || this.mode === "fire"; }
    /** The running burst was started aiming (use it for the jet spread: WaterFamasGameplay.jetDirection). */
    get burstIsAimed(): boolean { return this.burstAiming; }
    /** Jets already emitted in the running burst (0..3). */
    get jetsFired(): number { return this.burstJets; }
    /** true when a trigger pull would start a burst now. */
    get canFire(): boolean {
        if (this.ammo <= 0)
            return false;
        if (this.mode === "reload")
            return this.fired.has("pourEnd") && this.clock >= this.tl.reload.events.readyToFire;
        return this.sinceBurst >= this.tl.fire.burstInterval - 1e-4;
    }
    get canReload(): boolean { return this.ammo < this.capacity && this.mode !== "reload"; }
    /**
     * One trigger pull = one BURST of 3 jets (FAMAS). The first jet leaves NOW (onJet(0) fires inside this call),
     * the two others from update() at 0.075 / 0.15 s. Returns false (and onDryFire when empty) if refused.
     * aiming: plays the aimed burst clip (FP_FireAim) instead of the hip one.
     */
    fire(aiming = false): boolean {
        if (this.ammo <= 0) {
            if (this.mode !== "reload")
                this.ev.onDryFire?.();
            return false;
        }
        if (!this.canFire)
            return false;
        if (this.mode === "reload")
            this.finishReload(false);
        if (this.mode === "inspect")
            this.vm?.cancelInspect();
        this.mode = "fire";
        this.clock = 0;
        this.sinceBurst = 0;
        this.burstJets = 0;
        this.burstAiming = aiming;
        this.fired.clear();
        this.playWeaponClip("Fire");
        if (this.vm) {
            const ok = aiming && this.vm.playAction(this.aimFireKey, { fadeIn: 0.03, exitFade: 0.12 });
            if (!ok)
                this.vm.playAction("fire", { fadeIn: 0.03, exitFade: 0.12 });
        }
        this.ev.onBurstStart?.(aiming);
        this.emitDueJets();
        return true;
    }
    /** Refill (3.3 s): unscrew the cap, swing it open, pour a bottle, close, screw. */
    reload(): boolean {
        if (!this.canReload)
            return false;
        if (this.mode === "fire") {
            this.ev.onBurstEnd?.();
        }
        if (this.mode === "inspect")
            this.vm?.cancelInspect();
        this.ammoBeforeReload = this.ammo;
        this.mode = "reload";
        this.clock = 0;
        this.fired.clear();
        this.playWeaponClip(this.firstPerson || !this.clips["Reload_TP"] ? "Reload" : "Reload_TP");
        this.vm?.playAction("reload", { fadeIn: 0.08, exitFade: 0.15, onFinished: () => this.finishReload(false) });
        return true;
    }
    /** Weapon switch / death during a reload: before the end of the pour, the old ammo is kept. */
    cancelReload(): void {
        if (this.mode !== "reload")
            return;
        this.vm?.cancelAction(true);
        this.finishReload(true);
    }
    /** One-handed inspection (arms clip + weapon clip on the same frame). The water sloshes on the shakes. */
    inspect(): boolean {
        if (this.mode !== "idle" || !this.vm)
            return false;
        if (!this.vm.startInspect(() => { if (this.mode === "inspect")
            this.toIdle(); }))
            return false;
        this.mode = "inspect";
        this.clock = 0;
        this.fired.clear();
        this.playWeaponClip("Inspect");
        return true;
    }
    /** Network / respawn sync: force the ammo count (instant tank level, no animation). */
    setAmmo(n: number): void {
        if (this.mode === "reload")
            this.finishReload(true);
        this.ammo = Math.max(0, Math.min(this.capacity, Math.round(n)));
        this.tank.setAmmo(this.ammo);
        this.tank.snap();
    }
    /** Remote players: mirror an action decided by the server (never refused for a local ammo mismatch). */
    playRemote(action: "fire" | "reload", aiming = false): void {
        if (action === "fire") {
            if (this.mode === "reload")
                this.finishReload(false);
            if (this.ammo <= 0)
                this.setAmmo(this.jetsPerBurst);
            this.sinceBurst = 1e9;
            this.fire(aiming);
        }
        else {
            if (this.ammo >= this.capacity)
                this.setAmmo(this.capacity - this.jetsPerBurst);
            this.reload();
        }
    }
    playWeaponClip(name: string): void {
        const a = this.clips[name];
        if (!a)
            return;
        if (this.current && this.current !== a)
            this.current.stop();
        a.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
        this.current = a;
    }
    toIdle(): void {
        this.mode = "idle";
        this.playWeaponClip("Idle");
        this.tank.setPour(null, null, 0);
    }
    emitDueJets(): void {
        const jets = this.tl.fire.jets;
        while (this.burstJets < this.jetsPerBurst && this.burstJets < jets.length && this.clock >= jets[this.burstJets] - 1e-6) {
            if (this.ammo <= 0) {
                this.burstJets = this.jetsPerBurst;
                break;
            }
            const k = this.burstJets++;
            this.ammo--;
            this.tank.setAmmo(this.ammo);
            this.vm?.addRecoil(this.recoilPerJet);
            // the water is pushed toward the back of the tank by the jet
            this.muzzle.getWorldDirection(_d);
            this.tank.impulse(_d, 0.18);
            this.ev.onJet?.(k, this.ammo);
        }
    }
    once(key: string, at: number, fn?: () => void): void {
        if (this.clock >= at && !this.fired.has(key)) {
            this.fired.add(key);
            fn?.();
        }
    }
    finishReload(cancelled: boolean): void {
        if (this.mode !== "reload")
            return;
        if (cancelled && !this.fired.has("pourEnd"))
            this.ammo = this.ammoBeforeReload;
        else
            this.ammo = this.capacity;
        this.tank.setAmmo(this.ammo);
        if (cancelled)
            this.tank.snap();
        this.toIdle();
        this.ev.onReloadEnd?.(cancelled);
    }
    /** Per frame (same dt as the ViewmodelSystem), AFTER the FP camera sync / the TP character update. */
    update(dt: number): void {
        this.mixer.update(dt);
        this.clock += dt;
        this.sinceBurst += dt;
        const tl = this.tl;
        switch (this.mode) {
            case "fire":
                this.emitDueJets();
                if (this.clock >= tl.fire.burstDuration) {
                    this.ev.onBurstEnd?.();
                    this.toIdle();
                }
                break;
            case "reload": {
                const e = tl.reload.events;
                this.once("capGrab", e.capGrab, () => this.ev.onCapGrab?.());
                this.once("capOff", e.capOff, () => this.ev.onCapOff?.());
                this.once("hingeOpen", e.hingeOpen, () => this.ev.onHingeOpen?.());
                this.once("bottleIn", e.bottleIn, () => this.ev.onBottleIn?.());
                this.once("pourStart", e.pourStart, () => this.ev.onPourStart?.());
                this.once("pourEnd", e.pourEnd, () => { this.ammo = this.capacity; this.ev.onAmmoRefilled?.(); });
                this.once("bottleOut", e.bottleOut, () => this.ev.onBottleOut?.());
                this.once("hingeClose", e.hingeClose, () => this.ev.onHingeClose?.());
                this.once("capScrewed", e.capScrewed, () => this.ev.onCapScrewed?.());
                // the level follows the pour: old ammo until the stream reaches the tank, full at the end of the pour
                const u = THREE.MathUtils.smoothstep(this.clock, e.pourStart + 0.04, e.pourEnd - 0.02);
                const f0 = this.ammoBeforeReload / this.capacity;
                this.tank.setAmmo((f0 + (1 - f0) * u) * this.capacity);
                // pour stream nozzle -> filler hole
                const on = this.clock >= e.pourStart && this.clock <= e.pourEnd + 0.06 && this.nozzle && this.fillPoint
                    && (!this.bottle || this.bottle.scale.x > 0.5);
                if (on) {
                    this.object.updateWorldMatrix(true, true);
                    this.nozzle.getWorldPosition(_a);
                    this.fillPoint.getWorldPosition(_b);
                    const grow = Math.min(1, (this.clock - e.pourStart) / 0.08);
                    const tail = this.clock > e.pourEnd ? 1 - (this.clock - e.pourEnd) / 0.06 : 1;
                    this.tank.setPour(_a, _b, Math.max(0, Math.min(grow, tail)));
                }
                else
                    this.tank.setPour(null, null, 0);
                if (!this.vm && this.clock >= tl.reload.duration)
                    this.finishReload(false); // remote: no arms callback
                break;
            }
            case "inspect":
                for (const [k, t] of (tl.inspect.sloshKicks ?? []).entries()) {
                    this.once("kick" + k, t, () => { this.muzzle.getWorldDirection(_d); _d.cross(_a.set(0, 1, 0)); this.tank.impulse(_d, k % 2 ? -0.5 : 0.5); });
                }
                if (!this.vm && this.clock >= tl.inspect.duration)
                    this.toIdle();
                break;
            default:
                this.tank.setAmmo(this.ammo);
                break;
        }
        this.tank.update(dt);
    }
    dispose(): void {
        this.mixer.stopAllAction();
        this.tank.dispose();
        this.object.removeFromParent();
    }
}
