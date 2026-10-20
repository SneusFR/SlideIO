import type * as THREE from "three";
import { Pass } from "three/examples/jsm/postprocessing/Pass.js";

/**
 * Composer step that draws nothing: it hands the GPU the commands recorded
 * so far (`gl.flush()`), so the GPU starts on them while the CPU records the
 * following passes. See Game.flushGpu for why this matters.
 *
 * Never the last pass of a composer (EffectComposer would make it the one
 * that renders to the screen).
 */
export class FlushPass extends Pass {
  constructor() {
    super();
    this.needsSwap = false;
    this.clear = false;
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.getContext().flush();
  }
}
