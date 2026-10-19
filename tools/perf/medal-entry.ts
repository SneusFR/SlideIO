import { MedalHUD } from "../../src/ui/MedalHUD";
import { MedalManager } from "../../src/medals/MedalManager";
import { KillMethod } from "../../src/combat/KillMethod";

/**
 * Medal bench entry (tools/perf/medal-bench.mjs): the REAL MedalHUD driven by
 * the REAL MedalManager in REAL time (rAF), exactly like Game.ts does —
 * `kill(n)` = a confirmed local kill with combo count n. Exposed as
 * window.medalBench; `frames()` returns the rAF intervals since the last call.
 */
const manager = new MedalManager(new MedalHUD());
let last = performance.now();
let gaps: number[] = [];
const tick = (now: number): void => {
  const dt = (now - last) / 1000;
  gaps.push(now - last);
  last = now;
  manager.update(Math.min(dt, 1 / 30));
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);

(window as unknown as { medalBench: unknown }).medalBench = {
  kill(count = 1): void {
    manager.onPlayerKill(count, KillMethod.PAINTBALL_RIFLE, false);
  },
  frames(): number[] {
    const out = gaps;
    gaps = [];
    return out;
  },
};
