import { FXAAPass } from "three/examples/jsm/postprocessing/FXAAPass.js";

/**
 * GIVRE composer, LOW preset: the output conversion (tone mapping + sRGB,
 * what OutputPass does) and FXAA in ONE fullscreen pass, drawn straight to
 * the screen.
 *
 * PERF (GPU): the two-pass chain wrote the whole converted image into a
 * second HalfFloat target (8 bytes per pixel) for FXAA to read it back — a
 * full-screen write + read of 14 MB at 1920 × 928, pure memory traffic on an
 * integrated GPU (~1.3 ms of a 15 ms frame on an Intel Iris Xe). Here FXAA
 * samples the linear HDR image and converts each sample as it reads it.
 *
 * The conversion uses three's own functions, injected into every
 * ShaderMaterial program that renders to the screen: `toneMapping()` (only
 * when the renderer has one) and `linearToOutputTexel()` (the canvas colour
 * space: sRGB) — the exact OutputPass code path. The FXAA edge search
 * filters between two pixels: in linear space here, in sRGB space before —
 * a difference of a few levels on some anti-aliased edge pixels at most
 * (see PERFORMANCE.md), never on the rest of the image.
 */
export class OutputFXAAPass extends FXAAPass {
  constructor() {
    super();
    const material = this.material;
    const before = material.fragmentShader;
    material.fragmentShader = before.replace(
      "return texture( tex2D, uv );",
      [
        "vec4 texel = texture( tex2D, uv );",
        "#ifdef TONE_MAPPING",
        "texel.rgb = toneMapping( texel.rgb );",
        "#endif",
        "return linearToOutputTexel( texel );",
      ].join("\n"),
    );
    if (material.fragmentShader === before) {
      // three changed its FXAA shader: never ship a pass that skips the
      // output conversion silently.
      throw new Error("OutputFXAAPass: FXAA sampling function not found");
    }
    material.name = "OutputFXAA";
  }
}
