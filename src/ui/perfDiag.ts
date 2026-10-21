/**
 * Performance diagnostics on ANY build — production included — from the
 * address bar, so that a machine without `npm run dev` (a work PC, a
 * friend's laptop…) can be measured with the debug HUD:
 *
 *   ?gpu        GPU line per pass (world, arms, sRGB output, FXAA…) + the
 *               per-section CPU split of the Hitch line
 *   ?gpu=draws  the GPU line per draw category instead (map, sky, snow,
 *               halos, bots…) — what `perfDebug.gpu(true)` does in DEV
 *   ?gpu=off    neither (DEV builds have the per-pass line by default)
 *
 * The GPU line needs EXT_disjoint_timer_query_webgl2 (Chrome / Edge on
 * desktop); without it, it says so. The per-draw split costs a timer query
 * per change of category: measure with it, play without it.
 */
export type PerfDiag = "off" | "passes" | "draws";

export function perfDiag(search: string = typeof location === "undefined" ? "" : location.search): PerfDiag {
  const value = new URLSearchParams(search).get("gpu");
  if (value === null) return import.meta.env.DEV ? "passes" : "off";
  if (value === "draws") return "draws";
  return value === "off" || value === "0" ? "off" : "passes";
}

/**
 * `?diag=a,b,…` — what-if experiments that locate where a machine's frame
 * time goes, on any build (production included; nothing changes without the
 * parameter). Each one removes or adds ONE cost; compare the debug HUD's FPS
 * / Frame / CPU / Browser / GPU lines with and without it:
 *
 *   empty    no 3D render at all (simulation, HUD, audio… still run): what
 *            is left is the page's own cost (HUD, browser, compositing)
 *   nopost   Givre: the world drawn straight to the canvas — no HDR target,
 *            no output / FXAA pass
 *   scaleNN  the 3D rendered at NN % of its resolution (scale50: a quarter
 *            of the pixels): FPS almost doubling = the frame is fill-bound
 *   cpuNN    NN ms of extra CPU work at the end of each game frame: FPS
 *            unchanged = the CPU and the GPU work in parallel; FPS dropping
 *            by as much = they wait for each other (something serializes)
 *   noflush  no gl.flush() at the pass boundaries (Game.flushGpu): the old
 *            submission, to compare
 *
 * Givre post chain — memory traffic of the fullscreen steps on an iGPU
 * (effects/GivrePostChain; each one measured in PERFORMANCE.md « La chaîne
 * de post-traitement »; with FXAA — LOW / Auto — unless noted):
 *   out8      the sRGB output pass writes a dedicated RGBA8 image for FXAA
 *             (4 + 4 B/px) instead of a 2nd RGBA16F one (8 + 8). ≤ 1 level
 *             of difference (quantization before FXAA's blends)
 *   fused     no intermediate image at all: FXAA reads the world and
 *             converts each texel itself (more ALU, 16 B/px less); its
 *             bilinear blends by hand with exact weights
 *   fused8    the same with 8-bit sub-texel weights (what most desktop GPU
 *             samplers compute — the closer to the reference depends on the
 *             GPU: postab tells)
 *   world11   world target in R11F_G11F_B10F (4 B/px instead of 8; MSAA too):
 *             a few levels of difference (6 / 6 / 5-bit mantissas)
 *   worldsrgb world target in SRGB8_ALPHA8 (4 B/px): 8-bit storage, values
 *             clamped to 1 before the output (halos)
 *   direct    Givre drawn like Jungle / Yard (the materials encode sRGB,
 *             transparent effects blend in sRGB space: a VISUAL change),
 *             into an RGBA8 target that FXAA reads — no output pass. Ignored
 *             while the cel-shading outline feature is on
 * They combine (`?diag=worldsrgb,fused`); `direct` overrides the other four;
 * world11 / worldsrgb alone come with out8.
 *   postref   the reference chain, whatever the default (GIVRE_POST_DEFAULT)
 *   postab    `givrePost.ab()` in the console: the current view drawn with
 *             each chain, compared pixel by pixel with the reference ON THIS
 *             GPU (`givrePost.ab(true)` adds `direct` — compiles every
 *             program's sRGB variant once: a long freeze)
 *
 * Several at once: `?diag=noflush,scale50`. Never for normal play.
 */
export function perfExperiments(search: string = typeof location === "undefined" ? "" : location.search): ReadonlySet<string> {
  const value = new URLSearchParams(search).get("diag");
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** The number of a numbered experiment (`scale50` → 50), or null when absent / invalid. */
export function experimentValue(experiments: ReadonlySet<string>, prefix: string): number | null {
  for (const e of experiments) {
    if (!e.startsWith(prefix)) continue;
    const n = Number(e.slice(prefix.length));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}
