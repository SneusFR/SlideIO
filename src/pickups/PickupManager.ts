import * as THREE from "three";
import { PhysicsWorld, RAPIER } from "../physics/PhysicsWorld";
import { ParticleSystem } from "../effects/ParticleSystem";
import { Health } from "../combat/Combatant";
import { PickupConfig as pc } from "./PickupConfig";
import { PickupAssets } from "./PickupAssets";
import { Pickup } from "./Pickup";
import { HealthPickup } from "./HealthPickup";
import { CoinPickup } from "./CoinPickup";

/**
 * Owns every loot pickup in the world.
 *
 * Combat code stays clean: a bot death only calls `spawnLoot(position)`
 * and this manager handles ground placement, animation, walk-over
 * collection, lifetimes, pooling and shared sparkle particles.
 *
 * Coins have NO economy yet: `onCoinCollected` is the single hook a real
 * currency system can attach to later.
 */
export class PickupManager {
  /** Fired when the medkit heal is actually applied (already clamped). */
  onMedkitCollected: ((healedAmount: number) => void) | null = null;
  /** Fired once per collected coin. Future wallet hook — nothing stored yet. */
  onCoinCollected: (() => void) | null = null;

  private readonly assets = new PickupAssets();
  private readonly active: Pickup[] = [];
  private readonly medkitPool: HealthPickup[] = [];
  private readonly coinPool: CoinPickup[] = [];

  // scratch
  private readonly tmp = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly physics: PhysicsWorld,
    private readonly particles: ParticleSystem,
  ) {
    this.assets.load(); // one-time GLB fetch + parse
  }

  /**
   * Drop the loot for a REAL combat death at `deathPos`:
   * 1 medkit + 2..10 coins scattered within ~1 m, snapped to the ground.
   */
  spawnLoot(deathPos: THREE.Vector3): void {
    const groundY = this.findGroundY(deathPos.x, deathPos.y, deathPos.z);
    if (groundY === null) return; // died over the void / kill plane — no loot

    // ---- Medkit (1 per kill) ----
    for (let m = 0; m < pc.medkitsPerKill; m++) {
      if (this.active.length >= pc.maxActivePickups) break;
      const kit = this.medkitPool.pop() ?? new HealthPickup();
      kit.spawnAt(deathPos.x, groundY, deathPos.z);
      this.attach(kit);
    }

    // ---- Coins (2..10, scattered, never all stacked) ----
    const count =
      pc.coinDropMin +
      Math.floor(Math.random() * (pc.coinDropMax - pc.coinDropMin + 1));
    for (let i = 0; i < count; i++) {
      if (this.active.length >= pc.maxActivePickups) break;
      // Evenly spread angles + jitter → no overlapping pile.
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.9;
      const radius = 0.35 + Math.random() * (pc.coinDropRadius - 0.35);
      const tx = deathPos.x + Math.cos(angle) * radius;
      const tz = deathPos.z + Math.sin(angle) * radius;
      // Validate the landing spot; fall back to the death point's floor.
      const ty = this.findGroundY(tx, deathPos.y, tz);
      const coin = this.coinPool.pop() ?? new CoinPickup();
      if (ty !== null) {
        coin.spawnAt(deathPos.x, groundY, deathPos.z, tx, ty, tz);
      } else {
        coin.spawnAt(deathPos.x, groundY, deathPos.z, deathPos.x, groundY, deathPos.z);
      }
      this.attach(coin);
    }
  }

  /**
   * Animate, expire and collect pickups. Collection is a simple
   * walk-over distance check against the player capsule center.
   */
  update(dt: number, playerPos: THREE.Vector3, playerHealth: Health, time: number): void {
    const canCollect = playerHealth.alive;
    let sparkleBudget = pc.maxSparklesPerFrame;

    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];

      // Lazy model attach: templates load async at startup; each pickup
      // clones the shared template once, the first frame it's available.
      if (!p.hasModel) {
        const tpl =
          p instanceof CoinPickup ? this.assets.coinTemplate : this.assets.medkitTemplate;
        if (tpl) p.attachModel(tpl);
      }

      // Lifetime + idle animation (bob / spin / settle / fade).
      if (!p.update(dt, time)) {
        this.recycle(i);
        continue;
      }

      // Sparkles: budgeted shared emitter — a few rising glints per pickup.
      p.sparkleAccum += pc.sparkleRate * dt;
      if (p.sparkleAccum >= 1 && sparkleBudget > 0) {
        p.sparkleAccum -= 1;
        sparkleBudget--;
        this.tmp
          .set((Math.random() - 0.5) * 0.5, Math.random() * 0.15, (Math.random() - 0.5) * 0.5)
          .add(p.root.position);
        const vel = this.tmp; // reuse: position consumed by spawn() first
        this.particles.spawn(
          this.tmp,
          velUp(vel),
          0.4 + Math.random() * 0.3,
          p.sparkleColor,
          -0.6, // negative gravity → particles drift upward
          1.2,
        );
      }

      // ---- Walk-over pickup ----
      if (!canCollect) continue;
      const dx = playerPos.x - p.root.position.x;
      const dy = playerPos.y - p.root.position.y;
      const dz = playerPos.z - p.root.position.z;
      if (Math.abs(dy) > pc.pickupVerticalTolerance) continue;
      if (dx * dx + dz * dz > p.pickupRadius * p.pickupRadius) continue;

      if (p instanceof HealthPickup) {
        // Full HP → do NOT consume: the medkit stays for later.
        if (playerHealth.current >= playerHealth.max - 0.001) continue;
        const healed = Math.min(
          pc.medkitHealAmount,
          playerHealth.max - playerHealth.current,
        );
        playerHealth.current += healed;
        this.collectBurst(p, 16, 3, 0.55);
        this.recycle(i);
        this.onMedkitCollected?.(healed);
      } else {
        this.collectBurst(p, 8, 2.5, 0.4);
        this.recycle(i);
        this.onCoinCollected?.();
      }
    }
  }

  /** Total active pickups (debug / load testing). */
  get activeCount(): number {
    return this.active.length;
  }

  private attach(p: Pickup): void {
    this.scene.add(p.root);
    this.active.push(p);
  }

  /** Return the pickup at `index` to its pool (swap-remove). */
  private recycle(index: number): void {
    const p = this.active[index];
    p.deactivate();
    this.active[index] = this.active[this.active.length - 1];
    this.active.pop();
    if (p instanceof CoinPickup) this.coinPool.push(p);
    else this.medkitPool.push(p as HealthPickup);
  }

  private collectBurst(p: Pickup, count: number, speed: number, life: number): void {
    this.particles.burst(p.root.position, count, speed, life, p.sparkleColor, 1.5);
  }

  /**
   * Snap a loot position to the floor: short downward raycast against
   * STATIC geometry only (kinematic capsules never count as ground).
   * Returns null when there is no floor (void, kill plane…).
   */
  private findGroundY(x: number, y: number, z: number): number | null {
    const originY = y + pc.groundRaycastUp;
    const hit = this.physics.world.castRay(
      new RAPIER.Ray({ x, y: originY, z }, { x: 0, y: -1, z: 0 }),
      pc.groundRaycastDown,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC,
    );
    if (!hit) return null;
    const h = hit as unknown as { timeOfImpact?: number; toi?: number };
    const dist = h.timeOfImpact ?? h.toi ?? 0;
    return originY - dist;
  }
}

// Rising sparkle velocity (reuses a module scratch vector).
const SPARKLE_VEL = new THREE.Vector3();
function velUp(_pos: THREE.Vector3): THREE.Vector3 {
  return SPARKLE_VEL.set(
    (Math.random() - 0.5) * 0.4,
    0.5 + Math.random() * 0.7,
    (Math.random() - 0.5) * 0.4,
  );
}