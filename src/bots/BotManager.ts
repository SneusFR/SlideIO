import * as THREE from "three";
import { PhysicsWorld } from "../physics/PhysicsWorld";
import { ParticleSystem } from "../effects/ParticleSystem";
import { Combatant } from "../combat/Combatant";
import { CombatConfig as cc } from "../combat/CombatConfig";
import { SpawnManager } from "../combat/SpawnManager";
import { NavGrid } from "../navigation/NavGrid";
import { Bot, BotContext } from "./Bot";

/**
 * Owns the bot roster: add/remove at runtime from the pause menu,
 * per-frame updates and the shared BotContext. FFA — every combatant
 * (player included) is a potential target for every bot.
 */
export class BotManager {
  readonly bots: Bot[] = [];

  /** Fired when any bot dies; killer may be the player (for kill feedback). */
  onBotKilled: ((bot: Bot, killer: Combatant | null) => void) | null = null;

  private nextId = 0;
  private readonly ctx: BotContext;

  constructor(
    private readonly scene: THREE.Scene,
    physics: PhysicsWorld,
    particles: ParticleSystem,
    nav: NavGrid,
    spawner: SpawnManager,
    private readonly combatants: Combatant[],
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
    );
    bot.health.onDeath = (killer) => {
      bot.onDeath();
      this.onBotKilled?.(bot, killer);
    };
    this.bots.push(bot);
    this.combatants.push(bot);
  }

  private removeBot(): void {
    const bot = this.bots.pop();
    if (!bot) return;
    const i = this.combatants.indexOf(bot);
    if (i >= 0) this.combatants.splice(i, 1);
    bot.dispose();
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
}