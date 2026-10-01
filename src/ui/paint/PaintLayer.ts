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
 */
const CREEP_INTERVAL = 0.05;

let gl: PaintGL | null = null;
let glFailed = false;
const layers = new Set<PaintLayer>();
let raf = 0;
let last = 0;

function getGL(): PaintGL | null {
  if (gl || glFailed) return gl;
  try {
    gl = new PaintGL();
  } catch {
    glFailed = true;
  }
  return gl;
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

export class PaintLayer {
  readonly canvas: HTMLCanvasElement;
  readonly sim: PaintDripSim;
  visible = false;
  /** Preview / debug: slow-motion factor applied to the paint clock. */
  timeScale = 1;
  private readonly ctx: CanvasRenderingContext2D | null;
  private dirty = true;
  private creepT = 0;

  constructor(host: HTMLElement, profile: PaintProfile) {
    this.sim = new PaintDripSim(profile);
    this.canvas = document.createElement("canvas");
    this.canvas.className = "wpn-paint";
    this.canvas.width = Math.round(profile.canvas.w * PAINT_RENDER_SCALE);
    this.canvas.height = Math.round(profile.canvas.h * PAINT_RENDER_SCALE);
    this.canvas.style.cssText =
      `left:${profile.canvas.x}px;top:${profile.canvas.y}px;` +
      `width:${profile.canvas.w}px;height:${profile.canvas.h}px;`;
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
      wake();
    }
  }

  /** Weapon event (shot / hit / reload): jelly response + faster fill. */
  impact(strength: number): void {
    this.sim.impact(strength);
    this.dirty = true;
    wake();
  }

  /** Advance the paint clock and redraw if anything moved. */
  tick(dt: number): void {
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
    const src = getGL()?.draw(this.sim);
    if (!src || !this.ctx) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(src, 0, 0);
  }

  dispose(): void {
    layers.delete(this);
    this.canvas.remove();
    if (layers.size === 0 && gl) {
      gl.dispose();
      gl = null;
    }
  }
}
