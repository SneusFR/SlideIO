import * as THREE from "three";
import type { FXAAPass } from "three/examples/jsm/postprocessing/FXAAPass.js";
import type { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { Pass } from "three/examples/jsm/postprocessing/Pass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { CopyShader } from "three/examples/jsm/shaders/CopyShader.js";
import { asFullscreenPass } from "./FullscreenPass";
import { OutputFXAAPass } from "./OutputFXAAPass";

/**
 * GIVRE post chain — memory traffic of the fullscreen steps (`?diag=`).
 *
 * On an integrated GPU (Intel Iris Xe) the end of the frame is bound by
 * memory bandwidth, not by shading: the world is drawn into an RGBA16F
 * target (8 B/px, every blended fragment read AND written), the sRGB output
 * pass reads it and writes a SECOND RGBA16F image (8 + 8 B/px) that FXAA
 * reads back (8 B/px) before writing the canvas (4 B/px). Each switch below
 * removes part of that traffic; the reference chain stays the default
 * (see PERFORMANCE.md « La chaîne de post-traitement » for the pixel diffs
 * and the measurements).
 *
 * World target format (the composer's two buffers, `GivreWorldFormat`):
 *   rgba16f     RGBA16F, 8 B/px — the reference
 *   r11g11b10f  R11F_G11F_B10F, 4 B/px (`?diag=world11`): linear float, no
 *               alpha channel (reads 1.0), 6 / 6 / 5 mantissa bits
 *   srgb8       SRGB8_ALPHA8, 4 B/px (`?diag=worldsrgb`): the shaders still
 *               write linear values — the hardware encodes / decodes — but
 *               they are stored with 8 bits and clamped to [0, 1]
 *   direct      RGBA8 written like the canvas (`?diag=direct`, cel-shading
 *               outline off only): the materials encode sRGB themselves, as
 *               on Jungle / Yard, so transparent effects BLEND IN sRGB SPACE
 *               (a visual change); no output pass — FXAA reads the world
 *
 * Output → FXAA hand-over (FXAA on; `GivreOutputRoute`):
 *   half    OutputPass → the composer's other RGBA16F buffer → FXAA (reference)
 *   rgba8   OutputPass → a dedicated RGBA8 target, no depth (`?diag=out8`):
 *           it only holds sRGB values for an 8-bit canvas — 4 + 4 B/px
 *           instead of 8 + 8
 *   fused   FXAA converts each texel it reads itself (`?diag=fused`,
 *           OutputFXAAPass): no intermediate at all, more ALU — its manual
 *           bilinear blend with exact weights
 *   fused8  the same with weights rounded to 1/256 (`?diag=fused8`): what
 *           a GPU sampler with 8 bits of sub-texel precision computes
 *           (desktop GPUs typically) — the closer of the two to the
 *           reference depends on the GPU (`givrePost.ab()` tells)
 *   none    `direct` world: FXAA reads the world target as it is
 * With FXAA off (MSAA / none) the output pass draws the canvas, as before
 * (a plain copy for `direct`). A world format other than RGBA16F comes with
 * the `rgba8` route unless `fused` is asked: the `half` route's intermediate
 * is the composer's other buffer, in the world's format (DEV A/B only).
 *
 * The composer is never restructured: the output pass and the FXAA pass
 * keep their places (GPU line, the settings page's FXAA ⇄ MSAA switch,
 * warmAlternateOutput); their render() routes the image. Outside the
 * reference route no pass swaps the composer's buffers any more: the world
 * is drawn into the same buffer every frame.
 */
export type GivreWorldFormat = "rgba16f" | "r11g11b10f" | "srgb8" | "direct";
export type GivreOutputRoute = "half" | "rgba8" | "fused" | "fused8" | "none";

export interface GivrePostSetup {
  world: GivreWorldFormat;
  output: GivreOutputRoute;
}

/** The reference chain: what every variant is compared with (`?diag=postref` forces it). */
export const GIVRE_POST_REFERENCE: Readonly<GivrePostSetup> = Object.freeze({ world: "rgba16f", output: "half" });

/**
 * The chain built when the address asks for none: the reference. Making a
 * variant the default (after its real-GPU A/B) = this one constant; the
 * switches below still pick any chain, `?diag=postref` the reference.
 */
export const GIVRE_POST_DEFAULT: Readonly<GivrePostSetup> = GIVRE_POST_REFERENCE;

/** `?diag=` values read by givrePostSetup (documented in ui/perfDiag.ts). */
export const GIVRE_POST_DIAGS = ["out8", "fused", "fused8", "world11", "worldsrgb", "direct", "postref", "postab"] as const;

/**
 * The session's post chain from the `?diag=` experiments (ui/perfDiag.ts
 * perfExperiments). `outlines`: the cel-shading outline feature is on (its
 * passes compose a LINEAR rim colour: no `direct` world then).
 * Precedence when switches collide: postref > direct > worldsrgb > world11
 * (world), fused8 > fused > out8 (output). No switch: GIVRE_POST_DEFAULT.
 */
export function givrePostSetup(experiments: ReadonlySet<string>, opts: { outlines: boolean }): GivrePostSetup {
  if (experiments.has("postref")) return { ...GIVRE_POST_REFERENCE };
  if (!["out8", "fused", "fused8", "world11", "worldsrgb", "direct"].some((d) => experiments.has(d))) {
    return GIVRE_POST_DEFAULT.world === "direct" && opts.outlines ? { ...GIVRE_POST_REFERENCE } : { ...GIVRE_POST_DEFAULT };
  }
  if (experiments.has("direct") && !opts.outlines) return { world: "direct", output: "none" };
  const world: GivreWorldFormat = experiments.has("worldsrgb")
    ? "srgb8"
    : experiments.has("world11")
      ? "r11g11b10f"
      : "rgba16f";
  // The reference route's intermediate is the composer's OTHER buffer, which
  // has the world's format: an 8-bit / 11-bit world format would quantize
  // the converted image once more (sRGB-encoded twice for srgb8) — so a
  // world format always comes with a dedicated intermediate.
  const output: GivreOutputRoute = experiments.has("fused8")
    ? "fused8"
    : experiments.has("fused")
      ? "fused"
      : experiments.has("out8") || world !== "rgba16f"
        ? "rgba8"
        : "half";
  return { world, output };
}

/** Is `setup` a consistent pair (the `direct` world and the `none` route go together)? */
export function isValidPostSetup(setup: GivrePostSetup): boolean {
  return (setup.world === "direct") === (setup.output === "none");
}

/** Short text for the debug HUD / logs (`world rgba16f · out half`). */
export function describePostSetup(setup: GivrePostSetup): string {
  return `world ${setup.world} · out ${setup.output}`;
}

/** Colour attachment options of a world target in `format` (merged into the composer target's). */
export function worldTargetOptions(format: GivreWorldFormat): THREE.RenderTargetOptions {
  switch (format) {
    case "rgba16f":
      return { type: THREE.HalfFloatType };
    case "r11g11b10f":
      return { type: THREE.UnsignedInt101111Type, format: THREE.RGBFormat };
    case "srgb8":
      // three: UnsignedByte + sRGB colour space → SRGB8_ALPHA8.
      return { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace };
    case "direct":
      // sRGB colour space for the programs (DirectWorldTarget), RGBA8
      // storage: the values are already encoded, nothing to convert.
      return { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, internalFormat: "RGBA8" };
  }
}

/** Bytes per pixel of the world target's colour (one sample). */
export function worldBytesPerPixel(format: GivreWorldFormat): number {
  return format === "rgba16f" ? 8 : 4;
}

/**
 * The `direct` world target. three draws into a render target in LINEAR
 * space (working colour space, no tone mapping) — except an XR target,
 * drawn exactly like the canvas: output colour space = the target's
 * texture colour space (sRGB here), the renderer's tone mapping. Those are
 * the ONLY uses of the flag in three r185's WebGLRenderer (program variant,
 * tone mapping, clear / fog colours; MSAA buffers forced to linear storage —
 * RGBA8 here anyway). A subclass so that the composer's clone() keeps it.
 */
export class DirectWorldTarget extends THREE.WebGLRenderTarget {
  readonly isXRRenderTarget = true;
}

/** A world target: `options` (size-independent: depth, stencil, samples…) + the format's colour attachment. */
export function createWorldTarget(
  width: number,
  height: number,
  format: GivreWorldFormat,
  options: THREE.RenderTargetOptions,
): THREE.WebGLRenderTarget {
  const all = { ...options, ...worldTargetOptions(format) };
  return format === "direct" ? new DirectWorldTarget(width, height, all) : new THREE.WebGLRenderTarget(width, height, all);
}

/** Pixel difference of two RGBA8 images of the same size. */
export interface PixelDiff {
  /** Pixels with at least one channel different. */
  pixels: number;
  percent: number;
  /** Largest channel difference, in levels of 255. */
  max: number;
  /** Pixels whose largest difference is exactly one level. */
  oneLevel: number;
  /** Pixels whose alpha differs. */
  alpha: number;
}

export function diffPixels(a: Uint8Array, b: Uint8Array): PixelDiff {
  if (a.length !== b.length) throw new Error("diffPixels: sizes differ");
  let pixels = 0;
  let max = 0;
  let oneLevel = 0;
  let alpha = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
    if (d === 0) continue;
    pixels++;
    if (d > max) max = d;
    if (d === 1) oneLevel++;
    if (a[i + 3] !== b[i + 3]) alpha++;
  }
  return { pixels, percent: +((100 * pixels) / (a.length / 4)).toFixed(3), max, oneLevel, alpha };
}

/** The chains `abPostChains` compares with the reference (`direct`: compiles every program's sRGB variant once). */
export function abSetups(withDirect: boolean): Record<string, GivrePostSetup> {
  const setups: Record<string, GivrePostSetup> = {
    out8: { world: "rgba16f", output: "rgba8" },
    fused: { world: "rgba16f", output: "fused" },
    fused8: { world: "rgba16f", output: "fused8" },
    worldsrgb: { world: "srgb8", output: "rgba8" },
    "worldsrgb,fused": { world: "srgb8", output: "fused" },
    world11: { world: "r11g11b10f", output: "rgba8" },
  };
  if (withDirect) setups.direct = { world: "direct", output: "none" };
  return setups;
}

/**
 * Pixel A/B of post chains on THIS GPU (`?diag=postab` → `givrePost.ab()` in
 * the console): the current view rendered with the reference chain, then
 * with each of `setups`, read back from the canvas (RGBA) — all in one task,
 * so the scene does not move in between. `repeat` = the reference drawn
 * again (0 expected). The session's chain is restored afterwards.
 */
export function abPostChains(
  chain: { current(): GivrePostSetup; set(setup: GivrePostSetup): void; render(): void },
  gl: WebGL2RenderingContext,
  setups: Record<string, GivrePostSetup>,
): Record<string, PixelDiff> {
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const grab = (): Uint8Array => {
    chain.render();
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const saved = { ...chain.current() };
  const result: Record<string, PixelDiff> = {};
  try {
    chain.set({ ...GIVRE_POST_REFERENCE });
    grab();
    const ref = grab();
    for (const [name, setup] of Object.entries(setups)) {
      chain.set(setup);
      grab(); // first frame: new targets (and programs for `direct`)
      result[name] = diffPixels(ref, grab());
    }
    chain.set({ ...GIVRE_POST_REFERENCE });
    result.repeat = diffPixels(ref, grab());
  } finally {
    chain.set(saved);
  }
  return result;
}

type RenderFn = Pass["render"];

/**
 * Routes the output pass → FXAA hand-over (see the module comment). Patches
 * the two passes' render() / setSize() in place (after asFullscreenPass):
 * they stay the composer's passes, at the same places.
 */
export class GivreOutputChain {
  /** `rgba8` route: sRGB values for FXAA, no depth / stencil. GPU memory at its first use. */
  readonly intermediate: THREE.WebGLRenderTarget;
  /** `fused` / `fused8` routes: OutputPass + FXAA in one pass (each created at its first use). */
  private readonly fusedPasses: { exact: OutputFXAAPass | null; bits8: OutputFXAAPass | null } = { exact: null, bits8: null };
  /** `none` route with FXAA off: the encoded world copied to the canvas. */
  private copyPass: ShaderPass | null = null;
  private width = 1;
  private height = 1;
  /** Hand-over of the current frame: what the FXAA pass reads (null = its readBuffer). */
  private source: THREE.WebGLRenderTarget | null = null;
  private fuseNext: OutputFXAAPass | null = null;

  constructor(
    output: OutputPass & { material: THREE.Material },
    fxaa: FXAAPass,
    public route: GivreOutputRoute,
  ) {
    this.intermediate = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false });
    this.intermediate.texture.name = "GivreComposer.output8";
    const outputRender: RenderFn = output.render.bind(output);
    const fxaaRender: RenderFn = fxaa.render.bind(fxaa);
    const outputSetSize = output.setSize.bind(output);
    const fxaaSetSize = fxaa.setSize.bind(fxaa);

    output.render = (renderer, writeBuffer, readBuffer, deltaTime, maskActive) => {
      this.source = null;
      this.fuseNext = null;
      const route = this.route;
      if (output.renderToScreen) {
        // FXAA off (MSAA / none): this pass draws the canvas, as before.
        output.needsSwap = true;
        if (route === "none") {
          const copy = this.copy();
          copy.renderToScreen = true;
          copy.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
        } else outputRender(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
        return;
      }
      if (route === "half") {
        output.needsSwap = true;
        outputRender(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
        return;
      }
      output.needsSwap = false;
      if (route === "rgba8") {
        outputRender(renderer, this.intermediate, readBuffer, deltaTime, maskActive);
        this.source = this.intermediate;
      } else {
        // fused / fused8 / none: FXAA reads the world target itself.
        this.source = readBuffer;
        this.fuseNext = route === "none" ? null : this.fused(route === "fused8");
      }
    };

    fxaa.render = (renderer, writeBuffer, readBuffer, deltaTime, maskActive) => {
      const source = this.source;
      const fused = this.fuseNext;
      this.source = null;
      this.fuseNext = null;
      // Reference route: three's swap after the last pass, as before.
      // Others: the world keeps its buffer from frame to frame.
      fxaa.needsSwap = source === null;
      if (fused && source) {
        fused.renderToScreen = fxaa.renderToScreen;
        fused.render(renderer, writeBuffer, source, deltaTime, maskActive);
      } else fxaaRender(renderer, writeBuffer, source ?? readBuffer, deltaTime, maskActive);
    };

    output.setSize = (width: number, height: number) => {
      outputSetSize(width, height);
      this.width = width;
      this.height = height;
      this.intermediate.setSize(width, height);
    };
    fxaa.setSize = (width: number, height: number) => {
      fxaaSetSize(width, height);
      this.fusedPasses.exact?.setSize(width, height);
      this.fusedPasses.bits8?.setSize(width, height);
    };
  }

  private fused(bits8: boolean): OutputFXAAPass {
    const key = bits8 ? "bits8" : "exact";
    let pass = this.fusedPasses[key];
    if (!pass) {
      pass = asFullscreenPass(new OutputFXAAPass(bits8 ? 8 : null));
      pass.setSize(this.width, this.height);
      this.fusedPasses[key] = pass;
    }
    return pass;
  }

  private copy(): ShaderPass {
    if (!this.copyPass) {
      const pass = new ShaderPass(CopyShader);
      pass.material.blending = THREE.NoBlending;
      pass.material.name = "GivreDirectCopy";
      this.copyPass = asFullscreenPass(pass);
    }
    return this.copyPass;
  }

  dispose(): void {
    this.intermediate.dispose();
    this.fusedPasses.exact?.dispose();
    this.fusedPasses.bits8?.dispose();
    this.copyPass?.dispose();
  }
}
