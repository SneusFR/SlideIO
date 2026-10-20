import type * as THREE from "three";
import type { Pass } from "three/examples/jsm/postprocessing/Pass.js";

/** DEV A/B (givreDebug.perf.passClears): true = three's clear + depth test before each, as before. */
export const fullscreenPassDebug = { legacy: false };

/**
 * A composer pass that draws one fullscreen triangle over EVERY pixel of its
 * target, opaque, no blending — the sRGB output pass, FXAA. Returns the pass.
 *
 * PERF (GPU): three still cleared the target first — renderer.autoClear
 * applies to every render() call, a FullScreenQuad's included: colour +
 * depth + stencil of the whole target — then depth-tested the triangle and
 * wrote its depth. None of it changes a pixel: the triangle overwrites every
 * one. Measured in a real browser on an Intel Iris Xe (Givre, 2560 × 1238,
 * GPU-bound): the clear of the output pass's target cost 9 % of the FPS
 * (49.5 → 54 without it), the canvas's 3 % (50 → 51.7). Now: no clear, no
 * depth test, no depth write — the same image, bit for bit. (Between two
 * frames the browser still resets the canvas itself — WebGL
 * `preserveDrawingBuffer: false` — as it always did.)
 */
export function asFullscreenPass<T extends Pass & { material: THREE.Material }>(pass: T): T {
  const material = pass.material;
  const render = pass.render.bind(pass);
  pass.render = (renderer, writeBuffer, readBuffer, deltaTime, maskActive) => {
    const legacy = fullscreenPassDebug.legacy;
    material.depthTest = legacy;
    material.depthWrite = legacy;
    const autoClear = renderer.autoClear;
    if (!legacy) renderer.autoClear = false;
    try {
      render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    } finally {
      renderer.autoClear = autoClear;
    }
  };
  return pass;
}
