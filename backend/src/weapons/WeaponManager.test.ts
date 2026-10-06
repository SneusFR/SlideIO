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
import { basketLaunchOrigin } from "../../../shared/combat/BasketProjectileSim";
import { hitscan, hasLineOfSight } from "./HitDetection";
import {
  PopcornShotgunConfig,
  popcornPelletDirections,
  popcornRayVsPlayer,
  popcornShotDamage,
} from "../../../shared/combat/PopcornShotgunRules";
import {
  PaintballRifleConfig,
  paintballBallDirection,
  paintballDamage,
} from "../../../shared/combat/PaintballRifleRules";
import { PaintballRifleState, resolvePaintballFire } from "./PaintballRifleServer";

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
  assert.ok(Math.abs(speed - GB.throws[0].speed) < 1e-6, "standing shooter: L1 speed exactly (no momentum, no lift)");
  // RIGHT HAND launch point (shared rule), never the eye / head.
  const eye = eyeOf(a);
  const expected = basketLaunchOrigin(eye, { x: 0, y: 0, z: -1 });
  assert.ok(Math.abs(launch[0].ox - expected.x) < 1e-9 && Math.abs(launch[0].oy - expected.y) < 1e-9 && Math.abs(launch[0].oz - expected.z) < 1e-9, "launched from the hand");
  assert.ok(launch[0].oy < eye.y - 0.2, "clearly below the eye");
  assert.ok(launch[0].ox > eye.x + 0.2, "clearly to the right of the eye (facing −Z → +X)");
  // Hand → aim-line convergence: heads slightly left and up, never a lob.
  assert.ok(launch[0].dx < 0 && launch[0].dy > 0 && launch[0].dy < 1.0, "converges on the crosshair line");
});

test("basket: the ball inherits the shooter momentum reported at the release (px/py/pz), clamped", () => {
  const cases: [{ x: number; y: number; z: number }, number][] = [
    [{ x: 0, y: 0, z: -20 }, GB.throws[0].speed + 20 * GB.shooterMomentumForwardFactor], // running into the aim
    [{ x: 0, y: 0, z: 20 }, GB.throws[0].speed], // backpedalling → plain level speed
    [{ x: 0, y: 0, z: -500 }, GB.throws[0].speed + GB.maxShooterSpeed * GB.shooterMomentumForwardFactor], // cheat → clamp
  ];
  for (const [shooterVel, expectedSpeed] of cases) {
    const { wm, rec, addPlayer, advance } = makeWorld();
    const a = addPlayer("A", 3, 0.9, 16);
    wm.handleEquip(a, NetworkWeaponId.GOOFY_BASKET);
    fire(wm, a, WeaponActionType.BASKET_THROW_REQUEST, eyeOf(a), { x: 0, y: 0, z: -1 }, { px: shooterVel.x, py: shooterVel.y, pz: shooterVel.z });
    tickFor(wm, advance, 200);
    const launch = basketActions(rec, "BASKET_LAUNCH");
    assert.strictEqual(launch.length, 1);
    const speed = Math.hypot(launch[0].dx, launch[0].dy, launch[0].dz);
    // The convergence tilt is tiny: compare the speed along the aim.
    assert.ok(Math.abs(speed - expectedSpeed) < 0.05, `shooter ${shooterVel.z} m/s → ball ${speed.toFixed(2)} ≈ ${expectedSpeed}`);
  }
  // Faster shooter → faster ball (monotonic).
  const speeds: number[] = [];
  for (const vz of [-5, -15, -30]) {
    const { wm, rec, addPlayer, advance } = makeWorld();
    const a = addPlayer("A", 3, 0.9, 16);
    wm.handleEquip(a, NetworkWeaponId.GOOFY_BASKET);
    fire(wm, a, WeaponActionType.BASKET_THROW_REQUEST, eyeOf(a), { x: 0, y: 0, z: -1 }, { px: 0, py: 0, pz: vz });
    tickFor(wm, advance, 200);
    const l = basketActions(rec, "BASKET_LAUNCH")[0];
    speeds.push(Math.hypot(l.dx, l.dy, l.dz));
  }
  assert.ok(speeds[0] < speeds[1] && speeds[1] < speeds[2], "the faster the player, the faster the ball");
});

test("basket: level thresholds 0.25 / 0.45 s are decided by the SERVER clock", () => {
  const t2 = Math.round(GB.levelThresholdsSeconds[1] * 1000);
  const t3 = Math.round(GB.levelThresholdsSeconds[2] * 1000);
  const cases: [number, number][] = [
    [t2 - 10, 1],
    [t2, 2],
    [t3 - 10, 2],
    [t3, 3],
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
  advance(Math.round(GB.levelThresholdsSeconds[1] * 1000) + 50); // inside the L2 window (< L3)
  fire(wm, a, WeaponActionType.BASKET_THROW_REQUEST, eyeOf(a), { x: 0, y: 0, z: -1 });
  const t = basketActions(rec, "BASKET_THROW");
  assert.strictEqual(t.length, 2, "new sequence after the catch");
  assert.strictEqual(t[1].lv, 2, "the refused charge did not leak into the new one");
});

test("basket: flat 75 damage on the first player contact, projectile consumed, hit confirmed", () => {
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

test("basket: MAX charge = sniper ball — crosshair on a player 100 m away hits him within ~0.5 s, no gravity sag", () => {
  // Open lane of the Jungle map at x = 27 (no obstacle above the ground
  // between z = −52 and z = 60): shooter at z = 55, target at z = −45.
  const { wm, rec, addPlayer, advance, nowMs } = makeWorld();
  const a = addPlayer("A", 27, 0.9, 55);
  const b = addPlayer("B", 27, 0.9, -45);
  wm.handleEquip(a, NetworkWeaponId.GOOFY_BASKET);
  fire(wm, a, WeaponActionType.BASKET_CHARGE_START, eyeOf(a), { x: 0, y: 0, z: -1 });
  advance(GB.levelThresholdsSeconds[2] * 1000 + 50); // L3
  // Crosshair on the target's chest (capsule center), 100 m away.
  fire(wm, a, WeaponActionType.BASKET_THROW_REQUEST, eyeOf(a), dirTo(eyeOf(a), { x: b.x, y: b.y + 0.2, z: b.z }));
  assert.strictEqual(basketActions(rec, "BASKET_THROW")[0].lv, 3);
  let launchedAt = 0;
  let endAt = 0;
  for (let i = 0; i < 60 && !endAt; i++) {
    tickFor(wm, advance, 50);
    if (!launchedAt && basketActions(rec, "BASKET_LAUNCH").length) launchedAt = nowMs();
    if (basketActions(rec, "BASKET_END").length) endAt = nowMs();
  }
  const launch = basketActions(rec, "BASKET_LAUNCH")[0];
  assert.ok(Math.abs(Math.hypot(launch.dx, launch.dy, launch.dz) - GB.throws[2].speed) < 1e-6, "sniper speed");
  assert.strictEqual(b.health, 200 - GB.damage, "the 100 m target is HIT (flat 75)");
  assert.strictEqual(basketActions(rec, "BASKET_BOUNCE").length, 0, "no ground / wall contact on the way (straight flight)");
  const ends = basketActions(rec, "BASKET_END");
  assert.strictEqual(ends.length, 1);
  assert.strictEqual(ends[0].tid, "B");
  const flight = (endAt - launchedAt) / 1000;
  assert.ok(flight <= 0.6, `100 m crossed in ${flight.toFixed(2)} s (≤ 0.6 s, sniper-like)`);
  assert.strictEqual(wm.basketProjectileCount, 0);

  // Same shot at level 1 (tap): the slow lob never reaches a 100 m target.
  const w2 = makeWorld();
  const a2 = w2.addPlayer("A", 27, 0.9, 55);
  const b2 = w2.addPlayer("B", 27, 0.9, -45);
  w2.wm.handleEquip(a2, NetworkWeaponId.GOOFY_BASKET);
  fire(w2.wm, a2, WeaponActionType.BASKET_THROW_REQUEST, eyeOf(a2), dirTo(eyeOf(a2), { x: b2.x, y: b2.y + 0.2, z: b2.z }));
  tickFor(w2.wm, w2.advance, GB.maxLifetimeSeconds * 1000 + 1500);
  assert.strictEqual(b2.health, 200, "L1 lob falls short — the max charge is what makes the sniper ball");
});

test("basket: a MAX charge ball that hits a wall comes back as a plain basketball (speed capped, then falls & bounces)", () => {
  // Shooter at x = 27 firing at the big −z terrace mass (front face around
  // z ≈ −44 on this lane) — a world bounce, then a normal falling ball.
  const { wm, rec, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 27, 0.9, 20);
  wm.handleEquip(a, NetworkWeaponId.GOOFY_BASKET);
  fire(wm, a, WeaponActionType.BASKET_CHARGE_START, eyeOf(a), { x: 0, y: 0, z: -1 });
  advance(GB.levelThresholdsSeconds[2] * 1000 + 50);
  fire(wm, a, WeaponActionType.BASKET_THROW_REQUEST, eyeOf(a), { x: 0, y: 0, z: -1 });
  tickFor(wm, advance, GB.maxLifetimeSeconds * 1000 + 1500);
  const bounces = basketActions(rec, "BASKET_BOUNCE");
  assert.ok(bounces.length >= 2, `bounces on the wall then on the ground (${bounces.length})`);
  assert.ok(bounces[0].dz > 0 && Math.abs(bounces[0].hz - 1) < 1e-9, "first contact: the wall, ball comes back (+z)");
  for (const bn of bounces) {
    assert.ok(Math.hypot(bn.dx, bn.dy, bn.dz) <= GB.maxSpeedAfterBounce + 1e-6, "every rebound is capped to a readable basketball speed");
  }
  assert.ok(bounces.slice(1).some((bn) => Math.abs(bn.hy - 1) < 1e-9 && bn.dy > 0), "then it drops and bounces on the ground");
  assert.strictEqual(basketActions(rec, "BASKET_END").length, 1);
  assert.strictEqual(wm.basketProjectileCount, 0);
});

test("basket: world bounce budget per level, then the ball RESTS (BASKET_REST) and ends only at the 5 s lifetime", () => {
  for (const level of [1, 2, 3] as const) {
    const { wm, rec, addPlayer, advance, nowMs } = makeWorld();
    const a = addPlayer("A", 0, 0.9, 20);
    wm.handleEquip(a, NetworkWeaponId.GOOFY_BASKET);
    fire(wm, a, WeaponActionType.BASKET_CHARGE_START, eyeOf(a), { x: 0, y: 0, z: -1 });
    advance(GB.levelThresholdsSeconds[level - 1] * 1000 + 5);
    // Straight down onto the open ground slab: pure vertical bounces.
    fire(wm, a, WeaponActionType.BASKET_THROW_REQUEST, eyeOf(a), { x: 0, y: -1, z: 0 });
    const thrownAt = nowMs();
    let launchedAt = 0;
    let restAt = 0;
    let endAt = 0;
    for (let i = 0; i < (GB.maxLifetimeSeconds * 1000 + 1500) / 50; i++) {
      tickFor(wm, advance, 50);
      if (!launchedAt && basketActions(rec, "BASKET_LAUNCH").length) launchedAt = nowMs();
      if (!restAt && basketActions(rec, "BASKET_REST").length) restAt = nowMs();
      if (!endAt && basketActions(rec, "BASKET_END").length) endAt = nowMs();
    }
    const bounces = basketActions(rec, "BASKET_BOUNCE");
    // L3 at 200 m/s straight down: the rebound is capped to 30 m/s
    // (0.03 s), climbs ~28 m and lands again at ≈3.75 s (23 m/s up); the
    // 3rd ground contact would come at ≈6.7 s, past the 5 s lifetime →
    // 2 bounces then expiry in flight (no rest). L1 / L2 spend their
    // budget and come to rest.
    // Budget spent → the next floor contact is a ROLL start (signalled as a
    // bounce with NO upward rebound) when the residual horizontal speed is
    // still ≥ minBounceSpeed, otherwise the ball rests right there.
    const expected = level === 3 ? 2 : GB.throws[level - 1].maxWorldBounces;
    assert.ok(
      bounces.length === expected || bounces.length === expected + 1,
      `L${level} bounce budget / lifetime (${bounces.length} vs ${expected}[+1 roll start])`,
    );
    for (let i = 0; i < bounces.length; i++) {
      assert.strictEqual(bounces[i].bn, i + 1, "bounce numbering");
      assert.ok(Math.abs(bounces[i].hy - 1) < 1e-9, "ground normal");
      if (i < expected) assert.ok(bounces[i].dy > 0, "reflected upward");
      else assert.ok(Math.abs(bounces[i].dy) < 1e-9 && Math.hypot(bounces[i].dx, bounces[i].dz) >= GB.minBounceSpeed - 1e-9, "roll start: no rebound, tangential speed kept");
    }
    const rests = basketActions(rec, "BASKET_REST");
    if (level < 3) {
      assert.strictEqual(rests.length, 1, `L${level}: one rest event once the budget is spent`);
      assert.ok(Math.hypot(rests[0].dx, rests[0].dy, rests[0].dz) === 0, "rest = zero velocity");
      assert.ok(Math.abs(rests[0].hy - 1) < 1e-9, "rest on the ground");
      assert.ok(restAt > thrownAt && restAt < endAt, "rest happens before the end");
    } else {
      assert.strictEqual(rests.length, 0, "L3 never spends its budget within the lifetime here");
    }
    assert.strictEqual(basketActions(rec, "BASKET_END").length, 1, "exactly one end event");
    assert.strictEqual(wm.basketProjectileCount, 0);
    // The ball lived the FULL lifetime after its launch (never vanished early).
    const lived = (endAt - launchedAt) / 1000;
    assert.ok(Math.abs(lived - GB.maxLifetimeSeconds) <= 0.1, `L${level} lived ${lived.toFixed(2)} s ≈ ${GB.maxLifetimeSeconds} s`);
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

// ---------------------------------------------------------------------
// POPCORN SHOTGUN (shared seeded pellets, summed damage, ammo / reload)
// ---------------------------------------------------------------------

const PS = PopcornShotgunConfig;
const popcornFires = (rec: Recorded) => rec.actions.filter((e) => e.action === WeaponActionType.POPCORN_FIRE);

test("popcorn: point blank body shot = one shot, ONE damage event, seed + ammo confirmed", () => {
  const { wm, rec, addPlayer } = makeWorld();
  // Open ground (x = −40): all 12 pellets reach the target (at x = 3 a wall
  // beside the shooter eats 9 of them — that spot only passed thanks to the
  // old head one-shot rule).
  const a = addPlayer("A", -40, 0.9, 16);
  const b = addPlayer("B", -40, 0.9, 13); // 3 m
  wm.handleEquip(a, NetworkWeaponId.POPCORN_SHOTGUN);
  fire(wm, a, WeaponActionType.POPCORN_FIRE, eyeOf(a), dirTo(eyeOf(a), { x: -40, y: 0.9, z: 13 }), { sd: 12345 });
  assert.strictEqual(b.isAlive, false, "3 m body shot kills");
  assert.strictEqual(rec.hits.length, 1, "all pellets summed into ONE hit event");
  assert.strictEqual(rec.damages.length, 1);
  const conf = popcornFires(rec);
  assert.strictEqual(conf.length, 1);
  assert.strictEqual(conf[0].sd, 12345);
  assert.strictEqual(conf[0].am, 1);
});

test("popcorn: head pellets = ×1.5 damage, NO one-shot at range", () => {
  const { wm, rec, addPlayer } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  const b = addPlayer("B", 3, 0.9, -8); // 24 m, open street
  wm.handleEquip(a, NetworkWeaponId.POPCORN_SHOTGUN);
  // Head-aimed shot: server damage must equal the shared prediction (head pellets × 1.5).
  const aim = dirTo(eyeOf(a), { x: 3, y: 0.9 + 0.875, z: -8 });
  const dirs = Array.from({ length: PS.pellets }, () => ({ x: 0, y: 0, z: 0 }));
  popcornPelletDirections(aim, 7, dirs);
  const pred = dirs
    .map((d) => popcornRayVsPlayer(eyeOf(a), d, b, PS.maxRange))
    .filter((h) => h !== null)
    .map((h) => ({ distance: h!.t, head: h!.head }));
  fire(wm, a, WeaponActionType.POPCORN_FIRE, eyeOf(a), aim, { sd: 7 });
  if (pred.length > 0 && rec.hits.length > 0) {
    assert.ok(pred.some((h) => h.head), "the aimed pellet lands in the head");
    assert.strictEqual(rec.hits[0].ev.hitZone, "HEAD");
    assert.ok(Math.abs(rec.hits[0].ev.damageDealt - popcornShotDamage(pred, 200, 200)) < 1e-6, "server = shared (× 1.5)");
    assert.ok(b.isAlive, "a far head pellet no longer one-shots");
  }
  // Exact values of the rule (independent of the map).
  assert.strictEqual(popcornShotDamage([{ distance: 5, head: true }], 200, 200), 200 * 0.25 * 1.5);
  assert.strictEqual(popcornShotDamage([{ distance: 5, head: false }], 200, 200), 200 * 0.25);
});

test("popcorn: long range body shot = small damage, no kill", () => {
  const { wm, rec, addPlayer } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  const b = addPlayer("B", 3, 0.9, -4); // 20 m
  wm.handleEquip(a, NetworkWeaponId.POPCORN_SHOTGUN);
  // Pick (with the SHARED rule) a seed whose pellets only touch the body
  // (a stray ring pellet can reach the 0.45 m head sphere and get × 1.5).
  // This also checks that the server resolves exactly what the shared
  // module predicts.
  const aim = dirTo(eyeOf(a), { x: 3, y: 0.9, z: -4 });
  const dirs = Array.from({ length: PS.pellets }, () => ({ x: 0, y: 0, z: 0 }));
  let seed = 0;
  let expected = 0;
  for (let s = 1; s < 500; s++) {
    popcornPelletDirections(aim, s, dirs);
    const hits = dirs.map((d) => popcornRayVsPlayer(eyeOf(a), d, b, PS.maxRange)).filter((h) => h !== null);
    if (hits.length > 0 && hits.every((h) => !h!.head)) {
      seed = s;
      expected = popcornShotDamage(hits.map((h) => ({ distance: h!.t, head: false })), 200, 200);
      break;
    }
  }
  assert.ok(seed > 0, "a body-only seed exists");
  fire(wm, a, WeaponActionType.POPCORN_FIRE, eyeOf(a), aim, { sd: seed });
  assert.strictEqual(rec.hits.length, 1, "a far shot still touches");
  assert.ok(Math.abs(rec.hits[0].ev.damageDealt - expected) < 1e-6, "server = shared prediction");
  assert.strictEqual(rec.hits[0].ev.hitZone, "BODY");
  assert.ok(b.isAlive, "20 m body shot never kills");
  assert.ok(rec.hits[0].ev.damageDealt <= b.maxHealth * 0.25, "only a few weak pellets");
});

test("popcorn: 2 loads, cadence 0.58 s, dry fire refused, reload gates 1.75 / 2.06 s", () => {
  const { wm, rec, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  wm.handleEquip(a, NetworkWeaponId.POPCORN_SHOTGUN);
  const up = { x: 0, y: 1, z: 0 }; // shoot the sky: no victim needed
  fire(wm, a, WeaponActionType.POPCORN_FIRE, eyeOf(a), up, { sd: 1 });
  fire(wm, a, WeaponActionType.POPCORN_FIRE, eyeOf(a), up, { sd: 2 });
  assert.strictEqual(popcornFires(rec).length, 1, "cadence refuses the spam shot");
  advance(PS.timeline.fireReady * 1000);
  fire(wm, a, WeaponActionType.POPCORN_FIRE, eyeOf(a), up, { sd: 3 });
  assert.strictEqual(popcornFires(rec).length, 2);
  assert.strictEqual(popcornFires(rec)[1].am, 0, "last load");
  advance(2000);
  fire(wm, a, WeaponActionType.POPCORN_FIRE, eyeOf(a), up, { sd: 4 });
  assert.strictEqual(popcornFires(rec).length, 2, "empty tank refused");
  // Reload cancelled BEFORE 1.75 s keeps 0 ammo.
  fire(wm, a, WeaponActionType.POPCORN_RELOAD, eyeOf(a), up);
  advance(1000);
  fire(wm, a, WeaponActionType.POPCORN_RELOAD_CANCEL, eyeOf(a), up);
  advance(3000);
  fire(wm, a, WeaponActionType.POPCORN_FIRE, eyeOf(a), up, { sd: 5 });
  assert.strictEqual(popcornFires(rec).length, 2, "cancel before refill keeps the tank empty");
  // Full reload: refused at 1.9 s, accepted from 2.06 s.
  fire(wm, a, WeaponActionType.POPCORN_RELOAD, eyeOf(a), up);
  advance(1900);
  fire(wm, a, WeaponActionType.POPCORN_FIRE, eyeOf(a), up, { sd: 6 });
  assert.strictEqual(popcornFires(rec).length, 2, "fire refused before readyToFire");
  advance(200);
  fire(wm, a, WeaponActionType.POPCORN_FIRE, eyeOf(a), up, { sd: 7 });
  assert.strictEqual(popcornFires(rec).length, 3, "fire accepted after 2.06 s");
  assert.strictEqual(popcornFires(rec)[2].am, 1, "reload refilled 2 loads");
  // A cancel AFTER 1.75 s keeps the refilled tank.
  advance(1000);
  fire(wm, a, WeaponActionType.POPCORN_FIRE, eyeOf(a), up, { sd: 8 });
  fire(wm, a, WeaponActionType.POPCORN_RELOAD, eyeOf(a), up);
  advance(1800);
  fire(wm, a, WeaponActionType.POPCORN_RELOAD_CANCEL, eyeOf(a), up);
  advance(100);
  fire(wm, a, WeaponActionType.POPCORN_FIRE, eyeOf(a), up, { sd: 9 });
  assert.strictEqual(popcornFires(rec).at(-1).am, 1, "cancel after 1.75 s = full tank");
});

test("popcorn: wrong weapon / missing seed / invalid seed refused", () => {
  const { wm, rec, addPlayer } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  wm.handleEquip(a, NetworkWeaponId.REVOLVER);
  fire(wm, a, WeaponActionType.POPCORN_FIRE, eyeOf(a), { x: 0, y: 1, z: 0 }, { sd: 1 });
  wm.handleEquip(a, NetworkWeaponId.POPCORN_SHOTGUN);
  fire(wm, a, WeaponActionType.POPCORN_FIRE, eyeOf(a), { x: 0, y: 1, z: 0 });
  fire(wm, a, WeaponActionType.POPCORN_FIRE, eyeOf(a), { x: 0, y: 1, z: 0 }, { sd: -3 });
  fire(wm, a, WeaponActionType.POPCORN_FIRE, eyeOf(a), { x: 0, y: 1, z: 0 }, { sd: 1.5 });
  assert.strictEqual(popcornFires(rec).length, 0);
});

// ---------------------------------------------------------------------
// PAINTBALL RIFLE (automatic hitscan, 23 / 34.5, 32 balls, hopper swap)
// ---------------------------------------------------------------------

const PB = PaintballRifleConfig;
const paintFires = (rec: Recorded) => rec.actions.filter((e) => e.action === WeaponActionType.PAINTBALL_FIRE);

test("paintball: body ball = 23 immediately, head ball = 34.5", () => {
  const { wm, rec, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", -40, 0.9, 16);
  const b = addPlayer("B", -40, 0.9, 10); // 6 m, open ground
  wm.handleEquip(a, NetworkWeaponId.PAINTBALL_RIFLE);
  const chest = dirTo(eyeOf(a), { x: -40, y: 0.9, z: 10 });
  fire(wm, a, WeaponActionType.PAINTBALL_FIRE, eyeOf(a), chest, { sd: 1, sp: 0 });
  assert.strictEqual(b.health, 200 - 23, "hitscan: damage at the shot time");
  assert.strictEqual(rec.hits.length, 1);
  assert.strictEqual(rec.hits[0].ev.hitZone, "BODY");
  const conf = paintFires(rec);
  assert.strictEqual(conf.length, 1);
  assert.strictEqual(conf[0].sd, 1);
  assert.strictEqual(conf[0].am, PB.capacity - 1);
  assert.strictEqual(conf[0].tid, "B", "victim id confirmed (remote paint)");
  assert.ok(typeof conf[0].hx === "number", "end point confirmed");
  advance(100);
  const head = dirTo(eyeOf(a), { x: -40, y: 0.9 + 0.66, z: 10 });
  fire(wm, a, WeaponActionType.PAINTBALL_FIRE, eyeOf(a), head, { sd: 2, sp: 0 });
  assert.strictEqual(rec.hits[1].ev.hitZone, "HEAD");
  assert.strictEqual(rec.hits[1].ev.damageDealt, 34.5);
  assert.strictEqual(paintballDamage(false), 23);
  assert.strictEqual(paintballDamage(true), 34.5);
  // 200 HP scale: 9 body balls kill (207), 8 do not (184).
  assert.ok(9 * paintballDamage(false) >= 200 && 8 * paintballDamage(false) < 200);
});

test("paintball: NO max range — a player 150 m away is hit (23), wall first still blocks", () => {
  const st = new PaintballRifleState();
  const eye = { x: 0, y: 0.9 + PLAYER_EYE_OFFSET, z: 0 };
  const far = { id: "B", x: 0, y: 0.9, z: -150 };
  const chest = dirTo(eye, { x: 0, y: 0.9, z: -150 });
  const r = resolvePaintballFire(st, 1_000_000, eye, chest, 1, 0, [far], "A", []);
  assert.ok(r.accepted);
  assert.ok(r.victim && r.victim.targetId === "B", "hit at 150 m (the pack's 45 m cap is gone)");
  assert.strictEqual(r.victim!.amount, 23, "no distance falloff");
  // A wall in front of him still stops the ball (map bounds / walls = the only limit).
  const wall: [number, number, number, number, number, number][] = [[0, 2, -100, 20, 4, 1]];
  const r2 = resolvePaintballFire(st, 1_000_200, eye, chest, 2, 0, [far], "A", wall);
  assert.strictEqual(r2.victim, null, "wall in front → no hit");
  assert.ok(Math.abs(r2.endPoint.z - -99.5) < 1e-6, "ball stops on the wall face");
  assert.ok(PB.maxRange >= 400, "ray covers every map diagonal");
});

test("paintball: NO spread — any received cone clamps to 0°, the ball flies EXACTLY along the aim", () => {
  const { wm, rec, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", -40, 0.9, 16);
  wm.handleEquip(a, NetworkWeaponId.PAINTBALL_RIFLE);
  // Near-vertical sky shot (tilted: a cone would visibly move it): nothing
  // to hit, the end point is the end of the ray.
  const aim = dirTo(eyeOf(a), { x: -40 + 3, y: 100, z: 16 - 2 });
  const o = eyeOf(a);
  let k = 0;
  for (const sp of [2.2, 50, 0.35, -1, undefined]) {
    if (k > 0) advance(100);
    fire(wm, a, WeaponActionType.PAINTBALL_FIRE, o, aim, { sd: 777 + k, ...(sp !== undefined ? { sp } : {}) });
    const c = paintFires(rec)[k++];
    assert.strictEqual(c.sp, 0, `cone ${sp} → 0°`);
    // End point exactly on the aim ray (the server normalizes the aim).
    const d = paintballBallDirection(aim, 0, c.sd, { x: 0, y: 0, z: 0 });
    assert.ok(Math.abs(d.x - aim.x) < 1e-9 && Math.abs(d.y - aim.y) < 1e-9 && Math.abs(d.z - aim.z) < 1e-9, "0° cone = the aim itself");
    const ex = o.x + aim.x * PB.maxRange, ey = o.y + aim.y * PB.maxRange, ez = o.z + aim.z * PB.maxRange;
    assert.ok(
      Math.abs(c.hx - ex) < 1e-6 && Math.abs(c.hy - ey) < 1e-6 && Math.abs(c.hz - ez) < 1e-6,
      `end point on the aim ray (${c.hx},${c.hy},${c.hz}) vs (${ex},${ey},${ez})`,
    );
  }
  assert.strictEqual(PB.spreadMaxDeg, 0);
});

test("paintball: cadence ≥ 0.1 s (jitter-tolerant, never above 600 rpm), 32 balls, empty refused", () => {
  const { wm, rec, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  wm.handleEquip(a, NetworkWeaponId.PAINTBALL_RIFLE);
  const up = { x: 0, y: 1, z: 0 };
  let s = 1;
  const shoot = () => fire(wm, a, WeaponActionType.PAINTBALL_FIRE, eyeOf(a), up, { sd: s++ });
  shoot();
  shoot();
  assert.strictEqual(paintFires(rec).length, 1, "spam refused");
  advance(50); // 0.05 s: beyond the 0.04 s jitter tolerance → refused
  shoot();
  assert.strictEqual(paintFires(rec).length, 1);
  advance(40); // 0.09 s since the first ball: 10 ms early → accepted (jitter)
  shoot();
  assert.strictEqual(paintFires(rec).length, 2);
  // Sustained 90 ms spam: the 40 ms debt runs out → throttled to ≤ 600 rpm.
  let accepted = 0;
  for (let i = 0; i < 10; i++) {
    advance(90);
    const before = paintFires(rec).length;
    shoot();
    if (paintFires(rec).length > before) accepted++;
  }
  assert.ok(accepted < 10, `sustained 90 ms spam is throttled (${accepted}/10)`);
  // Drain the hopper at 600 rpm.
  while (paintFires(rec).length < PB.capacity) {
    advance(100);
    shoot();
  }
  assert.strictEqual(paintFires(rec).at(-1).am, 0, "32 balls");
  advance(100);
  shoot();
  assert.strictEqual(paintFires(rec).length, PB.capacity, "empty hopper refused");
});

test("paintball: hopper swap gates 1.52 / 2.10 s, cancel before the click keeps the ammo", () => {
  const { wm, rec, addPlayer, advance } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  wm.handleEquip(a, NetworkWeaponId.PAINTBALL_RIFLE);
  const up = { x: 0, y: 1, z: 0 };
  let s = 1;
  const shoot = () => fire(wm, a, WeaponActionType.PAINTBALL_FIRE, eyeOf(a), up, { sd: s++ });
  const act = (action: string) => fire(wm, a, action, eyeOf(a), up);
  act(WeaponActionType.PAINTBALL_RELOAD);
  assert.strictEqual(rec.actions.filter((e) => e.action === WeaponActionType.PAINTBALL_RELOAD).length, 0, "full: no reload");
  for (let i = 0; i < 5; i++) {
    shoot();
    advance(100);
  }
  assert.strictEqual(paintFires(rec).at(-1).am, 27);
  act(WeaponActionType.PAINTBALL_RELOAD);
  advance(1000);
  act(WeaponActionType.PAINTBALL_RELOAD_CANCEL);
  advance(500);
  shoot();
  assert.strictEqual(paintFires(rec).at(-1).am, 26, "cancel before 1.52 s keeps 27");
  advance(100);
  act(WeaponActionType.PAINTBALL_RELOAD);
  advance(1900);
  const n = paintFires(rec).length;
  shoot();
  assert.strictEqual(paintFires(rec).length, n, "refused before readyToFire (2.10 s)");
  advance(150);
  shoot();
  assert.strictEqual(paintFires(rec).at(-1).am, PB.capacity - 1, "full hopper after the click");
  advance(100);
  shoot();
  act(WeaponActionType.PAINTBALL_RELOAD);
  advance(1600);
  act(WeaponActionType.PAINTBALL_RELOAD_CANCEL);
  advance(100);
  shoot();
  assert.strictEqual(paintFires(rec).at(-1).am, PB.capacity - 1, "cancel after 1.52 s = full hopper");
  // Weapon swap mid-reload = cancel (before the click keeps the ammo).
  for (let i = 0; i < 3; i++) {
    advance(100);
    shoot();
  }
  act(WeaponActionType.PAINTBALL_RELOAD);
  advance(500);
  wm.handleEquip(a, NetworkWeaponId.REVOLVER);
  wm.handleEquip(a, NetworkWeaponId.PAINTBALL_RIFLE);
  advance(3000);
  shoot();
  assert.strictEqual(paintFires(rec).at(-1).am, PB.capacity - 5, "swap before the click kept the ammo");
});

test("paintball: wrong weapon / missing or invalid seed refused", () => {
  const { wm, rec, addPlayer } = makeWorld();
  const a = addPlayer("A", 3, 0.9, 16);
  const up = { x: 0, y: 1, z: 0 };
  wm.handleEquip(a, NetworkWeaponId.POPCORN_SHOTGUN);
  fire(wm, a, WeaponActionType.PAINTBALL_FIRE, eyeOf(a), up, { sd: 1 });
  wm.handleEquip(a, NetworkWeaponId.PAINTBALL_RIFLE);
  fire(wm, a, WeaponActionType.PAINTBALL_FIRE, eyeOf(a), up);
  fire(wm, a, WeaponActionType.PAINTBALL_FIRE, eyeOf(a), up, { sd: -3 });
  fire(wm, a, WeaponActionType.PAINTBALL_FIRE, eyeOf(a), up, { sd: 2.5 });
  assert.strictEqual(paintFires(rec).length, 0);
});

console.log(`\n${passed} weapon tests passed`);
