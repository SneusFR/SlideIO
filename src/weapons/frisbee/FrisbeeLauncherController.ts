import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
const _p = new THREE.Vector3();
/**
 * Timeline of the authored clips (seconds). Arms (FP_/TP_ clips) and weapon clips share the SAME clock.
 * Comes from WeaponProfile_FrisbeeLauncher.json → `actions` (see FrisbeeLauncherProfile.ts).
 */
export interface FrisbeeTimeline {
    fire: { duration: number; events: { shot: number; cocked: number; discTaken: number; discSeated: number; readyToFire: number } };
    fireLast: { duration: number; events: { shot: number; readyToReload: number } };
    reload: { duration: number; events: { cageOut: number; cageDrop: number; cageSwap: number; cageIn: number; readyToFire: number } };
    reloadEmpty: {
        duration: number;
        events: { cageOut: number; cageDrop: number; cageSwap: number; cageIn: number; cocked: number; discTaken: number; discSeated: number; readyToFire: number };
    };
    inspect: { duration: number };
}
/** Minimal structural view of the common ViewmodelSystem (no import-path coupling). */
export interface FrisbeeViewmodelLike {
    playAction(key: string, options?: { startAt?: number; fadeIn?: number; exitFade?: number; timeScale?: number; onFinished?: () => void }): boolean;
    cancelAction(immediate?: boolean): void;
    startInspect(onDone: (cancelled: boolean) => void): boolean;
    cancelInspect(): void;
    addRecoil(amount: number): void;
}
/** The cage the player throws away during a reload (TP: world copy hand-over; FP: nothing to hand over). */
export interface FrisbeeCageDrop {
    /** TP: world matrix of the Cage node at the release (null in FP). */
    world: THREE.Matrix4 | null;
    /** World velocity of the cage (m/s). */
    velocity: THREE.Vector3;
    /** Discs still in the cage. */
    discs: number;
}
/** Gameplay / audio / HUD hooks (all optional). */
export interface FrisbeeLauncherEvents {
    /** The loaded disc leaves NOW (projectile + network + HUD here). */
    onShot?: (aiming: boolean) => void;
    onDryFire?: () => void;
    onCocked?: () => void;
    onDiscTaken?: () => void;
    onDiscSeated?: () => void;
    onCageOut?: () => void;
    onCageDrop?: (d: FrisbeeCageDrop) => void;
    onCageIn?: () => void;
    onReloadEnd?: (cancelled: boolean) => void;
}
export interface FrisbeeLauncherOptions {
    /** true = local viewmodel (FP), false = remote / TP. */
    firstPerson: boolean;
    timeline: FrisbeeTimeline;
    events?: FrisbeeLauncherEvents;
    /** Cosmetic viewmodel kick at each shot (default 0.06). */
    recoil?: number;
    /** Discs in the cage at creation (default: full). */
    startCage?: number;
    /**
     * Playback rate of the cage swaps ("reload" / "reloadEmpty"): arms clip, weapon clip and the controller clock all
     * run at this rate (default 1). The timeline stays in CLIP time. Shots / re-cocks are never sped up.
     */
    reloadSpeed?: number;
}
/** State handed by the network for a remote replay. */
export interface FrisbeeRemoteState {
    aiming?: boolean;
    /** Discs in the shooter's cage AT the action. */
    cage?: number;
    deckLoaded?: boolean;
}
type FrisbeeMode = "idle" | "fire" | "reload" | "inspect";
/**
 * FRISBEE LAUNCHER — weapon-side controller (one per weapon instance, FP or TP).
 *
 * Owns the cloned weapon scene (pass `object` to ViewmodelSystem.equip), the weapon's own mixer (trigger, sled,
 * limbs, elastic cords, discs, cage), the ammo (the disc on the deck + the 5-disc cage), the automatic re-cocking
 * after each shot (arms action "fire" = shot + re-cock; "fireLast" when the cage is empty), the magazine swap
 * ("reload" with a loaded deck, "reloadEmpty" = swap + re-cock) and the inspection. The PROJECTILE is spawned by your
 * code in onShot (FrisbeeProjectiles). Two-handed: the left hand sits on the foregrip except to re-cock / reload.
 */
export class FrisbeeLauncherController {
    readonly object: THREE.Object3D;
    /** Projectile start (the disc leaves the deck here), forward -X. */
    readonly launchSocket: THREE.Object3D;
    /** The disc mesh (for FrisbeeProjectiles: `new FrisbeeProjectiles(scene, controller.discTemplate, cast)`). */
    readonly discTemplate: THREE.Object3D;
    /** The cage + its discs at identity (for DroppedCages). */
    readonly cageTemplate: THREE.Object3D;
    readonly mixer: THREE.AnimationMixer;
    readonly cageCapacity: number;
    deckLoaded = true;
    cageCount: number;
    private readonly tl: FrisbeeTimeline;
    private readonly ev: FrisbeeLauncherEvents;
    /** true = local viewmodel (FP), false = remote / TP. */
    private readonly firstPerson: boolean;
    private readonly clips: Record<string, THREE.AnimationAction>;
    private readonly recoil: number;
    /** Playback rate of the cage swaps (1 = authored speed). */
    readonly reloadSpeed: number;
    private readonly cageDiscs: THREE.Object3D[];
    private readonly slotY: number[];
    private current: THREE.AnimationAction | null = null;
    private mode: FrisbeeMode = "idle";
    private action = "";
    private clock = 0;
    private fired = new Set<string>();
    private vm: FrisbeeViewmodelLike | null = null;
    private stackShift = 0;
    /** Bumped by every start() / toIdle(): a callback of an older action is ignored. */
    private token = 0;
    /** The arms action (ViewmodelSystem) ends the current action; false = the controller's own clock ends it. */
    private vmDriven = false;
    /** The last shot was taken aiming (ADS). */
    lastShotAimed = false;
    private cageBefore = 0;
    private readonly cageNode: THREE.Object3D;
    /** TP: last world matrix / velocity of the cage node while visible (hand-over to the world copy at the release). */
    private cageWorld = new THREE.Matrix4();
    private cagePos = new THREE.Vector3();
    private cageVel = new THREE.Vector3();
    private cageSeen = false;
    constructor(gltf: GLTF, options: FrisbeeLauncherOptions) {
        this.tl = options.timeline;
        this.ev = options.events ?? {};
        this.firstPerson = options.firstPerson;
        this.recoil = options.recoil ?? 0.06;
        this.reloadSpeed = Math.max(0.05, options.reloadSpeed ?? 1);
        this.object = gltf.scene.clone(true);
        this.object.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (mesh.isMesh) {
                mesh.castShadow = !options.firstPerson;
                mesh.receiveShadow = false;
                if (options.firstPerson)
                    mesh.frustumCulled = false;
                mesh.raycast = () => { };
            }
        });
        const launch = this.object.getObjectByName("LaunchSocket");
        const deck = this.object.getObjectByName("DiscDeck");
        if (!launch || !deck)
            throw new Error("FrisbeeLauncher GLB: LaunchSocket / DiscDeck node missing");
        this.launchSocket = launch;
        this.discTemplate = deck.clone(false);
        const cage = this.object.getObjectByName("Cage");
        if (!cage)
            throw new Error("FrisbeeLauncher GLB: Cage node missing");
        this.cageNode = cage;
        this.cageTemplate = cage.clone(true);
        this.cageTemplate.position.set(0, 0, 0);
        this.cageTemplate.quaternion.identity();
        this.cageTemplate.scale.set(1, 1, 1);
        this.cageDiscs = [];
        for (let k = 0;; k++) {
            const d = this.object.getObjectByName(`CageDisc${k}`);
            if (!d)
                break;
            this.cageDiscs.push(d);
        }
        this.cageCapacity = this.cageDiscs.length;
        this.slotY = this.cageDiscs.map((d) => d.position.y);
        const n = this.slotY.length;
        this.slotY.push(n > 1 ? 2 * this.slotY[n - 1] - this.slotY[n - 2] : this.slotY[0] - 0.3);
        this.cageCount = Math.max(0, Math.min(this.cageCapacity, options.startCage ?? this.cageCapacity));
        this.mixer = new THREE.AnimationMixer(this.object);
        this.clips = {};
        for (const clip of gltf.animations) {
            const a = this.mixer.clipAction(clip);
            if (clip.name.startsWith("Idle"))
                a.setLoop(THREE.LoopRepeat, Infinity);
            else {
                a.setLoop(THREE.LoopOnce, 1);
                a.clampWhenFinished = true;
            }
            this.clips[clip.name] = a;
        }
        this.toIdle();
    }
    /** Remember the viewmodel (FP) so actions drive the arms the same frame as the weapon. */
    attachViewmodel(vm: FrisbeeViewmodelLike | null): void { this.vm = vm; }
    /** Total discs: the loaded one + the cage. */
    get ammo(): number { return (this.deckLoaded ? 1 : 0) + this.cageCount; }
    get capacity(): number { return 1 + this.cageCapacity; }
    get reloading(): boolean { return this.mode === "reload"; }
    get busy(): boolean { return this.mode === "reload" || this.mode === "fire"; }
    /** A disc is between the cage and the deck: taken for the re-cock (discTaken) and not seated yet (HUD read-out). */
    get discInHand(): boolean {
        const recock = (this.mode === "fire" && this.action === "fire") || (this.mode === "reload" && this.action === "reloadEmpty");
        return recock && this.fired.has("discTaken") && !this.fired.has("discSeated");
    }
    /** The running action key ("fire", "fireLast", "reload", "reloadEmpty"…) or "". */
    get currentAction(): string { return this.mode === "idle" || this.mode === "inspect" ? "" : this.action; }
    /** true when a trigger pull would throw a disc now. */
    get canFire(): boolean {
        if (!this.deckLoaded)
            return false;
        if (this.mode === "idle" || this.mode === "inspect")
            return true;
        if (this.mode === "fire")
            return this.action === "fire" && this.clock >= this.tl.fire.events.readyToFire;
        if (this.mode === "reload") {
            const e = this.action === "reload" ? this.tl.reload.events.readyToFire : this.tl.reloadEmpty.events.readyToFire;
            return this.clock >= e;
        }
        return false;
    }
    get canReload(): boolean {
        // a full cage with an empty deck (e.g. a re-cock interrupted by a weapon switch) may still reload: reloadEmpty re-cocks
        if (this.cageCount >= this.cageCapacity && this.deckLoaded)
            return false;
        if (this.mode === "reload")
            return false;
        if (this.mode === "fire")
            return this.action === "fireLast" ? this.clock >= this.tl.fireLast.events.readyToReload : false;
        return true;
    }
    /**
     * Trigger pull. Throws the loaded disc NOW (onShot inside this call), then re-cocks automatically if the cage has a
     * disc ("fire", ~1.6 s, can fire again from readyToFire) or stays empty ("fireLast"). aiming: ADS arms clips.
     */
    fire(aiming = false): boolean {
        if (!this.deckLoaded) {
            if (this.mode !== "reload" && this.mode !== "fire")
                this.ev.onDryFire?.();
            return false;
        }
        if (!this.canFire)
            return false;
        if (this.mode === "inspect")
            this.vm?.cancelInspect();
        if (this.mode === "reload")
            this.finishReload(false);
        this.deckLoaded = false;
        this.lastShotAimed = aiming;
        const withCycle = this.cageCount > 0;
        this.start("fire", withCycle ? "fire" : "fireLast", withCycle ? "Fire" : "FireLast", withCycle ? (aiming ? "fireAim" : "fire") : (aiming ? "fireLastAim" : "fireLast"), 0.03);
        this.vm?.addRecoil(this.recoil);
        this.ev.onShot?.(aiming);
        return true;
    }
    /** Magazine swap: "reload" (deck loaded, 1.4 s) or "reloadEmpty" (+ re-cock, ~2.5 s). */
    reload(): boolean {
        if (!this.canReload)
            return false;
        if (this.mode === "inspect")
            this.vm?.cancelInspect();
        this.cageBefore = this.cageCount;
        const empty = !this.deckLoaded;
        this.start("reload", empty ? "reloadEmpty" : "reload", empty ? "ReloadEmpty" : "Reload", empty ? "reloadEmpty" : "reload", 0.08, () => this.finishReload(false));
        return true;
    }
    /**
     * Weapon switch / death: interrupts the running action.
     *  - reload: before cageIn the old cage is kept; after, the new cage stays (a disc already taken for the re-cock goes
     *    back into the cage, the deck stays empty — the next reload re-cocks);
     *  - re-cock after a shot ("fire"): completed instantly (the disc ends on the deck), like the server does.
     */
    cancelAction(): void {
        if (this.mode === "reload")
            this.finishReload(true);
        else if (this.mode === "fire")
            this.finishFire();
        else if (this.mode === "inspect")
            this.toIdle();
        else
            return;
        this.vm?.cancelAction(true);
    }
    /** Same as cancelAction() (kept for the Popcorn Shotgun-style call sites). */
    cancelReload(): void { this.cancelAction(); }
    /** Inspection (arms clip + weapon clip on the same frame). */
    inspect(): boolean {
        if (this.mode !== "idle" || !this.vm)
            return false;
        if (!this.vm.startInspect(() => { if (this.mode === "inspect")
            this.toIdle(); }))
            return false;
        this.mode = "inspect";
        this.clock = 0;
        this.fired.clear();
        this.playWeaponClip(this.deckLoaded ? "Inspect" : "InspectEmpty");
        return true;
    }
    /** Network / respawn sync: force the ammo (instant, no animation). */
    setAmmo(deckLoaded: boolean, cageCount: number): void {
        if (this.mode === "reload")
            this.finishReload(true);
        this.deckLoaded = deckLoaded;
        this.cageCount = Math.max(0, Math.min(this.cageCapacity, Math.round(cageCount)));
        this.stackShift = 0;
        // a running re-cock keeps playing but must not change the ammo any more (the server state already includes it)
        if (this.mode === "fire")
            for (const k of ["cocked", "discTaken", "discSeated"])
                this.fired.add(k);
        else
            this.toIdle();
    }
    /**
     * Remote players: mirror an action decided by the server (never refused for a local ammo mismatch).
     * `state` = the shooter's ammo at the moment of the action (from the server message), so the mirror picks the same
     * clip: fire → "fire" (re-cock) when cage > 0, else "fireLast"; reload → "reload" when the deck was loaded, else
     * "reloadEmpty".
     */
    playRemote(action: "fire" | "reload", state: FrisbeeRemoteState = {}): void {
        const clampCage = (n: number) => Math.max(0, Math.min(this.cageCapacity, Math.round(n)));
        if (this.mode === "inspect")
            this.vm?.cancelInspect();
        if (this.mode === "reload")
            this.finishReload(false);
        if (state.cage !== undefined)
            this.cageCount = clampCage(state.cage);
        this.stackShift = 0;
        this.mode = "idle";
        if (action === "fire") {
            this.deckLoaded = true;
            this.fire(state.aiming ?? false);
        }
        else {
            if (state.deckLoaded !== undefined)
                this.deckLoaded = state.deckLoaded;
            if (this.cageCount >= this.cageCapacity)
                this.cageCount = this.cageCapacity - 1;
            this.reload();
        }
    }
    private start(mode: FrisbeeMode, action: string, weaponClip: string, vmKey: string, fadeIn: number, onFinished?: () => void): void {
        this.mode = mode;
        this.action = action;
        this.clock = 0;
        this.fired.clear();
        const token = ++this.token;
        this.playWeaponClip(weaponClip);
        this.vmDriven = false;
        if (this.vm) {
            // a late / interrupted callback of an older action must not end this one
            const done = () => { if (token === this.token)
                (onFinished ?? (() => this.actionDone()))(); };
            const timeScale = mode === "reload" ? this.reloadSpeed : 1;
            let ok = this.vm.playAction(vmKey, { fadeIn, exitFade: 0.15, timeScale, onFinished: done });
            if (!ok && vmKey.endsWith("Aim"))
                ok = this.vm.playAction(vmKey.slice(0, -3), { fadeIn, exitFade: 0.15, timeScale, onFinished: done });
            this.vmDriven = ok;
        }
    }
    private actionDone(): void {
        if (this.mode === "fire")
            this.finishFire();
    }
    /** End of the shot / re-cock (clip end or interruption): the pending ammo events are applied. */
    private finishFire(): void {
        if (this.mode !== "fire")
            return;
        if (this.action === "fire") {
            if (!this.fired.has("discTaken")) {
                this.fired.add("discTaken");
                this.takeDisc();
            }
            if (!this.fired.has("discSeated")) {
                this.fired.add("discSeated");
                this.deckLoaded = true;
                this.ev.onDiscSeated?.();
            }
        }
        this.toIdle();
    }
    private playWeaponClip(name: string): void {
        const a = this.clips[name];
        if (!a)
            return;
        if (this.current && this.current !== a)
            this.current.stop();
        a.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
        this.current = a;
    }
    private toIdle(): void {
        this.token++;
        this.mode = "idle";
        this.action = "";
        this.playWeaponClip(this.deckLoaded ? "Idle" : "IdleEmpty");
    }
    private once(key: string, at: number, fn?: () => void): void {
        if (this.clock >= at && !this.fired.has(key)) {
            this.fired.add(key);
            fn?.();
        }
    }
    private takeDisc(): void {
        if (this.cageCount > 0) {
            this.cageCount--;
            this.stackShift = 1;
        }
        this.ev.onDiscTaken?.();
    }
    private finishReload(cancelled: boolean): void {
        if (this.mode !== "reload")
            return;
        const empty = this.action === "reloadEmpty";
        if (cancelled) {
            if (!this.fired.has("cageIn"))
                this.cageCount = this.cageBefore;
            else if (empty && this.fired.has("discTaken") && !this.fired.has("discSeated"))
                this.cageCount = Math.min(this.cageCapacity, this.cageCount + 1); // the disc in the hand goes back
            this.stackShift = 0;
        }
        else {
            if (!this.fired.has("cageIn"))
                this.cageCount = this.cageCapacity;
            if (empty && !this.fired.has("discSeated")) {
                if (!this.fired.has("discTaken"))
                    this.takeDisc();
                this.deckLoaded = true;
            }
            this.stackShift = 0;
        }
        this.toIdle();
        this.ev.onReloadEnd?.(cancelled);
    }
    private updateCage(dt: number): void {
        this.stackShift = Math.max(0, this.stackShift - dt / 0.22);
        const s = this.stackShift * this.stackShift * (3 - 2 * this.stackShift);
        for (let k = 0; k < this.cageDiscs.length; k++) {
            const d = this.cageDiscs[k];
            const on = k < this.cageCount;
            d.visible = on;
            if (on)
                d.position.y = this.slotY[k] + (this.slotY[k + 1] - this.slotY[k]) * s;
        }
    }
    private dropCage(): void {
        const discs = this.cageCount;
        if (this.firstPerson) {
            this.ev.onCageDrop?.({ world: null, velocity: new THREE.Vector3(), discs });
            return;
        }
        this.ev.onCageDrop?.({ world: this.cageSeen ? this.cageWorld.clone() : this.cageNode.matrixWorld.clone(),
            velocity: this.cageVel.clone(), discs });
    }
    /** TP: remember where the (visible) cage node is and how fast it moves. */
    private trackCage(dt: number): void {
        if (this.mode !== "reload") {
            this.cageSeen = false;
            return;
        }
        const n = this.cageNode;
        n.updateWorldMatrix(true, false);
        if (n.scale.x < 0.98)
            return; // hidden / shrinking (hand-over) or growing (new cage)
        _p.setFromMatrixPosition(n.matrixWorld);
        if (this.cageSeen && dt > 1e-4)
            this.cageVel.subVectors(_p, this.cagePos).divideScalar(dt);
        else
            this.cageVel.set(0, 0, 0);
        this.cagePos.copy(_p);
        this.cageWorld.copy(n.matrixWorld);
        this.cageSeen = true;
    }
    /** Per frame (same dt as the ViewmodelSystem), AFTER the FP camera sync / the TP character update (TP: after the
     *  character's matrixWorld is updated, the dropped cage hand-over reads the cage's world matrix). */
    update(dt: number): void {
        // Cage swaps run reloadSpeed x faster: the weapon mixer AND the clip-time clock advance together (the arms clip
        // is sped up by start()); every other action keeps the authored speed.
        const rate = this.mode === "reload" ? this.reloadSpeed : 1;
        this.mixer.update(dt * rate);
        this.clock += dt * rate;
        if (!this.firstPerson)
            this.trackCage(dt);
        const tl = this.tl;
        if (this.mode === "fire") {
            if (this.action === "fire") {
                const e = tl.fire.events;
                this.once("cocked", e.cocked, () => this.ev.onCocked?.());
                this.once("discTaken", e.discTaken, () => this.takeDisc());
                this.once("discSeated", e.discSeated, () => { this.deckLoaded = true; this.ev.onDiscSeated?.(); });
                if (!this.vmDriven && this.clock >= tl.fire.duration)
                    this.finishFire();
            }
            else if (!this.vmDriven && this.clock >= tl.fireLast.duration)
                this.toIdle();
        }
        else if (this.mode === "reload") {
            const e = this.action === "reload" ? tl.reload.events : tl.reloadEmpty.events;
            this.once("cageOut", e.cageOut, () => this.ev.onCageOut?.());
            this.once("cageDrop", e.cageDrop, () => this.dropCage());
            this.once("cageSwap", e.cageSwap, () => { this.cageCount = this.cageCapacity; this.stackShift = 0; });
            this.once("cageIn", e.cageIn, () => this.ev.onCageIn?.());
            if (this.action === "reloadEmpty") {
                const r = tl.reloadEmpty.events;
                this.once("cocked", r.cocked, () => this.ev.onCocked?.());
                this.once("discTaken", r.discTaken, () => this.takeDisc());
                this.once("discSeated", r.discSeated, () => { this.deckLoaded = true; this.ev.onDiscSeated?.(); });
            }
            const dur = this.action === "reload" ? tl.reload.duration : tl.reloadEmpty.duration;
            if (!this.vmDriven && this.clock >= dur)
                this.finishReload(false);
        }
        else if (this.mode === "inspect") {
            if (!this.vm && this.clock >= tl.inspect.duration)
                this.toIdle();
        }
        this.updateCage(dt);
    }
    dispose(): void {
        this.mixer.stopAllAction();
        this.object.removeFromParent();
    }
}
