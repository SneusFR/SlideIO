// Re-settle the baked layouts with the RUNTIME solver so the shipped Full/Half layouts are exactly at rest.
import { readFileSync, writeFileSync } from "node:fs";
import { PopcornTankSim, PState } from "./PopcornTankSim";
const buf = readFileSync("../PopcornShotgun_Weapon.glb"); const jlen = buf.readUInt32LE(12);
const tank = JSON.parse(buf.subarray(20, 20 + jlen).toString("utf8")).nodes.find((n: any) => n.name === "Tank").extras;
const G = tank.gravityUnitsPerS2, N = tank.count, PER = tank.perShot;
const sim = new PopcornTankSim({ halfExtents: tank.halfExtents, capacity: N, popcornRadius: tank.popcornRadius, kernelRadius: tank.kernelRadius });
for (let i = 0; i < N; i++) { const L = tank.fullLayout[i]; sim.place(i, L[0], L[1], L[2], PState.Popcorn); }
let steps = 0; while ((sim.awake || steps < 60) && steps < 1200) { sim.step(1 / 60, 0, -G, 0); steps++; }
const full = [...Array(N).keys()].map(i => [sim.px[i], sim.py[i], sim.pz[i]]);
const order = [...Array(N).keys()].sort((a, b) => sim.py[a] - sim.py[b]);
order.slice(0, PER).forEach(i => sim.consume(i));
let s2 = 0; while ((sim.awake || s2 < 60) && s2 < 1200) { sim.step(1 / 60, 0, -G, 0); s2++; }
const halfIdx = order.slice(PER);
const halfPos = halfIdx.map(i => [sim.px[i], sim.py[i], sim.pz[i]]);
writeFileSync("../popcorn_bake_ts.json", JSON.stringify({ full, order, halfIdx, halfPos }));
console.log("full settled in", steps, "steps; half settled in", s2, "steps; sleeping:", !sim.awake);
