import { perfExperiments } from "../ui/perfDiag";

/**
 * PERF — the end of a match on the Iris Xe laptop (production, 1080p): ONE
 * main-thread frame of 133-166 ms where the match ends (the end screen's WebGL
 * context, programs, extruded title, style sheet and fonts all created in it),
 * then 52-54 FPS on the end screen (the frozen world still drawn behind the
 * end screen's snapshot of it, and two full-screen 3D passes drawn at
 * opacity 0). Each change has its `?diag=` switch (production included):
 *
 *   warm   the end screen's first-time work done in the menu's idle time
 *          (EndScreen.prewarm: style sheet, fonts, audio context, 3D intro),
 *          then kept from one end screen to the next (replays)
 *                                                         — off: `noendwarm`
 *   cover  no world render once the snapshot covering it is known opaque
 *          everywhere (read band by band over the first frames of the
 *          intro)                                         — off: `noendcover`
 *   skip   no 3D draw of the intro that cannot change a pixel (backdrop and
 *          speed lines at opacity 0, empty particle pools…) — off: `noendskip`
 *   snap   the snapshot of the frozen world and its glass: no copy of the
 *          whole frame to test 64 of its pixels (the 64 samples alone are
 *          read); the shattered glass built straight into typed arrays
 *          (same geometry bit for bit, 3× less CPU)
 *                                                         — off: `noendsnap`
 *   layout the results' unit (--u) set before their content is built: its
 *          style and layout computed once, at the final size, instead of
 *          once at the default unit and again at the real one
 *                                                         — off: `noendlayout`
 *
 * `?diag=oldendscreen` = all of them off (the old end of match, to compare).
 */
export interface EndScreenPerf {
  warm: boolean;
  cover: boolean;
  skip: boolean;
  snap: boolean;
  layout: boolean;
}

export function endScreenPerf(experiments: ReadonlySet<string> = perfExperiments()): EndScreenPerf {
  const old = experiments.has("oldendscreen");
  return {
    warm: !old && !experiments.has("noendwarm"),
    cover: !old && !experiments.has("noendcover"),
    skip: !old && !experiments.has("noendskip"),
    snap: !old && !experiments.has("noendsnap"),
    layout: !old && !experiments.has("noendlayout"),
  };
}
