import * as THREE from "three";
// cage geometry in cage-node units (FrisbeeLauncher_Weapon.glb, node "Cage": origin = top centre, axis +Y)
const TOP = 0.08;
const BOTTOM = -1.64;
const RADIUS = 1.25;
const CENTER_Y = (TOP + BOTTOM) / 2;
const HALF = (TOP - BOTTOM) / 2;
const _c = new THREE.Vector3();
const _a = new THREE.Vector3();
const _t = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _id = new THREE.Quaternion();
interface Drop {
    obj: THREE.Object3D;
    pos: THREE.Vector3;
    quat: THREE.Quaternion;
    scale: number;
    vel: THREE.Vector3;
    spin: THREE.Vector3;
    age: number;
    restAge: number;
    resting: boolean;
}
export interface DroppedCagesOptions {
    /** Ground height under (x, z) (default: y = 0). */
    ground?: (x: number, z: number) => number;
    /** Seconds on the ground before it sinks (default 6). */
    life?: number;
    /** Cages alive at once (default 12). */
    max?: number;
    /** World scale of a spawnAt() cage (default 0.35 * 0.19). */
    scale?: number;
    gravity?: number;
}
export class DroppedCages {
    group = new THREE.Group();
    private readonly template: THREE.Object3D;
    private readonly ground: (x: number, z: number) => number;
    private readonly life: number;
    private readonly max: number;
    private readonly scale: number;
    private readonly gravity: number;
    private readonly drops: Drop[] = [];
    /** template: FrisbeeLauncherController.cageTemplate (the Cage node + its CageDisc children, identity transform). */
    constructor(parent: THREE.Object3D, template: THREE.Object3D, options: DroppedCagesOptions = {}) {
        this.template = template;
        this.ground = options.ground ?? (() => 0);
        this.life = options.life ?? 6;
        this.max = options.max ?? 12;
        this.scale = options.scale ?? 0.35 * 0.19;
        this.gravity = options.gravity ?? 9.81;
        this.group.name = "DroppedCages";
        parent.add(this.group);
    }
    get count() { return this.drops.length; }
    /** TP hand-over: `world` = the weapon Cage node's world matrix at the release, `velocity` its world velocity (m/s). */
    spawn(world: THREE.Matrix4, velocity: THREE.Vector3, discs: number): void {
        const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
        world.decompose(pos, quat, _s);
        // a small tumble along the throw
        _t.set(velocity.z, 0, -velocity.x);
        const spin = _t.lengthSq() > 1e-6 ? _t.normalize().multiplyScalar(3.5) : new THREE.Vector3(3.5, 0, 0);
        this.add(pos, quat, Math.abs(_s.x), velocity, spin.clone(), discs);
    }
    /** Anywhere (FP: under the local player's view): position / orientation / velocity, world scale = options.scale. */
    spawnAt(position: THREE.Vector3, quaternion: THREE.Quaternion, velocity: THREE.Vector3, discs: number, spin: THREE.Vector3 = new THREE.Vector3(2.5, 0.5, 3.0)): void {
        this.add(position.clone(), quaternion.clone(), this.scale, velocity, spin.clone(), discs);
    }
    private add(pos: THREE.Vector3, quat: THREE.Quaternion, scale: number, vel: THREE.Vector3, spin: THREE.Vector3, discs: number): void {
        if (this.drops.length >= this.max)
            this.remove(0);
        const obj = this.template.clone(true);
        obj.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.isMesh) {
                m.castShadow = true;
                m.frustumCulled = false;
                m.raycast = () => { };
            }
            const k = /^CageDisc(\d+)$/.exec(o.name);
            if (k)
                o.visible = Number(k[1]) < discs;
        });
        this.group.add(obj);
        const d = { obj, pos, quat, scale, vel: vel.clone(), spin, age: 0, restAge: 0, resting: false };
        this.drops.push(d);
        this.place(d, 0);
    }
    update(dt: number): void {
        const h = Math.min(dt, 1 / 30);
        for (let i = this.drops.length - 1; i >= 0; i--) {
            const d = this.drops[i];
            d.age += dt;
            if (!d.resting)
                this.step(d, h);
            else
                d.restAge += dt;
            let sink = 0;
            if (d.restAge > this.life || d.age > this.life + 4) {
                sink = (Math.max(d.restAge - this.life, d.age - this.life - 4)) / 1.2;
                if (sink >= 1) {
                    this.remove(i);
                    continue;
                }
            }
            this.place(d, sink);
        }
    }
    private step(d: Drop, h: number): void {
        d.vel.y -= this.gravity * h;
        d.pos.addScaledVector(d.vel, h);
        const w = d.spin.length();
        if (w > 1e-6) {
            _q.setFromAxisAngle(_t.copy(d.spin).divideScalar(w), w * h);
            d.quat.premultiply(_q).normalize();
        }
        // lowest point of the cylinder on the ground
        _a.set(0, 1, 0).applyQuaternion(d.quat);
        _c.set(0, CENTER_Y * d.scale, 0).applyQuaternion(d.quat).add(d.pos);
        const ay = Math.abs(_a.y);
        const low = _c.y - (ay * HALF + Math.sqrt(Math.max(0, 1 - ay * ay)) * RADIUS) * d.scale;
        const g = this.ground(_c.x, _c.z);
        if (low < g) {
            d.pos.y += g - low;
            if (d.vel.y < 0)
                d.vel.y = -d.vel.y * 0.2;
            d.vel.x *= 0.55;
            d.vel.z *= 0.55;
            d.spin.multiplyScalar(0.5);
            // settle: rotate the axis toward the nearest stable pose (on its side, or standing on either end)
            const target = ay > 0.72 ? _t.set(0, Math.sign(_a.y), 0) : _t.set(_a.x, 0, _a.z).normalize();
            if (target.lengthSq() < 0.5)
                target.set(1, 0, 0);
            _q.setFromUnitVectors(_a, target);
            const ang = 2 * Math.acos(Math.min(1, Math.abs(_q.w)));
            if (ang > 1e-4) {
                _q.slerp(_id, Math.max(0, 1 - Math.min(1, (10 * h) / ang)));
                d.quat.premultiply(_q).normalize();
            }
            if (d.vel.lengthSq() < 0.04 && d.spin.lengthSq() < 0.3 && ang < 0.02) {
                d.resting = true;
                d.vel.set(0, 0, 0);
                d.spin.set(0, 0, 0);
            }
        }
    }
    private place(d: Drop, sink: number): void {
        d.obj.position.copy(d.pos);
        if (sink > 0)
            d.obj.position.y -= sink * (HALF * 2) * d.scale;
        d.obj.quaternion.copy(d.quat);
        d.obj.scale.setScalar(d.scale);
    }
    private remove(i: number): void {
        this.drops[i].obj.removeFromParent();
        this.drops.splice(i, 1);
    }
    /** Remove every dropped cage (round reset). */
    clear(): void { while (this.drops.length)
        this.remove(this.drops.length - 1); }
    dispose(): void { this.clear(); this.group.removeFromParent(); }
}
