import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import {
  ARM_PIVOT,
  BAND_R,
  CAP_POS,
  CordTube,
  FrisbeeHudKit,
  HIDDEN_Y,
  SEAT_LIFT,
  SLOT_Y,
} from "./frisbeeHudGeometry";

const DEG = Math.PI / 180;

/** Canvas box in PLATE pixels (the 170 × 72 plate, y down): over the badge spot, room above for the ejection. */
export const MECH_CANVAS = { x: -8, y: -10, w: 62, h: 80 } as const;

/**
 * Motion tuning (seconds / plate px / radians). Reference values of the brief:
 * impulse 30–50 ms, ejection 120–180 ms over 10–18 px, tilt 8–15°, damped
 * return of the support 160–220 ms, main motion < 350 ms.
 */
export const FRISBEE_MECH_TUNING = {
  /** Ejected disc: travel time, rise, sideways drift (left = away from the digits), toward-camera drift. */
  ejectMove: 0.15,
  ejectRise: 14,
  ejectDrift: -3.5,
  ejectToward: 2,
  /** Tilt reached during the travel and the slow precession of its axis (readability: edge + underside). */
  ejectTilt: 12 * DEG,
  ejectAxis0: 0.5,
  ejectPrecession: 0.6,
  /** Fade window: the disc stays a HUD object, it never "flies off" like the scene projectile. */
  fadeStart: 0.13,
  fadeEnd: 0.23,
  /** Arms: inward kick (rad/s) on a shot, damped return (ω, ζ) ≈ 190 ms. */
  armKick: 2.4,
  armW: 34,
  armZ: 0.62,
  /** Cords: release snap ≈ 40 ms with one small elastic overshoot; slower grab when the next disc is seated. */
  bandReleaseW: 55,
  bandReleaseZ: 0.55,
  bandGrabW: 30,
  bandGrabZ: 0.8,
  /** Stack advance: one level, one small damped settle. */
  stackW: 26,
  stackZ: 0.62,
  /** Seated disc lift into the cords. */
  seatW: 28,
  seatZ: 0.7,
  /** Refill (new cage): discs rise out of the well one after the other. */
  refillW: 22,
  refillZ: 0.72,
  refillStagger: 0.055,
} as const;

const T = FRISBEE_MECH_TUNING;
const VIEW_TARGET_Y = -6;
const CAM_FOV = 18;
/** Seen a little from above: the dished top, the yellow ring and the edge all read. */
const CAM_ELEVATION = 26 * DEG;
/** On-screen size of the mechanism vs 1 world unit = 1 plate px. */
const MECH_SCALE = 1.12;
const CAM_DIST = MECH_CANVAS.h / (2 * Math.tan((CAM_FOV / 2) * DEG)) / MECH_SCALE;
const SUBSTEP = 1 / 240;
/** At most two ejected discs at once (rapid fire / corrections): the oldest is recycled, nothing piles up. */
const MAX_EJECTS = 2;
const CORD_SAMPLES = 33;
/** Arms lean in this much (rad) while the cords hold a seated disc. */
const ARM_LOAD = 0.03;
const CAP_REL = CAP_POS.clone().sub(ARM_PIVOT);

/** Damped spring (semi-implicit Euler, sub-stepped by the caller). */
class Spring {
  x = 0;
  v = 0;
  target = 0;
  constructor(
    public w: number,
    public z: number,
  ) {}

  step(dt: number): void {
    const a = -2 * this.z * this.w * this.v - this.w * this.w * (this.x - this.target);
    this.v += a * dt;
    this.x += this.v * dt;
  }

  get settled(): boolean {
    return Math.abs(this.x - this.target) < 0.004 && Math.abs(this.v) < 0.02;
  }

  snap(to = this.target): void {
    this.target = to;
    this.x = to;
    this.v = 0;
  }
}

/** One disc of the column. Index in `slots` = level (0 = top / next to fire). */
interface Slot {
  mesh: THREE.Mesh;
  y: Spring;
  /** Represents a real disc on the weapon. */
  on: boolean;
  /** Sinking back into the well (cancelled swap / correction), hidden once inside. */
  sinking: boolean;
  /** Refill stagger: waits hidden in the well until 0. */
  delay: number;
}

interface Eject {
  mesh: THREE.Mesh;
  mat: THREE.MeshPhysicalMaterial;
  t: number;
  y0: number;
  alive: boolean;
}

const slotY = (i: number): number => (i < SLOT_Y.length ? SLOT_Y[i] : HIDDEN_Y);
const easeOut = (t: number): number => 1 - (1 - t) ** 3;
const smooth = (a: number, b: number, t: number): number => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

/**
 * The 3D launcher fork of the Frisbee plate: a turquoise / ivory fork with navy
 * cords and orange caps, the seated disc held in the cords and the short stack
 * under it rising out of the well (the cage). Real geometry, own small
 * WebGL context on its own canvas (the game renderer is never touched).
 *
 *  - created on first show; renders ON DEMAND: a rAF loop runs only while
 *    something moves, then stops (nothing runs at rest or while hidden);
 *  - fixed 240 Hz sub-steps → the same motion at any frame rate;
 *  - every reaction is driven by the HUD from REAL weapon state only
 *    (`shot()` on a disc actually thrown, `setState()` on ammo changes);
 *  - hiding (weapon switch, death) settles everything instantly: no replay;
 *  - no WebGL / context lost → `onAvailability(false)` (the plate shows its
 *    flat badge instead), restored → `onAvailability(true)`.
 */
export class FrisbeeMechanism {
  readonly canvas: HTMLCanvasElement;
  /** Debug / preview: slow-motion factor of the mechanism clock. */
  timeScale = 1;
  /** Called with false when the 3D cannot be drawn (no WebGL / context lost), true when it is back. */
  onAvailability: ((available: boolean) => void) | null = null;

  private renderer: THREE.WebGLRenderer | null = null;
  private kit: FrisbeeHudKit | null = null;
  private envTex: THREE.Texture | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(CAM_FOV, MECH_CANVAS.w / MECH_CANVAS.h, 40, 600);
  private readonly armR = new THREE.Group();
  private readonly armL = new THREE.Group();
  private readonly slots: Slot[] = [];
  private readonly ejects: Eject[] = [];
  private readonly cords: CordTube[] = [];
  /** Scene-only resources (shadow catcher) released by dispose(). */
  private readonly owned: Array<{ dispose(): void }> = [];
  private readonly cordPts: THREE.Vector3[] = Array.from({ length: CORD_SAMPLES }, () => new THREE.Vector3());
  private readonly capL = new THREE.Vector3();
  private readonly capR = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly arm = new Spring(T.armW, T.armZ);
  private readonly band = new Spring(T.bandGrabW, T.bandGrabZ);
  private readonly seat = new Spring(T.seatW, T.seatZ);

  private visible = false;
  private failed = false;
  private lost = false;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private scale = 0;
  private sizeDirty = true;
  /** Discs on the weapon (deck + hand + cage) and "a disc is seated in the cords". */
  private count: number;
  private seated = true;

  constructor(
    host: HTMLElement,
    private readonly capacity: number,
  ) {
    this.count = capacity;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "frisbee-mech";
    this.canvas.style.cssText =
      `left:${MECH_CANVAS.x}px;top:${MECH_CANVAS.y}px;width:${MECH_CANVAS.w}px;height:${MECH_CANVAS.h}px;`;
    host.appendChild(this.canvas);
    window.addEventListener("resize", this.onResize);
    document.addEventListener("visibilitychange", this.onPageVisibility);
  }

  /** True when the 3D is actually drawn (created, context alive). */
  get available(): boolean {
    return this.renderer !== null && !this.lost;
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) {
      if (!this.ensure()) return;
      this.settleAll(); // a weapon switch never replays an old reaction
      this.sizeDirty = true;
      this.render();
    } else {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.settleAll();
    }
  }

  /**
   * Real ammo state. `count` = discs on the weapon, `seated` = a disc sits in
   * the cords (the deck is loaded). More discs → they rise out of the well
   * (a new cage); fewer WITHOUT a shot (cancelled swap / server correction) →
   * they sink back in. `instant` = no motion (respawn, first sync).
   */
  setState(count: number, seated: boolean, instant = false): void {
    const n = Math.max(0, Math.min(this.capacity, Math.round(count)));
    const s = seated && n > 0;
    if (n === this.count && s === this.seated && !instant) return;
    this.count = n;
    this.seated = s;
    if (!this.renderer) return; // applied when the scene is built
    this.applyState(instant || !this.visible);
  }


  /**
   * A disc was REALLY thrown: the seated disc leaves the cords (a local HUD
   * object: short rise, tilt + precession, fade — never a scene projectile),
   * the cords snap, the arms rebound a little and the column moves up one
   * level. Call BEFORE the matching setState(). Rapid fire is capped: at most
   * MAX_EJECTS discs are alive (the oldest is recycled) and the arm kick is
   * clamped, so nothing accumulates or restarts abruptly.
   */
  shot(): void {
    if (!this.renderer || !this.visible || this.lost) return;
    const top = this.slots[0];
    if (!top.on) return;
    let e = this.ejects.find((x) => !x.alive);
    if (!e) e = this.ejects.reduce((a, b) => (a.t >= b.t ? a : b));
    e.alive = true;
    e.t = 0;
    e.y0 = top.mesh.position.y;
    e.mesh.position.copy(top.mesh.position);
    e.mesh.quaternion.identity();
    e.mat.opacity = 1;
    e.mesh.visible = true;
    // The column advances one level; the other springs keep their motion (no restart on spam).
    top.on = false;
    top.sinking = false;
    top.delay = 0;
    top.y.snap(HIDDEN_Y);
    top.mesh.visible = false;
    this.slots.push(this.slots.shift()!);
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.on) continue;
      s.y.w = T.stackW;
      s.y.z = T.stackZ;
      s.y.target = slotY(i);
    }
    this.band.w = T.bandReleaseW;
    this.band.z = T.bandReleaseZ;
    this.band.target = 0;
    this.seat.snap(0);
    this.arm.target = 0;
    this.arm.v = Math.max(this.arm.v - T.armKick, -T.armKick * 1.25);
    this.seated = false;
    this.count = Math.max(0, this.count - 1);
    this.wake();
  }

  dispose(): void {
    this.stopLoop();
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("visibilitychange", this.onPageVisibility);
    for (const e of this.ejects) e.mat.dispose();
    for (const c of this.cords) c.dispose();
    for (const o of this.owned) o.dispose();
    this.kit?.dispose();
    this.envTex?.dispose();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
    }
    this.renderer = null;
    this.kit = null;
    this.canvas.remove();
  }

  // ------------------------------------------------------------------
  // Scene
  // ------------------------------------------------------------------

  /** Lazy creation (first show). false = no WebGL: the plate keeps its flat badge. */
  private ensure(): boolean {
    if (this.renderer) return !this.lost;
    if (this.failed) return false;
    let r: THREE.WebGLRenderer;
    try {
      r = new THREE.WebGLRenderer({
        canvas: this.canvas,
        alpha: true,
        antialias: true,
        premultipliedAlpha: true,
        powerPreference: "low-power",
      });
    } catch {
      this.failed = true;
      this.onAvailability?.(false);
      return false;
    }
    r.setPixelRatio(1);
    r.setClearColor(0x000000, 0);
    r.toneMapping = THREE.NeutralToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    this.canvas.addEventListener("webglcontextlost", (ev) => {
      ev.preventDefault();
      this.lost = true;
      this.stopLoop();
      this.onAvailability?.(false);
    });
    this.canvas.addEventListener("webglcontextrestored", () => {
      this.lost = false;
      this.sizeDirty = true;
      this.scale = 0;
      this.onAvailability?.(true);
      this.settleAll();
      if (this.visible) this.render();
    });
    this.renderer = r;
    this.build(r);
    this.applyState(true);
    this.onAvailability?.(true);
    return true;
  }


  private build(r: THREE.WebGLRenderer): void {
    const kit = (this.kit = new FrisbeeHudKit());
    // Soft studio reflections (very low): the satin plastic reads as plastic, never as chrome.
    const pmrem = new THREE.PMREMGenerator(r);
    const room = new RoomEnvironment();
    this.envTex = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    this.scene.environment = this.envTex;
    this.scene.environmentIntensity = 0.3;

    // One warm key light from the upper left / front (same side as the plate's hard drop shadows) + a cool fill.
    const key = new THREE.DirectionalLight(0xfff3e2, 2.3);
    const target = new THREE.Object3D();
    target.position.set(0, VIEW_TARGET_Y, 0);
    key.target = target;
    key.position.set(-0.34, 0.62, 0.71).normalize().multiplyScalar(140).add(target.position);
    key.castShadow = true;
    key.shadow.mapSize.set(512, 512);
    const sc = key.shadow.camera;
    sc.left = -42;
    sc.right = 42;
    sc.top = 42;
    sc.bottom = -42;
    sc.near = 40;
    sc.far = 260;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.35;
    key.shadow.radius = 2;
    this.scene.add(key, target, new THREE.HemisphereLight(0xdff4ff, 0x4a3426, 0.55));

    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D = this.scene): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };
    add(kit.well, kit.plastic);
    add(kit.handle, kit.plastic);
    add(kit.pommel, kit.capPlastic).position.set(0, -27.2, 0);
    this.armR.position.copy(ARM_PIVOT);
    this.armL.position.set(-ARM_PIVOT.x, ARM_PIVOT.y, 0);
    this.armL.scale.x = -1; // mirrored copy (three flips the winding for negative determinants)
    for (const g of [this.armR, this.armL]) {
      add(kit.arm, kit.plastic, g);
      add(kit.cap, kit.capPlastic, g).position.copy(CAP_REL);
      this.scene.add(g);
    }
    for (let i = 0; i < this.capacity; i++) {
      const mesh = add(kit.disc, kit.plastic);
      mesh.position.y = HIDDEN_Y;
      mesh.visible = false;
      this.slots.push({ mesh, y: new Spring(T.stackW, T.stackZ), on: false, sinking: false, delay: 0 });
    }
    for (let i = 0; i < MAX_EJECTS; i++) {
      const mat = kit.ejectMaterial();
      const mesh = new THREE.Mesh(kit.disc, mat);
      mesh.visible = false;
      mesh.renderOrder = 2;
      this.scene.add(mesh);
      this.ejects.push({ mesh, mat, t: 0, y0: 0, alive: false });
    }
    // ONE continuous elastic band: left cap → around the back of the seated disc → right cap.
    const cord = new CordTube(CORD_SAMPLES, 0.8);
    add(cord.geometry, kit.cord).frustumCulled = false;
    this.cords.push(cord);
    // Discreet contact shadow on the plate behind the mechanism (shadow only, otherwise transparent).
    const catcher = new THREE.Mesh(
      new THREE.PlaneGeometry(64, 76),
      new THREE.ShadowMaterial({ color: 0x08070c, opacity: 0.16 }),
    );
    catcher.position.set(0, VIEW_TARGET_Y, -16.5);
    catcher.receiveShadow = true;
    this.scene.add(catcher);
    this.owned.push(catcher.geometry, catcher.material as THREE.Material);

    this.camera.position.set(0, VIEW_TARGET_Y + CAM_DIST * Math.sin(CAM_ELEVATION), CAM_DIST * Math.cos(CAM_ELEVATION));
    this.camera.lookAt(0, VIEW_TARGET_Y, 0);
  }


  // ------------------------------------------------------------------
  // State → targets
  // ------------------------------------------------------------------

  /**
   * Retarget every spring on the real state. Discs that appear rise out of
   * the well one after the other (new cage); discs that vanish without a shot
   * sink back in. instant = snap everything (respawn, hidden, first build).
   */
  private applyState(instant: boolean): void {
    const n = this.count;
    let k = 0;
    let refill = false;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const want = i < n;
      const ty = want ? slotY(i) : HIDDEN_Y;
      if (instant) {
        s.on = want;
        s.sinking = false;
        s.delay = 0;
        s.y.snap(ty);
        continue;
      }
      if (want && !s.on) {
        s.on = true;
        refill = true;
        if (!s.sinking) s.y.snap(HIDDEN_Y); // comes out of the well
        s.sinking = false;
        s.delay = i < SLOT_Y.length ? T.refillStagger * k++ : 0;
        s.y.w = T.refillW;
        s.y.z = T.refillZ;
      } else if (!want && s.on) {
        s.on = false;
        s.sinking = true;
        s.delay = 0;
        s.y.w = T.refillW;
        s.y.z = T.refillZ;
      }
      s.y.target = ty;
    }
    // A new cage under discs already shown: the column takes ONE small push from below.
    if (refill) {
      for (const s of this.slots) {
        if (s.on && s.delay <= 0 && Math.abs(s.y.x - s.y.target) < 0.2 && s.y.target > HIDDEN_Y) s.y.v += 32;
      }
    }
    const seatT = this.seated ? 1 : 0;
    const armT = this.seated ? ARM_LOAD : 0;
    if (instant) {
      this.seat.snap(seatT);
      this.band.snap(seatT);
      this.arm.snap(armT);
      for (const e of this.ejects) {
        e.alive = false;
        e.mesh.visible = false;
      }
      this.acc = 0;
      return;
    }
    if (this.seat.target !== seatT) {
      this.seat.target = seatT;
      this.band.w = seatT ? T.bandGrabW : T.bandReleaseW;
      this.band.z = seatT ? T.bandGrabZ : T.bandReleaseZ;
      this.band.target = seatT;
    }
    this.arm.target = armT;
    this.wake();
  }

  /** Weapon switch / hide / context restored: everything at rest on the current state, no replay. */
  private settleAll(): void {
    if (!this.renderer) return;
    this.applyState(true);
  }

  // ------------------------------------------------------------------
  // Loop (on demand)
  // ------------------------------------------------------------------

  private wake(): void {
    if (this.raf || !this.visible || this.lost || !this.renderer || document.hidden) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private readonly loop = (now: number): void => {
    this.raf = 0;
    if (!this.visible || this.lost) return;
    const dt = Math.min((now - this.last) / 1000, 0.1) * this.timeScale;
    this.last = now;
    this.acc += dt;
    while (this.acc >= SUBSTEP) {
      this.step(SUBSTEP);
      this.acc -= SUBSTEP;
    }
    const moving = this.moving();
    if (!moving) this.restAll();
    this.render();
    if (moving && !document.hidden) this.raf = requestAnimationFrame(this.loop);
  };

  private step(h: number): void {
    this.arm.step(h);
    this.band.step(h);
    this.seat.step(h);
    for (const s of this.slots) {
      if (s.delay > 0) {
        s.delay -= h;
        continue;
      }
      s.y.step(h);
      if (s.sinking && s.y.x <= HIDDEN_Y + 0.3) {
        s.sinking = false;
        s.y.snap(HIDDEN_Y);
      }
    }
    for (const e of this.ejects) {
      if (!e.alive) continue;
      e.t += h;
      if (e.t >= T.fadeEnd) {
        e.alive = false;
        e.mesh.visible = false;
      }
    }
  }

  private moving(): boolean {
    if (!this.arm.settled || !this.band.settled || !this.seat.settled) return true;
    for (const e of this.ejects) if (e.alive) return true;
    for (const s of this.slots) if (s.delay > 0 || s.sinking || !s.y.settled) return true;
    return false;
  }

  /** Motion over: land exactly on the targets (no residual drift between two events). */
  private restAll(): void {
    this.arm.snap();
    this.band.snap();
    this.seat.snap();
    for (const s of this.slots) s.y.snap();
    this.acc = 0;
  }


  // ------------------------------------------------------------------
  // Pose + draw
  // ------------------------------------------------------------------

  private pose(): void {
    // Arms: rotation about Z at the pivot; positive = lean inward (toward the axis). Left arm is mirrored.
    const a = this.arm.x;
    this.armR.rotation.z = a;
    this.armL.rotation.z = -a;
    // Discs: the top one lifts into the cords when seated.
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const show = (s.on || s.sinking) && s.delay <= 0 && s.y.x > HIDDEN_Y + 0.05;
      s.mesh.visible = show;
      if (!show) continue;
      s.mesh.position.set(0, s.y.x + (i === 0 && s.on ? SEAT_LIFT * this.seat.x : 0), 0);
    }
    this.poseEjects();
    this.poseCords();
  }

  /** Ejected disc: ease-out rise + drift, tilt toward the camera with a slow precession, then a short fade. */
  private poseEjects(): void {
    for (const e of this.ejects) {
      if (!e.alive) continue;
      const u = easeOut(Math.min(1, e.t / T.ejectMove));
      e.mesh.position.set(T.ejectDrift * u, e.y0 + T.ejectRise * u, T.ejectToward * u);
      const ang = T.ejectAxis0 + T.ejectPrecession * u;
      this.axis.set(Math.cos(ang), 0, Math.sin(ang));
      e.mesh.quaternion.setFromAxisAngle(this.axis, T.ejectTilt * u);
      const fade = 1 - smooth(T.fadeStart, T.fadeEnd, e.t);
      e.mat.opacity = fade;
      e.mat.depthWrite = fade > 0.98;
    }
  }

  /**
   * Cords: one navy band from the left cap, across the FRONT of the seated
   * disc's edge (navy on orange: always readable), to the right cap.
   * band = 1 → holding the disc; band = 0 → straight between the caps
   * (released), the spring overshoot giving one tiny elastic flick. The band
   * follows the caps (arm rotation).
   */
  private poseCords(): void {
    const capW = (g: THREE.Group, out: THREE.Vector3) => out.copy(CAP_REL).multiply(g.scale).applyEuler(g.rotation).add(g.position);
    capW(this.armL, this.capL);
    capW(this.armR, this.capR);
    const top = this.slots[0];
    const discY = top.mesh.position.y - 0.1; // widest point of the rim
    const b = this.band.x;
    const half = (CORD_SAMPLES - 1) / 2;
    for (let i = 0; i < CORD_SAMPLES; i++) {
      // u: 0 = left cap → 1 = right cap, across the FRONT of the disc (z > 0).
      const u = i / (CORD_SAMPLES - 1);
      const p = this.cordPts[i];
      // straight line between the caps, sagging slightly
      const sx = this.capL.x + (this.capR.x - this.capL.x) * u;
      const sy = this.capL.y + (this.capR.y - this.capL.y) * u - Math.sin(Math.PI * u) * 1.2;
      // holding path: cap → onto the rim → around the front edge
      const th = Math.PI * (1 - u); // π (left) → 0 (right)
      const wx = Math.cos(th) * BAND_R;
      const wz = Math.sin(th) * BAND_R * 0.92;
      const edge = Math.min(1, Math.abs(i - half) / half);
      const toCap = smooth(0.78, 1, edge);
      const capP = u < 0.5 ? this.capL : this.capR;
      const wxx = wx + (capP.x - wx) * toCap;
      const wy = discY + (capP.y - discY) * toCap;
      const wzz = wz * (1 - toCap);
      p.set(sx + (wxx - sx) * b, sy + (wy - sy) * b, wzz * b);
    }
    this.cords[0].update(this.cordPts);
  }

  private render(): void {
    const r = this.renderer;
    if (!r || this.lost || !this.visible) return;
    if (this.sizeDirty) this.resize(r);
    this.pose();
    r.render(this.scene, this.camera);
  }

  /** Backing store = CSS size × the real on-screen scale (HUD zoom × devicePixelRatio), capped. */
  private resize(r: THREE.WebGLRenderer): void {
    this.sizeDirty = false;
    const rect = this.canvas.getBoundingClientRect();
    const zoom = rect.width > 0 ? rect.width / MECH_CANVAS.w : 1;
    const s = Math.min(4, Math.max(1, zoom * (window.devicePixelRatio || 1)));
    if (Math.abs(s - this.scale) < 0.01) return;
    this.scale = s;
    r.setSize(Math.round(MECH_CANVAS.w * s), Math.round(MECH_CANVAS.h * s), false);
  }

  private readonly onResize = (): void => {
    this.sizeDirty = true;
    if (this.visible && !this.raf) this.render();
  };

  private readonly onPageVisibility = (): void => {
    if (document.hidden) {
      this.stopLoop();
      return;
    }
    // Back on the page: anything that was mid-motion lands at rest (no catch-up burst).
    if (this.visible && this.renderer && !this.lost) {
      this.restAll();
      for (const e of this.ejects) {
        e.alive = false;
        e.mesh.visible = false;
      }
      this.render();
    }
  };
}

