/**
 * GoofyBasket SHARED projectile integration tests (run: npm run test:basket).
 * Pure CPU: swept sphere vs boxes, reflection, remaining-time continuation,
 * corner (two contacts in ONE step), contact cap, bounce budget.
 */
import assert from "node:assert";
import { NetworkWeaponConfig as W } from "../../../shared/combat/NetworkWeapons";
import {
  basketLaunchOrigin,
  basketLaunchVelocity,
  createBasketProjectileState,
  resolveBasketLaunch,
  stepBasketProjectile,
  sweepSphereAabb,
  type BasketSweepCaster,
  type BasketVec3,
} from "../../../shared/combat/BasketProjectileSim";
import type { ColliderBox } from "../../../shared/map/MapColliders";
import { sweepBasketSphere } from "./HitDetection";

const B = W.goofyBasket;
const R = B.projectileRadius;
let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const casterFor = (boxes: ColliderBox[], targets: { id: string; x: number; y: number; z: number }[] = []): BasketSweepCaster => ({
  sweep: (from, dir, maxDist, radius, excludeId) => sweepBasketSphere(from, dir, maxDist, radius, targets, excludeId, boxes),
});
const len = (v: BasketVec3) => Math.hypot(v.x, v.y, v.z);

test("sweepSphereAabb: inflated face + normal; parallel miss", () => {
  const hit = sweepSphereAabb({ x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, R, 0, 0, 0, 10, 1, 10, 100);
  assert.ok(hit);
  assert.ok(Math.abs(hit!.distance - (5 - 1 - R)) < 1e-9, "center stops one radius above the top face");
  assert.deepStrictEqual(hit!.normal, { x: 0, y: 1, z: 0 });
  assert.strictEqual(sweepSphereAabb({ x: 0, y: 5, z: 0 }, { x: 1, y: 0, z: 0 }, R, 0, 0, 0, 10, 1, 10, 100), null);
});

test("ground bounce: reflection with the level restitution, remaining time continued, clearance applied", () => {
  const ground: ColliderBox[] = [[0, -0.5, 0, 200, 1, 200]];
  const p = createBasketProjectileState({ x: 0, y: 0.5, z: 0 }, { x: 4, y: -10, z: 0 }, 2);
  // One 50 ms step: falls ~0.54 m → reaches y = R (contact) inside the step.
  const events = stepBasketProjectile(p, 0.05, casterFor(ground), null);
  const bounce = events.find((e) => e.type === "bounce");
  assert.ok(bounce && bounce.type === "bounce", "bounced inside the step");
  const vyBefore = -10 - B.gravity * 0.05;
  assert.ok(Math.abs(bounce.vel.y - -vyBefore * B.throws[1].restitution) < 1e-9, "normal component × e");
  assert.ok(Math.abs(bounce.vel.x - 4) < 1e-9, "tangential speed preserved");
  assert.ok(p.pos.y > R, "continued upward with the remaining time (never tested only at the end point)");
  assert.strictEqual(p.bouncesLeft, B.throws[1].maxWorldBounces - 1);
  assert.strictEqual(events.filter((e) => e.type !== "bounce").length, 0, "no terminal event");
});

test("corner: two contacts in ONE step (floor + wall), both reflected, budget consumed twice", () => {
  const boxes: ColliderBox[] = [
    [0, -0.5, 0, 200, 1, 200], // floor top at y = 0
    [5.5, 5, 0, 1, 10, 200], // wall face at x = 5
  ];
  // Start close to both surfaces, moving diagonally into the corner fast.
  const p = createBasketProjectileState({ x: 4.4, y: R + 0.3, z: 0 }, { x: 20, y: -20, z: 0 }, 3);
  const events = stepBasketProjectile(p, 0.05, casterFor(boxes), null);
  const bounces = events.filter((e) => e.type === "bounce");
  assert.strictEqual(bounces.length, 2, "floor then wall resolved in the same step");
  assert.ok(p.vel.x < 0 && p.vel.y > 0, "moving away from both surfaces");
  assert.ok(p.pos.x < 5 - R + 1e-6 && p.pos.y > R - 1e-6, "never inside the wall or the floor");
  assert.strictEqual(p.bounceCount, 2);
});

test("bounce budget exhausted → the next world contact puts the ball to REST (not an end); it stays until the lifetime", () => {
  const ground: ColliderBox[] = [[0, -0.5, 0, 200, 1, 200]];
  const p = createBasketProjectileState({ x: 0, y: 2, z: 0 }, { x: 0, y: -1, z: 0 }, 1); // budget 1
  let restAt = -1;
  let expiredAt = -1;
  let restPos: BasketVec3 | null = null;
  for (let i = 0; i < 600 && expiredAt < 0; i++) {
    const ev = stepBasketProjectile(p, 1 / 60, casterFor(ground), null);
    if (restAt < 0 && ev.some((e) => e.type === "rest")) {
      restAt = p.age;
      restPos = { ...p.pos };
    }
    if (ev.some((e) => e.type === "expired")) expiredAt = p.age;
  }
  assert.ok(restAt > 0, "second floor contact puts a level-1 ball to rest");
  assert.strictEqual(p.bounceCount, 1);
  assert.ok(p.resting, "state flagged resting");
  assert.ok(restAt < B.maxLifetimeSeconds - 1, "rest happens well before the lifetime");
  assert.ok(Math.abs(expiredAt - B.maxLifetimeSeconds) < 0.02, "expiry exactly at the shared lifetime (5 s)");
  assert.ok(restPos && Math.abs(p.pos.x - restPos.x) < 1e-9 && Math.abs(p.pos.y - restPos.y) < 1e-9, "a resting ball never moves");
  assert.ok(p.pos.y >= R, "rests ON the ground, never inside it");

  // Degenerate: a ball squeezed between two facing walls 2R + ε apart with
  // a huge horizontal speed → more than maxContactsPerStep contacts in one step.
  const gap = 2 * R + 0.01;
  const squeeze: ColliderBox[] = [
    [-(gap / 2 + 0.5), 0, 0, 1, 100, 100],
    [gap / 2 + 0.5, 0, 0, 1, 100, 100],
  ];
  const q = createBasketProjectileState({ x: 0, y: 0, z: 0 }, { x: 500, y: 0, z: 0 }, 3);
  const ev = stepBasketProjectile(q, 0.05, casterFor(squeeze), null);
  assert.ok(ev.some((e) => e.type === "rest"), "contact cap puts the ball to rest");
  assert.ok(ev.filter((e) => e.type === "bounce").length <= B.maxContactsPerStep);
  assert.ok(q.resting && len(q.vel) === 0);
});

test("launch: the ball leaves the RIGHT HAND (never the eye) and converges on the aim line", () => {
  const eye = { x: 0, y: 1.45, z: 0 };
  const dir = { x: 0, y: 0, z: -1 }; // Three.js default facing: looking down −Z → right = +X
  const o = basketLaunchOrigin(eye, dir);
  const off = B.launchOffset;
  assert.ok(Math.abs(o.y - (eye.y - off.down)) < 1e-9, "below the eye");
  assert.ok(Math.abs(o.z - (eye.z - off.forward)) < 1e-9, "in front of the eye");
  assert.ok(Math.abs(o.x - off.right) < 1e-9, "RIGHT hand: +X when facing −Z");
  // Facing +X: right = fwd × up = (0, 0, 1) → hand on the +Z side.
  const o2 = basketLaunchOrigin(eye, { x: 1, y: 0, z: 0 });
  assert.ok(Math.abs(o2.z - off.right) < 1e-9 && Math.abs(o2.x - off.forward) < 1e-9);
  // Vertical aim: the right vector never collapses.
  const o3 = basketLaunchOrigin(eye, { x: 0, y: -1, z: 0 });
  assert.ok(Number.isFinite(o3.x) && Math.abs(Math.hypot(o3.x - eye.x, o3.z - eye.z) - off.right) < 1e-9);

  // Convergence: from the hand the velocity points toward eye + dir·D.
  const { start, vel } = resolveBasketLaunch(eye, dir, 2, null, () => null);
  assert.deepStrictEqual(start, o);
  assert.ok(Math.abs(len(vel) - B.throws[1].speed) < 1e-9, "standing shooter: level speed exactly");
  const D = B.launchConvergeDistance;
  const targetZ = eye.z - D; // the eye aims at this plane at the converge distance
  const t = (start.z - targetZ) / -vel.z; // time to reach it (no gravity in this check)
  const px = start.x + vel.x * t;
  const py = start.y + vel.y * t;
  assert.ok(Math.abs(px - eye.x) < 1e-6 && Math.abs(py - eye.y) < 1e-6, "rejoins the crosshair line at the converge distance");
  assert.ok(vel.x < 0 && vel.y > 0, "heads left and up from the right-low hand toward the aim line");

  // Hand inside a wall → fallback to the eye pushed forward by the radius.
  const blockedHand = resolveBasketLaunch(eye, dir, 1, null, (from, d) => (Math.abs(d.z) < 0.99 ? 0.2 : null));
  assert.ok(Math.abs(blockedHand.start.z - (eye.z - R)) < 1e-9 && Math.abs(blockedHand.start.x) < 1e-9, "eye + radius");
  // Everything blocked → the eye itself.
  const allBlocked = resolveBasketLaunch(eye, dir, 1, null, () => 0.1);
  assert.deepStrictEqual(allBlocked.start, eye);
});

test("launch: the ball inherits the shooter momentum — faster player, faster ball; never against the aim", () => {
  const dir = { x: 0, y: 0, z: -1 };
  const base = len(basketLaunchVelocity(dir, 1, null));
  assert.ok(Math.abs(base - B.throws[0].speed) < 1e-9);
  // Running INTO the aim at 20 m/s → +20 × forwardFactor.
  const fast = basketLaunchVelocity(dir, 1, { x: 0, y: 0, z: -20 });
  assert.ok(Math.abs(len(fast) - (B.throws[0].speed + 20 * B.shooterMomentumForwardFactor)) < 1e-9, "speed adds up");
  assert.ok(fast.z < 0 && Math.abs(fast.x) < 1e-9, "still straight along the aim");
  // Faster shooter → faster ball (monotonic).
  const faster = basketLaunchVelocity(dir, 1, { x: 0, y: 0, z: -30 });
  assert.ok(len(faster) > len(fast));
  // Backpedalling → no reduction (the ball never leaves slower than the level speed).
  const back = basketLaunchVelocity(dir, 1, { x: 0, y: 0, z: 15 });
  assert.ok(Math.abs(len(back) - B.throws[0].speed) < 1e-9, "backward component ignored");
  // Strafing → partial lateral carry, no vertical lob from a jump.
  const strafe = basketLaunchVelocity(dir, 1, { x: 10, y: 12, z: 0 });
  assert.ok(Math.abs(strafe.x - 10 * B.shooterMomentumLateralFactor) < 1e-9, "lateral factor");
  assert.ok(Math.abs(strafe.y) < 1e-9, "jump velocity never lifts the ball");
  // Implausible speed is clamped.
  const cheat = basketLaunchVelocity(dir, 1, { x: 0, y: 0, z: -1000 });
  assert.ok(Math.abs(len(cheat) - (B.throws[0].speed + B.maxShooterSpeed * B.shooterMomentumForwardFactor)) < 1e-9);
});

test("player contact: consumed on the first hit, owner excluded, wall in front blocks", () => {
  const targets = [{ id: "B", x: 0, y: 0.9, z: -6 }];
  const p = createBasketProjectileState({ x: 0, y: 1.2, z: 0 }, { x: 0, y: 0, z: -24 }, 3);
  let hit = null;
  for (let i = 0; i < 60 && !hit; i++) {
    const ev = stepBasketProjectile(p, 1 / 60, casterFor([], targets), "A");
    hit = ev.find((e) => e.type === "hit") ?? null;
  }
  assert.ok(hit && hit.type === "hit" && hit.targetId === "B");
  // Owner never hit.
  const own = createBasketProjectileState({ x: 0, y: 1.2, z: 0 }, { x: 0, y: 0, z: -24 }, 3);
  const evOwn = stepBasketProjectile(own, 0.5, casterFor([], [{ id: "A", x: 0, y: 0.9, z: -6 }]), "A");
  assert.ok(!evOwn.some((e) => e.type === "hit"));
  // A wall closer than the player wins (world contact, not a hit).
  const wall: ColliderBox[] = [[0, 1, -3, 10, 4, 0.5]];
  const w = createBasketProjectileState({ x: 0, y: 1.2, z: 0 }, { x: 0, y: 0, z: -24 }, 3);
  const evWall = stepBasketProjectile(w, 0.2, casterFor(wall, targets), "A");
  assert.ok(evWall.some((e) => e.type === "bounce") && !evWall.some((e) => e.type === "hit"));
});

test("lifetime: expired event once the age passes the maximum", () => {
  const p = createBasketProjectileState({ x: 0, y: 100, z: 0 }, { x: 0, y: 0, z: 0 }, 1);
  let expired = false;
  for (let i = 0; i < 200 && !expired; i++) {
    expired = stepBasketProjectile(p, 0.05, casterFor([]), null).some((e) => e.type === "expired");
  }
  assert.ok(expired);
  assert.ok(p.age >= B.maxLifetimeSeconds && p.age < B.maxLifetimeSeconds + 0.06);
  assert.ok(len(p.vel) > 0, "gravity accumulated meanwhile");
});

console.log(`\n${passed} basket sim tests passed`);

