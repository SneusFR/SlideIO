// KILL CASCADE (src/hud/host/killCascade.ts) — a kill's HUD effects start over a few frames instead
// of one. Measured on the PC gamer (RTX 2080 Super, 240 Hz, 23/10): the medal, BEANED!, combo,
// killstreak and leaderboard started in the kill's batch made the game's frame wait for Chrome's
// GPU process 4-8 frames later (4-9 ms, on 5 kills of 17); started over 8 frames (the prototype
// these frame numbers come from): 0 of 11. Pure, no DOM: the schedule at 240 / 144 / 60 Hz, the
// order within each widget, what is never held, the idle pass-through, and HudHost's wiring.
// Usage (repo root):  npx --prefix backend tsx scripts/test-hud-kill-cascade.mts
import assert from "node:assert/strict";
import fs from "node:fs";

const { KillCascade, cascadeOf, cascadeFrames, CASCADE, CASCADE_IDLE_MS } = await import("../src/hud/host/killCascade.ts");

let failures = 0;
const test = (name: string, fn: () => void): void => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}\n     ${(err as Error).message}`);
  }
};

type Cmd = [string, ...unknown[]];

/** A frame loop like HudHost's: commands of a frame → hold() or this frame's batch; release() before posting. */
function loop(hz: number) {
  let now = 1000;
  const c = new KillCascade(() => now);
  const batches: Cmd[][] = [];
  let batch: Cmd[] = [];
  const frame = (cmds: Cmd[] = []): Cmd[] => {
    for (const cmd of cmds) if (!c.hold(cmd as never)) batch.push(cmd);
    c.release((cmd) => batch.push(cmd as Cmd));
    const out = batch;
    batches.push(out);
    batch = [];
    now += 1000 / hz;
    return out;
  };
  for (let i = 0; i < 120; i++) frame(); // the display rate is measured first (menu / play frames)
  return { c, frame, batches, advance: (ms: number) => (now += ms) };
}

/** The commands of a real kill's frame (order of Game.onBotKilled + the frame's HUD updates). */
const KILL_FRAME: Cmd[] = [
  ["hitmarker.show", "BODY", 0.09, true],
  ["damage.hit", "#c3", 12, "BODY", [0, 1, 2], null, true],
  ["combat.kill"],
  ["combo.kill"],
  ["killstreak.render", []],
  ["medal.show", "KILL", 0],
  ["combat.update", 0.004, { current: 100, max: 100, ratio: 1, alive: true }, 0],
  ["combo.update", { active: true, comboCount: 1, ratio: 1, timeRemaining: 5 }],
  ["leaderboard.refresh", []],
];

/** Frame offset (after the kill's frame) of each command's first appearance. */
function schedule(hz: number): Record<string, number> {
  const L = loop(hz);
  const first = L.batches.length;
  L.frame(KILL_FRAME);
  for (let i = 0; i < 20; i++) L.frame([["combo.update", { active: true, comboCount: 1, ratio: 0.99 - i * 0.01, timeRemaining: 4.9 }]]);
  const at: Record<string, number> = {};
  for (let k = first; k < L.batches.length; k++) for (const cmd of L.batches[k]) if (!(cmd[0] in at)) at[cmd[0]] = k - first;
  return at;
}

test("240 Hz: the frames of the measured prototype (hit 0 · medal 2 · BEANED!, combo 4 · killstreak 6 · leaderboard 8)", () => {
  const at = schedule(240);
  assert.equal(at["hitmarker.show"], 0, "the kill hitmarker answers the shot: same frame");
  assert.equal(at["damage.hit"], 0, "the kill number too");
  assert.equal(at["combat.update"], 0, "the frame's other commands are never held");
  assert.equal(at["medal.show"], 2);
  assert.equal(at["combat.kill"], 4);
  assert.equal(at["combo.kill"], 4);
  assert.equal(at["combo.update"], 4, "the combo's state waits behind its kill (same widget, same order)");
  assert.equal(at["killstreak.render"], 6);
  assert.equal(at["leaderboard.refresh"], 8);
});

test("144 Hz and 60 Hz: each group in its own frame, ≈ the same milliseconds (doc table of killCascade.ts)", () => {
  const a144 = schedule(144);
  assert.deepEqual([a144["medal.show"], a144["combat.kill"], a144["combo.kill"], a144["killstreak.render"], a144["leaderboard.refresh"]], [1, 2, 2, 4, 5]);
  const a60 = schedule(60);
  assert.deepEqual([a60["medal.show"], a60["combat.kill"], a60["combo.kill"], a60["killstreak.render"], a60["leaderboard.refresh"]], [1, 2, 2, 3, 4]);
  // never more than 67 ms after the kill, at any rate
  for (const hz of [60, 75, 120, 144, 165, 240, 360]) {
    const at = schedule(hz);
    const lastMs = (Math.max(...Object.values(at)) * 1000) / hz;
    assert.ok(lastMs <= 67 + 1e-9, `${hz} Hz: the leaderboard ${lastMs.toFixed(1)} ms after the kill`);
    const order = [at["medal.show"], at["combat.kill"], at["killstreak.render"], at["leaderboard.refresh"]];
    for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], `${hz} Hz: groups in distinct frames, in order (${order})`);
  }
});

test("cascadeFrames: max(rank, round(ms / frame))", () => {
  for (const g of Object.keys(CASCADE) as (keyof typeof CASCADE)[]) {
    assert.equal(cascadeFrames(g, 1000 / 240), Math.max(CASCADE[g].rank, Math.round(CASCADE[g].ms / (1000 / 240))));
    assert.equal(cascadeFrames(g, 1000), CASCADE[g].rank, "very slow frames: the rank");
  }
});

test("each widget gets its commands in order (combo kill → its updates; medal show → hide)", () => {
  const L = loop(240);
  const first = L.batches.length;
  L.frame([["combo.kill"], ["combo.update", { comboCount: 2 }], ["medal.show", "DOUBLE_KILL", 1]]);
  L.frame([["combo.update", { comboCount: 2, r: 1 }], ["medal.hide"]]); // a death right after: the badge goes
  L.frame([["combo.update", { comboCount: 0 }]]);
  for (let i = 0; i < 10; i++) L.frame();
  const seq = L.batches.slice(first).flat().map((c) => c[0] + (c[0] === "combo.update" ? `:${(c[1] as { comboCount: number }).comboCount}` : ""));
  assert.deepEqual(seq.filter((s) => s.startsWith("combo")), ["combo.kill", "combo.update:2", "combo.update:2", "combo.update:0"]);
  assert.deepEqual(seq.filter((s) => s.startsWith("medal")), ["medal.show", "medal.hide"]);
  assert.equal(L.c.size, 0, "nothing left behind");
});

test("followers alone go at once (the combo burning down, the medal's exit a second later)", () => {
  const L = loop(240);
  assert.deepEqual(L.frame([["combo.update", { comboCount: 1 }], ["medal.exit"], ["medal.hide"]]).map((c) => c[0]), ["combo.update", "medal.exit", "medal.hide"]);
});

test("only the kill effects are ever held (every command of the protocol checked)", () => {
  const protocol = fs.readFileSync(new URL("../src/hud/protocol.ts", import.meta.url), "utf8");
  const names = [...protocol.matchAll(/\|\s*\["([a-z]+\.[a-zA-Z]+)"/g)].map((m) => m[1]);
  assert.ok(names.length >= 30, `protocol commands found: ${names.length}`);
  const held = names.filter((n) => cascadeOf([n] as never) !== null).sort();
  assert.deepEqual(held, ["combat.kill", "combo.kill", "combo.update", "killstreak.ready", "killstreak.render", "leaderboard.refresh", "medal.exit", "medal.hide", "medal.show"].sort());
  const triggers = held.filter((n) => cascadeOf([n] as never)!.trigger).sort();
  assert.deepEqual(triggers, ["combat.kill", "combo.kill", "killstreak.ready", "killstreak.render", "leaderboard.refresh", "medal.show"].sort());
});

test("outside a frame loop (no release for > CASCADE_IDLE_MS): nothing is held", () => {
  const L = loop(240);
  L.advance(CASCADE_IDLE_MS + 5);
  for (const cmd of KILL_FRAME) assert.equal(L.c.hold(cmd as never), false, cmd[0]);
});

test("drain: everything held, now, in order", () => {
  const L = loop(240);
  for (const cmd of KILL_FRAME) L.c.hold(cmd as never);
  const out: string[] = [];
  L.c.drain((cmd) => out.push(cmd[0]));
  assert.deepEqual(out, ["combat.kill", "combo.kill", "killstreak.render", "medal.show", "combo.update", "leaderboard.refresh"]);
  assert.equal(L.c.size, 0);
});

test("HudHost: held only in frame mode, released before each batch is posted, drained on a late fallback; on in the page's host", () => {
  const src = fs.readFileSync(new URL("../src/hud/host/HudHost.ts", import.meta.url), "utf8");
  assert.match(src, /if \(this\.phase === "frame" && this\.cascade\?\.hold\(cmd\)\) return;\s*this\.emitNow\(cmd\);/, "emit: hold in frame mode only, else the old path");
  const flush = src.slice(src.indexOf("  flush(): void {"), src.indexOf("  /** DEV debug line"));
  assert.ok(flush.indexOf("this.cascade?.release(") > 0 && flush.indexOf("this.cascade?.release(") < flush.indexOf('this.post({ t: "batch"'), "flush: release before the post");
  const fall = src.slice(src.indexOf("  private fallBack("), src.indexOf("  private goInline("));
  assert.ok(fall.indexOf("this.cascade?.drain(") > 0 && fall.indexOf("this.cascade?.drain(") < fall.indexOf("this.buffer = ["), "fallBack: drain before the replay buffer is built");
  assert.match(src, /export const hudHost = new HudHost\(\{ killCascade: optSwitch\("killcascade"\)\.on \}\);/);
  assert.match(src, /constructor\(options: \{ killCascade\?: boolean \} = \{\}\)/, "off by default (the host tests' HudHost)");
});

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
