/**
 * The display's frame interval (60 Hz → 16.7 ms, 240 Hz → 4.2 ms), measured
 * ONCE per document. The HUD warm-up's "drawn" tests rely on it
 * (HudWarmup.holdUntilDrawn), and the game page's GPU warm-up waits for it.
 * Its own module so that the game page, which only starts the measurement,
 * does not pull the HUD warm-up code (the HUD lives in its own document).
 *
 * Started at boot — main.ts for the game page, the HUD iframe's entry for its
 * document — while the loading screen mostly waits on downloads. Measured
 * later — during the shader compile the HUD warm-up runs alongside
 * (Game.warmUpRendering, step 3a), whose polling delays some frames — it
 * could read 2× too long at 240 Hz, and every "on time" test of
 * holdUntilDrawn would then pass too easily.
 */

let frameMs = 1000 / 60;
let frameMeasure: Promise<void> | null = null;

/** Starts the measurement (once); resolves when it is done. */
export function measureDisplayFrames(): Promise<void> {
  frameMeasure ??= measureFrameInterval();
  return frameMeasure;
}

/** The measured frame interval (ms) — 60 Hz until measureDisplayFrames() resolved. */
export function displayFrameMs(): number {
  return frameMs;
}

/**
 * The second shortest of a dozen frame gaps. A frame comes late when the
 * thread is busy (a multiple of the interval), never early: the shortest
 * gaps are the display's own — the second one ignores a lone outlier.
 */
function measureFrameInterval(): Promise<void> {
  return new Promise((resolve) => {
    const stamps: number[] = [];
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      const gaps = stamps.slice(1).map((t, i) => t - stamps[i]).sort((a, b) => a - b);
      if (gaps.length >= 2) frameMs = Math.min(50, Math.max(4, gaps[1]));
      resolve();
    };
    // Hidden tab (no frames) or a thread busy for 2 s: the 60 Hz default.
    const timer = window.setTimeout(finish, 2000);
    const step = (now: number): void => {
      if (done) return;
      stamps.push(now);
      if (stamps.length < 13) {
        requestAnimationFrame(step);
        return;
      }
      window.clearTimeout(timer);
      finish();
    };
    requestAnimationFrame(step);
  });
}
