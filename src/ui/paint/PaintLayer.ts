import { PaintGL, PAINT_RENDER_SCALE } from "./PaintGL";
import { PaintDripSim } from "./PaintDripSim";
import type { PaintProfile } from "./paintTypes";

/**
 * PaintLayer — one `<canvas class="wpn-paint">` per weapon plate, aligned on
 * the plate box and fed by the shared PaintGL (Three.js) context.
 *
 *  - one rAF loop for ALL layers, running only while a layer is visible and
 *    the page is not hidden;
 *  - a layer re-renders every frame only while its sim moves (activity 2),
 *    at 20 Hz during the slow creep (activity 1) and never when frozen;
 *  - the GL context is created on first use and released with the last layer;
 *  - no WebGL / context lost → the plate simply has no paint (HUD intact).
 *
 * PERF: the paint is a per-pixel raymarch (up to 30 steps × every node)
 * drawn by a SECOND WebGL context — its GPU time never shows in the game's
 * own timer, yet it runs every frame while the paint moves. The backing
 * store therefore follows the plate's REAL on-screen size (HUD zoom ×
 * devicePixelRatio) × 2 (the look of the 3× render: supersampled, then
 * filtered down by the browser), capped at PAINT_RENDER_SCALE. Unchanged
 * where the plate is big on screen (≥ 1.5 device px per plate px: a
 * 1536-px window at 125 %, 1440p…); small windows stop rendering pixels
 * the screen cannot show (1280-px window: 2.25× instead of 3×, −44 %).
 *
 * PERF (240 Hz): the ONE visible layer (in game: the equipped weapon's
 * plate) shows the GL canvas ITSELF, placed exactly where its 2D canvas
 * sits — same class, box and backing size, so the same pixels. Copying the
 * GL canvas into the 2D canvas made Chrome snapshot the WebGL drawing
 * buffer into a freshly allocated GPU image, then re-draw that image into
 * the 2D canvas, at every paint frame — up to 240 times per second after
 * each shot, all in the browser's GPU process, which the game's own frames
 * need too. The 2D copy remains the path when several plates show at once
 * (HUD preview page).
 */
const CREEP_INTERVAL = 0.05;
/** Backing pixels per ON-SCREEN pixel kept by the paint (supersampling). */
const SUPERSAMPLE = 2;
/** The on-screen size is measured once the plate's enter animation has settled. */
const MEASURE_DELAY = 0.5;

let gl: PaintGL | null = null;
let glFailed = false;
const layers = new Set<PaintLayer>();
let raf = 0;
let last = 0;
/** The single visible layer that displays the GL canvas directly (no 2D copy). */
let direct: PaintLayer | null = null;

function getGL(): PaintGL | null {
  if (gl || glFailed) return gl;
  try {
    gl = new PaintGL();
  } catch {
    glFailed = true;
  }
  return gl;
}

/** Exactly one visible layer → it shows the GL canvas itself; otherwise nobody does. */
function updateDirect(): void {
  let only: PaintLayer | null = null;
  let visible = 0;
  for (const layer of layers) {
    if (!layer.visible) continue;
    visible++;
    only = layer;
  }
  const next = visible === 1 ? only : null;
  if (next === direct) return;
  const prev = direct;
  direct = null;
  prev?.releaseDirect();
  if (next && next.adoptDirect()) direct = next;
}

function loop(now: number): void {
  raf = 0;
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  let any = false;
  for (const layer of layers) {
    if (!layer.visible) continue;
    any = true;
    layer.tick(dt);
  }
  if (any && !document.hidden) raf = requestAnimationFrame(loop);
}

function wake(): void {
  if (raf || document.hidden) return;
  last = performance.now();
  raf = requestAnimationFrame(loop);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) wake();
});

/**
 * Loading screen (main.ts): the shared paint context is created and its
 * raymarch program compiled NOW. Both used to wait for the first plate shown
 * — the first frame of play with the Popcorn Shotgun / Paintball Rifle in
 * hand: a WebGL context creation + a heavy shader compile (nested raymarch
 * loops: long under D3D11) at that very frame.
 */
export function warmUpPaint(): void {
  try {
    getGL()?.precompile();
  } catch {
    /* no paint context: the plates fall back as before */
  }
}

/**
 * DEV (debug HUD "GPU" line): GPU ms spent drawing the plate paint since the
 * last call — null when it cannot be measured (no paint context / timer).
 */
export function takePaintGpuMs(): number | null {
  return gl ? gl.takeGpu() : null;
}

// Window resize / zoom / DPR change: every plate re-measures its on-screen size.
window.addEventListener("resize", () => {
  for (const layer of layers) layer.remeasure();
});

export class PaintLayer {
  /** The 2D canvas of the plate (shown unless the GL canvas stands in for it). */
  readonly canvas: HTMLCanvasElement;
  readonly sim: PaintDripSim;
  visible = false;
  /** Preview / debug: slow-motion factor applied to the paint clock. */
  timeScale = 1;
  private readonly ctx: CanvasRenderingContext2D | null;
  /** Box of the paint canvas on the plate (CSS), shared by both canvases. */
  private readonly boxCss: string;
  /** The shared GL canvas while this layer displays it directly (see updateDirect). */
  private glCanvas: HTMLCanvasElement | null = null;
  /** The GL canvas was just moved here: kept invisible until this layer drew in it. */
  private glPending = false;
  private dirty = true;
  private creepT = 0;
  /** Backing pixels per plate pixel (max until the on-screen size is known). */
  private scale = PAINT_RENDER_SCALE;
  /** Seconds before the next on-screen measurement (< 0: none pending). */
  private measureIn = MEASURE_DELAY;

  constructor(host: HTMLElement, profile: PaintProfile) {
    this.sim = new PaintDripSim(profile);
    this.canvas = document.createElement("canvas");
    this.canvas.className = "wpn-paint";
    this.canvas.width = Math.round(profile.canvas.w * this.scale);
    this.canvas.height = Math.round(profile.canvas.h * this.scale);
    this.boxCss =
      `left:${profile.canvas.x}px;top:${profile.canvas.y}px;` +
      `width:${profile.canvas.w}px;height:${profile.canvas.h}px;`;
    this.canvas.style.cssText = this.boxCss;
    this.ctx = this.canvas.getContext("2d");
    host.appendChild(this.canvas);
    layers.add(this);
  }

  setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    if (v) {
      this.sim.enter();
      this.dirty = true;
      this.measureIn = MEASURE_DELAY;
      wake();
    }
    updateDirect();
  }

  /**
   * Show the shared GL canvas in place of this layer's 2D canvas: same
   * class (stacking, positioning), same box, same backing size (set by every
   * PaintGL.draw). Hidden until this layer has drawn in it (it may still
   * hold another plate's paint). False when there is no GL context.
   */
  adoptDirect(): boolean {
    const glc = getGL()?.canvas ?? null;
    if (!glc || !this.canvas.parentElement) return false;
    glc.className = this.canvas.className;
    glc.style.cssText = this.boxCss + "visibility:hidden;";
    this.canvas.after(glc);
    this.canvas.style.display = "none";
    this.glCanvas = glc;
    this.glPending = true;
    this.dirty = true;
    return true;
  }

  /** Back to the 2D canvas (redrawn on the next tick if the plate shows). */
  releaseDirect(): void {
    const glc = this.glCanvas;
    if (!glc) return;
    this.glCanvas = null;
    this.glPending = false;
    if (glc.previousElementSibling === this.canvas) glc.remove();
    this.canvas.style.display = "";
    this.dirty = true;
  }

  /** The window changed (size / zoom / screen): measure again once settled. */
  remeasure(): void {
    this.measureIn = MEASURE_DELAY;
  }

  /** Weapon event (shot / hit / reload): jelly response + faster fill. */
  impact(strength: number): void {
    this.sim.impact(strength);
    this.dirty = true;
    wake();
  }

  /** Advance the paint clock and redraw if anything moved. */
  tick(dt: number): void {
    if (this.measureIn >= 0) {
      this.measureIn -= dt;
      if (this.measureIn < 0) this.measure();
    }
    this.sim.step(dt * this.timeScale);
    const act = this.sim.activity;
    let draw = this.dirty || act === 2;
    if (!draw && act === 1) {
      this.creepT += dt;
      draw = this.creepT >= CREEP_INTERVAL;
    }
    if (!draw) return;
    this.creepT = 0;
    this.dirty = act === 2; // one more frame once the motion has stopped
    const src = getGL()?.draw(this.sim, this.scale);
    if (!src) return;
    if (src === this.glCanvas) {
      // Direct: the browser composites the GL canvas as drawn — no copy.
      if (this.glPending) {
        this.glPending = false;
        src.style.visibility = "";
      }
      return;
    }
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(src, 0, 0);
  }

  /**
   * Backing store = the plate's REAL on-screen size (getBoundingClientRect:
   * HUD zoom + transforms) × devicePixelRatio × SUPERSAMPLE, in quarter
   * steps, within [1, PAINT_RENDER_SCALE]. Runs once per show / resize,
   * after the enter animation (its scale would read too small).
   */
  private measure(): void {
    // The canvas actually displayed (the hidden one has no box).
    const w = (this.glCanvas ?? this.canvas).getBoundingClientRect().width;
    if (w <= 0) {
      // Not laid out yet (HUD hidden behind the menu): keep the current
      // scale and look again a little later.
      this.measureIn = MEASURE_DELAY;
      return;
    }
    const p = this.sim.profile;
    const onScreen = (w * (window.devicePixelRatio || 1)) / p.canvas.w;
    const s = Math.min(PAINT_RENDER_SCALE, Math.max(1, Math.ceil(onScreen * SUPERSAMPLE * 4) / 4));
    if (s === this.scale) return;
    this.scale = s;
    this.canvas.width = Math.round(p.canvas.w * s); // also clears it
    this.canvas.height = Math.round(p.canvas.h * s);
    this.dirty = true;
  }

  dispose(): void {
    layers.delete(this);
    if (direct === this) {
      direct = null;
      this.releaseDirect();
    }
    this.canvas.remove();
    if (layers.size === 0 && gl) {
      gl.dispose();
      gl = null;
    } else {
      updateDirect();
    }
  }
}
