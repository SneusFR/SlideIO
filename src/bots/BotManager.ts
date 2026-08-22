import * as THREE from "three";
import { PhysicsWorld, RAPIER } from "../physics/PhysicsWorld";
import { ParticleSystem } from "../effects/ParticleSystem";
import { Combatant } from "../combat/Combatant";
import { KillMethod } from "../combat/KillMethod";
import { HitZone } from "../combat/HitZone";
import { CombatConfig as cc } from "../combat/CombatConfig";
import { SpawnManager } from "../combat/SpawnManager";
import { NavGrid } from "../navigation/NavGrid";
import { CorpseManager } from "../ragdoll/CorpseManager";
import { Bot, BotContext } from "./Bot";

/**
 * Owns the bot roster: add/remove at runtime from the pause menu,
 * per-frame updates and the shared BotContext. FFA — every combatant
 * (player included) is a potential target for every bot.
 */
export class BotManager {
  readonly bots: Bot[] = [];

  /**
   * Fired ONCE per bot death (Health guarantees a single onDeath event).
   * Carries the killer AND the explicit kill method so the combo/medal
   * systems can react without guessing.
   */
  onBotKilled:
    | ((bot: Bot, killer: Combatant | null, method: KillMethod, hitZone: HitZone) => void)
    | null = null;

  /** A bot joined the roster (Escape menu). NOT a respawn. */
  onBotAdded: ((bot: Bot) => void) | null = null;
  /** A bot was removed from the roster (Escape menu). NOT a death. */
  onBotRemoved: ((bot: Bot) => void) | null = null;

  private nextId = 0;
  private readonly ctx: BotContext;

  // Visibility scratch (frustum + LOS raycasts, zero per-frame allocation)
  private readonly frustum = new THREE.Frustum();
  private readonly projView = new THREE.Matrix4();
  private readonly visSphere = new THREE.Sphere();
  private readonly camPos = new THREE.Vector3();
  private readonly botPos = new THREE.Vector3();
  /** Vertical sample offsets: head / chest / pelvis (capsule center-relative). */
  private static readonly LOS_OFFSETS = [0.6, 0.1, -0.5];

  constructor(
    private readonly scene: THREE.Scene,
    physics: PhysicsWorld,
    particles: ParticleSystem,
    nav: NavGrid,
    spawner: SpawnManager,
    private readonly combatants: Combatant[],
    /** Death ragdoll sink — every bot death snapshots a physical corpse. */
    private readonly corpses: CorpseManager | null = null,
  ) {
    this.ctx = { combatants, physics, nav, spawner, particles };
  }

  get aliveCount(): number {
    let n = 0;
    for (const b of this.bots) if (b.health.alive) n++;
    return n;
  }

  /** Adjust the roster to `count` bots (0..maxBotCount), live. */
  setBotCount(count: number): void {
    const target = Math.max(0, Math.min(cc.maxBotCount, Math.round(count)));
    while (this.bots.length < target) this.addBot();
    while (this.bots.length > target) this.removeBot();
  }

  private addBot(): void {
    const id = this.nextId++;
    const bot = new Bot(
      id,
      `Bot ${String(id + 1).padStart(2, "0")}`,
      this.scene,
      this.ctx.physics,
      this.ctx.particles,
      this.ctx.spawner,
      this.combatants,
      this.corpses,
    );
    bot.health.onDeath = (killer, method, hitZone) => {
      bot.onDeath();
      this.onBotKilled?.(bot, killer, method, hitZone);
    };
    this.bots.push(bot);
    this.combatants.push(bot);
    this.onBotAdded?.(bot);
  }

  private removeBot(): void {
    const bot = this.bots.pop();
    if (!bot) return;
    const i = this.combatants.indexOf(bot);
    if (i >= 0) this.combatants.splice(i, 1);
    bot.dispose();
    this.onBotRemoved?.(bot);
  }

  /** AI + movement (before the physics step). */
  update(dt: number): void {
    for (const bot of this.bots) bot.update(dt, this.ctx);
  }

  /** Weapons (after world matrices are up to date). */
  updateWeapons(dt: number, hittables: THREE.Object3D[], time: number): void {
    for (const bot of this.bots) bot.updateWeapon(dt, hittables, time);
  }

  /** Visual sync (after the physics step, before render). */
  postStep(dt: number, camQuat: THREE.Quaternion, camPos: THREE.Vector3, time: number): void {
    for (const bot of this.bots) bot.postStep(dt, camQuat, camPos, time);
  }

  /**
   * REAL player→bot visibility for the enemy readability visuals
   * (red outline + name + HP bar). A bot is "seen" only when:
   *   1. it is inside the camera frustum, AND
   *   2. at least one significant body point (head / chest / pelvis)
   *      has an unobstructed line of sight from the camera
   *      (walls only — kinematic capsules never block the check).
   * Anything else → hidden. No wallhack, no X-ray, ever.
   */
  updateVisibility(camera: THREE.PerspectiveCamera): void {
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    camera.getWorldPosition(this.camPos);

    for (const bot of this.bots) {
      // A knocked-down (ragdolled) bot hides its enemy UI/outline: the
      // billboard bar can't follow a tumbling body cleanly.
      bot.model.setSeen(bot.health.alive && !bot.ragdolled && this.isVisible(bot));
    }
  }

  private isVisible(bot: Bot): boolean {
    bot.getPosition(this.botPos);

    // Distance cap + camera frustum culling first (cheap rejects).
    if (
      this.botPos.distanceToSquared(this.camPos) >
      cc.enemyVisibilityMaxDistance * cc.enemyVisibilityMaxDistance
    ) {
      return false;
    }
    this.visSphere.set(this.botPos, cc.enemyVisibilityBodyRadius);
    if (!this.frustum.intersectsSphere(this.visSphere)) return false;

    // Multi-point LOS: head / chest / pelvis. One clear ray = visible
    // (prevents flicker when only a shoulder peeks past a corner).
    for (const offset of BotManager.LOS_OFFSETS) {
      const dx = this.botPos.x - this.camPos.x;
      const dy = this.botPos.y + offset - this.camPos.y;
      const dz = this.botPos.z - this.camPos.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist < 0.001) return true;
      const inv = 1 / dist;
      const hit = this.ctx.physics.world.castRay(
        new RAPIER.Ray(
          { x: this.camPos.x, y: this.camPos.y, z: this.camPos.z },
          { x: dx * inv, y: dy * inv, z: dz * inv },
        ),
        Math.max(dist - 0.35, 0.05),
        true,
        RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC, // walls only
      );
      if (hit === null) return true;
    }
    return false;
  }
}
