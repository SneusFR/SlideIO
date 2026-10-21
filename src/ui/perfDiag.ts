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
 *   tunemarginNN  the automatic detection measures every rung with NN %
 *            extra pixels on any GPU (tunemargin30 = the old rule; default:
 *            50 on integrated GPUs, 30 elsewhere); tunemargin0 = no margin —
 *            an answer too heavy for matches on purpose, to watch the guard
 *            step it down. Only the next detection ("Run again") uses it.
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
