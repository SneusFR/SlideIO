// HUD warm-up × medal badge looks (src/medals/medalLooks.ts, src/ui/HudWarmup.ts).
// Measured on the PC gamer (22/10, RTX 2080 Super, 240 Hz): the first badge of a look the
// warm-up never drew cost ~12-14 ms of Chrome's GPU process at its first appearance (the first
// HEADSHOT of the session: a 16.7 ms frame = game 3.4 + browser 0.6 + GPU wait ~12; the second
// one: nothing). The star count changes how the badge is built. This test plays every medal
// chain the game can produce through the REAL MedalManager and checks that the warm-up draws
// each look the badge can take (each star count outside the hype look, the hype look), and
// that HudWarmup's passes draw exactly WARM_MEDAL_LOOKS. Pure, no DOM.
// Usage (repo root):  npx --prefix backend tsx scripts/test-hud-warmup-medals.mts
import assert from "node:assert/strict";
import fs from "node:fs";

const { MedalManager } = await import("../src/medals/MedalManager.ts");
const { MedalType } = await import("../src/medals/MedalType.ts");
const { MedalConfig, MedalStyles } = await import("../src/medals/MedalConfig.ts");
const { KillMethod } = await import("../src/combat/KillMethod.ts");
const { medalLook, WARM_MEDAL_LOOKS, HYPE_CHAIN } = await import("../src/medals/medalLooks.ts");

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

type Shown = { medal: string; chainIndex: number };

/** Plays `kills` (one combo) through the real MedalManager; returns every badge shown. */
function play(kills: { method: string; head: boolean }[], perFrame = 1): Shown[] {
  const shown: Shown[] = [];
  const m = new MedalManager({
    show: (medal, chainIndex) => shown.push({ medal, chainIndex }),
    beginExit: () => {},
    hide: () => {},
  });
  const dt = 1 / 60;
  let count = 0;
  for (let i = 0; i < kills.length; i += perFrame) {
    for (const k of kills.slice(i, i + perFrame)) m.onPlayerKill(++count, k.method as never, k.head);
    for (let f = 0; f < 6; f++) m.update(dt); // a few frames between two kills
  }
  for (let f = 0; f < 60 * 20; f++) m.update(dt); // drain the queue
  m.resetChain();
  return shown;
}

// Every chain the game can produce: 1-4 kills per combo, each a body shot or a headshot
// (paintball / FAMAS…), or a special method (hammer, slam, lance rush, mole strike); several
// kills in one frame too (a ground slam killing 3).
const methods = [KillMethod.PAINTBALL_RIFLE, KillMethod.HAMMER_SWING, KillMethod.GROUND_SLAM, KillMethod.SPEAR_RUSH, KillMethod.MOLE_STRIKE];
const reachable = new Map<string, { stars: number; hype: boolean; example: string }>();
for (let n = 1; n <= 4; n++) {
  const patterns: { method: string; head: boolean }[][] = [[]];
  for (let i = 0; i < n; i++) {
    const next: { method: string; head: boolean }[][] = [];
    for (const p of patterns) {
      for (const method of methods) {
        next.push([...p, { method, head: false }]);
        if (method === KillMethod.PAINTBALL_RIFLE) next.push([...p, { method, head: true }]);
      }
    }
    patterns.splice(0, patterns.length, ...next);
  }
  for (const p of patterns) {
    for (const perFrame of [1, n]) {
      for (const s of play(p, perFrame)) {
        const look = medalLook(s.medal as never, s.chainIndex);
        const key = `${look.stars}/${look.hype}`;
        if (!reachable.has(key)) reachable.set(key, { stars: look.stars, hype: look.hype, example: `${s.medal} #${s.chainIndex}` });
      }
    }
  }
}
const warmed = WARM_MEDAL_LOOKS.map(([medal, chainIndex]) => medalLook(medal, chainIndex));

test("the chains reach the looks the measurements are about (no star, two stars, hype)", () => {
  assert.ok(reachable.has("0/false"), "a medal without star outside the hype look (HEADSHOT after KILL)");
  assert.ok(reachable.has("2/false"), "DOUBLE KILL before any hype");
  assert.ok([...reachable.values()].some((l) => l.hype), "a hype look");
});

test("every star count the badge shows outside the hype look is warmed outside it too", () => {
  for (const l of reachable.values()) {
    if (l.hype) continue;
    assert.ok(warmed.some((w) => w.stars === l.stars && !w.hype), `stars ${l.stars} (e.g. ${l.example}) never drawn by the warm-up`);
  }
});

test("every star count the badge shows is warmed, and the hype look is warmed", () => {
  for (const l of reachable.values()) assert.ok(warmed.some((w) => w.stars === l.stars), `stars ${l.stars} (e.g. ${l.example})`);
  if ([...reachable.values()].some((l) => l.hype)) assert.ok(warmed.some((w) => w.hype), "no hype look in the warm-up");
});

test("a medal style with a new star count would fail here (styles known)", () => {
  const counts = new Set(Object.values(MedalStyles).map((s) => s.stars));
  for (const c of counts) assert.ok(warmed.some((w) => w.stars === c), `a medal style has ${c} star(s), no warmed look has`);
});

test("medalLook = what MedalHUD.show sets (stars, hype from the chain, label, colour)", () => {
  for (const medal of Object.values(MedalType)) {
    for (const chainIndex of [0, 1, HYPE_CHAIN, HYPE_CHAIN + 3]) {
      const l = medalLook(medal, chainIndex);
      assert.equal(l.stars, MedalStyles[medal].stars);
      assert.equal(l.label, MedalStyles[medal].label);
      assert.equal(l.color, MedalStyles[medal].color);
      assert.equal(l.hype, chainIndex >= HYPE_CHAIN);
    }
  }
  const hud = fs.readFileSync(new URL("../src/ui/MedalHUD.ts", import.meta.url), "utf8");
  assert.match(hud, /const look = medalLook\(medal, chainIndex\)/, "MedalHUD.show must read medalLook");
  assert.ok(!/MedalStyles/.test(hud), "MedalHUD must not read MedalStyles directly (one rule)");
});

test("HudWarmup's passes draw exactly WARM_MEDAL_LOOKS, each in a pass of warmUpHud", () => {
  const src = fs.readFileSync(new URL("../src/ui/HudWarmup.ts", import.meta.url), "utf8");
  const calls = [...src.matchAll(/medalOn\(p, MedalType\.(\w+), (\d+), "pop-[ab]"\)/g)].map((m) => `${m[1]}/${m[2]}`).sort();
  const want = WARM_MEDAL_LOOKS.map(([medal, i]) => `${medal}/${i}`).sort();
  assert.deepEqual(calls, want);
  for (const fn of ["killLook", "chainLook", "specialLook", "rareLooks"]) {
    assert.match(src, new RegExp(`await warmPass\\(${fn},`), `${fn} is not a warm-up pass`);
  }
  // The real timing: the badge after the combo medal shows ~1.4 s after the kill (enter + hold + exit + gap).
  const after = MedalConfig.medalEnterDuration + MedalConfig.medalDisplayDuration + MedalConfig.medalExitDuration + MedalConfig.medalQueueDelay;
  assert.ok(after > 1.2 && after < 1.6, `second medal ${after.toFixed(2)} s after the first (specialLook's comment)`);
});

console.log(`\nreachable looks: ${[...reachable.entries()].map(([k, v]) => `${k} (${v.example})`).join(", ")}`);
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
