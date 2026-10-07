import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GRAIN_VARIANTS, LID_D, LID_HINGE, LID_T, LID_TOP_Y, PopcornHudKit, WIN } from "./popcornHudGeometry";
import {
  FLIGHTS,
  FLIGHT_END,
  JUMP_SCALE,
  LAYER,
  LOAD_PITCH,
  LOAD_Y0,
  MAX_JUMPS,
  MECH_CANVAS,
  MECH_SCALE,
  POPCORN_MECH_TUNING as T,
  REST_SCALE,
  Spring,
  VIEW_TARGET_Y,
  flightHeight,
} from "./popcornMotion";

const DEG = Math.PI / 180;
const CAM_FOV = 18;
/** Seen a little from above: the window, the heap and the lid all read. */
const CAM_ELEVATION = 20 * DEG;
const CAM_DIST = MECH_CANVAS.h / (2 * Math.tan((CAM_FOV / 2) * DEG)) / MECH_SCALE;
const SUBSTEP = 1 / 240;
/** The lid never tilts more than this on a shot (rapid fire restarts the kick, it never stacks). */
const TILT_MAX = 12 * DEG;

/** One resting grain of a real load. Index in `loads` = load (0 = bottom). */
interface GrainSlot {
  mesh: THREE.Mesh;
  /** Scale 0..1 (pop-in / quick shrink). */
  s: Spring;
  /** Pop-in stagger: waits (invisible) until 0. */
  delay: number;
}

/**
 * The 3D mini popcorn machine of the Popcorn plate: a red satin frame, an
 * ivory base, a transparent window with one heap of grains per REAL load and
 * a hinged red lid. Own small WebGL context on its own canvas (the game
 * renderer is never touched).
 *
 *  - created on first show; renders ON DEMAND: a rAF loop runs only while
 *    something moves, then stops (nothing runs at rest or while hidden);
 *  - fixed 240 Hz sub-steps → the same motion at any frame rate;
 *  - every reaction is driven by the HUD from REAL weapon data only:
 *    `shot()` on a shot actually fired, `setState()` on real ammo / reload;
 *  - a shot = a local impulse of the miniature, one damped tilt of the lid
 *    and 3 pooled grains that jump out of the lid and fall back INTO it
 *    (never into the window: a falling grain can not read as an ammo gain);
 *  - hiding (weapon switch, death) settles everything instantly: no replay;
 *  - no WebGL / context lost → `onAvailability(false)` (the plate keeps its
 *    flat badge), restored → `onAvailability(true)`.
 */
export class PopcornMechanism {
  readonly canvas: HTMLCanvasElement;
  /** Debug / preview: slow-motion factor of the mechanism clock. */
  timeScale = 1;
  /** Called with false when the 3D cannot be drawn (no WebGL / context lost), true when it is back. */
  onAvailability: ((available: boolean) => void) | null = null;

  private renderer: THREE.WebGLRenderer | null = null;
  private kit: PopcornHudKit | null = null;
  private envTex: THREE.Texture | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(CAM_FOV, MECH_CANVAS.w / MECH_CANVAS.h, 40, 600);
  private readonly machine = new THREE.Group();
  private readonly lid = new THREE.Group();
  private readonly loads: GrainSlot[][] = [];
  private readonly jumpers: THREE.Mesh[] = [];
  private readonly kick = new Spring(T.kickW, T.kickZ);
  private readonly tilt = new Spring(T.lidW, T.lidZ);
  private readonly open = new Spring(T.lidOpenW, T.lidOpenZ);

  private visible = false;
  private failed = false;
  private lost = false;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private scale = 0;
  private sizeDirty = true;
  /** Seconds since the last real shot, -1 = no grain in the air. */
  private flightT = -1;
  /** Real loads on the weapon and "the weapon is really reloading". */
  private count: number;
  private reloading = false;

  constructor(
    host: HTMLElement,
    private readonly capacity: number,
  ) {
    this.count = capacity;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "popcorn-mech";
    this.canvas.style.cssText = `left:${MECH_CANVAS.x}px;top:${MECH_CANVAS.y}px;width:${MECH_CANVAS.w}px;height:${MECH_CANVAS.h}px;`;
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
      this.stopLoop();
      this.settleAll();
    }
  }

  /**
   * Real weapon state: `count` = loads left in the machine, `reloading` = the
   * weapon is really reloading (the lid opens). More loads → they pop in
   * (reload refill); fewer WITHOUT a shot (cancelled reload / server
   * correction) → they shrink away. `instant` = no motion (respawn, first sync).
   */
  setState(count: number, reloading: boolean, instant = false): void {
    const n = Math.max(0, Math.min(this.capacity, Math.round(count)));
    if (n === this.count && reloading === this.reloading && !instant) return;
    this.count = n;
    this.reloading = reloading;
    if (!this.renderer) return; // applied when the scene is built
    this.applyState(instant || !this.visible);
  }

  /**
   * A shot was REALLY fired. Call BEFORE the matching setState(). One impulse
   * of the miniature, one tilt of the lid, 3 pooled grains. A new shot
   * restarts the same motion (springs keep their value, grains restart from
   * the lid): nothing accumulates, nothing grows with the fire rate.
   */
  shot(): void {
    if (!this.renderer || !this.visible || this.lost) return;
    this.kick.v = T.kickV;
    this.tilt.v = T.lidKick;
    this.tilt.x = Math.min(this.tilt.x, TILT_MAX * 0.6);
    this.flightT = 0;
    this.wake();
  }

  dispose(): void {
    this.stopLoop();
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("visibilitychange", this.onPageVisibility);
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
    const kit = (this.kit = new PopcornHudKit());
    // Soft studio reflections (very low): satin plastic, never chrome.
    const pmrem = new THREE.PMREMGenerator(r);
    const room = new RoomEnvironment();
    this.envTex = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    this.scene.environment = this.envTex;
    this.scene.environmentIntensity = 0.3;

    // One warm key light from the upper left / front (same side as the plate's hard drop shadows) + a cool fill.
    const key = new THREE.DirectionalLight(0xfff3e2, 2.3);
    key.position.set(-0.34, 0.62, 0.71).normalize().multiplyScalar(140);
    this.scene.add(key, new THREE.HemisphereLight(0xdff4ff, 0x4a3426, 0.6), this.machine);

    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D = this.machine): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      parent.add(m);
      return m;
    };
    add(kit.base, kit.ivory).position.set(0, WIN.y0 - 3, 0);
    add(kit.rim, kit.red).position.set(0, WIN.y0 + WIN.h + 1.3, 0);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) add(kit.post, kit.red).position.set(sx * 12.7, WIN.y0 + WIN.h / 2, sz * 8.4);
    }
    // Hinged lid: the group sits on the hinge (back edge), the box extends toward the camera.
    this.lid.position.copy(LID_HINGE);
    this.machine.add(this.lid);
    add(kit.lid, kit.red, this.lid).position.set(0, LID_T / 2, LID_D / 2);
    add(kit.knob, kit.red, this.lid).position.set(-11, LID_T, LID_D / 2);

    // Grains of the real loads (resting, scaled by their own spring).
    const span = WIN.h - 2 * LOAD_Y0 - 3;
    const pitch = this.capacity > 1 ? Math.min(LOAD_PITCH, span / (this.capacity - 1)) : LOAD_PITCH;
    for (let i = 0; i < this.capacity; i++) {
      const row: GrainSlot[] = [];
      for (let k = 0; k < LAYER.length; k++) {
        const [x, dy, z] = LAYER[k];
        const id = i * LAYER.length + k;
        const m = add(kit.grains[id % GRAIN_VARIANTS], kit.grain);
        m.position.set(i % 2 ? -x : x, WIN.y0 + LOAD_Y0 + i * pitch + dy, i % 2 ? -z * 0.6 : z);
        m.rotation.set(id * 1.7, id * 2.3, id * 0.9);
        m.visible = false;
        row.push({ mesh: m, s: new Spring(T.popW, T.popZ), delay: 0 });
      }
      this.loads.push(row);
    }
    // Jumping grains: a fixed pool of MAX_JUMPS, reused by every shot.
    for (let j = 0; j < MAX_JUMPS; j++) {
      const m = add(kit.grains[(j + 1) % GRAIN_VARIANTS], kit.grain);
      m.scale.setScalar(JUMP_SCALE);
      m.visible = false;
      this.jumpers.push(m);
    }
    // The glass last: transparent, never hides the grains behind it.
    const glass = add(kit.glass, kit.window);
    glass.position.set(0, WIN.y0 + WIN.h / 2, 0);
    glass.renderOrder = 2;

    this.camera.position.set(0, VIEW_TARGET_Y + CAM_DIST * Math.sin(CAM_ELEVATION), CAM_DIST * Math.cos(CAM_ELEVATION));
    this.camera.lookAt(0, VIEW_TARGET_Y, 0);
  }

  // ------------------------------------------------------------------
  // State → targets
  // ------------------------------------------------------------------

  /**
   * Retarget every spring on the real state. Loads that appear pop in one
   * after the other (the reload refill); loads that vanish without a shot
   * shrink away. The lid opens while the weapon really reloads.
   * instant = snap everything (respawn, hidden, first build).
   */
  private applyState(instant: boolean): void {
    let k = 0;
    for (let i = 0; i < this.loads.length; i++) {
      const want = i < this.count;
      for (const g of this.loads[i]) {
        const tgt = want ? 1 : 0;
        if (instant) {
          g.s.snap(tgt);
          g.delay = 0;
          g.mesh.visible = want;
          continue;
        }
        if (want && g.s.target === 0) {
          g.s.snap(0);
          g.s.target = 1;
          g.s.w = T.popW;
          g.s.z = T.popZ;
          g.delay = T.popStagger * k++;
        } else if (!want && g.s.target === 1) {
          g.s.target = 0;
          g.s.w = T.dropW;
          g.s.z = T.dropZ;
          g.delay = 0;
        }
      }
    }
    this.open.target = this.reloading ? T.lidOpen : 0;
    if (instant) {
      this.open.snap();
      this.tilt.snap(0);
      this.kick.snap(0);
      this.flightT = -1;
      this.acc = 0;
      for (const m of this.jumpers) m.visible = false;
      return;
    }
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
    this.kick.step(h);
    this.tilt.step(h);
    this.open.step(h);
    for (const row of this.loads) {
      for (const g of row) {
        if (g.delay > 0) {
          g.delay -= h;
          continue;
        }
        g.s.step(h);
      }
    }
    if (this.flightT >= 0) {
      this.flightT += h;
      if (this.flightT >= FLIGHT_END) this.flightT = -1;
    }
  }

  private moving(): boolean {
    if (this.flightT >= 0) return true;
    if (!this.kick.settled || !this.tilt.settled || !this.open.settled) return true;
    for (const row of this.loads) for (const g of row) if (g.delay > 0 || !g.s.settled) return true;
    return false;
  }

  /** Motion over: land exactly on the targets (no residual drift between two events). */
  private restAll(): void {
    this.kick.snap(0);
    this.tilt.snap(0);
    this.open.snap();
    for (const row of this.loads) for (const g of row) g.s.snap();
    this.flightT = -1;
    this.acc = 0;
  }

  // ------------------------------------------------------------------
  // Pose + draw
  // ------------------------------------------------------------------

  private pose(): void {
    // Miniature impulse: a short local push toward the camera / down (the panel itself never moves).
    const k = this.kick.x;
    this.machine.position.set(0, -k * 0.5, k * 0.6);
    this.machine.rotation.z = k * 0.012;
    // Lid: hinged at the back edge. Opening (reload) and the shot tilt both lift the front edge.
    const tilt = Math.max(-TILT_MAX, Math.min(TILT_MAX, this.tilt.x));
    this.lid.rotation.x = -(this.open.x + tilt);
    // Resting grains: pop-in / shrink (hidden entirely at scale 0).
    for (const row of this.loads) {
      for (const g of row) {
        const s = g.delay > 0 ? 0 : Math.max(0, g.s.x);
        g.mesh.visible = s > 0.02;
        g.mesh.scale.setScalar(REST_SCALE * s);
      }
    }
    // Jumping grains: fixed pool, each on its own clock since the last real shot.
    for (let j = 0; j < this.jumpers.length; j++) {
      const m = this.jumpers[j];
      const f = FLIGHTS[j];
      const h = this.flightT >= 0 ? flightHeight(f, this.flightT - f.delay) : null;
      if (h === null) {
        m.visible = false;
        continue;
      }
      m.visible = true;
      // Local to the machine, above the closed lid's top face (the lid hides the lower part of the path).
      m.position.set(f.x, LID_TOP_Y + h, LID_HINGE.z + LID_D * 0.62 + f.z);
      const a = this.flightT - f.delay;
      m.rotation.set(f.spin[0] * a, f.spin[1] * a, f.spin[2] * a);
    }
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
    // Back on the page: anything mid-motion lands at rest (no catch-up burst).
    if (this.visible && this.renderer && !this.lost) {
      this.restAll();
      this.render();
    }
  };
}

