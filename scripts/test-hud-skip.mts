// HUD FACADES — repeats not sent (HudProxies `skipRepeats`, `?diag=nohudskip` turns it off): a
// display-state command identical to the last one SENT for its widget is skipped, everything else
// goes out exactly as before, in the same order. Checked on long random call sequences: the stream
// sent with the skip equals the full stream minus exactly the commands that are no-ops for their
// widget (same value as the last one sent, no visibility change in between, no pulse request since
// the last flush), and nothing that advances with the frame delta or reports an event is ever
// dropped. (That each skipped command is a no-op for its widget is the widgets' own last-value
// checks — see each facade; the browser check `tools/perf/hud-skip-check.mjs` compares the HUD's
// DOM after every step with and without the skip.)
// Usage (repo root):  npx tsx scripts/test-hud-skip.mts
import assert from "node:assert/strict";
import * as THREE from "three";
import { createHudProxies } from "../src/hud/host/HudProxies.ts";
import type { HudCommand } from "../src/hud/protocol.ts";

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

let seed = 0x2f6b9a1d;
const rnd = (): number => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 4294967296;
};
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];

const camera = new THREE.PerspectiveCamera();
camera.updateMatrixWorld();
const health = { alive: true, current: 100, max: 100, ratio: 1 };

/** One random game frame of HUD calls (the Game's per-frame order, plus random events). */
function frameCalls(api: ReturnType<typeof createHudProxies>, s: Record<string, unknown>): void {
  // mutate a small state space so repeats are frequent (like real frames)
  if (rnd() < 0.1) s.weapon = pick(["popcorn", "paintball", "famas", "frisbee"]);
  if (rnd() < 0.2) s.ammo = pick([0, 3, 7]);
  if (rnd() < 0.1) s.reload = !s.reload;
  if (rnd() < 0.15) s.serial = (s.serial as number) + 1;
  if (rnd() < 0.1) s.spearOn = !s.spearOn;
  if (rnd() < 0.2) s.rush = pick([0, 0.5, 1.25]);
  if (rnd() < 0.05) s.rushing = !s.rushing;
  if (rnd() < 0.2) s.dash = pick([0, 0.4, 0.8]);
  if (rnd() < 0.05) s.dashing = !s.dashing;
  if (rnd() < 0.1) s.combo = pick([null, [1, 0.5, 2], [2, 0.25, 0.5]]);
  if (rnd() < 0.1) s.aim = !s.aim;
  if (rnd() < 0.05) s.down = !s.down;
  if (rnd() < 0.1) s.getUp = !s.getUp;
  if (rnd() < 0.1) api.crosshair.fire("medium");
  if (rnd() < 0.1) api.hitmarker.show(0 as never, undefined, rnd() < 0.2);
  if (rnd() < 0.03) api.combo.notifyKill();
  api.crosshair.setAiming(s.aim as boolean);
  api.damageNumbers.update(1 / 60, camera);
  api.crosshair.flush();
  api.hitmarker.flush();
  api.combat.update(1 / 60, health as never, 0);
  api.combat.setKnockdown(s.down as boolean, s.getUp as boolean);
  api.dash.update(1 / 60, { dashCooldownRemaining: s.dash as number, isDashing: s.dashing as boolean });
  api.spear.setVisible(s.spearOn as boolean);
  api.spear.update({ rushCooldownRemaining: s.rush as number, isRushing: s.rushing as boolean });
  for (const id of ["popcorn", "paintball", "famas", "frisbee"] as const) {
    api[id].setVisible(s.weapon === id);
  }
  const ammo = { ammo: s.ammo as number, isReloading: s.reload as boolean };
  api.popcorn.update({ ...ammo, shotSerial: s.serial as number });
  api.paintball.update(ammo);
  api.famas.update(ammo);
  api.frisbee.update({ deckLoaded: (s.ammo as number) > 0, cageCount: 2, discInHand: !s.reload, isReloading: s.reload as boolean, shotSerial: s.serial as number });
  const c = s.combo as [number, number, number] | null;
  api.combo.update(c ? { active: true, comboCount: c[0], ratio: c[1], timeRemaining: c[2] } : { active: false, comboCount: 0, ratio: 0, timeRemaining: 0 });
  api.clock.set(300 - (s.frame as number) / 60);
  s.frame = (s.frame as number) + 1;
}

const freshState = (): Record<string, unknown> => ({
  weapon: "popcorn", ammo: 7, reload: false, serial: 0, spearOn: false, rush: 0, rushing: false,
  dash: 0, dashing: false, combo: null, aim: false, down: false, getUp: false, frame: 0,
});

/** Widget a command belongs to (the unit whose "last sent" decides a repeat). */
function widgetOf(cmd: HudCommand): string {
  switch (cmd[0]) {
    case "plate.visible":
      return `plate:${cmd[1]}`;
    case "plate.popcorn":
    case "plate.paintball":
    case "plate.famas":
    case "plate.frisbee":
      return `plate:${cmd[0].slice(6)}`;
    default:
      return cmd[0].split(".")[0];
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

test("the skipped stream = the full stream minus its no-op repeats (20 000 random frames)", () => {
  const full: HudCommand[][] = [];
  const kept: HudCommand[][] = [];
  const a = createHudProxies((c) => full[full.length - 1].push(c), { skipRepeats: false });
  const b = createHudProxies((c) => kept[kept.length - 1].push(c), { skipRepeats: true });
  seed = 0x2f6b9a1d;
  const sa = freshState();
  const sb = freshState();
  let skipped = 0;
  let total = 0;
  // Reference filter: what may be dropped, computed from the FULL stream.
  const lastSent = new Map<string, HudCommand>();
  let pulse = { crosshair: true, hitmarker: true };
  for (let f = 0; f < 20000; f++) {
    full.push([]);
    kept.push([]);
    const saved = seed;
    frameCalls(a, sa);
    seed = saved; // the same random calls for both facades
    frameCalls(b, sb);
    const expect: HudCommand[] = [];
    for (const cmd of full[f]) {
      total++;
      let drop = false;
      switch (cmd[0]) {
        case "crosshair.fire":
          pulse.crosshair = true;
          break;
        case "hitmarker.show":
          pulse.hitmarker = true;
          break;
        case "crosshair.flush":
          drop = !pulse.crosshair;
          pulse.crosshair = false;
          break;
        case "hitmarker.flush":
          drop = !pulse.hitmarker;
          pulse.hitmarker = false;
          break;
        case "combat.knockdown":
        case "crosshair.aim":
        case "spear.visible":
        case "spear.update":
        case "combo.update":
        case "plate.visible":
        case "plate.popcorn":
        case "plate.paintball":
        case "plate.famas":
        case "plate.frisbee": {
          const key = cmd[0] === "plate.visible" ? `plate.visible:${cmd[1]}` : cmd[0];
          const prev = lastSent.get(key);
          drop = prev !== undefined && same(prev, cmd);
          if (!drop) {
            lastSent.set(key, cmd);
            // a visibility change makes the next update of that widget go out
            if (cmd[0] === "plate.visible") lastSent.delete(`plate.${cmd[1]}`);
            if (cmd[0] === "spear.visible") lastSent.delete("spear.update");
          }
          break;
        }
        case "dash.update": {
          const prev = lastSent.get("dash.update");
          drop = prev !== undefined && same(prev[2], cmd[2]); // the widget ignores the delta
          if (!drop) lastSent.set("dash.update", cmd);
          break;
        }
        default:
          break; // never dropped
      }
      if (drop) skipped++;
      else expect.push(cmd);
    }
    assert.deepEqual(kept[f], expect, `frame ${f}`);
  }
  assert.ok(skipped > total * 0.4, `most per-frame state commands are repeats (${skipped} / ${total})`);
  console.log(`    ${skipped} of ${total} commands skipped (${((100 * skipped) / total).toFixed(0)} %)`);
});

test("never skipped: delta-driven updates and events, even when identical", () => {
  const sent: HudCommand[] = [];
  const api = createHudProxies((c) => sent.push(c), { skipRepeats: true });
  for (let i = 0; i < 3; i++) {
    api.combat.update(1 / 60, health as never, 0);
    api.combat.notifyDamage(10, 0.5);
    api.crosshair.fire("medium");
    api.crosshair.flush();
    api.hitmarker.show(0 as never, undefined, false);
    api.hitmarker.flush();
    api.combo.notifyKill();
    api.clock.set(120);
    api.medal.show("KILL" as never, 0);
  }
  const kinds = sent.map((c) => c[0]);
  for (const k of ["combat.update", "combat.damage", "crosshair.fire", "crosshair.flush", "hitmarker.show", "hitmarker.flush", "combo.kill", "clock.set", "medal.show"]) {
    assert.equal(kinds.filter((x) => x === k).length, 3, k);
  }
});

test("a plate update after a visibility change is always sent (the plate may have forgotten it)", () => {
  const sent: HudCommand[] = [];
  const api = createHudProxies((c) => sent.push(c), { skipRepeats: true });
  const v = { ammo: 5, isReloading: false, shotSerial: 2 };
  api.popcorn.setVisible(true);
  api.popcorn.update(v);
  api.popcorn.update({ ...v });
  api.popcorn.setVisible(false);
  api.popcorn.update({ ...v });
  api.popcorn.update({ ...v });
  api.popcorn.setVisible(true);
  api.popcorn.update({ ...v });
  assert.deepEqual(
    sent.map((c) => c[0]),
    ["plate.visible", "plate.popcorn", "plate.visible", "plate.popcorn", "plate.visible", "plate.popcorn"],
  );
});

test("the views sent are plain copies (never the live object)", () => {
  const sent: HudCommand[] = [];
  const api = createHudProxies((c) => sent.push(c), { skipRepeats: true });
  const live = { ammo: 5, isReloading: false, shotSerial: 2 };
  api.popcorn.update(live);
  live.ammo = 4; // the weapon moves on: the next update must go out
  api.popcorn.update(live);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0][1], live);
  assert.equal((sent[0][1] as { ammo: number }).ammo, 5);
  assert.equal((sent[1][1] as { ammo: number }).ammo, 4);
});

test("skipRepeats: false sends every call (the old stream)", () => {
  const sent: HudCommand[] = [];
  const api = createHudProxies((c) => sent.push(c), { skipRepeats: false });
  for (let i = 0; i < 4; i++) {
    api.crosshair.setAiming(false);
    api.crosshair.flush();
    api.spear.setVisible(false);
    api.dash.update(1 / 60, { dashCooldownRemaining: 0, isDashing: false });
  }
  assert.equal(sent.length, 16);
});

console.log(`test-hud-skip: ${passed} passed`);
