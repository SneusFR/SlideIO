// Shared driver helpers for the leaderboard preview (see leaderboard.mjs).
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch } from "./cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export async function open(width) {
  const height = Math.round(width * 0.56);
  const b = await launch({ width, height, url: pathToFileURL(resolve(here, "leaderboard.html")).href });
  const J = (expr) => b.eval(`JSON.stringify(${expr})`).then(JSON.parse);
  const run = (expr) => b.eval(expr);
  const settle = async (ms) => {
    await run(`window.lb.step(${ms})`);
    await new Promise((r) => setTimeout(r, 40)); // let Chrome dispatch finish / cancel events
  };

  /** Clip around the leaderboard (CSS px) + its box. */
  async function box(pad = 24) {
    const bx = await J("window.lb.box()");
    return { x: Math.max(0, bx.x - pad), y: Math.max(0, bx.y - pad - 20), width: bx.w + pad * 2, height: bx.h + pad * 2 + 30, bx };
  }

  /** Load a scenario's initial board, then feed its timed updates; onFrame(frameIndex, t) runs before each step. */
  async function play(id, until = Infinity, onFrame = null, stepMs = 50) {
    const sc = await J(`window.lb.scenarios[${JSON.stringify(id)}]`);
    await run(`window.lb.load(${JSON.stringify(sc.init)})`);
    await settle(100);
    let t = 0;
    const pending = [...sc.steps];
    for (let f = 0; t <= until; f++) {
      while (pending.length && pending[0].t <= t) await run(`window.lb.apply(${JSON.stringify(pending.shift().scores)})`);
      if (onFrame) await onFrame(f, t);
      await settle(stepMs);
      t += stepMs;
    }
    return sc;
  }
  return { b, J, run, settle, box, play };
}
