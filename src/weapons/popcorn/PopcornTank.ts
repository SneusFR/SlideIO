import * as THREE from "three";
import { PopcornTankSim, PState } from "./PopcornTankSim";

/** Authored tank data (the GLB `Tank` node extras → Object3D.userData). */
export interface PopcornTankData {
  halfExtents: [number, number, number];
  count: number;
  perShot: number;
  shots: number;
  popcornRadius: number;
  kernelRadius: number;
  gravityUnitsPerS2: number;
  /** [x, y, z, qx, qy, qz, qw, scale] per piece — settled FULL tank (tank-local). */
  fullLayout: number[][];
  /** Piece indices sorted bottom → top in the full layout (first `perShot` = first shot). */
  consumeOrder: number[];
  /** Settled HALF tank: surviving piece indices + their positions. */
  halfLayout: { indices: number[]; positions: number[][] };
}

export interface PopcornTankOptions {
  /** true = local first-person weapon: real-time physics. false = remote / TP: baked slots only. */
  physics: boolean;
  /** How much of the weapon's own acceleration the popcorn feels (0 = none, 1 = physical). */
  inertiaScale?: number;
  /** Clamp of the inertial acceleration, in multiples of the tank gravity. */
  maxInertiaG?: number;
}

const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 3;

// Scratch objects (no per-frame allocation).
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _wq = new THREE.Quaternion();
const _ws = new THREE.Vector3();
const _v = new THREE.Vector3();

/**
 * Three.js side of the popcorn tank: 2 InstancedMeshes (popcorn + kernels = 2 draw calls whatever
 * the fill level), fed by PopcornTankSim. The simulation runs in the Tank node's local space; the
 * effective gravity is the WORLD gravity + the weapon's own acceleration (finite differences of
 * the Tank world position — sway, recoil, running, jumping all make the popcorn move), expressed in
 * that local space. Asleep = no simulation and no instance-buffer upload.
 */
export class PopcornTank {
  readonly sim: PopcornTankSim;
  readonly data: PopcornTankData;
  readonly node: THREE.Object3D;
  readonly popcornMesh: THREE.InstancedMesh;
  readonly kernelMesh: THREE.InstancedMesh;
  physics: boolean;
  inertiaScale: number;
  maxInertiaG: number;

  /** Current effective acceleration (tank-local units/s²) — "down" for the popcorn. */
  readonly accel = new THREE.Vector3(0, -1, 0);
  private accum = 0;
  private dirty = true;
  // finite-difference state (world metres)
  private readonly prevPos = new THREE.Vector3();
  private readonly prevVel = new THREE.Vector3();
  private readonly accWorld = new THREE.Vector3();
  private fdFrames = 0;
  private readonly feed = new THREE.Vector3();

  constructor(tankNode: THREE.Object3D, options: PopcornTankOptions) {
    this.node = tankNode;
    this.data = tankNode.userData as PopcornTankData;
    if (!this.data || !this.data.fullLayout) throw new Error("PopcornTank: Tank node extras missing");
    this.physics = options.physics;
    this.inertiaScale = options.inertiaScale ?? 0.45;
    this.maxInertiaG = options.maxInertiaG ?? 2.2;
    const d = this.data;
    this.sim = new PopcornTankSim({
      halfExtents: d.halfExtents,
      capacity: d.count,
      popcornRadius: d.popcornRadius,
      kernelRadius: d.kernelRadius,
    });
    for (let i = 0; i < d.count; i++) {
      const L = d.fullLayout[i];
      this.sim.setRotation(i, L[3], L[4], L[5], L[6]);
      this.sim.baseScale[i] = L[7];
    }
    const feedNode = tankNode.getObjectByName("PopcornFeed");
    if (feedNode) this.feed.copy(feedNode.position);
    else this.feed.set(0, -d.halfExtents[1], 0);

    const popTpl = tankNode.getObjectByName("Popcorn_Template") as THREE.Mesh | undefined;
    const kerTpl = tankNode.getObjectByName("Kernel_Template") as THREE.Mesh | undefined;
    if (!popTpl?.isMesh || !kerTpl?.isMesh) throw new Error("PopcornTank: runtime templates missing");
    popTpl.visible = false;
    kerTpl.visible = false;
    // The GLB preview fill (EXT_mesh_gpu_instancing) is replaced by our own simulated instances.
    const fill = tankNode.getObjectByName("Popcorn_Fill");
    if (fill) fill.visible = false;

    this.popcornMesh = this.makeInstanced(popTpl, d.count, "PopcornInstances");
    this.kernelMesh = this.makeInstanced(kerTpl, d.count, "KernelInstances");
    tankNode.add(this.popcornMesh, this.kernelMesh);
    this.setAmmo(d.shots);
  }

  private makeInstanced(tpl: THREE.Mesh, capacity: number, name: string): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(tpl.geometry, tpl.material, capacity);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false; // lives inside a camera-locked weapon
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.raycast = () => {};
    return mesh;
  }

  /** Popcorn pieces currently in the tank. */
  get popcornCount(): number {
    return this.sim.count(PState.Popcorn);
  }

  /** Instant fill for an ammo count (0 = empty, 1 = half, 2 = full) using the baked layouts. */
  setAmmo(ammo: number): void {
    const d = this.data;
    const sim = this.sim;
    for (let i = 0; i < d.count; i++) sim.hide(i);
    if (ammo >= d.shots) {
      for (let i = 0; i < d.count; i++) {
        const L = d.fullLayout[i];
        sim.place(i, L[0], L[1], L[2], PState.Popcorn);
      }
    } else if (ammo > 0) {
      const H = d.halfLayout;
      for (let k = 0; k < H.indices.length; k++) {
        const P = H.positions[k];
        sim.place(H.indices[k], P[0], P[1], P[2], PState.Popcorn);
      }
    }
    this.dirty = true;
  }

  /**
   * A shot: the `perShot` LOWEST pieces (along the current gravity) are sucked into the feed.
   * With physics the rest falls into place; without physics they snap to the baked half layout.
   */
  consumeShot(): void {
    const d = this.data;
    const sim = this.sim;
    const ids: number[] = [];
    for (let i = 0; i < d.count; i++) if (sim.state[i] === PState.Popcorn) ids.push(i);
    const a = this.accel;
    const al = a.length() || 1;
    // project on "down": larger = lower
    ids.sort((i, j) =>
      (sim.px[j] * a.x + sim.py[j] * a.y + sim.pz[j] * a.z) / al - (sim.px[i] * a.x + sim.py[i] * a.y + sim.pz[i] * a.z) / al);
    const n = Math.min(d.perShot, ids.length);
    for (let k = 0; k < n; k++) sim.consume(ids[k]);
    if (this.physics) {
      sim.shake(1.2, -a.x / al, -a.y / al, -a.z / al);
    } else if (ids.length - n > 0) {
      // remote: survivors go to their settled half-tank slots (after the suction anim)
      const H = d.halfLayout;
      const survivors = ids.slice(n);
      for (let k = 0; k < survivors.length && k < H.positions.length; k++) {
        const P = H.positions[k];
        sim.px[survivors[k]] = sim.ox[survivors[k]] = P[0];
        sim.py[survivors[k]] = sim.oy[survivors[k]] = P[1];
        sim.pz[survivors[k]] = sim.oz[survivors[k]] = P[2];
      }
    }
    this.dirty = true;
  }

  /**
   * Free slots that kernels can use to refill the tank.
   * SlideIO fix: a piece still being sucked into the feed (Consumed, 0.35 s
   * after a shot) is free too — otherwise a reload started right after the
   * last shot only found 36 slots and refilled the tank to HALF.
   */
  freeSlots(out: number[]): number[] {
    out.length = 0;
    for (let i = 0; i < this.sim.n; i++) {
      const s = this.sim.state[i];
      if (s === PState.Hidden || s === PState.Consumed) out.push(i);
    }
    return out;
  }

  /**
   * A kernel materialises in the tank (reload). Physics: appears in the upper part of the tank and
   * drops on the pile. Remote: appears directly on its full-layout slot.
   */
  spawnKernel(slot: number): void {
    const sim = this.sim;
    const d = this.data;
    if (this.physics) {
      const [hx, hy, hz] = d.halfExtents;
      const x = (sim.rand() * 2 - 1) * (hx - 0.12);
      const z = (sim.rand() * 0.9 - 0.2) * (hz - 0.1); // biased toward the left (hand) side
      const y = hy - d.kernelRadius - sim.rand() * 0.08;
      sim.spawnKernel(slot, x, y, z, (sim.rand() - 0.5) * 0.6, -1.5 - sim.rand() * 1.5, (sim.rand() - 0.5) * 0.6);
    } else {
      const L = d.fullLayout[slot];
      sim.spawnKernel(slot, L[0], L[1] - d.popcornRadius + d.kernelRadius, L[2], 0, 0, 0);
    }
    this.dirty = true;
  }

  /** Pop one kernel into a popcorn piece. Returns false when no kernel is left. */
  popKernel(slot: number): boolean {
    const sim = this.sim;
    if (sim.state[slot] !== PState.Kernel) return false;
    if (this.physics) {
      const a = this.accel;
      const l = a.length() || 1;
      sim.pop(slot, -a.x / l, -a.y / l, -a.z / l);
    } else {
      const L = this.data.fullLayout[slot];
      sim.pop(slot, 0, 0, 0);
      sim.px[slot] = sim.ox[slot] = L[0];
      sim.py[slot] = sim.oy[slot] = L[1];
      sim.pz[slot] = sim.oz[slot] = L[2];
    }
    this.dirty = true;
    return true;
  }

  /** Remove every kernel (cancelled reload). */
  clearKernels(): void {
    for (let i = 0; i < this.sim.n; i++) if (this.sim.state[i] === PState.Kernel) this.sim.hide(i);
    this.dirty = true;
  }

  /** Random kick (lid slam, landing…). */
  shake(amount: number): void {
    if (!this.physics) return;
    const a = this.accel;
    const l = a.length() || 1;
    this.sim.shake(amount, -a.x / l, -a.y / l, -a.z / l);
  }

  /** Forget the motion history (teleport, respawn, weapon re-equip). */
  resetMotion(): void {
    this.fdFrames = 0;
    this.accWorld.set(0, 0, 0);
  }

  /** Per frame, after the weapon's world matrix is final (after ViewmodelSystem.syncCamera). */
  update(dt: number): void {
    if (dt <= 0) return;
    const sim = this.sim;
    const d = this.data;
    this.node.updateWorldMatrix(true, false);
    this.node.matrixWorld.decompose(_p, _wq, _ws);
    const unit = _ws.x || 1; // metres per tank unit (≈ 0.076 FP, ≈ 0.067 TP)

    if (this.physics) {
      // ---- weapon acceleration (world, m/s²), filtered finite differences
      if (dt > 0.1 || this.fdFrames === 0) {
        this.prevPos.copy(_p);
        this.prevVel.set(0, 0, 0);
        this.accWorld.set(0, 0, 0);
        this.fdFrames = 1;
      } else {
        _v.copy(_p).sub(this.prevPos).divideScalar(dt); // velocity
        if (_v.lengthSq() > 30 * 30) {
          this.resetMotion(); // teleport
          this.prevPos.copy(_p);
        } else {
          if (this.fdFrames >= 2) {
            const ax = (_v.x - this.prevVel.x) / dt, ay = (_v.y - this.prevVel.y) / dt, az = (_v.z - this.prevVel.z) / dt;
            const k = 1 - Math.exp(-dt / 0.045);
            this.accWorld.x += (ax - this.accWorld.x) * k;
            this.accWorld.y += (ay - this.accWorld.y) * k;
            this.accWorld.z += (az - this.accWorld.z) * k;
          }
          this.prevVel.copy(_v);
          this.prevPos.copy(_p);
          this.fdFrames++;
        }
      }
      // ---- effective acceleration in tank-local units/s²
      const G = d.gravityUnitsPerS2;
      _q.copy(_wq).invert();
      _v.set(0, -G, 0).applyQuaternion(_q); // gravity (stylized magnitude, real direction)
      _s.copy(this.accWorld).multiplyScalar(-this.inertiaScale / unit).applyQuaternion(_q);
      const lim = this.maxInertiaG * G;
      if (_s.lengthSq() > lim * lim) _s.setLength(lim);
      this.accel.copy(_v).add(_s);

      this.accum = Math.min(this.accum + dt, FIXED_DT * MAX_SUBSTEPS);
      while (this.accum >= FIXED_DT) {
        if (sim.step(FIXED_DT, this.accel.x, this.accel.y, this.accel.z, this.feed.x, this.feed.y, this.feed.z)) this.dirty = true;
        this.accum -= FIXED_DT;
      }
    } else {
      this.accel.set(0, -d.gravityUnitsPerS2, 0);
      if (sim.animate(dt, this.feed.x, this.feed.y, this.feed.z)) this.dirty = true;
    }
    if (this.dirty) this.writeInstances();
  }

  private writeInstances(): void {
    const sim = this.sim;
    let np = 0, nk = 0;
    let animating = false;
    for (let i = 0; i < sim.n; i++) {
      const s = sim.state[i];
      if (s === PState.Hidden) continue;
      _p.set(sim.px[i], sim.py[i], sim.pz[i]);
      _q.set(sim.qx[i], sim.qy[i], sim.qz[i], sim.qw[i]);
      if (s === PState.Kernel) {
        const k = sim.visualScale(i);
        if (sim.age[i] < 0.12) animating = true;
        _s.setScalar(k);
        _m.compose(_p, _q, _s);
        this.kernelMesh.setMatrixAt(nk++, _m);
      } else {
        const k = sim.visualScale(i);
        if (sim.age[i] < 0.2) animating = true;
        _s.setScalar(k);
        _m.compose(_p, _q, _s);
        this.popcornMesh.setMatrixAt(np++, _m);
      }
    }
    this.popcornMesh.count = np;
    this.kernelMesh.count = nk;
    this.popcornMesh.instanceMatrix.needsUpdate = true;
    this.kernelMesh.instanceMatrix.needsUpdate = true;
    this.dirty = animating || (this.physics && sim.awake);
  }

  dispose(): void {
    this.popcornMesh.removeFromParent();
    this.kernelMesh.removeFromParent();
    this.popcornMesh.dispose();
    this.kernelMesh.dispose();
  }
}
