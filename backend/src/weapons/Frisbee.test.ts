/**
 * Frisbee Launcher backend tests (run: npm run test:frisbee).
 * Plain tsx script — WeaponManager + the REAL CombatManager pipeline, no
 * Colyseus transport (same harness as WaterFamas.test.ts).
 */
import assert from "node:assert";
import { CombatManager } from "../combat/CombatManager";
import { GameRoomState } from "../schemas/GameRoomState";
import { NetworkPlayer } from "../schemas/NetworkPlayer";
import { WeaponManager } from "./WeaponManager";
import {
  NetworkWeaponId,
  WeaponActionType,
  PLAYER_EYE_OFFSET,
  FRISBEE_ACTION_BOUNCE,
  FRISBEE_ACTION_HIT,
  FRISBEE_ACTION_END,
} from "../../../shared/combat/NetworkWeapons";
import { FrisbeeLauncherConfig as FL, frisbeeDamage, sanitizeFrisbeeSeed } from "../../../shared/combat/FrisbeeLauncherRules";
import type { ColliderBox } from "../../../shared/map/MapColliders";

/** Floor (top at y = 0) + optional extra boxes. [cx, cy, cz, sx, sy, sz]. */
const FLOOR: ColliderBox = [0, -0.5, 0, 400, 1, 400];

function makeWorld(extra: ColliderBox[] = []) {
  const state = new GameRoomState();
  const combat = new CombatManager(state);
  const actions: any[] = [];
  const hits: { attackerId: string; ev: any }[] = [];
  const impulses: { victimId: string; impulse: { x: number; y: number; z: number } }[] = [];
  let now = 1_000_000;
  const wm = new WeaponManager(
    {
      getPlayer: (id) => state.players.get(id),
      players: () => state.players.values(),
      applyDamage: (req) => combat.applyDamage(req),
      broadcastAction: (ev) => actions.push(ev),
      sendHitConfirmed: (attackerId, ev) => hits.push({ attackerId, ev }),
      sendDamageTaken: () => {},
      sendImpulse: (victimId, impulse) => impulses.push({ victimId, impulse }),
      sendHexPull: () => {},
      now: () => now,
    },
    [FLOOR, ...extra],
  );
  const addPlayer = (id: string, x: number, y: number, z: number): NetworkPlayer => {
    const p = new NetworkPlayer();
    p.id = id;
    p.name = id;
    p.x = x;
    p.y = y;
    p.z = z;
    p.maxHealth = 100;
    p.health = 100;
    p.isAlive = true;
    state.players.set(id, p);
    return p;
  };
  const advance = (ms: number) => {
    now += ms;
  };
  /** Run the combat tick for `seconds` (20 Hz, like GameRoom). */
  const run = (seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += 0.05) {
      advance(50);
      wm.tick(0.05);
    }
  };
  return { wm, actions, hits, impulses, addPlayer, advance, run };
}

const eyeOf = (p: NetworkPlayer) => ({ x: p.x, y: p.y + PLAYER_EYE_OFFSET, z: p.z });
function dirTo(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return { x: dx / len, y: dy / len, z: dz / len };
}
let seq = 0;
function send(wm: WeaponManager, p: NetworkPlayer, action: string, dir: any, extra?: any) {
  const o = eyeOf(p);
  wm.handleAction(p, { action, seq: ++seq, ox: o.x, oy: o.y, oz: o.z, dx: dir.x, dy: dir.y, dz: dir.z, ...(extra ?? {}) });
}
const fires = (actions: any[]) => actions.filter((e) => e.action === WeaponActionType.FRISBEE_FIRE);
let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok ${name}`);
}
const FIRE = WeaponActionType.FRISBEE_FIRE;
const RELOAD = WeaponActionType.FRISBEE_RELOAD;
const CANCEL = WeaponActionType.FRISBEE_RELOAD_CANCEL;
const AHEAD = { x: 0, y: 0, z: 1 };

// ---------------------------------------------------------------------

test("frisbee: damage rule 75 body / 100 head / 45 / 60 after a bounce, 100 HP scale", () => {
  assert.strictEqual(frisbeeDamage(false, false), 75);
  assert.strictEqual(frisbeeDamage(true, false), 100);
  assert.strictEqual(frisbeeDamage(false, true), 45);
  assert.strictEqual(frisbeeDamage(true, true), 60);
  assert.strictEqual(FL.reloadSpeed, 1.5, "cage swaps run x1.5 faster");
  assert.strictEqual(FL.capacity, 6);
  assert.strictEqual(FL.cageCapacity, 5);
  assert.ok(frisbeeDamage(true, false) >= 100, "1 head disc = kill");
  assert.ok(frisbeeDamage(false, false) < 100, "1 body disc = no kill");
  assert.ok(2 * frisbeeDamage(false, false) >= 100, "2 body discs = kill");
  assert.strictEqual(sanitizeFrisbeeSeed(-1), null);
  assert.strictEqual(sanitizeFrisbeeSeed(1.5), null);
  assert.strictEqual(sanitizeFrisbeeSeed("x"), null);
  assert.strictEqual(sanitizeFrisbeeSeed(42), 42);
});

test("frisbee: a body touch = 75 once + knockback along the disc (2.5 horizontal, 0.8 up), one touch per disc", () => {
  const { wm, actions, hits, impulses, addPlayer, run } = makeWorld();
  const a = addPlayer("A", 0, 0.9, 0);
  const b = addPlayer("B", 0, 0.9, 10);
  wm.handleEquip(a, NetworkWeaponId.FRISBEE_LAUNCHER);
  send(wm, a, FIRE, dirTo(eyeOf(a), { x: 0, y: 0.5, z: 10 }), { sd: 7 });
  assert.strictEqual(fires(actions).length, 1);
  assert.strictEqual(wm.frisbeeCount, 1);
  run(1.0);
  assert.strictEqual(b.health, 100 - 75, "75 to the body, once");
  assert.strictEqual(hits.length, 1, "attacker gets HIT_CONFIRMED");
  assert.strictEqual(hits[0].ev.hitZone, "BODY");
  assert.strictEqual(impulses.length, 1, "knockback sent once");
  assert.strictEqual(impulses[0].victimId, "B");
  assert.ok(Math.abs(impulses[0].impulse.y - FL.tuning.knockbackUp) < 1e-9);
  assert.ok(impulses[0].impulse.z > 2.4 && Math.abs(impulses[0].impulse.x) < 0.3, "pushed along the disc");
  assert.ok(actions.some((e) => e.action === FRISBEE_ACTION_HIT && e.tid === "B"));
  assert.strictEqual(a.health, 100, "the shooter is never hit by its own disc");
});

test("frisbee: a head touch = 100 (one-shot kill)", () => {
  const { wm, hits, addPlayer, run } = makeWorld();
  const a = addPlayer("A", 0, 0.9, 0);
  const b = addPlayer("B", 0, 0.9, 10);
  wm.handleEquip(a, NetworkWeaponId.FRISBEE_LAUNCHER);
  send(wm, a, FIRE, dirTo(eyeOf(a), { x: 0, y: 1.8, z: 10 }), { sd: 9 });
  run(1.0);
  assert.strictEqual(b.health, 0, "100 to the head: killed in one disc");
  assert.strictEqual(b.isAlive, false);
  assert.strictEqual(hits[0].ev.hitZone, "HEAD");
});

test("frisbee: a wall bounces the disc (FRISBEE_BOUNCE), a player behind it is not hit, END at the end of life", () => {
  const { wm, actions, addPlayer, run } = makeWorld([[0, 2, 6, 20, 4, 0.5]]);
  const a = addPlayer("A", 0, 0.9, 0);
  const b = addPlayer("B", 0, 0.9, 10);
  wm.handleEquip(a, NetworkWeaponId.FRISBEE_LAUNCHER);
  send(wm, a, FIRE, dirTo(eyeOf(a), { x: 0, y: 1.2, z: 10 }), { sd: 11 });
  run(1.5);
  assert.ok(actions.some((e) => e.action === FRISBEE_ACTION_BOUNCE && e.pid === 1), "bounce broadcast");
  assert.strictEqual(b.health, 100, "the wall protects B");
  run(3.5);
  assert.ok(actions.some((e) => e.action === FRISBEE_ACTION_END && e.pid === 1), "END broadcast");
  assert.strictEqual(wm.frisbeeCount, 0);
});

test("frisbee: a kill sends no knockback; wrong weapon / bad seed refused", () => {
  const { wm, actions, impulses, addPlayer, run } = makeWorld();
  const a = addPlayer("A", 0, 0.9, 0);
  const b = addPlayer("B", 0, 0.9, 10);
  b.health = 30;
  send(wm, a, FIRE, AHEAD, { sd: 1 });
  assert.strictEqual(fires(actions).length, 0, "not equipped");
  wm.handleEquip(a, NetworkWeaponId.FRISBEE_LAUNCHER);
  send(wm, a, FIRE, AHEAD, {});
  send(wm, a, FIRE, AHEAD, { sd: -3 });
  send(wm, a, FIRE, AHEAD, { sd: 1.5 });
  assert.strictEqual(fires(actions).length, 0, "missing / invalid seeds refused");
  send(wm, a, FIRE, dirTo(eyeOf(a), { x: 0, y: 0.5, z: 10 }), { sd: 3 });
  run(1.0);
  assert.strictEqual(b.isAlive, false, "killed");
  assert.strictEqual(impulses.length, 0, "no knockback on a kill");
});
test("frisbee: cadence 1.50 s, re-cock 6 discs (deck + cage 5), the last shot leaves the deck empty, dry fire refused", () => {
  const { wm, actions, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 0, 0.9, 0);
  wm.handleEquip(a, NetworkWeaponId.FRISBEE_LAUNCHER);
  send(wm, a, FIRE, AHEAD, { sd: 1 });
  assert.strictEqual(fires(actions).length, 1);
  assert.strictEqual(fires(actions)[0].am, 5, "5 discs left after the shot (the cage; the next one is taken by the re-cock)");
  assert.strictEqual(fires(actions)[0].cg, 5, "cage at the shot = 5 (the remote plays fire, not fireLast)");
  advance(1000);
  send(wm, a, FIRE, AHEAD, { sd: 2 });
  assert.strictEqual(fires(actions).length, 1, "refused before readyToFire (1.50 s)");
  advance(500); // 1.50 s
  send(wm, a, FIRE, AHEAD, { sd: 3 });
  assert.strictEqual(fires(actions).length, 2, "accepted at readyToFire");
  // 4 more shots, each 1.5 s apart: 6 discs = 6 shots
  for (let i = 0; i < 4; i++) {
    advance(1500);
    send(wm, a, FIRE, AHEAD, { sd: 10 + i });
  }
  assert.strictEqual(fires(actions).length, 6, "six discs, six shots");
  const last = fires(actions)[5];
  assert.strictEqual(last.cg, 0, "the last shot is taken with an empty cage -> fireLast");
  assert.strictEqual(last.am, 0);
  advance(1600);
  send(wm, a, FIRE, AHEAD, { sd: 99 });
  assert.strictEqual(fires(actions).length, 6, "empty deck: refused (dry fire)");
});

test("frisbee: reload gates (x1.5: cage full at 0.47 s, fire again from 0.87 s; empty deck = reloadEmpty 1.60 s)", () => {
  const { wm, actions, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 0, 0.9, 0);
  wm.handleEquip(a, NetworkWeaponId.FRISBEE_LAUNCHER);
  const reloads = () => actions.filter((e) => e.action === RELOAD);
  send(wm, a, RELOAD, AHEAD);
  assert.strictEqual(reloads().length, 0, "full cage + loaded deck: refused");
  send(wm, a, FIRE, AHEAD, { sd: 1 });
  advance(1600); // re-cock over: 5 discs (deck + 4)
  assert.strictEqual(wm.frisbeeCount, 1);
  send(wm, a, RELOAD, AHEAD);
  assert.strictEqual(reloads().length, 1);
  assert.strictEqual(reloads()[0].cg, 4, "cage before = 4");
  assert.strictEqual(reloads()[0].dk, 1, "deck loaded before -> reload (0.93 s at x1.5)");
  send(wm, a, RELOAD, AHEAD);
  assert.strictEqual(reloads().length, 1, "already swapping");
  advance(600);
  send(wm, a, FIRE, AHEAD, { sd: 2 });
  assert.strictEqual(fires(actions).length, 1, "refused before readyToFire (1.30 s / 1.5 = 0.87 s)");
  advance(300); // 0.90 s
  send(wm, a, FIRE, AHEAD, { sd: 3 });
  assert.strictEqual(fires(actions).length, 2, "accepted after the swap");
  assert.strictEqual(fires(actions)[1].cg, 5, "the new cage holds 5");
});

test("frisbee: reloadEmpty on an empty deck (cage swap + re-cock), tir from 1.60 s (2.40 s / 1.5)", () => {
  const { wm, actions, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 0, 0.9, 0);
  wm.handleEquip(a, NetworkWeaponId.FRISBEE_LAUNCHER);
  for (let i = 0; i < 6; i++) {
    send(wm, a, FIRE, AHEAD, { sd: i + 1 });
    advance(1600);
  }
  assert.strictEqual(fires(actions).length, 6);
  send(wm, a, RELOAD, AHEAD);
  const r = actions.filter((e) => e.action === RELOAD);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].dk, 0, "deck empty -> reloadEmpty");
  advance(1400);
  send(wm, a, FIRE, AHEAD, { sd: 50 });
  assert.strictEqual(fires(actions).length, 6, "refused before 1.60 s");
  advance(200);
  send(wm, a, FIRE, AHEAD, { sd: 51 });
  assert.strictEqual(fires(actions).length, 7, "accepted at readyToFire of reloadEmpty");
  assert.strictEqual(fires(actions)[6].cg, 4, "the re-cock took a disc from the new cage (5 -> 4)");
});

test("frisbee: cancel a swap before cageIn keeps the old cage; after cageIn the new cage stays; a re-cock is completed", () => {
  const { wm, actions, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 0, 0.9, 0);
  wm.handleEquip(a, NetworkWeaponId.FRISBEE_LAUNCHER);
  send(wm, a, FIRE, AHEAD, { sd: 1 });
  advance(1600); // cage 4
  send(wm, a, RELOAD, AHEAD);
  advance(300); // < cageSwap (0.71 s / 1.5 = 0.47 s)
  send(wm, a, CANCEL, AHEAD);
  const c1 = actions.filter((e) => e.action === CANCEL);
  assert.strictEqual(c1.length, 1);
  assert.strictEqual(c1[0].cg, 4, "before the swap the old cage is kept");
  advance(200);
  send(wm, a, RELOAD, AHEAD);
  advance(600); // past cageSwap (0.47 s) but before cageIn (0.73 s)
  send(wm, a, CANCEL, AHEAD);
  assert.strictEqual(actions.filter((e) => e.action === CANCEL)[1].cg, 4, "the old cage is given back before the click");
  advance(200);
  send(wm, a, RELOAD, AHEAD);
  advance(800); // after cageIn (0.73 s), before the end (0.93 s)
  send(wm, a, CANCEL, AHEAD);
  assert.strictEqual(actions.filter((e) => e.action === CANCEL)[2].cg, 5, "after the click the new cage stays");
  // weapon switch mid re-cock: completed, disc on the deck
  advance(2000);
  send(wm, a, FIRE, AHEAD, { sd: 2 });
  advance(300);
  wm.handleEquip(a, NetworkWeaponId.REVOLVER);
  wm.handleEquip(a, NetworkWeaponId.FRISBEE_LAUNCHER);
  advance(100);
  send(wm, a, FIRE, AHEAD, { sd: 3 });
  assert.strictEqual(fires(actions).length, 3, "the interrupted re-cock was completed: the next disc is on the deck at once");
});

test("frisbee: death drops the swap, respawn refills deck + cage", () => {
  const { wm, actions, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 0, 0.9, 0);
  wm.handleEquip(a, NetworkWeaponId.FRISBEE_LAUNCHER);
  for (let i = 0; i < 6; i++) {
    send(wm, a, FIRE, AHEAD, { sd: i + 1 });
    advance(1600);
  }
  wm.onPlayerRespawn("A");
  send(wm, a, FIRE, AHEAD, { sd: 77 });
  assert.strictEqual(fires(actions).length, 7, "respawn = loaded deck");
  assert.strictEqual(fires(actions)[6].cg, 5, "respawn = full cage");
  wm.onPlayerDeath("A");
  a.isAlive = false;
  send(wm, a, FIRE, AHEAD, { sd: 78 });
  assert.strictEqual(fires(actions).length, 7, "a dead player cannot fire");
});

console.log(`\n${passed} frisbee tests passed`);