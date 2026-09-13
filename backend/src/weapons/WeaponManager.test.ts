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
  pulls: { victimId: string; ev: any }[];
}

function makeWorld() {
  const state = new GameRoomState();
  const combat = new CombatManager(state);
  const rec: Recorded = { actions: [], hits: [], damages: [], impulses: [], pulls: [] };
  let now = 1_000_000;
  const wm = new WeaponManager({
    getPlayer: (id) => state.players.get(id),
    players: () => state.players.values(),
    applyDamage: (req) => combat.applyDamage(req),
    broadcastAction: (ev) => rec.actions.push(ev),
    sendHitConfirmed: (attackerId, ev) => rec.hits.push({ attackerId, ev }),
    sendDamageTaken: (victimId, ev) => rec.damages.push({ victimId, ev }),
    sendImpulse: (victimId, impulse) => rec.impulses.push({ victimId, impulse }),
    sendHexPull: (victimId, ev) => rec.pulls.push({ victimId, ev }),
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

test("hitscan: wall blocks the shot (east terrace ruins)", () => {
  // Shooter inside the east terrace ruins mass, target behind it (+z).
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

test("poison: short-range DPS tick, NO headshot bonus, out-of-range refused", () => {
  const { wm, addPlayer } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  const b = addPlayer("B", 3, 0.9, 10); // 6 m — inside the 9 m range
  const c = addPlayer("C", 3, 0.9, -20); // 36 m — far outside
  wm.handleEquip(a, NetworkWeaponId.POISON_SPRAYER);
  assert.strictEqual(a.weapon, NetworkWeaponId.POISON_SPRAYER);

  // Spray at B's torso → flat DPS tick.
  fire(wm, a, WeaponActionType.POISON_START, eyeOf(a), dirTo(eyeOf(a), { x: 3, y: 0.9, z: 10 }));
  wm.tick(0.05);
  const tick = W.poison.damagePerSecond * 0.05;
  assert.ok(Math.abs(b.health - (200 - tick)) < 0.01, "body DPS tick");

  // Aim at the HEAD → SAME flat damage (poison never headshots).
  fire(wm, a, "POISON_AIM", eyeOf(a), dirTo(eyeOf(a), { x: 3, y: 1.56, z: 10 }));
  const before = b.health;
  wm.tick(0.05);
  assert.ok(Math.abs(before - b.health - tick) < 0.01, "head aim = flat damage");

  // STOP → no more damage.
  fire(wm, a, WeaponActionType.POISON_STOP, eyeOf(a), { x: 0, y: 0, z: -1 });
  const after = b.health;
  wm.tick(0.05);
  assert.strictEqual(b.health, after, "no damage after POISON_STOP");

  // Far target: even a perfect aim is beyond the 9 m poison range.
  fire(wm, a, WeaponActionType.POISON_START, eyeOf(a), dirTo(eyeOf(a), { x: 3, y: 0.9, z: -20 }));
  wm.tick(0.05);
  assert.strictEqual(c.health, 200, "target beyond poison range untouched");
});

// NOTE: melee tests live on the open CENTER LANE of Ancient Jungle City
// (x = 0, z 5..16 — no cover): the low "Crossing cover wall" occupies
// x 0.45..7.55 at z ≈ 14 and would block capsule-center line of sight.
test("brick maul whirlwind: bounded attack, 360°, FLAT 50 once per victim (200 max HP)", () => {
  const { wm, rec, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 0, 0.9, 16);
  const front = addPlayer("B", 0, 0.9, 14); // 2 m in front
  const behind = addPlayer("D", 0, 0.9, 18.5); // 2.5 m BEHIND (360° zone)
  const far = addPlayer("C", 0, 0.9, 5); // 11 m — out of range
  fire(wm, a, WeaponActionType.HAMMER_SWEEP, eyeOf(a), { x: 0, y: 0, z: -1 });
  // Confirmed with the authoritative start timestamp.
  const confirm = rec.actions.find((ev) => ev.action === WeaponActionType.HAMMER_SWEEP);
  assert.ok(confirm && typeof confirm.ts === "number", "HAMMER_SWEEP confirmed with ts");
  // No damage at reception: the window opens at 0.20 s.
  wm.tick(0.05);
  assert.strictEqual(front.health, 200, "no damage before the active phase");
  // Inside the active phase (0.20–1.04 s) → flat 50, both sides.
  advance(300);
  wm.tick(0.05);
  assert.strictEqual(front.health, 150, "flat 50 (not 50% of 200 max HP)");
  assert.strictEqual(behind.health, 150, "target behind the attacker hit (360°)");
  assert.strictEqual(far.health, 200, "out-of-range target untouched");
  assert.strictEqual(rec.impulses.length, 2);
  // The following turns never re-hit the same victims.
  advance(300);
  wm.tick(0.05);
  advance(300);
  wm.tick(0.05);
  assert.strictEqual(front.health, 150, "one hit per victim for the whole attack");
  assert.strictEqual(behind.health, 150);
  assert.strictEqual(rec.impulses.length, 2);
});

test("brick maul whirlwind: target entering during the window is hit; long tick never skips the window", () => {
  const { wm, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 0, 0.9, 16);
  const late = addPlayer("B", 0, 0.9, 40); // far away at the start
  fire(wm, a, WeaponActionType.HAMMER_SWEEP, eyeOf(a), { x: 0, y: 0, z: -1 });
  advance(250);
  wm.tick(0.05); // active but B still far
  assert.strictEqual(late.health, 200);
  // B walks in during the active phase → hit on the next tick.
  late.z = 14;
  wm.recordTransform(late);
  advance(300);
  wm.tick(0.05);
  assert.strictEqual(late.health, 150, "target entering the active window is hit");

  // LONG FRAME: one single tick jumping from 0.05 s straight past the end
  // of the window (1.04 s) must still resolve the sweep exactly once.
  const w2 = makeWorld();
  const a2 = w2.addPlayer("A", 0, 0.9, 16);
  const b2 = w2.addPlayer("B", 0, 0.9, 14);
  fire(w2.wm, a2, WeaponActionType.HAMMER_SWEEP, eyeOf(a2), { x: 0, y: 0, z: -1 });
  w2.advance(50);
  w2.wm.tick(0.05);
  assert.strictEqual(b2.health, 200);
  w2.advance(1200); // 1.25 s elapsed — the window is entirely inside the gap
  w2.wm.tick(1.2);
  assert.strictEqual(b2.health, 150, "window overlap test catches the long frame");
});

test("brick maul whirlwind: anti-spam = the engaged 1.35 s attack (0.5 s is not enough)", () => {
  const { wm, rec, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 0, 0.9, 16);
  addPlayer("B", 0, 0.9, 14);
  fire(wm, a, WeaponActionType.HAMMER_SWEEP, eyeOf(a), { x: 0, y: 0, z: -1 });
  advance(600);
  fire(wm, a, WeaponActionType.HAMMER_SWEEP, eyeOf(a), { x: 0, y: 0, z: -1 });
  assert.strictEqual(
    rec.actions.filter((ev) => ev.action === WeaponActionType.HAMMER_SWEEP).length,
    1,
    "second sweep at 0.6 s refused (attack still engaged)",
  );
  advance(800); // 1.4 s → the first attack ended
  wm.tick(0.05);
  fire(wm, a, WeaponActionType.HAMMER_SWEEP, eyeOf(a), { x: 0, y: 0, z: -1 });
  assert.strictEqual(
    rec.actions.filter((ev) => ev.action === WeaponActionType.HAMMER_SWEEP).length,
    2,
    "new sweep accepted once the attack is over",
  );
});

test("brick maul slam: start + single impact (flat 50), duplicates and fraud refused", () => {
  const { wm, rec, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 0, 0.9, 16);
  const b = addPlayer("B", 2, 0.9, 16);
  // Impact WITHOUT a start → refused (no attack engaged).
  wm.handleAction(a, { action: WeaponActionType.HAMMER_SLAM_IMPACT, seq: ++seq, px: 0, py: 0.9, pz: 16 });
  assert.strictEqual(b.health, 200, "impact without a slam start refused");
  // Start the slam.
  fire(wm, a, WeaponActionType.HAMMER_SLAM_START, eyeOf(a), { x: 0, y: -1, z: 0 });
  assert.ok(rec.actions.some((ev) => ev.action === WeaponActionType.HAMMER_SLAM_START));
  // Fraud: impact reported 50 m away → refused (attack stays engaged).
  wm.handleAction(a, { action: WeaponActionType.HAMMER_SLAM_IMPACT, seq: ++seq, px: 0, py: 0, pz: -40 });
  assert.strictEqual(b.health, 200);
  // Legit impact at the attacker's feet → flat 50.
  wm.handleAction(a, { action: WeaponActionType.HAMMER_SLAM_IMPACT, seq: ++seq, px: 0, py: 0.9, pz: 16 });
  assert.strictEqual(b.health, 150, "flat 50 slam damage");
  // Duplicate impact of the SAME attack with a fresh seq → refused.
  wm.handleAction(a, { action: WeaponActionType.HAMMER_SLAM_IMPACT, seq: ++seq, px: 0, py: 0.9, pz: 16 });
  assert.strictEqual(b.health, 150, "second impact of the same slam refused");
  assert.strictEqual(
    rec.actions.filter((ev) => ev.action === WeaponActionType.HAMMER_SLAM_IMPACT).length,
    1,
  );
  // Recovery (0.72 s) keeps the attack engaged: a sweep is refused…
  advance(300);
  wm.tick(0.05);
  fire(wm, a, WeaponActionType.HAMMER_SWEEP, eyeOf(a), { x: 0, y: 0, z: -1 });
  assert.ok(!rec.actions.some((ev) => ev.action === WeaponActionType.HAMMER_SWEEP), "sweep refused during recovery");
  // …and accepted once the recovery is over.
  advance(500);
  wm.tick(0.05);
  fire(wm, a, WeaponActionType.HAMMER_SWEEP, eyeOf(a), { x: 0, y: 0, z: -1 });
  assert.ok(rec.actions.some((ev) => ev.action === WeaponActionType.HAMMER_SWEEP), "sweep accepted after recovery");
});

test("spear rush: cooldown enforced + single hit per target", () => {
  const { wm, rec, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 0, 0.9, 16);
  const b = addPlayer("B", 0, 0.9, 14);
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

// ---------------------------------------------------------------------
// HEX SNIPER — tongue grab → server pull → arrival bite
// ---------------------------------------------------------------------

test("hex sniper: tongue grab = flat damage + HEX_TONGUE_HIT + HEX_PULL start", () => {
  const { wm, rec, addPlayer } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  const b = addPlayer("B", 3, 0.9, 10);
  wm.handleEquip(a, NetworkWeaponId.HEX_SNIPER);
  fire(wm, a, WeaponActionType.HEX_TONGUE_FIRE, eyeOf(a), dirTo(eyeOf(a), { x: 3, y: 0.9, z: 10 }));
  assert.strictEqual(b.health, 200 - W.hexSniper.tongueDamage, "tongue deals flat damage");
  assert.strictEqual(rec.hits.length, 1, "attacker gets HIT_CONFIRMED");
  const hit = rec.actions.find((e) => e.action === "HEX_TONGUE_HIT");
  assert.ok(hit, "HEX_TONGUE_HIT broadcast");
  assert.strictEqual(hit.tid, "B", "victim id travels with the confirm");
  assert.strictEqual(rec.pulls.length, 1, "victim told to start the pull");
  assert.deepStrictEqual(rec.pulls[0], { victimId: "B", ev: { attackerId: "A", active: true } });
  // A second shot while pulling is refused (one attack at a time).
  const before = rec.actions.length;
  fire(wm, a, WeaponActionType.HEX_TONGUE_FIRE, eyeOf(a), dirTo(eyeOf(a), { x: 3, y: 0.9, z: 10 }));
  assert.strictEqual(rec.actions.length, before, "no second tongue while pulling");
});

test("hex sniper: arrival = bite damage + knockback + HEX_BITE + pull stop", () => {
  const { wm, rec, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  const b = addPlayer("B", 3, 0.9, 10);
  wm.handleEquip(a, NetworkWeaponId.HEX_SNIPER);
  fire(wm, a, WeaponActionType.HEX_TONGUE_FIRE, eyeOf(a), dirTo(eyeOf(a), { x: 3, y: 0.9, z: 10 }));
  // Still far: no bite yet.
  advance(50);
  wm.tick(0.05);
  assert.ok(!rec.actions.some((e) => e.action === "HEX_BITE"), "no bite while far");
  // The victim's client reeled it in next to the shooter.
  b.z = 16 - W.hexSniper.pullStopDistance;
  advance(50);
  wm.tick(0.05);
  assert.ok(rec.actions.some((e) => e.action === "HEX_BITE" && e.tid === "B"), "HEX_BITE broadcast");
  assert.strictEqual(
    b.health,
    200 - W.hexSniper.tongueDamage - W.hexSniper.biteDamage,
    "bite deals flat damage once",
  );
  assert.strictEqual(rec.impulses.length, 1, "bite knockback sent to the victim");
  assert.ok(rec.impulses[0].impulse.z < 0, "knocked AWAY from the shooter");
  assert.strictEqual(rec.pulls.length, 2, "pull start + stop");
  assert.deepStrictEqual(rec.pulls[1].ev, { attackerId: null, active: false });
  // The tongue is free again → a new shot is accepted after the cooldown.
  advance(W.hexSniper.fireCooldown * 1000 + 10);
  const before = rec.actions.length;
  fire(wm, a, WeaponActionType.HEX_TONGUE_FIRE, eyeOf(a), { x: 0, y: 0, z: 1 });
  assert.ok(rec.actions.length > before, "re-armed after the bite");
});

test("hex sniper: wall in the way → HEX_TONGUE_MISS, no damage, no pull", () => {
  const { wm, rec, addPlayer } = makeWorld();
  // Shooter inside the east terrace ruins mass, target behind it (+z).
  const a = addPlayer("A", 19, 0.9, 33);
  const b = addPlayer("B", 19, 0.9, 39);
  wm.handleEquip(a, NetworkWeaponId.HEX_SNIPER);
  fire(wm, a, WeaponActionType.HEX_TONGUE_FIRE, eyeOf(a), { x: 0, y: 0, z: 1 });
  assert.strictEqual(b.health, 200, "wall blocks the tongue");
  const miss = rec.actions.find((e) => e.action === "HEX_TONGUE_MISS");
  assert.ok(miss && typeof miss.hx === "number", "miss confirm carries the tip end point");
  assert.strictEqual(rec.pulls.length, 0, "no pull on a miss");
});

test("hex sniper: stall / attacker death release the victim (HEX_PULL_END)", () => {
  const { wm, rec, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  addPlayer("B", 3, 0.9, 10);
  wm.handleEquip(a, NetworkWeaponId.HEX_SNIPER);
  fire(wm, a, WeaponActionType.HEX_TONGUE_FIRE, eyeOf(a), dirTo(eyeOf(a), { x: 3, y: 0.9, z: 10 }));
  // Victim never moves (blocked by a wall) → stall release.
  for (let i = 0; i < 20; i++) {
    advance(50);
    wm.tick(0.05);
  }
  assert.ok(rec.actions.some((e) => e.action === "HEX_PULL_END"), "stall → HEX_PULL_END");
  assert.deepStrictEqual(rec.pulls[rec.pulls.length - 1].ev, { attackerId: null, active: false });
  assert.ok(!rec.actions.some((e) => e.action === "HEX_BITE"), "no bite on a stalled pull");

  // New grab, then the attacker dies mid-pull → victim released.
  advance(W.hexSniper.fireCooldown * 1000 + 10);
  fire(wm, a, WeaponActionType.HEX_TONGUE_FIRE, eyeOf(a), dirTo(eyeOf(a), { x: 3, y: 0.9, z: 10 }));
  const pullsBefore = rec.pulls.length;
  assert.deepStrictEqual(rec.pulls[pullsBefore - 1].ev, { attackerId: "A", active: true });
  wm.onPlayerDeath("A");
  assert.strictEqual(rec.pulls.length, pullsBefore + 1, "death releases the victim");
  assert.deepStrictEqual(rec.pulls[pullsBefore].ev, { attackerId: null, active: false });
});

// ---------------------------------------------------------------------
// GOOFY BASKET — server-owned charge, marker launch, bouncing projectile
// ---------------------------------------------------------------------

const GB = W.goofyBasket;
/** Run the combat tick for `ms` in 50 ms steps (20 Hz like GameRoom). */
function tickFor(wm: WeaponManager, advance: (ms: number) => void, ms: number, step = 50) {
  let left = ms;
  while (left > 0) {
    const s = Math.min(step, left);
    advance(s);
    wm.tick(s / 1000);
    left -= s;
  }
}
const basketActions = (rec: Recorded, action: string) => rec.actions.filter((a) => a.action === action);

test("basket: tap without charge = level 1, projectile created at the 0.14 s marker only", () => {
  const { wm, rec, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  wm.handleEquip(a, NetworkWeaponId.GOOFY_BASKET);
  fire(wm, a, WeaponActionType.BASKET_THROW_REQUEST, eyeOf(a), { x: 0, y: 0, z: -1 });
  const throws = basketActions(rec, "BASKET_THROW");
  assert.strictEqual(throws.length, 1);
  assert.strictEqual(throws[0].lv, 1);
  assert.strictEqual(typeof throws[0].pid, "number");
  assert.strictEqual(wm.basketProjectileCount, 0, "no projectile at the request");
  tickFor(wm, advance, 100);
  assert.strictEqual(wm.basketProjectileCount, 0, "still in hand before the marker");
  tickFor(wm, advance, 50);
  assert.strictEqual(wm.basketProjectileCount, 1, "launched at the marker");
  const launch = basketActions(rec, "BASKET_LAUNCH");
  assert.strictEqual(launch.length, 1);
  assert.strictEqual(launch[0].pid, throws[0].pid);
  const speed = Math.hypot(launch[0].dx, launch[0].dy, launch[0].dz);
  assert.ok(Math.abs(speed - GB.throws[0].speed) < 1e-6, "L1 speed, no added lift");
  assert.ok(Math.abs(launch[0].dy) < 1e-9, "flat aim → zero vertical velocity");
});

test("basket: level thresholds 0.58 / 1.00 s are decided by the SERVER clock", () => {
  const cases: [number, number][] = [
    [570, 1],
    [580, 2],
    [990, 2],
    [1000, 3],
    [4000, 3], // prolonged max charge keeps level 3
  ];
  for (const [ms, expected] of cases) {
    const { wm, rec, addPlayer, advance } = makeWorld();
    const a = addPlayer("A", 3, 0.9, 16);
    wm.handleEquip(a, NetworkWeaponId.GOOFY_BASKET);
    fire(wm, a, WeaponActionType.BASKET_CHARGE_START, eyeOf(a), { x: 0, y: 0, z: -1 });
    advance(ms);
    // A forged `lv` / extra data is ignored: only the server clock counts.
    fire(wm, a, WeaponActionType.BASKET_THROW_REQUEST, eyeOf(a), { x: 0, y: 0, z: -1 }, { lv: 3 });
    const t = basketActions(rec, "BASKET_THROW");
    assert.strictEqual(t.length, 1, `held ${ms} ms → one throw`);
    assert.strictEqual(t[0].lv, expected, `held ${ms} ms → level ${expected}`);
  }
});

test("basket: repeated release / charge during the engaged sequence is refused; free after Catch", () => {
  const { wm, rec, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  wm.handleEquip(a, NetworkWeaponId.GOOFY_BASKET);
  fire(wm, a, WeaponActionType.BASKET_THROW_REQUEST, eyeOf(a), { x: 0, y: 0, z: -1 });
  fire(wm, a, WeaponActionType.BASKET_THROW_REQUEST, eyeOf(a), { x: 0, y: 0, z: -1 });
  assert.strictEqual(basketActions(rec, "BASKET_THROW").length, 1, "duplicate release refused");
  // Throw_L1 0.50 s + Catch 0.58 s = 1.08 s busy.
  tickFor(wm, advance, 1000);
  fire(wm, a, WeaponActionType.BASKET_CHARGE_START, eyeOf(a), { x: 0, y: 0, z: -1 });
  advance(50);
  fire(wm, a, WeaponActionType.BASKET_THROW_REQUEST, eyeOf(a), { x: 0, y: 0, z: -1 });
  assert.strictEqual(basketActions(rec, "BASKET_THROW").length, 1, "release before readyAt refused");
  tickFor(wm, advance, 200);
  fire(wm, a, WeaponActionType.BASKET_CHARGE_START, eyeOf(a), { x: 0, y: 0, z: -1 });
  advance(600);
  fire(wm, a, WeaponActionType.BASKET_THROW_REQUEST, eyeOf(a), { x: 0, y: 0, z: -1 });
  const t = basketActions(rec, "BASKET_THROW");
  assert.strictEqual(t.length, 2, "new sequence after the catch");
  assert.strictEqual(t[1].lv, 2, "the refused charge did not leak into the new one");
});

test("basket: flat 25 damage on the first player contact, projectile consumed, hit confirmed", () => {
  for (const maxHealth of [100, 200]) {
    const { wm, rec, addPlayer, advance } = makeWorld();
    // Open lane at x = −3 (the x = 3 lane has a low cover wall whose top the
    // 0.3 m ball would clip, unlike a thin revolver ray).
    const a = addPlayer("A", -3, 0.9, 16);
    const b = addPlayer("B", -3, 0.9, 10);
    b.maxHealth = maxHealth;
    b.health = maxHealth;
    wm.handleEquip(a, NetworkWeaponId.GOOFY_BASKET);
    fire(wm, a, WeaponActionType.BASKET_CHARGE_START, eyeOf(a), { x: 0, y: 0, z: -1 });
    advance(1000);
    fire(wm, a, WeaponActionType.BASKET_THROW_REQUEST, eyeOf(a), dirTo(eyeOf(a), { x: -3, y: 1.0, z: 10 }));
    tickFor(wm, advance, 1500);
    assert.strictEqual(b.health, maxHealth - GB.damage, `25 flat on ${maxHealth} max HP`);
    assert.strictEqual(wm.basketProjectileCount, 0, "consumed by the first player hit");
    const ends = basketActions(rec, "BASKET_END");
    assert.strictEqual(ends.length, 1);
    assert.strictEqual(ends[0].tid, "B");
    const hit = rec.hits.find((h) => h.attackerId === "A");
    assert.ok(hit && hit.ev.weapon === NetworkWeaponId.GOOFY_BASKET && hit.ev.damageDealt === GB.damage);
    assert.strictEqual(rec.hits.length, 1, "no second hit at the same contact");
  }
});

test("basket: world bounce budget per level, then the next world contact ends the ball", () => {
  for (const level of [1, 2, 3] as const) {
    const { wm, rec, addPlayer, advance } = makeWorld();
    const a = addPlayer("A", 0, 0.9, 20);
    wm.handleEquip(a, NetworkWeaponId.GOOFY_BASKET);
    fire(wm, a, WeaponActionType.BASKET_CHARGE_START, eyeOf(a), { x: 0, y: 0, z: -1 });
    advance(GB.levelThresholdsSeconds[level - 1] * 1000 + 5);
    // Straight down onto the open ground slab: pure vertical bounces.
    fire(wm, a, WeaponActionType.BASKET_THROW_REQUEST, eyeOf(a), { x: 0, y: -1, z: 0 });
    tickFor(wm, advance, GB.maxLifetimeSeconds * 1000 + 1500);
    const bounces = basketActions(rec, "BASKET_BOUNCE");
    // L3 at 24 m/s straight down: 0.78 restitution → the 5th ground contact
    // would come at ≈6.75 s, past the 6 s lifetime → 4 bounces then expiry.
    const expected = level === 3 ? 4 : GB.throws[level - 1].maxWorldBounces;
    assert.strictEqual(bounces.length, expected, `L${level} bounce budget / lifetime`);
    for (let i = 0; i < bounces.length; i++) {
      assert.strictEqual(bounces[i].bn, i + 1, "bounce numbering");
      assert.ok(bounces[i].dy > 0, "reflected upward");
      assert.ok(Math.abs(bounces[i].hy - 1) < 1e-9, "ground normal");
    }
    assert.strictEqual(basketActions(rec, "BASKET_END").length, 1, "exactly one end event");
    assert.strictEqual(wm.basketProjectileCount, 0);
  }
});

test("basket: a ball always ends within its lifetime (no immortal projectile)", () => {
  const { wm, rec, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 0, 0.9, 20);
  wm.handleEquip(a, NetworkWeaponId.GOOFY_BASKET);
  fire(wm, a, WeaponActionType.BASKET_THROW_REQUEST, eyeOf(a), { x: 0, y: 1, z: 0 });
  tickFor(wm, advance, GB.maxLifetimeSeconds * 1000 + 1500);
  assert.strictEqual(wm.basketProjectileCount, 0);
  assert.strictEqual(basketActions(rec, "BASKET_END").length, 1);
});

test("basket: weapon swap cancels the charge; death drops a planned launch", () => {
  const { wm, rec, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  wm.handleEquip(a, NetworkWeaponId.GOOFY_BASKET);
  fire(wm, a, WeaponActionType.BASKET_CHARGE_START, eyeOf(a), { x: 0, y: 0, z: -1 });
  advance(1200);
  wm.handleEquip(a, NetworkWeaponId.REVOLVER);
  wm.handleEquip(a, NetworkWeaponId.GOOFY_BASKET);
  fire(wm, a, WeaponActionType.BASKET_THROW_REQUEST, eyeOf(a), { x: 0, y: 0, z: -1 });
  assert.strictEqual(basketActions(rec, "BASKET_THROW")[0].lv, 1, "swap dropped the charge → tap");
  // Death right after the release, before the marker: no projectile.
  wm.onPlayerDeath("A");
  a.isAlive = false;
  tickFor(wm, advance, 500);
  assert.strictEqual(basketActions(rec, "BASKET_LAUNCH").length, 0, "a corpse never launches");
  assert.strictEqual(wm.basketProjectileCount, 0);
});

test("basket: wrong weapon / dead player requests are ignored", () => {
  const { wm, rec, addPlayer } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  wm.handleEquip(a, NetworkWeaponId.REVOLVER);
  fire(wm, a, WeaponActionType.BASKET_THROW_REQUEST, eyeOf(a), { x: 0, y: 0, z: -1 });
  assert.strictEqual(basketActions(rec, "BASKET_THROW").length, 0);
  wm.handleEquip(a, NetworkWeaponId.GOOFY_BASKET);
  a.isAlive = false;
  fire(wm, a, WeaponActionType.BASKET_THROW_REQUEST, eyeOf(a), { x: 0, y: 0, z: -1 });
  assert.strictEqual(basketActions(rec, "BASKET_THROW").length, 0);
});

console.log(`\n${passed} weapon tests passed`);
