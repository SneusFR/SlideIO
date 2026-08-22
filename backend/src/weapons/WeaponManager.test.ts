/**
 * Phase 5 backend weapon tests (run: npm run test:weapons).
 * Plain tsx script — exercises WeaponManager + HitDetection + the REAL
 * CombatManager pipeline with no Colyseus transport.
 */
import assert from "node:assert";
import { CombatManager } from "../combat/CombatManager";
import { GameRoomState } from "../schemas/GameRoomState";
import { NetworkPlayer } from "../schemas/NetworkPlayer";
import { WeaponManager } from "./WeaponManager";
import { NetworkWeaponId, WeaponActionType, NetworkWeaponConfig as W, PLAYER_EYE_OFFSET } from "../../../shared/combat/NetworkWeapons";
import { hitscan, hasLineOfSight } from "./HitDetection";

interface Recorded {
  actions: any[];
  hits: { attackerId: string; ev: any }[];
  damages: { victimId: string; ev: any }[];
  impulses: { victimId: string; impulse: any }[];
}

function makeWorld() {
  const state = new GameRoomState();
  const combat = new CombatManager(state);
  const rec: Recorded = { actions: [], hits: [], damages: [], impulses: [] };
  let now = 1_000_000;
  const wm = new WeaponManager({
    getPlayer: (id) => state.players.get(id),
    players: () => state.players.values(),
    applyDamage: (req) => combat.applyDamage(req),
    broadcastAction: (ev) => rec.actions.push(ev),
    sendHitConfirmed: (attackerId, ev) => rec.hits.push({ attackerId, ev }),
    sendDamageTaken: (victimId, ev) => rec.damages.push({ victimId, ev }),
    sendImpulse: (victimId, impulse) => rec.impulses.push({ victimId, impulse }),
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
  const nowMs = () => now;
  return { state, combat, wm, rec, addPlayer, advance, nowMs };
}

function dirTo(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return { x: dx / len, y: dy / len, z: dz / len };
}

let seq = 0;
function fire(wm: WeaponManager, p: NetworkPlayer, action: string, origin: any, dir: any, extra?: any) {
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
let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// ---------------------------------------------------------------------

test("hitscan: body hit on open street", () => {
  const targets = [{ id: "B", x: 3, y: 0.9, z: 10 }];
  const origin = { x: 3, y: 1.45, z: 16 };
  const hit = hitscan(origin, dirTo(origin, { x: 3, y: 0.9, z: 10 }), 300, targets, "A");
  assert.ok(hit && hit.kind === "player" && hit.targetId === "B");
  assert.strictEqual(hit!.zone, "BODY");
});

test("hitscan: head hit (sphere above capsule center)", () => {
  const targets = [{ id: "B", x: 3, y: 0.9, z: 10 }];
  const origin = { x: 3, y: 1.45, z: 16 };
  const hit = hitscan(origin, dirTo(origin, { x: 3, y: 0.9 + 0.66, z: 10 }), 300, targets, "A");
  assert.ok(hit && hit.kind === "player");
  assert.strictEqual(hit!.zone, "HEAD");
});

test("hitscan: wall blocks the shot (garage south wall)", () => {
  // Shooter inside the blue garage, target behind the z=35.7 wall.
  const targets = [{ id: "B", x: 19, y: 0.9, z: 39 }];
  const hit = hitscan({ x: 19, y: 1.45, z: 33 }, { x: 0, y: 0, z: 1 }, 300, targets, "A");
  assert.ok(hit && hit.kind === "wall", "wall must be hit first");
  assert.ok(!hasLineOfSight({ x: 19, y: 1.45, z: 33 }, { x: 19, y: 0.9, z: 39 }));
});

test("revolver: body damage + HIT_CONFIRMED + ammo + cadence", () => {
  const { wm, rec, addPlayer } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  const b = addPlayer("B", 3, 0.9, 10);
  wm.handleEquip(a, NetworkWeaponId.REVOLVER);
  assert.strictEqual(a.weapon, NetworkWeaponId.REVOLVER);

  const torso = dirTo(eyeOf(a), { x: 3, y: 0.9, z: 10 });
  fire(wm, a, WeaponActionType.REVOLVER_FIRE, eyeOf(a), torso);
  assert.strictEqual(b.health, 200 - W.revolver.bodyDamage);
  assert.strictEqual(rec.hits.length, 1);
  assert.strictEqual(rec.hits[0].ev.hitZone, "BODY");
  assert.strictEqual(rec.damages.length, 1);

  // Immediate second shot → refused by cadence (no time advanced).
  fire(wm, a, WeaponActionType.REVOLVER_FIRE, eyeOf(a), torso);
  assert.strictEqual(rec.hits.length, 1, "cadence must refuse the spam shot");
});

test("revolver: headshot uses the weapon-specific 50 dmg rule", () => {
  const { wm, rec, addPlayer } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  const b = addPlayer("B", 3, 0.9, 10);
  wm.handleEquip(a, NetworkWeaponId.REVOLVER);
  fire(wm, a, WeaponActionType.REVOLVER_FIRE, eyeOf(a), dirTo(eyeOf(a), { x: 3, y: 1.56, z: 10 }));
  assert.strictEqual(rec.hits[0].ev.hitZone, "HEAD");
  assert.strictEqual(b.health, 200 - W.revolver.headDamage);
});

test("dead shooter: every action refused", () => {
  const { wm, rec, addPlayer } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  addPlayer("B", 3, 0.9, 10);
  wm.handleEquip(a, NetworkWeaponId.REVOLVER);
  a.isAlive = false;
  fire(wm, a, WeaponActionType.REVOLVER_FIRE, eyeOf(a), { x: 0, y: 0, z: -1 });
  assert.strictEqual(rec.actions.length, 0);
  assert.strictEqual(rec.hits.length, 0);
});

test("invalid weapon id: equip refused", () => {
  const { wm, addPlayer } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  wm.handleEquip(a, "ROCKET_LAUNCHER_9000");
  assert.strictEqual(a.weapon, "PLASMA_RIFLE");
});

test("plasma: tick DPS uses real deltaTime + 2x headshot", () => {
  const { wm, addPlayer } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  const b = addPlayer("B", 3, 0.9, 10);
  fire(wm, a, WeaponActionType.PLASMA_START, eyeOf(a), dirTo(eyeOf(a), { x: 3, y: 0.9, z: 10 }));
  wm.tick(0.05);
  const bodyTick = W.plasma.damagePerSecond * 0.05;
  assert.ok(Math.abs(b.health - (200 - bodyTick)) < 0.01, "body DPS tick");
  // Aim at the head → 2x
  fire(wm, a, "PLASMA_AIM", eyeOf(a), dirTo(eyeOf(a), { x: 3, y: 1.56, z: 10 }));
  const before = b.health;
  wm.tick(0.05);
  assert.ok(Math.abs(before - b.health - bodyTick * 2) < 0.01, "headshot = 2x DPS");
  fire(wm, a, WeaponActionType.PLASMA_STOP, eyeOf(a), { x: 0, y: 0, z: -1 });
  const after = b.health;
  wm.tick(0.05);
  assert.strictEqual(b.health, after, "no damage after PLASMA_STOP");
});

test("plasma: kill produces PLAYER_DIED with real headshot flag", () => {
  const { wm, combat, addPlayer } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  const b = addPlayer("B", 3, 0.9, 10);
  b.health = 1;
  let died: any = null;
  combat.onPlayerDied = (ev) => (died = ev);
  fire(wm, a, WeaponActionType.PLASMA_START, eyeOf(a), dirTo(eyeOf(a), { x: 3, y: 1.56, z: 10 }));
  wm.tick(0.05);
  assert.ok(died, "victim must die");
  assert.strictEqual(died.killerId, "A");
  assert.strictEqual(died.isHeadshot, true, "HEAD kill → isHeadshot true");
  assert.strictEqual(a.kills, 1);
  assert.strictEqual(b.deaths, 1);
});

test("hammer sweep: in-arc target damaged + knocked back, far target untouched", () => {
  const { wm, rec, addPlayer } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  const near = addPlayer("B", 3, 0.9, 14); // 2 m in front
  const far = addPlayer("C", 3, 0.9, 5); // 11 m — out of range
  fire(wm, a, WeaponActionType.HAMMER_SWEEP, eyeOf(a), { x: 0, y: 0, z: -1 });
  assert.strictEqual(near.health, 200 - 200 * W.hammer.sweepDamageFraction);
  assert.strictEqual(far.health, 200, "out-of-range target untouched");
  assert.strictEqual(rec.impulses.length, 1);
  assert.strictEqual(rec.impulses[0].victimId, "B");
});

test("hammer slam: AoE around impact, fraudulous far impact refused", () => {
  const { wm, addPlayer } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  const b = addPlayer("B", 5, 0.9, 14);
  // Fraud: impact reported 50 m away → refused.
  wm.handleAction(a, { action: WeaponActionType.HAMMER_SLAM_IMPACT, seq: ++seq, px: 3, py: 0, pz: -40 });
  assert.strictEqual(b.health, 200);
  // Legit impact at the attacker's feet.
  wm.handleAction(a, { action: WeaponActionType.HAMMER_SLAM_IMPACT, seq: ++seq, px: 3, py: 0.9, pz: 16 });
  assert.strictEqual(b.health, 200 - 200 * W.hammer.slamDamageFraction);
});

test("spear rush: cooldown enforced + single hit per target", () => {
  const { wm, rec, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  const b = addPlayer("B", 3, 0.9, 14);
  fire(wm, a, WeaponActionType.SPEAR_RUSH_START, eyeOf(a), { x: 0, y: 0, z: -1 });
  wm.tick(0.05);
  wm.tick(0.05); // same rush → no double hit
  assert.strictEqual(b.health, 200 - 200 * W.spear.rushDamageFraction);
  fire(wm, a, WeaponActionType.SPEAR_RUSH_STOP, eyeOf(a), { x: 0, y: 0, z: -1 });
  // Rush again while on cooldown → refused (no RUSH_START confirm).
  const actionsBefore = rec.actions.length;
  fire(wm, a, WeaponActionType.SPEAR_RUSH_START, eyeOf(a), { x: 0, y: 0, z: -1 });
  assert.strictEqual(rec.actions.length, actionsBefore, "rush during cooldown refused");
  advance(W.spear.rushCooldown * 1000 + 100);
  fire(wm, a, WeaponActionType.SPEAR_RUSH_START, eyeOf(a), { x: 0, y: 0, z: -1 });
  assert.strictEqual(rec.actions.length, actionsBefore + 1, "rush allowed after cooldown");
});

test("obliterreur: anchors validated against map, beam damages inside volume", () => {
  const { wm, rec, addPlayer } = makeWorld();
  const a = addPlayer("A", 0, 0.9, 16);
  const victim = addPlayer("B", 0, 0.9, 10);
  wm.handleEquip(a, NetworkWeaponId.OBLITERREUR);
  // Place both anchors on the ground near the victim.
  fire(wm, a, WeaponActionType.OBLITERREUR_PLACE, eyeOf(a), dirTo(eyeOf(a), { x: 0, y: 0, z: 8 }));
  fire(wm, a, WeaponActionType.OBLITERREUR_PLACE, eyeOf(a), dirTo(eyeOf(a), { x: 0, y: 0, z: 12 }));
  const places = rec.actions.filter((e) => e.action === WeaponActionType.OBLITERREUR_PLACE);
  assert.strictEqual(places.length, 2, "two validated placements");
  wm.handleAction(a, { action: WeaponActionType.OBLITERREUR_FIRE, seq: ++seq });
  wm.tick(0.05);
  const expected = 200 * W.obliterreur.damagePerSecondFraction * 0.05;
  assert.ok(victim.health < 200 && Math.abs(200 - victim.health - expected) < 0.5, "beam ticks damage");
});

test("spawn protection: real weapons are refused by applyDamage", () => {
  const { wm, combat, addPlayer } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  const b = addPlayer("B", 3, 0.9, 10);
  combat.grantSpawnProtection("B", 5);
  wm.handleEquip(a, NetworkWeaponId.REVOLVER);
  fire(wm, a, WeaponActionType.REVOLVER_FIRE, eyeOf(a), { x: 0, y: 0, z: -1 });
  assert.strictEqual(b.health, 200, "spawn-protected target takes 0");
});

test("origin spoofing: fire origin far from the transform is refused", () => {
  const { wm, rec, addPlayer } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  addPlayer("B", 3, 0.9, 10);
  wm.handleEquip(a, NetworkWeaponId.REVOLVER);
  fire(wm, a, WeaponActionType.REVOLVER_FIRE, { x: 3, y: 1.45, z: 10.5 }, { x: 0, y: 0, z: -1 });
  assert.strictEqual(rec.hits.length, 0, "spoofed origin refused");
});

test("assists: contributor gets the assist on a real weapon kill", () => {
  const { wm, combat, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  const c = addPlayer("C", -3, 0.9, 16);
  const b = addPlayer("B", 3, 0.9, 10);
  let died: any = null;
  combat.onPlayerDied = (ev) => (died = ev);
  // C chips in 100 (plasma), A finishes with a revolver body shot ×2.
  fire(wm, c, WeaponActionType.PLASMA_START, eyeOf(c), dirTo(eyeOf(c), { x: 3, y: 0.9, z: 10 }));
  for (let i = 0; i < 37; i++) wm.tick(0.05); // ~101 dmg
  fire(wm, c, WeaponActionType.PLASMA_STOP, eyeOf(c), { x: 0, y: 0, z: -1 });
  wm.handleEquip(a, NetworkWeaponId.REVOLVER);
  const finish = dirTo(eyeOf(a), { x: 3, y: 0.9, z: 10 });
  fire(wm, a, WeaponActionType.REVOLVER_FIRE, eyeOf(a), finish);
  if (!died) {
    advance(W.revolver.primaryFireInterval * 1000);
    fire(wm, a, WeaponActionType.REVOLVER_FIRE, eyeOf(a), finish);
  }
  assert.ok(died, "victim died");
  assert.strictEqual(died.killerId, "A");
  assert.ok(died.assistIds.includes("C"), "C earned the assist");
});

/**
 * Lag compensation — the shooter declares its VIEW TIME (`vt`) and the
 * server rewinds the transform history to that exact moment, with
 * INTERPOLATION between the bracketing entries (no sample-and-hold).
 */

/** Builds a moving target B with history x = 0 → 2 → 4 over 200 ms. */
function makeMovingTargetWorld() {
  const w = makeWorld();
  const a = w.addPlayer("A", 0, 0.9, 16);
  const b = w.addPlayer("B", 0, 0.9, 10);
  w.wm.handleEquip(a, NetworkWeaponId.REVOLVER);
  // History: x=0 at t0, x=2 at t0+100, x=4 at t0+200 (current = 4).
  b.x = 0;
  w.wm.recordTransform(b);
  w.advance(100);
  b.x = 2;
  w.wm.recordTransform(b);
  w.advance(100);
  b.x = 4;
  w.wm.recordTransform(b);
  return { ...w, a, b };
}

test("lag comp: vt rewinds to the INTERPOLATED historical position", () => {
  const { wm, rec, a, nowMs } = makeMovingTargetWorld();
  // vt = now-150 → halfway between (x=0 @ now-200) and (x=2 @ now-100) → x=1.
  const eye = eyeOf(a);
  fire(wm, a, WeaponActionType.REVOLVER_FIRE, eye, dirTo(eye, { x: 1, y: 0.9, z: 10 }), {
    vt: nowMs() - 150,
  });
  assert.strictEqual(rec.hits.length, 1, "shot at the rewound position must hit");
  assert.strictEqual(rec.hits[0].ev.targetId, "B");
});

test("lag comp: with vt in the past, the CURRENT position is NOT hit", () => {
  const { wm, rec, a, nowMs } = makeMovingTargetWorld();
  // Aim at the CURRENT position (x=4) while rewinding 150 ms (target at x=1):
  // the rewound hitbox is ~3 m away from the aim ray → clean miss.
  const eye = eyeOf(a);
  fire(wm, a, WeaponActionType.REVOLVER_FIRE, eye, dirTo(eye, { x: 4, y: 0.9, z: 10 }), {
    vt: nowMs() - 150,
  });
  assert.strictEqual(rec.hits.length, 0, "current position must miss under rewind");
});

test("lag comp: missing vt falls back to the fixed conservative rewind", () => {
  const { wm, rec, a } = makeMovingTargetWorld();
  // Fallback = 120 ms → between (x=0 @ now-200) and (x=2 @ now-100):
  // k = 80/100 → x = 1.6.
  const eye = eyeOf(a);
  fire(wm, a, WeaponActionType.REVOLVER_FIRE, eye, dirTo(eye, { x: 1.6, y: 0.9, z: 10 }));
  assert.strictEqual(rec.hits.length, 1, "fallback rewind position must hit");
});

test("lag comp: aberrant vt is refused → fallback rewind", () => {
  const { wm, rec, a, nowMs } = makeMovingTargetWorld();
  // vt 10 s in the past is implausible → treated as absent (120 ms → x=1.6).
  const eye = eyeOf(a);
  fire(wm, a, WeaponActionType.REVOLVER_FIRE, eye, dirTo(eye, { x: 1.6, y: 0.9, z: 10 }), {
    vt: nowMs() - 10_000,
  });
  assert.strictEqual(rec.hits.length, 1, "aberrant vt must use the fallback");
});

test("lag comp: vt is HARD-CLAMPED to the max rewind window", () => {
  const { wm, rec, a, nowMs } = makeMovingTargetWorld();
  // vt = now-3000 is plausible-looking but beyond the 350 ms cap →
  // clamped to now-350, which is before the oldest entry → holds x=0.
  // (A cheater cannot resurrect very old positions.)
  const eye = eyeOf(a);
  fire(wm, a, WeaponActionType.REVOLVER_FIRE, eye, dirTo(eye, { x: 0, y: 0.9, z: 10 }), {
    vt: nowMs() - 3000,
  });
  assert.strictEqual(rec.hits.length, 1, "clamped rewind = oldest plausible position");
});

test("lag comp: idle-suppression gaps HOLD the older position (no lerp)", () => {
  const w = makeWorld();
  const a = w.addPlayer("A", 0, 0.9, 16);
  const b = w.addPlayer("B", 0, 0.9, 10);
  w.wm.handleEquip(a, NetworkWeaponId.REVOLVER);
  // B stood at x=0, silent for 400 ms (idle suppression), then moved to x=4.
  b.x = 0;
  w.wm.recordTransform(b);
  w.advance(400);
  b.x = 4;
  w.wm.recordTransform(b);
  // vt inside the silent window → B truly WAS at x=0 the whole time.
  const eye = eyeOf(a);
  fire(w.wm, a, WeaponActionType.REVOLVER_FIRE, eye, dirTo(eye, { x: 0, y: 0.9, z: 10 }), {
    vt: w.nowMs() - 200,
  });
  assert.strictEqual(w.rec.hits.length, 1, "idle gap must hold the older position");
});

console.log(`\n${passed} weapon tests passed`);
