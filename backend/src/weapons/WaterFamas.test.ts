/**
 * Water FAMAS backend tests (run: npm run test:famas).
 * Plain tsx script — WeaponManager + the REAL CombatManager pipeline, no
 * Colyseus transport (same harness as WeaponManager.test.ts).
 */
import assert from "node:assert";
import { CombatManager } from "../combat/CombatManager";
import { GameRoomState } from "../schemas/GameRoomState";
import { NetworkPlayer } from "../schemas/NetworkPlayer";
import { WeaponManager } from "./WeaponManager";
import { NetworkWeaponId, WeaponActionType, PLAYER_EYE_OFFSET } from "../../../shared/combat/NetworkWeapons";
import {
  WaterFamasConfig as WF,
  waterFamasJetDamage,
  waterFamasJetDirection,
  waterFamasJetSeed,
  waterFamasSpreadDeg,
} from "../../../shared/combat/WaterFamasRules";
import { WaterFamasState, resolveWaterFamasFire } from "./WaterFamasServer";

function makeWorld() {
  const state = new GameRoomState();
  const combat = new CombatManager(state);
  const actions: any[] = [];
  const hits: { attackerId: string; ev: any }[] = [];
  let now = 1_000_000;
  const wm = new WeaponManager({
    getPlayer: (id) => state.players.get(id),
    players: () => state.players.values(),
    applyDamage: (req) => combat.applyDamage(req),
    broadcastAction: (ev) => actions.push(ev),
    sendHitConfirmed: (attackerId, ev) => hits.push({ attackerId, ev }),
    sendDamageTaken: () => {},
    sendImpulse: () => {},
    sendHexPull: () => {},
    now: () => now,
  });
  const addPlayer = (id: string, x: number, y: number, z: number): NetworkPlayer => {
    const p = new NetworkPlayer();
    p.id = id;
    p.name = id;
    p.x = x;
    p.y = y;
    p.z = z;
    p.maxHealth = 200;
    p.health = 200;
    p.isAlive = true;
    state.players.set(id, p);
    return p;
  };
  const advance = (ms: number) => {
    now += ms;
  };
  return { wm, actions, hits, addPlayer, advance };
}

function dirTo(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return { x: dx / len, y: dy / len, z: dz / len };
}

let seq = 0;
function send(wm: WeaponManager, p: NetworkPlayer, action: string, origin: any, dir: any, extra?: any) {
  wm.handleAction(p, {
    action,
    seq: ++seq,
    ox: origin.x,
    oy: origin.y,
    oz: origin.z,
    dx: dir.x,
    dy: dir.y,
    dz: dir.z,
    ...(extra ?? {}),
  });
}

const eyeOf = (p: NetworkPlayer) => ({ x: p.x, y: p.y + PLAYER_EYE_OFFSET, z: p.z });
const famasFires = (actions: any[]) => actions.filter((e) => e.action === WeaponActionType.WATER_FAMAS_FIRE);
let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok ${name}`);
}

/** One full burst through the manager: jets at 0 / 75 / 150 ms (same aim every jet). */
function burst(wm: WeaponManager, a: NetworkPlayer, advance: (ms: number) => void, aim: any, seedBase: number, aiming = false) {
  for (let k = 0; k < WF.jetsPerBurst; k++) {
    if (k > 0) advance(75);
    send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), aim, { sd: waterFamasJetSeed(seedBase, k), pi: k, pc: aiming ? 1 : 0 });
  }
}

// ---------------------------------------------------------------------

test("famas: damage rule 23 body / 34.5 head, 200 HP scale", () => {
  assert.strictEqual(waterFamasJetDamage(false), 23);
  assert.strictEqual(waterFamasJetDamage(true), 34.5);
  assert.strictEqual(WF.capacity, 9);
  assert.strictEqual(WF.jetsPerBurst, 3);
  assert.ok(WF.maxRange >= 400, "ray covers every map diagonal (no weapon range)");
  // a full burst on the body = 69; a full tank = 207 (> 200 HP only if all 9 land)
  assert.strictEqual(3 * waterFamasJetDamage(false), 69);
  assert.ok(9 * waterFamasJetDamage(false) > 200 && 8 * waterFamasJetDamage(false) < 200);
});

test("famas: a burst = 3 hitscan jets, damage at each jet time, seed / index / ammo confirmed", () => {
  const { wm, actions, hits, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", -40, 0.9, 16);
  const b = addPlayer("B", -40, 0.9, 10); // 6 m, open ground
  wm.handleEquip(a, NetworkWeaponId.WATER_FAMAS);
  const chest = dirTo(eyeOf(a), { x: -40, y: 0.9, z: 10 });
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), chest, { sd: 11, pi: 0, pc: 0 });
  assert.strictEqual(b.health, 200 - 23, "jet 0: damage immediately (hitscan)");
  advance(75);
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), chest, { sd: 12, pi: 1, pc: 0 });
  assert.strictEqual(b.health, 200 - 46, "jet 1: damage at 0.075 s");
  advance(75);
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), chest, { sd: 13, pi: 2, pc: 0 });
  assert.strictEqual(b.health, 200 - 69, "jet 2: damage at 0.15 s");
  assert.strictEqual(hits.length, 3, "one HIT_CONFIRMED per jet");
  assert.strictEqual(hits[0].ev.hitZone, "BODY");
  assert.strictEqual(hits[0].ev.damageDealt, 23);
  const conf = famasFires(actions);
  assert.strictEqual(conf.length, 3);
  assert.deepStrictEqual(conf.map((c) => c.pi), [0, 1, 2]);
  assert.deepStrictEqual(conf.map((c) => c.sd), [11, 12, 13]);
  assert.deepStrictEqual(conf.map((c) => c.am), [8, 7, 6]);
  assert.strictEqual(conf[0].tid, "B", "victim id confirmed (remote wet mark)");
  assert.ok(typeof conf[0].hx === "number", "end point confirmed");
});

test("famas: head jet = 34.5, zone HEAD", () => {
  const { wm, hits, addPlayer } = makeWorld();
  const a = addPlayer("A", -40, 0.9, 16);
  const b = addPlayer("B", -40, 0.9, 10);
  wm.handleEquip(a, NetworkWeaponId.WATER_FAMAS);
  const head = dirTo(eyeOf(a), { x: -40, y: 0.9 + 0.875, z: 10 });
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), head, { sd: 5, pi: 0, pc: 1 }); // aiming: tight cone
  assert.strictEqual(hits.at(-1)!.ev.hitZone, "HEAD");
  assert.strictEqual(hits.at(-1)!.ev.damageDealt, 34.5);
  assert.strictEqual(b.health, 200 - 34.5);
});

test("famas: NO max range — hit at 20 m and at 150 m, no falloff, wall blocks, sky = end of the ray", () => {
  const st = new WaterFamasState();
  const eye = { x: 0, y: 0.9 + PLAYER_EYE_OFFSET, z: 0 };
  const near = { id: "B", x: 0, y: 0.9, z: -20 };
  const far = { id: "C", x: 0, y: 0.9, z: -150 };
  const r = resolveWaterFamasFire(st, 1_000_000, eye, dirTo(eye, { x: 0, y: 0.9, z: -20 }), 1, 0, true, [near], "A", []);
  assert.ok(r.accepted && r.victim && r.victim.targetId === "B", "hit at 20 m");
  assert.strictEqual(r.victim!.amount, 23, "no distance falloff");
  const r2 = resolveWaterFamasFire(st, 1_001_000, eye, dirTo(eye, { x: 0, y: 0.9, z: -150 }), 2, 0, true, [far], "A", []);
  assert.ok(r2.accepted);
  assert.ok(r2.victim && r2.victim.targetId === "C", "hit at 150 m (the pack's 28 m cap is gone)");
  assert.strictEqual(r2.victim!.amount, 23, "still no distance falloff");
  // A wall in front of him still stops the jet (walls / map bounds = the only limit).
  const wall: [number, number, number, number, number, number][] = [[0, 2, -100, 20, 4, 1]];
  const r3 = resolveWaterFamasFire(st, 1_002_000, eye, dirTo(eye, { x: 0, y: 0.9, z: -150 }), 3, 0, true, [far], "A", wall);
  assert.strictEqual(r3.victim, null, "wall in front blocks the jet");
  // Nothing on the way: the end point is the end of the ray.
  const r4 = resolveWaterFamasFire(st, 1_003_000, eye, { x: 0, y: 1, z: 0 }, 4, 0, true, [], "A", []);
  const reach = Math.hypot(r4.endPoint.x - eye.x, r4.endPoint.y - eye.y, r4.endPoint.z - eye.z);
  assert.ok(r4.victim === null && reach > 300, "sky: the jet flies to the end of the ray");
});

test("famas: shooter ignored, jet direction = the shared rule (same seed, same ray), cones 0.35/0.8/1.25", () => {
  const st = new WaterFamasState();
  const eye = { x: 0, y: 1.45, z: 0 };
  const l = Math.hypot(0.1, 1);
  const fwd = { x: 0, y: 0.1 / l, z: -1 / l };
  const self = { id: "A", x: 0, y: 0.9, z: -1 };
  const r = resolveWaterFamasFire(st, 1_000_000, eye, fwd, 77, 0, false, [self], "A", []);
  assert.strictEqual(r.victim, null, "never hits the shooter");
  const expect = waterFamasJetDirection(fwd, 0, false, 77, { x: 0, y: 0, z: 0 });
  assert.ok(Math.abs(r.jetDir.x - expect.x) + Math.abs(r.jetDir.y - expect.y) + Math.abs(r.jetDir.z - expect.z) < 1e-12);
  assert.deepStrictEqual([0, 1, 2].map((k) => waterFamasSpreadDeg(k, false)), [0.35, 0.8, 1.25]);
  assert.ok(Math.abs(waterFamasSpreadDeg(2, true) - 1.25 * 0.55) < 1e-12);
  const angle = (k: number) => {
    const d = waterFamasJetDirection(fwd, k, false, 1234 + k, { x: 0, y: 0, z: 0 });
    return (Math.acos(Math.min(1, d.x * fwd.x + d.y * fwd.y + d.z * fwd.z)) * 180) / Math.PI;
  };
  assert.ok(angle(0) <= 0.35 + 1e-6 && angle(1) <= 0.8 + 1e-6 && angle(2) <= 1.25 + 1e-6, "inside the cones");
});

test("famas: cadence — one burst per >= 0.45 s, jets in order, 9 jets total, empty refused", () => {
  const { wm, actions, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  wm.handleEquip(a, NetworkWeaponId.WATER_FAMAS);
  const up = { x: 0, y: 1, z: 0 };
  burst(wm, a, advance, up, 100);
  assert.strictEqual(famasFires(actions).length, 3);
  advance(100); // 250 ms after the burst start: too early for the next burst
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), up, { sd: 1, pi: 0 });
  assert.strictEqual(famasFires(actions).length, 3, "next burst before 0.45 s refused");
  advance(260);
  burst(wm, a, advance, up, 200);
  assert.strictEqual(famasFires(actions).length, 6, "burst 2 accepted");
  advance(500);
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), up, { sd: 3, pi: 0 });
  advance(150);
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), up, { sd: 4, pi: 2 });
  assert.strictEqual(famasFires(actions).length, 7, "jet 2 skipping jet 1 refused");
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), up, { sd: 5, pi: 1 });
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), up, { sd: 6, pi: 1 });
  assert.strictEqual(famasFires(actions).length, 8, "jet 1 accepted once, not twice");
  advance(75);
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), up, { sd: 7, pi: 2 });
  assert.strictEqual(famasFires(actions).at(-1).am, 0, "9 jets total");
  advance(600);
  const n = famasFires(actions).length;
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), up, { sd: 10, pi: 0 });
  assert.strictEqual(famasFires(actions).length, n, "empty tank refused");
});


test("famas: refill gates 1.98 / 2.95 s, cancel before the end of the pour keeps the ammo", () => {
  const { wm, actions, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  wm.handleEquip(a, NetworkWeaponId.WATER_FAMAS);
  const up = { x: 0, y: 1, z: 0 };
  const act = (action: string) => send(wm, a, action, eyeOf(a), up);
  const reloads = () => actions.filter((e) => e.action === WeaponActionType.WATER_FAMAS_RELOAD).length;
  act(WeaponActionType.WATER_FAMAS_RELOAD);
  assert.strictEqual(reloads(), 0, "full tank: no refill");
  burst(wm, a, advance, up, 1); // 6 left
  advance(500);
  act(WeaponActionType.WATER_FAMAS_RELOAD);
  assert.strictEqual(reloads(), 1);
  advance(1500);
  act(WeaponActionType.WATER_FAMAS_RELOAD_CANCEL);
  advance(500);
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), up, { sd: 20, pi: 0 });
  assert.strictEqual(famasFires(actions).at(-1).am, 5, "cancel before 1.98 s keeps 6 (then -1)");
  advance(500);
  act(WeaponActionType.WATER_FAMAS_RELOAD);
  advance(2800);
  const n = famasFires(actions).length;
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), up, { sd: 21, pi: 0 });
  assert.strictEqual(famasFires(actions).length, n, "refused before readyToFire (2.95 s)");
  advance(250);
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), up, { sd: 22, pi: 0 });
  assert.strictEqual(famasFires(actions).at(-1).am, WF.capacity - 1, "full tank after the pour");
  advance(600);
  act(WeaponActionType.WATER_FAMAS_RELOAD);
  advance(800);
  wm.handleEquip(a, NetworkWeaponId.REVOLVER);
  wm.handleEquip(a, NetworkWeaponId.WATER_FAMAS);
  advance(3500);
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), up, { sd: 23, pi: 0 });
  assert.strictEqual(famasFires(actions).at(-1).am, WF.capacity - 2, "swap before the end of the pour kept the ammo");
});

test("famas: wrong weapon / missing or invalid seed / bad jet index refused", () => {
  const { wm, actions, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  const up = { x: 0, y: 1, z: 0 };
  wm.handleEquip(a, NetworkWeaponId.POPCORN_SHOTGUN);
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), up, { sd: 1, pi: 0 });
  wm.handleEquip(a, NetworkWeaponId.WATER_FAMAS);
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), up, { pi: 0 });
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), up, { sd: -3, pi: 0 });
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), up, { sd: 2.5, pi: 0 });
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), up, { sd: 2 });
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), up, { sd: 2, pi: 3 });
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), up, { sd: 2, pi: 0.5 });
  advance(1);
  assert.strictEqual(famasFires(actions).length, 0);
});

test("famas: respawn = full tank", () => {
  const { wm, actions, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  wm.handleEquip(a, NetworkWeaponId.WATER_FAMAS);
  const up = { x: 0, y: 1, z: 0 };
  burst(wm, a, advance, up, 1);
  assert.strictEqual(famasFires(actions).at(-1).am, 6);
  wm.onPlayerRespawn("A");
  advance(600);
  send(wm, a, WeaponActionType.WATER_FAMAS_FIRE, eyeOf(a), up, { sd: 30, pi: 0 });
  assert.strictEqual(famasFires(actions).at(-1).am, WF.capacity - 1);
});

console.log(`\n${passed} water famas tests passed`);

