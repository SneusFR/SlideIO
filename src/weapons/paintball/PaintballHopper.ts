import * as THREE from "three";
import { PaintballHopperSim, BState } from "./PaintballHopperSim";

/** Authored hopper data (the GLB `Hopper` node extras → Object3D.userData). */
export interface PaintballHopperData {
  capacity: number;
  ballRadius: number;
  innerRadius: number;
  xMin: number;
  xMax: number;
  feedX: number;
  vSlope: number;
  /** Paint colours (linear RGB) — one per ball colour index. */
  palette: number[][];
  /** Colour index of each ball slot. */
  colors: number[];
  /** layouts[n] = hopper-local [x, y, z] of each slot (null = empty) with n balls left, settled. */
  layouts: (number[] | null)[][];
}

export interface PaintballHopperOptions {
  /** true = local first-person weapon: real-time physics. false = remote / TP: baked layouts only. */
  physics: boolean;
  /** How much of the weapon's own acceleration the balls feel (0 = none, 1 = physical). */
  inertiaScale?: number;
  /** Clamp of the inertial acceleration, in g. */
  maxInertiaG?: number;
}

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 3;
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _wq = new THREE.Quaternion();
const _ws = new THREE.Vector3();
const _v = new THREE.Vector3();
const _c = new THREE.Color();

/**
 * Three.js side of the paintball hopper: ONE InstancedMesh (all balls, per-instance colour) fed by
 * PaintballHopperSim. The simulation runs in the Hopper node's local space; the effective gravity is the WORLD
 * gravity + the weapon's own acceleration (finite differences of the hopper world position — sway, recoil,
 * running, jumping, the reload swing all make the balls roll), expressed in that local space.
 * Asleep = no simulation and no instance-buffer upload.
 */
export class PaintballHopper {
  readonly sim: PaintballHopperSim;
  readonly data: PaintballHopperData;
  readonly node: THREE.Object3D;
  readonly ballMesh: THREE.InstancedMesh;
  physics: boolean;
  inertiaScale: number;
  maxInertiaG: number;
  /** Current effective acceleration (hopper-local units/s²) — "down" for the balls. */
  readonly accel = new THREE.Vector3(0, -1, 0);
  /** Hopper world velocity (m/s), filtered — used for the dropped-hopper throw. */
  readonly worldVelocity = new THREE.Vector3();
  private accum = 0;
  private dirty = true;
  private readonly prevPos = new THREE.Vector3();
  private readonly prevVel = new THREE.Vector3();
  private readonly accWorld = new THREE.Vector3();
  private fdFrames = 0;

  constructor(hopperNode: THREE.Object3D, options: PaintballHopperOptions) {
    this.node = hopperNode;
    this.data = hopperNode.userData as PaintballHopperData;
    if (!this.data || !this.data.layouts) throw new Error("PaintballHopper: Hopper node extras missing");
    this.physics = options.physics;
    this.inertiaScale = options.inertiaScale ?? 0.5;
    this.maxInertiaG = options.maxInertiaG ?? 2.5;
    const d = this.data;
    this.sim = new PaintballHopperSim({
      capacity: d.capacity, ballRadius: d.ballRadius, innerRadius: d.innerRadius,
      xMin: d.xMin, xMax: d.xMax, feedX: d.feedX, vSlope: d.vSlope,
    });
    const tpl = hopperNode.getObjectByName("Ball_Template") as THREE.Mesh | undefined;
    if (!tpl?.isMesh) throw new Error("PaintballHopper: Ball_Template missing");
    tpl.visible = false;
    const fill = hopperNode.getObjectByName("Ball_Fill");
    if (fill) fill.visible = false;                       // GLB preview fill, replaced by our instances
    const mesh = new THREE.InstancedMesh(tpl.geometry, tpl.material, d.capacity);
    mesh.name = "PaintballInstances";
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.raycast = () => {};
    this.ballMesh = mesh;
    hopperNode.add(mesh);
    this.setAmmo(d.capacity);
  }

  /** Balls currently in the hopper. */
  get ballCount(): number {
    return this.sim.count(BState.Active);
  }

  /** Paint colour of slot i (linear RGB, for the projectile / splat of the ball that was fed). */
  colorOf(slot: number, out: THREE.Color): THREE.Color {
    const c = this.data.palette[this.data.colors[slot] ?? 0];
    return out.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
  }

  /** Instant fill with the settled layout for n balls (0..capacity). */
  setAmmo(n: number): void {
    const d = this.data;
    const L = d.layouts[Math.max(0, Math.min(d.capacity, Math.round(n)))];
    for (let i = 0; i < d.capacity; i++) {
      const P = L[i];
      if (P) this.sim.place(i, P[0], P[1], P[2]); else this.sim.hide(i);
    }
    this.dirty = true;
  }

  /**
   * A shot: the ball nearest to the feed is sucked in. Returns its slot (-1 when empty) so the caller can
   * colour the projectile / splat. Physics: the others roll into the gap; remote: they snap to the baked layout.
   */
  feedOne(): number {
    const sim = this.sim;
    const i = sim.nearestToFeed(this.accel.x, this.accel.y, this.accel.z);
    if (i < 0) return -1;
    sim.feed(i);
    if (this.physics) {
      const a = this.accel, l = a.length() || 1;
      sim.shake(0.35, -a.x / l, -a.y / l, -a.z / l);
    } else {
      const n = sim.count(BState.Active);
      const L = this.data.layouts[n];
      for (let k = 0; k < sim.n; k++) {
        if (sim.state[k] !== BState.Active) continue;
        const P = L[k];
        if (P) { sim.px[k] = sim.ox[k] = P[0]; sim.py[k] = sim.oy[k] = P[1]; sim.pz[k] = sim.oz[k] = P[2]; }
      }
    }
    this.dirty = true;
    return i;
  }

  /** Random kick (slap, seating, landing…). */
  shake(amount: number): void {
    if (!this.physics) return;
    const a = this.accel, l = a.length() || 1;
    this.sim.shake(amount, -a.x / l, -a.y / l, -a.z / l);
  }

  /** Forget the motion history (teleport, respawn, re-equip, the hopper swap). */
  resetMotion(): void {
    this.fdFrames = 0;
    this.accWorld.set(0, 0, 0);
    this.worldVelocity.set(0, 0, 0);
  }

  /** Per frame, after the weapon's world matrix is final (after ViewmodelSystem.syncCamera). */
  update(dt: number): void {
    if (dt <= 0) return;
    const sim = this.sim;
    this.node.updateWorldMatrix(true, false);
    this.node.matrixWorld.decompose(_p, _wq, _ws);
    const unit = _ws.x;                                            // metres per hopper unit (0 while hidden)
    if (unit < 1e-6) { this.fdFrames = 0; return; }                // hidden during the swap: nothing to do
    // world velocity / acceleration (filtered finite differences) — also used for the drop throw
    if (dt > 0.1 || this.fdFrames === 0) {
      this.prevPos.copy(_p); this.prevVel.set(0, 0, 0); this.accWorld.set(0, 0, 0); this.worldVelocity.set(0, 0, 0);
      this.fdFrames = 1;
    } else {
      _v.copy(_p).sub(this.prevPos).divideScalar(dt);
      if (_v.lengthSq() > 30 * 30) {
        this.resetMotion(); this.prevPos.copy(_p);
      } else {
        this.worldVelocity.lerp(_v, 1 - Math.exp(-dt / 0.03));
        if (this.fdFrames >= 2) {
          const k = 1 - Math.exp(-dt / 0.045);
          this.accWorld.x += ((_v.x - this.prevVel.x) / dt - this.accWorld.x) * k;
          this.accWorld.y += ((_v.y - this.prevVel.y) / dt - this.accWorld.y) * k;
          this.accWorld.z += ((_v.z - this.prevVel.z) / dt - this.accWorld.z) * k;
        }
        this.prevVel.copy(_v); this.prevPos.copy(_p); this.fdFrames++;
      }
    }
    if (this.physics) {
      const G = 9.81 / unit;                                       // physical gravity in hopper units
      _q.copy(_wq).invert();
      _v.set(0, -G, 0).applyQuaternion(_q);
      _s.copy(this.accWorld).multiplyScalar(-this.inertiaScale / unit).applyQuaternion(_q);
      const lim = this.maxInertiaG * G;
      if (_s.lengthSq() > lim * lim) _s.setLength(lim);
      this.accel.copy(_v).add(_s);
      this.accum = Math.min(this.accum + dt, FIXED_DT * MAX_SUBSTEPS);
      while (this.accum >= FIXED_DT) {
        if (sim.step(FIXED_DT, this.accel.x, this.accel.y, this.accel.z)) this.dirty = true;
        this.accum -= FIXED_DT;
      }
    } else {
      this.accel.set(0, -9.81 / unit, 0);
      if (sim.animate(dt)) this.dirty = true;
    }
    if (this.dirty) this.writeInstances();
  }

  private writeInstances(): void {
    const sim = this.sim;
    const r = this.data.ballRadius;
    let n = 0, animating = false;
    for (let i = 0; i < sim.n; i++) {
      const s = sim.state[i];
      if (s === BState.Hidden) continue;
      if (s === BState.Fed) animating = true;
      _p.set(sim.px[i], sim.py[i], sim.pz[i]);
      _q.set(sim.qx[i], sim.qy[i], sim.qz[i], sim.qw[i]);
      _s.setScalar(r * sim.visualScale(i));
      this.ballMesh.setMatrixAt(n, _m.compose(_p, _q, _s));
      this.ballMesh.setColorAt(n, this.colorOf(i, _c));
      n++;
    }
    this.ballMesh.count = n;
    this.ballMesh.instanceMatrix.needsUpdate = true;
    if (this.ballMesh.instanceColor) this.ballMesh.instanceColor.needsUpdate = true;
    this.dirty = animating || (this.physics && sim.awake);
  }

  /** Copy of the current balls (for the dropped hopper): an InstancedMesh frozen in hopper-local space. */
  snapshotBalls(): THREE.InstancedMesh | null {
    const n = this.ballMesh.count;
    if (n === 0) return null;
    const m = new THREE.InstancedMesh(this.ballMesh.geometry, this.ballMesh.material, n);
    m.name = "DroppedPaintballs";
    for (let k = 0; k < n; k++) {
      this.ballMesh.getMatrixAt(k, _m); m.setMatrixAt(k, _m);
      this.ballMesh.getColorAt(k, _c); m.setColorAt(k, _c);
    }
    m.frustumCulled = false;
    m.raycast = () => {};
    return m;
  }

  dispose(): void {
    this.ballMesh.removeFromParent();
    this.ballMesh.dispose();
  }
}
