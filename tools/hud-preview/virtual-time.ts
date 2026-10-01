/**
 * Virtual clock for the weapon-HUD preview. MUST be the first import of the
 * entry: it replaces requestAnimationFrame / performance.now so the paint
 * layer (rAF loop) runs on a clock the driver advances by exact steps, and
 * `advance()` also steps every CSS animation / transition (Web Animations),
 * so frame sequences are deterministic and reproducible.
 */
const queue: Array<(t: number) => void> = [];
let vnow = 1000;
let nextId = 0;
const seen = new WeakSet<Animation>();

window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
  queue.push(cb);
  return ++nextId;
};
window.cancelAnimationFrame = (): void => {};
performance.now = (): number => vnow;

/** Pause every animation not yet seen and start it at t = 0 (call after triggers). */
export function freeze(): void {
  for (const a of document.getAnimations()) {
    if (seen.has(a)) continue;
    seen.add(a);
    a.pause();
    a.currentTime = 0;
  }
}

/** Advance the virtual clock by `ms` (paint rAF callbacks + CSS animations). */
export function advance(ms: number): void {
  freeze();
  for (const a of document.getAnimations()) {
    if (a.playState === "paused") a.currentTime = Number(a.currentTime ?? 0) + ms;
  }
  vnow += ms;
  const run = queue.splice(0);
  for (const cb of run) cb(vnow);
}
