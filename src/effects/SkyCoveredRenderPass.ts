import type * as THREE from "three";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";

/**
 * The world RenderPass of the Givre composer: ONE clear per frame instead
 * of two, and no colour clear while the sky covers every pixel.
 *
 * PERF (GPU): three's RenderPass clears its target (colour + depth +
 * stencil), then renderer.render() clears it AGAIN — a scene whose
 * background is a Color makes WebGLBackground clear whatever `autoClear`
 * says ("forceClear"). Two full clears of the HDR target every frame
 * (RGBA16F = 8 bytes per pixel, ×4 samples with the MSAA of HIGH) plus two
 * of depth / stencil, before the first draw: the "monde (début)" term of
 * the debug HUD's GPU line. On an Intel Iris Xe they are NOT fast clears
 * (the sky colour is not a 0 / 1 value): every byte is written, ~0.7 ms
 * each at 1920 × 928 — measured in a real browser on that GPU, dropping
 * those two colour clears took 2560 × 1238 from 49 to 57 FPS. And neither
 * colour clear is ever visible: the Givre sky dome is drawn on the far
 * plane after the opaques (GivreSky), so every pixel — every sample with
 * MSAA — is written by an opaque object or by the dome. Now: depth +
 * stencil cleared once (hierarchical-Z / fast clears on every desktop GPU),
 * and the colour attachment is only declared "don't care"
 * (invalidateFramebuffer: nothing is written for it — and a tiled GPU,
 * Apple / mobile, does not reload last frame's colour either). Same image,
 * pixel for pixel. When the sky does not cover the screen (`skyCovers()`
 * false: sky hidden or removed), ONE full clear comes back (the Color
 * background's, or the pass's own without one).
 */
export class SkyCoveredRenderPass extends RenderPass {
  /** DEV A/B (givreDebug.perf.clears): true = three's two full clears. */
  legacyClears = false;

  constructor(
    scene: THREE.Scene,
    camera: THREE.Camera,
    private readonly skyCovers: () => boolean,
  ) {
    super(scene, camera);
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ): void {
    if (this.legacyClears || this.renderToScreen || !this.skyCovers()) {
      // A Color background is cleared by three anyway: the pass's own clear
      // only when there is none (or for the A/B of the old two clears).
      const colorBackground = (this.scene.background as THREE.Color | null)?.isColor === true;
      this.clear = this.legacyClears || !colorBackground;
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      return;
    }
    renderer.setRenderTarget(readBuffer);
    const gl = renderer.getContext();
    // (WebGL 2: the colour attachment of the bound framebuffer — the
    // multisampled one when the target has samples.)
    if (typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext) {
      gl.invalidateFramebuffer(gl.FRAMEBUFFER, [gl.COLOR_ATTACHMENT0]);
    }
    // Depth + stencil (the stencil carries the enemy-outline mask), once.
    renderer.clear(false, true, true);
    // Neither the pass nor the scene's colour background clears again.
    const { autoClearColor, autoClearDepth, autoClearStencil } = renderer;
    renderer.autoClearColor = false;
    renderer.autoClearDepth = false;
    renderer.autoClearStencil = false;
    this.clear = false;
    try {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    } finally {
      renderer.autoClearColor = autoClearColor;
      renderer.autoClearDepth = autoClearDepth;
      renderer.autoClearStencil = autoClearStencil;
    }
  }
}
