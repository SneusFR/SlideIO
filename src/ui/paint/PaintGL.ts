import * as THREE from "three";
import { PAINT_FRAG_HEAD, PAINT_VERT } from "./paintShader";
import { PAINT_FRAG_MAIN } from "./paintShaderMain";
import { PAINT_MAX_CLUSTERS, PAINT_MAX_NODES } from "./paintTypes";
import type { PaintDripSim } from "./PaintDripSim";

/** Offscreen pixel density of the paint canvas (CSS px → GL px). */
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

  /** Draw `sim`; returns the GL canvas (valid until the next draw) or null. */
  draw(sim: PaintDripSim): HTMLCanvasElement | null {
    if (this.lost) return null;
    const p = sim.profile;
    const w = Math.round(p.canvas.w * PAINT_RENDER_SCALE);
    const h = Math.round(p.canvas.h * PAINT_RENDER_SCALE);
    if (w !== this.w || h !== this.h) {
      this.w = w;
      this.h = h;
      this.renderer.setSize(w, h, false);
    }
    const u = this.material.uniforms;
    (u.uNodes.value as Float32Array).set(sim.nodes);
    (u.uLinks.value as Float32Array).set(sim.links);
    const cl = u.uCl.value as Float32Array;
    const col = u.uColor.value as Float32Array;
    const mat = u.uMat.value as Float32Array;
    cl.fill(0);
    for (let c = 0; c < sim.clusterCount; c++) {
      const [s, e] = sim.range(c);
      for (let i = s; i < e; i++) cl[i] = c;
      const spec = p.clusters[c];
      col.set(spec.color, c * 3);
      mat.set([spec.material.gloss, spec.material.spec, spec.material.sss, spec.material.opacity], c * 4);
    }
    u.uCount.value = sim.nodeCount;
    u.uNC.value = sim.clusterCount;
    u.uSize.value.set(p.canvas.w, p.canvas.h);
    u.uOrigin.value.set(p.canvas.x, p.canvas.y);
    u.uRect0.value.set(...p.frame.rects[0]);
    u.uRect1.value.set(...p.frame.rects[1]);
    u.uRad.value.set(p.frame.radii[0], p.frame.radii[1]);
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement;
  }

  dispose(): void {
    this.quad.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
