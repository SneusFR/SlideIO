/**
 * BOOT TIMELINE — where the loading screen's time goes (page open → menu).
 *
 * Each step of the single loading phase marks its END; one console line sums
 * them up once the menu is revealed (DEV and production):
 *
 *   [BOOT] menu en 4.1 s — page 0.42 · physique 0.08 · carte 0.95 · …
 *
 * The first slice ("page") runs from the navigation start to the first line
 * of the game script: HTML, script download / parse / evaluation. The
 * numbers are wall-clock and the steps overlap (downloads started early run
 * behind later steps): each slice is the time the loading screen waited on
 * that step. `bootTimeline()` returns the same slices as data.
 */

interface BootMark {
  label: string;
  t: number;
}

const marks: BootMark[] = [];
let reported = false;

/** End of a boot step (performance.now() clock: 0 = navigation start). */
export function bootMark(label: string): void {
  if (reported) return;
  marks.push({ label, t: performance.now() });
  // Visible in DevTools > Performance ("Timings" track) as `boot:<label>`.
  performance.mark(`boot:${label}`);
}

/** The boot slices so far: label + duration (ms), in order. */
export function bootTimeline(): { label: string; ms: number }[] {
  let prev = 0;
  return marks.map((m) => {
    const ms = m.t - prev;
    prev = m.t;
    return { label: m.label, ms };
  });
}

/** Logs the one-line summary (once) — call when the menu is revealed. */
export function reportBoot(): void {
  if (reported || marks.length === 0) return;
  reported = true;
  const total = marks[marks.length - 1].t;
  const parts = bootTimeline().map((s) => `${s.label} ${(s.ms / 1000).toFixed(2)}`);
  console.info(`[BOOT] menu en ${(total / 1000).toFixed(1)} s — ${parts.join(" · ")}`);
}
