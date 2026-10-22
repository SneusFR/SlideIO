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
 *   noguard  no in-match Auto guard (settings/AutoGuard): "Auto" keeps the
 *            detection's answer whatever the match's frame rate (the old
 *            behaviour)
 *   nopowerguard  the guard without power awareness (settings/Power): the
 *            battery is never read, every step waits the normal time before
 *            its rung is tried again — even one taken on battery once the
 *            charger is plugged in
 *   tunemarginNN  the automatic detection measures every rung with NN %
 *            extra pixels on any GPU (default: 30 everywhere); tunemargin50 =
 *            the +50 % variant for integrated GPUs — the A/B to try if the
 *            in-match guard steps down too often in the field; tunemargin0 =
 *            no margin — an answer too heavy for matches on purpose, to watch
 *            the guard step it down. Only the next detection ("Run again")
 *            uses it.
 *   prepass  Givre: depth prepass of the static map (GivreDepthPrepass) —
 *            the map (+ backdrop) drawn depth-only first, then the map's
 *            material shaded ≈ once per covered pixel instead of ≈ 2 times;
 *            same image (checked at load on this GPU: console line
 *            "[GPU] pré-passe…"). Costs the big triangles' vertices twice
 *            + 2 draws: compare the GPU line (`?gpu=draws`: "pré-passe" +
 *            "carte") and the CPU line
 *   noprepass  Givre: no depth prepass (when GivreConfig turns it on)
 *   prepassall  Givre: with `prepass`, every map triangle in it (not only
 *            those ≥ GivreConfig.staticBatching.depthPrepassMinArea m²) —
 *            the vertex cost of a complete prepass
 *   percomponent  Givre: the single-sided rule of the static map (closed,
 *            outward, ≤ 2 m thin solids drawn FrontSide) applied per
 *            connected component of a mesh, not only per whole mesh
 *            (GivreRenderOptim.closedOutwardThinTriangles) — NOT the same
 *            image to the bit (a few pixels per view): an experiment
 *   nohudidle  the HUD document's old permanent frame loop: a main frame at
 *            every refresh even at rest (src/hud/runtime/frameClock.ts) —
 *            the debug line "HUD: … images/s" back at the display rate
 *   hudanim  the HUD's previous animation CSS + Bean Buddy markup: the idle
 *            motions that repainted / re-rasterized at every frame (SVG-child
 *            animations, clip-path / mask on animated elements, the FAMAS
 *            wave's background-position, the K.O. banner's translateX(-50%)
 *            keyframes…) and the medal ribbon tails' filtered shadow (the
 *            ribbon repainted at every frame of a medal's pop) — hud.css
 *            « PERF — animations »
 *   paintssNN  the weapon plate's 3D paint rendered at NN % of the screen's
 *            pixel density per axis instead of 200 % (src/ui/paint/PaintLayer.ts):
 *            its GPU cost on a real GPU (paintss100 ≈ 3× fewer pixels at 1080p)
 *            — NOT the same pixels (less supersampling), an experiment only
 *   paintfpsNN  that paint drawn at most NN times per second while it moves
 *            (default: at every display frame) — a jerkier jelly, an experiment
 *   programsort  Givre: opaques sorted by program, then material, near → far
 *            inside (EXPERIMENT, see world/GivreRenderOptim.ts
 *            programFirstOpaqueSort — meant with the depth prepass)
 *
 * The HUD's own switches reach its document (the HUD iframe has its own
 * address: src/hud/host/HudHost.ts hudDocumentUrl passes `?diag=` on).
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
 * (Session switches — prepass, percomponent: `?diag=<name>` on,
 * `?diag=no<name>` off, see diagSwitch; read once at load.)
 *
 * End of match (src/match/EndScreenPerf.ts) — on by default, these turn ONE
 * change off (same image either way):
 *
 *   noendwarm     the end screen's first use (style sheet, fonts, audio
 *                 context, WebGL context, programs, extruded title) when the
 *                 match ends, as before — no warm-up in the menu's idle slots,
 *                 nothing kept from one end screen to the next
 *   noendcover    the frozen world still drawn every frame behind the end
 *                 screen's snapshot of it, even once that snapshot is known
 *                 opaque everywhere
 *   noendskip     every 3D draw of the end screen, even those that cannot
 *                 change a pixel (backdrop and speed lines at opacity 0, empty
 *                 particle pools, faded cracks)
 *   noendsnap     the snapshot of the frozen world copied whole (8 MB at
 *                 1080p) to test 64 of its pixels, and its glass built
 *                 through growing JS arrays, as before
 *   noendlayout   the results styled and laid out at the default unit first,
 *                 then again at the real one (twice the style + layout of the
 *                 whole end screen in the frame where the match ends)
 *   oldendscreen  all of them: the old end of match, to compare
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

/**
 * An optimisation with a session switch: `?diag=<name>` turns it on,
 * `?diag=no<name>` off (wins), otherwise `defaultOn`.
 */
export function diagSwitch(experiments: ReadonlySet<string>, name: string, defaultOn: boolean): boolean {
  if (experiments.has(`no${name}`)) return false;
  if (experiments.has(name)) return true;
  return defaultOn;
}

/**
 * CPU-side optimisations that change neither the image nor the game (same GL state, same
 * matrices, same HUD) are ON by default; `?diag=no<name>` turns one off from the load, to compare
 * on any machine (see PERFORMANCE.md « Vérifier sur une machine »):
 *
 *   nohudskip       the HUD display-state commands repeated every frame are sent again
 *                   (hud/host/HudProxies.ts)
 *   nouniformcache  three.js's own uniform caches and setters (effects/UniformCacheKinds.ts)
 *   nofreshskip     the renderer's second pass over the map and the FP arms runs again, and
 *                   the frame's pass over the dead bots (effects/matrixFresh.ts)
 *   nokillprep      a corpse's bone textures and fade clones are created in the kill frame
 *                   again, at its first draw (effects/KillPrep.ts)
 *
 * DEV builds expose the live switches as `window.__cpuOpt` (`__cpuOpt.hudskip.on = false`): a
 * headless check compares both paths in the SAME session, on the same frame.
 */
const optSwitches: Record<string, { on: boolean }> = {};

export function optSwitch(name: string): { on: boolean } {
  let s = optSwitches[name];
  if (!s) {
    s = { on: !perfExperiments().has(`no${name}`) };
    optSwitches[name] = s;
    if (import.meta.env?.DEV && typeof window !== "undefined") {
      (window as unknown as Record<string, unknown>).__cpuOpt = optSwitches;
    }
  }
  return s;
}

/**
 * `?diag=hudanim`: the class HudRuntime puts on the HUD document's <html>
 * (the iframe's, or the game page's in the inline fallback). The HUD
 * stylesheets' compositor-only overrides key on its ABSENCE, and CombatHUD
 * then builds the one-SVG Bean Buddy instead of its layers.
 */
export const HUD_ANIM_LEGACY_CLASS = "diag-hudanim";

/** The number of a numbered experiment (`scale50` → 50), or null when absent / invalid. */
export function experimentValue(experiments: ReadonlySet<string>, prefix: string): number | null {
  for (const e of experiments) {
    if (!e.startsWith(prefix)) continue;
    const n = Number(e.slice(prefix.length));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}
