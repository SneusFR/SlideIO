/**
 * Recent gameplay events (kill, death, shot, damage…), quoted by the debug
 * HUD's "Hitch" line: a frame that came late right after a kill or a death
 * says so, so a hitch can be tied to what triggered it without a profiler.
 * A few dozen timestamps in a ring — free to call from game code.
 */
interface FrameEvent {
  t: number;
  label: string;
}

const RING = 32;
const ring: FrameEvent[] = [];

/** Records `label` now (bursts of the same label within 50 ms count once). */
export function noteFrameEvent(label: string): void {
  const t = performance.now();
  const last = ring[ring.length - 1];
  if (last && last.label === label && t - last.t < 50) return;
  ring.push({ t, label });
  if (ring.length > RING) ring.shift();
}

/** Distinct labels recorded in [from, to] (performance.now() ms), oldest first. */
export function frameEventsBetween(from: number, to: number): string[] {
  const out: string[] = [];
  for (const e of ring) {
    if (e.t < from || e.t > to) continue;
    if (!out.includes(e.label)) out.push(e.label);
  }
  return out;
}
