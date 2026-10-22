import * as THREE from "three";
import { PAINT_FRAG_HEAD, PAINT_VERT } from "./paintShader";
import { PAINT_FRAG_MAIN } from "./paintShaderMain";
import { PAINT_MAX_CLUSTERS, PAINT_MAX_NODES } from "./paintTypes";
import type { PaintDripSim } from "./PaintDripSim";
import { GpuTimer } from "../GpuTimer";
import { perfDiag } from "../perfDiag";

/**
 * MAX offscreen pixel density of the paint canvas (plate px → GL px). The
 * layers render at their on-screen density (PaintLayer.measure), never above.
 */
export const PAINT_RENDER_SCALE = 3;

/**
 * PaintGL — the Three.js context of the paint layer: ONE offscreen
 * WebGLRenderer with a single full-screen quad running the raymarch shader
 * (see paintShader.ts). Own context, own resources: the game renderer is
 * never touched. Shared by every plate; created lazily by PaintLayer and
 * released with dispose().
 */
export class PaintGL {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  lost = false;
  private w = 0;
  private h = 0;
  /**
   * DEV: GPU time of the paint draws. This context is NOT the game's, so its
   * cost never shows in the debug HUD's GPU line otherwise (see takeGpu).
   */
  private readonly timer: GpuTimer | null;

  constructor() {
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
    });
    this.renderer.domElement.addEventListener("webglcontextrestored", () => {
      this.lost = false;
    });
    // DEV, or `?gpu` (ui/perfDiag.ts): the debug HUD's "+ peinture HUD" term.
    this.timer = perfDiag() !== "off" ? GpuTimer.create(this.renderer) : null;
    this.material = new THREE.ShaderMaterial({
      vertexShader: PAINT_VERT,
      fragmentShader: PAINT_FRAG_HEAD + PAINT_FRAG_MAIN,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      uniforms: {
        uNodes: { value: new Float32Array(PAINT_MAX_NODES * 4) },
        uLinks: { value: new Float32Array(PAINT_MAX_NODES) },
        uCl: { value: new Float32Array(PAINT_MAX_NODES) },
        uColor: { value: new Float32Array(PAINT_MAX_CLUSTERS * 3) },
        uMat: { value: new Float32Array(PAINT_MAX_CLUSTERS * 4) },
        uCount: { value: 0 },
        uNC: { value: 0 },
        uSize: { value: new THREE.Vector2() },
        uOrigin: { value: new THREE.Vector2() },
        uPx: { value: 1 / PAINT_RENDER_SCALE },
        uRect0: { value: new THREE.Vector4() },
        uRect1: { value: new THREE.Vector4() },
        uRad: { value: new THREE.Vector2() },
      },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /** The GL canvas (shown directly by the single visible plate — see PaintLayer). */
  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /**
   * Starts compiling the raymarch program now (see warmUpPaint): the GPU
   * process works on it in the background — on several threads where the
   * browser compiles in parallel — and the first draw only waits for what
   * may be left.
   */
  precompile(): void {
    if (!this.lost) this.renderer.compile(this.scene, this.camera);
  }

  /**
   * Draw `sim` at `scale` GL px per plate px; returns the GL canvas (valid
   * until the next draw) or null.
   */
  draw(sim: PaintDripSim, scale = PAINT_RENDER_SCALE): HTMLCanvasElement | null {
    if (this.lost) return null;
    const p = sim.profile;
    const w = Math.round(p.canvas.w * scale);
    const h = Math.round(p.canvas.h * scale);
    if (w !== this.w || h !== this.h) {
      this.w = w;
      this.h = h;
      this.renderer.setSize(w, h, false);
    }
    const u = this.material.uniforms;
    // Silhouette anti-aliasing width = one GL pixel, in plate px.
    u.uPx.value = 1 / scale;
    (u.uNodes.value as Float32Array).set(sim.nodes);
    (u.uLinks.value as Float32Array).set(sim.links);
    const cl = u.uCl.value as Float32Array;
    const col = u.uColor.value as Float32Array;
    const mat = u.uMat.value as Float32Array;
    cl.fill(0);
    // No allocation per draw (up to every frame while the paint moves).
    for (let c = 0; c < sim.clusterCount; c++) {
      const s = sim.rangeStart(c);
      const e = sim.rangeEnd(c);
      for (let i = s; i < e; i++) cl[i] = c;
      const spec = p.clusters[c];
      col.set(spec.color, c * 3);
      const m = spec.material;
      mat[c * 4] = m.gloss;
      mat[c * 4 + 1] = m.spec;
      mat[c * 4 + 2] = m.sss;
      mat[c * 4 + 3] = m.opacity;
    }
    u.uCount.value = sim.nodeCount;
    u.uNC.value = sim.clusterCount;
    u.uSize.value.set(p.canvas.w, p.canvas.h);
    u.uOrigin.value.set(p.canvas.x, p.canvas.y);
    const r0 = p.frame.rects[0];
    const r1 = p.frame.rects[1];
    u.uRect0.value.set(r0[0], r0[1], r0[2], r0[3]);
    u.uRect1.value.set(r1[0], r1[1], r1[2], r1[3]);
    u.uRad.value.set(p.frame.radii[0], p.frame.radii[1]);
    this.timer?.beginFrame("peinture");
    this.renderer.render(this.scene, this.camera);
    this.timer?.endFrame();
    return this.renderer.domElement;
  }

  /** DEV: total GPU ms of the paint draws measured since the last call. */
  takeGpu(): number | null {
    if (!this.timer || this.timer.dead) return null;
    const r = this.timer.take();
    return r ? r.total * r.frames : 0;
  }

  dispose(): void {
    this.quad.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
