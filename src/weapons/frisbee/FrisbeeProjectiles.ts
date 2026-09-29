import * as THREE from "three";
import { FrisbeeLauncherConfig, type FrisbeeTuning } from "../../../shared/combat/FrisbeeLauncherRules";
/**
 * Flight / damage tuning of a disc = the SHARED FrisbeeLauncherConfig.tuning (ONE source for the server and every client:
 * the pack's own copy of these numbers was removed so the collision radius can never drift between the two sides).
 */
export const FRISBEE_TUNING: FrisbeeTuning = FrisbeeLauncherConfig.tuning;
const STEP = 1 / 120;
const MAX_STEPS = 36;
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
/** Ownership key of a shooter ("local" / a remote session id); null = nobody. */
export type FrisbeeOwner = string | null;
/** Contact of a swept sphere: `target` = a player (touch), otherwise scenery (bounce). */
export interface FrisbeeCastHit {
    distance: number;
    point: THREE.Vector3;
    normal: THREE.Vector3;
    target?: string | null;
    headshot?: boolean;
}
/** Sphere of `radius` swept from `from` along the unit `dir` for `maxDist`; `ignore` = the shooter. */
export type FrisbeeCastFn = (from: THREE.Vector3, dir: THREE.Vector3, maxDist: number, radius: number, ignore: FrisbeeOwner) => FrisbeeCastHit | null;
export interface FrisbeeHit {
    id: number;
    owner: FrisbeeOwner;
    target: string;
    damage: number;
    headshot: boolean;
    /** m/s, world: added to the victim's velocity (2.5 horizontal + 0.8 up). */
    impulse: THREE.Vector3;
    point: THREE.Vector3;
    bounces: number;
}
export interface FrisbeeEvents {
    onHit?: (e: FrisbeeHit) => void;
    onBounce?: (id: number, point: THREE.Vector3, normal: THREE.Vector3, speed: number) => void;
    onRest?: (id: number, pos: THREE.Vector3) => void;
    onExpire?: (id: number) => void;
}
export interface FrisbeeShot {
    origin: THREE.Vector3;
    direction: THREE.Vector3;
    owner: FrisbeeOwner;
    seed?: number;
    /** Launcher roll (rad) the disc banks with at the start. */
    roll?: number;
    /** Where the VISIBLE disc starts (the launcher's deck); the simulation starts at `origin` (the eye). */
    visualFrom?: THREE.Vector3;
}
export interface FrisbeeProjectilesOptions {
    tuning?: Partial<FrisbeeTuning>;
    /** Discs alive at once (default 24). */
    max?: number;
    /** Visible disc radius (m) — default 0.1. */
    visualRadius?: number;
    /** Turns per second (default 7). */
    spin?: number;
    trail?: boolean;
    trailColor?: number;
}
/** One disc (pure simulation, no rendering). */
export class FrisbeeSim {
    pos = new THREE.Vector3();
    vel = new THREE.Vector3();
    age = 0;
    bounces = 0;
    canDamage = true;
    resting = false;
    restAge = 0;
    alive = true;
    readonly id: number;
    readonly tuning: FrisbeeTuning;
    readonly owner: FrisbeeOwner;
    constructor(id: number, shot: FrisbeeShot, tuning: FrisbeeTuning = FRISBEE_TUNING, owner: FrisbeeOwner = shot.owner) {
        this.id = id;
        this.tuning = tuning;
        this.owner = owner;
        this.pos.copy(shot.origin);
        this.vel.copy(shot.direction).normalize().multiplyScalar(tuning.speed);
    }
    /** Advance one fixed step. Returns the events of this step (hit / bounce / rest). */
    step(cast: FrisbeeCastFn, ev: FrisbeeEvents): void {
        const T = this.tuning;
        if (!this.alive)
            return;
        this.age += STEP;
        if (this.resting) {
            this.restAge += STEP;
            if (this.restAge > 0.6) {
                this.alive = false;
                ev.onExpire?.(this.id);
            }
            return;
        }
        if (this.age > T.lifetime) {
            this.alive = false;
            ev.onExpire?.(this.id);
            return;
        }
        const speed = this.vel.length();
        const lift = T.lift * Math.min(1, speed / T.speed) * (this.bounces > 0 ? 0.35 : 1);
        this.vel.y -= T.gravity * (1 - lift) * STEP;
        this.vel.multiplyScalar(Math.exp(-T.drag * STEP));
        _v.copy(this.vel).multiplyScalar(STEP);
        let len = _v.length();
        let guard = 0;
        while (len > 1e-6 && guard++ < 3) {
            _d.copy(_v).divideScalar(len);
            const hit = cast(this.pos, _d, len, T.radius, this.owner);
            if (!hit) {
                this.pos.addScaledVector(_d, len);
                break;
            }
            this.pos.addScaledVector(_d, Math.max(0, hit.distance - 1e-3));
            _n.copy(hit.normal).normalize();
            this.pos.addScaledVector(_n, 2e-3);
            const vn = this.vel.dot(_n);
            const sp = this.vel.length();
            if (hit.target != null) {
                if (this.canDamage && sp >= T.minDamageSpeed) {
                    this.canDamage = false;
                    let dmg = T.damageBody * (hit.headshot ? T.headshotMultiplier : 1) * (this.bounces > 0 ? T.bouncedDamageScale : 1);
                    dmg = Math.round(dmg);
                    const imp = new THREE.Vector3(this.vel.x, 0, this.vel.z);
                    if (imp.lengthSq() > 1e-8)
                        imp.normalize().multiplyScalar(T.knockback);
                    imp.y = T.knockbackUp;
                    ev.onHit?.({ id: this.id, owner: this.owner, target: hit.target, damage: dmg, headshot: !!hit.headshot, impulse: imp,
                        point: hit.point.clone(), bounces: this.bounces });
                }
                // bounce off the player (soft)
                if (vn < 0)
                    this.vel.addScaledVector(_n, -vn * (1 + T.playerRestitution));
                this.vel.multiplyScalar(0.6);
            }
            else {
                this.bounces++;
                if (this.bounces > T.maxBounces)
                    this.canDamage = false;
                if (vn < 0) {
                    // v = vt * friction - vn * restitution
                    _v.copy(_n).multiplyScalar(vn); // normal part
                    this.vel.sub(_v).multiplyScalar(T.friction).addScaledVector(_v, -T.restitution);
                }
                const restNow = _n.y > 0.7 && this.vel.length() < T.restSpeed;
                ev.onBounce?.(this.id, hit.point.clone(), _n.clone(), sp);
                if (restNow) {
                    this.vel.set(0, 0, 0);
                    this.resting = true;
                    this.canDamage = false;
                    ev.onRest?.(this.id, this.pos.clone());
                    return;
                }
            }
            // remaining displacement of the step with the new velocity (simple: finish next step)
            break;
        }
    }
}
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _rn = new THREE.Vector3(); // ring normal (never the sim's scratch vectors: the sim keeps using them after its events)
const _up = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _side = new THREE.Vector3();
const TRAIL_N = 14;
/**
 * Discs for everybody (local player + remote players): the simulation + the visuals. `template` = the launcher's
 * disc mesh (FrisbeeLauncherController.discTemplate): shared geometry / material, cloned per flying disc.
 */
interface LiveDisc {
    sim: FrisbeeSim;
    obj: THREE.Object3D;
    offset: THREE.Vector3;
    roll: number;
    seed: number;
    spinA: number;
    trail: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null;
    pts: THREE.Vector3[];
    lastPt: number;
    fade: number;
}
interface Ring {
    m: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
    t: number;
}
export class FrisbeeProjectiles {
    readonly tuning: FrisbeeTuning;
    group = new THREE.Group();
    private readonly events: FrisbeeEvents;
    private readonly cast: FrisbeeCastFn;
    private readonly template: THREE.Object3D;
    private readonly templateRadius: number;
    private readonly visualRadius: number;
    private readonly spin: number;
    private readonly useTrail: boolean;
    private readonly trailMat: THREE.MeshBasicMaterial;
    private readonly ringGeo: THREE.RingGeometry;
    private readonly ringMat: THREE.MeshBasicMaterial;
    private readonly rings: Ring[] = [];
    private readonly live: LiveDisc[] = [];
    private readonly max: number;
    private acc = 0;
    private nextId = 1;
    constructor(parent: THREE.Object3D, template: THREE.Object3D, cast: FrisbeeCastFn, events: FrisbeeEvents = {}, options: FrisbeeProjectilesOptions = {}) {
        this.tuning = { ...FRISBEE_TUNING, ...(options.tuning ?? {}) };
        this.cast = cast;
        this.events = events;
        this.max = options.max ?? 24;
        this.visualRadius = options.visualRadius ?? 0.1;
        this.spin = (options.spin ?? 7) * Math.PI * 2;
        this.useTrail = options.trail ?? true;
        // the template disc, recentred, no parent transform: its radius in its own units (x/z extent)
        this.template = template.clone(true);
        this.template.position.set(0, 0, 0);
        this.template.quaternion.identity();
        this.template.scale.set(1, 1, 1);
        const box = new THREE.Box3().setFromObject(this.template);
        this.templateRadius = Math.max(1e-4, Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2);
        this.trailMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(options.trailColor ?? 0xffffff), transparent: true,
            opacity: 0.2, depthWrite: false, side: THREE.DoubleSide, vertexColors: true, blending: THREE.AdditiveBlending });
        this.ringGeo = new THREE.RingGeometry(0.7, 1.0, 20);
        this.ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide });
        this.group.name = "Frisbees";
        parent.add(this.group);
    }
    get count() { return this.live.length; }
    /** Launch a disc. Returns its id (the same on every client if you pass the same shot). */
    fire(shot: FrisbeeShot): number {
        if (this.live.length >= this.max) {
            const old = this.live[0].sim;
            old.alive = false;
            this.remove(0);
            this.events.onExpire?.(old.id);
        }
        const id = this.nextId++;
        const sim = new FrisbeeSim(id, shot, this.tuning);
        const obj = this.template.clone(true);
        obj.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) {
            m.castShadow = true;
            m.frustumCulled = false;
            m.raycast = () => { };
        } });
        this.group.add(obj);
        const offset = new THREE.Vector3();
        if (shot.visualFrom)
            offset.subVectors(shot.visualFrom, shot.origin);
        let trail = null;
        if (this.useTrail) {
            const g = new THREE.BufferGeometry();
            g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(TRAIL_N * 2 * 3), 3));
            g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(TRAIL_N * 2 * 3), 3));
            const idx = [];
            for (let i = 0; i < TRAIL_N - 1; i++) {
                const a = i * 2;
                idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
            }
            g.setIndex(idx);
            trail = new THREE.Mesh(g, this.trailMat);
            trail.frustumCulled = false;
            trail.raycast = () => { };
            this.group.add(trail);
        }
        const start = (shot.visualFrom ?? shot.origin).clone();
        const pts = new Array(TRAIL_N).fill(0).map(() => start.clone());
        this.live.push({ sim, obj, offset, roll: shot.roll ?? 0, seed: shot.seed ?? id, spinA: 0, trail, pts, lastPt: 0, fade: 1 });
        this.place(this.live[this.live.length - 1], 0);
        return id;
    }
    /** Per frame. */
    update(dt: number): void {
        // fixed step, the time debt is kept (a frame hitch is caught up over the next frames, so this client's discs stay
        // on the same clock as the server's); at most MAX_STEPS per frame, debt bounded to 2 s (tab in the background)
        this.acc = Math.min(this.acc + dt, 2.0);
        let n = 0;
        while (this.acc >= STEP && n++ < MAX_STEPS) {
            this.acc -= STEP;
            for (const l of this.live)
                l.sim.step(this.cast, this.stepEvents(l));
        }
        for (let i = this.live.length - 1; i >= 0; i--) {
            const l = this.live[i];
            if (!l.sim.alive) {
                this.remove(i);
                continue;
            }
            this.place(l, dt);
        }
        for (let i = this.rings.length - 1; i >= 0; i--) {
            const r = this.rings[i];
            r.t += dt;
            const u = r.t / 0.35;
            if (u >= 1) {
                r.m.removeFromParent();
                r.m.material.dispose();
                this.rings.splice(i, 1);
                continue;
            }
            r.m.scale.setScalar(0.08 + 0.35 * u);
            r.m.material.opacity = 0.6 * (1 - u);
        }
    }
    private stepEvents(l: LiveDisc): FrisbeeEvents {
        return {
            onHit: (e) => { this.ring(e.point, _rn.copy(l.sim.vel).normalize().negate()); this.events.onHit?.(e); },
            onBounce: (id, p, n, s) => { if (s > 4)
                this.ring(p, n); this.events.onBounce?.(id, p, n, s); },
            onRest: (id, p) => this.events.onRest?.(id, p),
            onExpire: (id) => this.events.onExpire?.(id),
        };
    }
    private ring(p: THREE.Vector3, n: THREE.Vector3): void {
        const m = new THREE.Mesh(this.ringGeo, this.ringMat.clone());
        m.position.copy(p).addScaledVector(n, 0.01);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
        m.raycast = () => { };
        this.group.add(m);
        this.rings.push({ m, t: 0 });
    }
    private place(l: LiveDisc, dt: number): void {
        const s = l.sim;
        const conv = Math.exp(-s.age / 0.09);
        l.obj.position.copy(s.pos).addScaledVector(l.offset, conv);
        // orientation: disc plane banked with the launcher roll (fading), nose slightly up, wobble; spin about its axis
        if (!s.resting)
            l.spinA += this.spin * dt * Math.min(1, 0.3 + s.vel.length() / this.tuning.speed);
        const wob = s.resting ? 0 : 0.06 * Math.sin(s.age * 17 + l.seed) * Math.exp(-s.age * 0.8);
        const bank = l.roll * Math.exp(-s.age * 2.5) + wob + (s.bounces > 0 && !s.resting ? 0.35 * Math.sin(s.age * 9 + l.seed) : 0);
        _a.copy(s.vel).setY(0);
        const yaw = _a.lengthSq() > 1e-6 ? Math.atan2(-_a.x, -_a.z) : 0;
        _q.setFromAxisAngle(_up, yaw);
        _q2.setFromAxisAngle(_b.set(0, 0, 1), bank);
        _q.multiply(_q2);
        _q2.setFromAxisAngle(_b.set(1, 0, 0), s.resting ? 0 : 0.08);
        _q.multiply(_q2);
        _q2.setFromAxisAngle(_up, l.spinA);
        _q.multiply(_q2);
        l.obj.quaternion.copy(_q);
        if (s.resting)
            l.fade = Math.max(0, 1 - s.restAge / 0.6);
        else if (s.age > this.tuning.lifetime - 0.4)
            l.fade = Math.max(0, (this.tuning.lifetime - s.age) / 0.4);
        l.obj.scale.setScalar((this.visualRadius / this.templateRadius) * (0.2 + 0.8 * l.fade));
        // trail
        if (l.trail) {
            l.lastPt += dt;
            if (l.lastPt >= 0.008) {
                l.lastPt = 0;
                for (let i = TRAIL_N - 1; i > 0; i--)
                    l.pts[i].copy(l.pts[i - 1]);
            }
            l.pts[0].copy(l.obj.position);
            const pos = l.trail.geometry.attributes.position;
            const col = l.trail.geometry.attributes.color;
            const speedK = Math.min(1, s.vel.length() / this.tuning.speed);
            for (let i = 0; i < TRAIL_N; i++) {
                const p = l.pts[i];
                const q = l.pts[Math.min(i + 1, TRAIL_N - 1)];
                _a.subVectors(i === 0 ? p : l.pts[i - 1], q);
                _side.set(-_a.z, 0, _a.x);
                if (_side.lengthSq() < 1e-8)
                    _side.set(1, 0, 0);
                _side.normalize().multiplyScalar(this.visualRadius * 0.75 * (1 - i / TRAIL_N));
                pos.setXYZ(i * 2, p.x + _side.x, p.y, p.z + _side.z);
                pos.setXYZ(i * 2 + 1, p.x - _side.x, p.y, p.z - _side.z);
                const born = THREE.MathUtils.smoothstep(s.age, 0.03, 0.16); // no beam from the launcher: the trail appears in flight
                const c = (1 - i / (TRAIL_N - 1)) * speedK * l.fade * born * (s.resting ? 0 : 1);
                col.setXYZ(i * 2, c, c, c);
                col.setXYZ(i * 2 + 1, c, c, c);
            }
            pos.needsUpdate = true;
            col.needsUpdate = true;
        }
    }
    private remove(i: number): void {
        const l = this.live[i];
        l.obj.removeFromParent();
        if (l.trail) {
            l.trail.removeFromParent();
            l.trail.geometry.dispose();
        }
        this.live.splice(i, 1);
    }
    /** True while a disc with this id is flying. */
    has(id: number): boolean {
        return this.live.some((l) => l.sim.id === id);
    }
    /**
     * SERVER correction of a disc (bounce / touch): snap the simulated state. A copy that already matches the server
     * (within `tolerance` m and 0.5 m/s) is left alone (no jitter); a stale confirm (fewer bounces than the local
     * copy already did) is ignored. `spent` = the disc already touched a player (no second touch).
     */
    snap(id: number, pos: THREE.Vector3, vel: THREE.Vector3, opts: {
        bounces?: number;
        spent?: boolean;
        tolerance?: number;
    } = {}): void {
        const l = this.live.find((d) => d.sim.id === id);
        if (!l) return;
        if (opts.spent) l.sim.canDamage = false;
        if (opts.bounces !== undefined && l.sim.bounces > opts.bounces)
            return;
        if (opts.tolerance !== undefined && l.sim.pos.distanceTo(pos) < opts.tolerance && l.sim.vel.distanceTo(vel) < 0.5) {
            if (opts.bounces !== undefined)
                l.sim.bounces = opts.bounces;
            return;
        }
        l.sim.pos.copy(pos);
        l.sim.vel.copy(vel);
        l.sim.resting = false;
        if (opts.bounces !== undefined)
            l.sim.bounces = opts.bounces;
        l.offset.set(0, 0, 0);
    }
    /** SERVER end of a disc (rest / expiry): remove it (unknown ids are no-ops). */
    end(id: number): void {
        const i = this.live.findIndex((d) => d.sim.id === id);
        if (i >= 0)
            this.remove(i);
    }
    /** Fast-forward a freshly fired disc by `seconds` of fixed steps (a late server confirm), events muted (max 0.5 s). */
    catchUp(id: number, seconds: number): void {
        const l = this.live.find((d) => d.sim.id === id);
        if (!l)
            return;
        const n = Math.min(Math.floor(seconds / STEP), 60);
        for (let i = 0; i < n && l.sim.alive; i++)
            l.sim.step(this.cast, {});
        this.place(l, 0);
    }
    /** Remove every disc (round reset). */
    clear(): void {
        while (this.live.length)
            this.remove(this.live.length - 1);
        for (const r of this.rings) {
            r.m.removeFromParent();
            r.m.material.dispose();
        }
        this.rings.length = 0;
    }
    dispose(): void {
        this.clear();
        this.group.removeFromParent();
        this.trailMat.dispose();
        this.ringGeo.dispose();
        this.ringMat.dispose();
    }
}
