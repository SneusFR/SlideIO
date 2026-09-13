/**
 * GoofyBasket SHARED projectile integration tests (run: npm run test:basket).
 * Pure CPU: swept sphere vs boxes, reflection, remaining-time continuation,
 * corner (two contacts in ONE step), contact cap, bounce budget.
 */
import assert from "node:assert";
import { NetworkWeaponConfig as W } from "../../../shared/combat/NetworkWeapons";
import {
  createBasketProjectileState,
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

test("bounce budget exhausted → the next world contact ends the ball; contact cap ends a degenerate step", () => {
  const ground: ColliderBox[] = [[0, -0.5, 0, 200, 1, 200]];
  const p = createBasketProjectileState({ x: 0, y: 2, z: 0 }, { x: 0, y: -1, z: 0 }, 1); // budget 1
  let terminal = null;
  for (let i = 0; i < 400 && !terminal; i++) {
    const ev = stepBasketProjectile(p, 1 / 60, casterFor(ground), null);
    terminal = ev.find((e) => e.type === "world-end" || e.type === "expired") ?? null;
  }
  assert.ok(terminal && terminal.type === "world-end", "second floor contact ends a level-1 ball");
  assert.strictEqual(p.bounceCount, 1);

  // Degenerate: a ball squeezed between two facing walls 2R + ε apart with
  // a huge horizontal speed → more than maxContactsPerStep contacts in one step.
  const gap = 2 * R + 0.01;
  const squeeze: ColliderBox[] = [
    [-(gap / 2 + 0.5), 0, 0, 1, 100, 100],
    [gap / 2 + 0.5, 0, 0, 1, 100, 100],
  ];
  const q = createBasketProjectileState({ x: 0, y: 0, z: 0 }, { x: 500, y: 0, z: 0 }, 3);
  const ev = stepBasketProjectile(q, 0.05, casterFor(squeeze), null);
  assert.ok(ev.some((e) => e.type === "world-end"), "contact cap terminates the ball");
  assert.ok(ev.filter((e) => e.type === "bounce").length <= B.maxContactsPerStep);
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

