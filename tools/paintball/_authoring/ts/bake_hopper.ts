// tsx bake_hopper.ts  -> hopper_bake.json (settled full layout + one layout per ball count, runtime solver)
import { writeFileSync } from "node:fs";
import { PaintballHopperSim, BState } from "./PaintballHopperSim";

const cfg = { capacity: 32, ballRadius: 0.1456, innerRadius: 0.3402, xMin: -1.554, xMax: 1.526, feedX: -0.3836,
  vSlope: Math.tan((7 * Math.PI) / 180) };
const G = 9.81 / (0.19 * 0.4);          // physical gravity in FP weapon units / s²
const sim = new PaintballHopperSim(cfg);
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
for (let i = 0; i < cfg.capacity; i++) {
  sim.place(i, cfg.xMin + 0.25 + rnd() * (cfg.xMax - cfg.xMin - 0.5), -0.05 + rnd() * 0.3, (rnd() - 0.5) * 0.3);
}
const dt = 1 / 60;
const run = (sec: number) => { for (let k = 0; k < sec / dt; k++) sim.step(dt, 0, -G, 0); };
run(4.0);
const snap = () => Array.from({ length: cfg.capacity }, (_, i) => sim.state[i] === BState.Active
  ? [+sim.px[i].toFixed(5), +sim.py[i].toFixed(5), +sim.pz[i].toFixed(5)] : null);
const full = snap();
// overlap check
let minD = 9;
for (let i = 0; i < 32; i++) for (let j = i + 1; j < 32; j++) {
  const d = Math.hypot(sim.px[i] - sim.px[j], sim.py[i] - sim.py[j], sim.pz[i] - sim.pz[j]); minD = Math.min(minD, d);
}
let topY = -9; for (let i = 0; i < 32; i++) topY = Math.max(topY, sim.py[i] + cfg.ballRadius);
console.log("full: min dist/2r", (minD / (2 * cfg.ballRadius)).toFixed(3), "top of pile", topY.toFixed(3), "ceiling", cfg.innerRadius, "asleep", !sim.awake);
const layouts: (number[] | null)[][] = [];
layouts[32] = full;
const order: number[] = [];
for (let n = 31; n >= 0; n--) {
  const i = sim.nearestToFeed(0, -G, 0);
  order.push(i);
  sim.feed(i);
  run(0.6);
  layouts[n] = snap();
}
const colors = Array.from({ length: 32 }, (_, i) => i % 3);
for (let i = 31; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [colors[i], colors[j]] = [colors[j], colors[i]]; }
writeFileSync("../hopper_bake.json", JSON.stringify({ cfg, gravity: G, full, layouts, feedOrder: order, colors }));
console.log("feed order", order.join(","));
