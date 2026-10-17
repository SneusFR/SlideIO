import * as THREE from "three";
import { Combatant } from "../combat/Combatant";
import { KillMethod } from "../combat/KillMethod";
import { HitZone } from "../combat/HitZone";
import { NetworkWeaponConfig } from "../../shared/combat/NetworkWeapons";
import { PRIMARY_WEAPON_IDS, type PrimaryWeaponId } from "../loadout/Loadout";
import { PaintballRifleConfig as PB, paintballDamage } from "../../shared/combat/PaintballRifleRules";
import {
  WaterFamasConfig as WF,
  waterFamasJetDamage,
  waterFamasJetDirection,
  waterFamasJetSeed,
} from "../../shared/combat/WaterFamasRules";
import {
  PopcornShotgunConfig as PC,
  popcornPelletDirections,
  popcornShotDamage,
  popcornShotIsHeadshot,
  type PopcornPelletHit,
} from "../../shared/combat/PopcornShotgunRules";
import { FrisbeeLauncherConfig as FL, frisbeeDirection } from "../../shared/combat/FrisbeeLauncherRules";
import { HexSniperConfig as hexCfg } from "../weapons/hexsniper/HexSniperConfig";
import type { RemoteWeaponController } from "../network/remote/RemoteWeaponController";

const HX = NetworkWeaponConfig.hexSniper;
const GB = NetworkWeaponConfig.goofyBasket;

/** Raycast hit reported by the world (combatant = null → map geometry). */
export interface BotRayHit {
  distance: number;
  point: THREE.Vector3;
  combatant: Combatant | null;
  zone: HitZone;
  /** Map intersection (surface splats / wet marks), null on a character. */
  intersection: THREE.Intersection | null;
}

/**
 * Everything a bot weapon needs from the game world, implemented ONCE by the
 * Game on top of the SHARED pools (paint jets, water jets, popcorn, basket
 * balls, discs): bots reuse the exact visuals of the player / remote
 * avatars — never a private copy per bot.
 */
export interface BotWeaponWorld {
  /** First hit along the ray (map + combatant hit volumes), `owner` skipped. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, far: number, owner: Combatant): BotRayHit | null;
  popcornShot(bot: BotShooter, origin: THREE.Vector3, dirs: readonly THREE.Vector3[]): void;
  paintballShot(bot: BotShooter, origin: THREE.Vector3, dir: THREE.Vector3, hit: BotRayHit | null, seed: number): void;
  famasJet(bot: BotShooter, origin: THREE.Vector3, dir: THREE.Vector3, hit: BotRayHit | null, seed: number, jet: number): void;
  /** Launch a REAL basket ball owned by the bot (solo authority, kill credited to it). */
  basketThrow(bot: BotShooter, eye: THREE.Vector3, dir: THREE.Vector3, level: 1 | 2 | 3): void;
  /** Launch a REAL disc owned by the bot (solo authority, kill credited to it). */
  frisbeeThrow(bot: BotShooter, eye: THREE.Vector3, dir: THREE.Vector3, visualFrom: THREE.Vector3 | null): void;
  /** Hex Sniper audio cues. */
  hexEvent(bot: BotShooter, kind: "shot" | "grab" | "bite", at: THREE.Vector3): void;
  /**
   * Hex Sniper: reel a victim the bot can't move itself (the local player):
   * true = the world owns the reel (movement.startHexPull). Stopped by
   * `hexPullStop` (bite / release / death).
   */
  hexPullStart(bot: BotShooter, victim: Combatant): boolean;
  hexPullStop(victim: Combatant): void;
}

/** The parts of a Bot its weapon drives. */
export interface BotShooter extends Combatant {
  /** TP presentation (weapon GLB in hand + clips) — null until the model loads. */
  readonly weapons: RemoteWeaponController | null;
  /** Unique target key ("bot:N") used by the shared projectile sweeps. */
  readonly targetKey: string;
}

/** Physical reel-in exposed by bots (Bot.pullToward). */
interface Pullable {
  pullToward(
    dest: THREE.Vector3,
    maxDistance: number,
    stopDistance: number,
    dt: number,
    blockedRatio: number,
  ): { reached?: boolean; blocked?: boolean; valid?: boolean };
}
const isPullable = (c: Combatant): c is Combatant & Pullable =>
  typeof (c as Partial<Pullable>).pullToward === "function";

/** What the AI wants this frame; the weapon owns cadence / ammo / reloads. */
export interface BotFireIntent {
  /** Target in sight + aim inside the weapon's fire cone + reaction elapsed. */
  wantFire: boolean;
  /** Horizontal distance to the current target (m); Infinity when none. */
  targetDistance: number;
}

/** Per-weapon engagement profile read by the AI. */
export interface BotWeaponProfile {
  preferredRangeMin: number;
  preferredRangeMax: number;
  /** The trigger is pulled only when the aim is within this cone (deg). */
  fireConeDeg: number;
  /** Projectile speed for target leading (m/s); 0 = hitscan, no lead. */
  leadSpeed: number;
}

export const BOT_WEAPON_PROFILES: Record<PrimaryWeaponId, BotWeaponProfile> = {
  GOOFY_BASKET: { preferredRangeMin: 7, preferredRangeMax: 18, fireConeDeg: 5, leadSpeed: 0 },
  POPCORN_SHOTGUN: { preferredRangeMin: 5, preferredRangeMax: 9, fireConeDeg: 9, leadSpeed: 0 },
  PAINTBALL_RIFLE: { preferredRangeMin: 10, preferredRangeMax: 20, fireConeDeg: 5, leadSpeed: 0 },
  WATER_FAMAS: { preferredRangeMin: 9, preferredRangeMax: 18, fireConeDeg: 5, leadSpeed: 0 },
  FRISBEE_LAUNCHER: { preferredRangeMin: 8, preferredRangeMax: 20, fireConeDeg: 4, leadSpeed: FL.tuning.speed },
  HEX_SNIPER: { preferredRangeMin: 16, preferredRangeMax: 32, fireConeDeg: 3, leadSpeed: 0 },
};

/** Uniform random primary for a (re)spawning bot. */
export function randomBotWeapon(): PrimaryWeaponId {
  return PRIMARY_WEAPON_IDS[Math.floor(Math.random() * PRIMARY_WEAPON_IDS.length)];
}

const randomSeed = (): number => (Math.random() * 0x7fffffff) >>> 0;

/**
 * One bot's primary weapon: SAME numbers as the player / server (shared
 * *Rules), SAME third-person presentation as the remote avatars
 * (RemoteWeaponController: GLB in the hand + TP clips), SAME world visuals
 * (BotWeaponWorld → the shared pools).
 *
 *   GOOFY_BASKET     charge by distance (L1 close, L2 mid, L3 > 20 m), release, wait the catch
 *   POPCORN_SHOTGUN  single shots (2 loads), pump between shots, reload
 *   PAINTBALL_RIFLE  automatic 0.1 s, 32-ball hopper, reload
 *   WATER_FAMAS      3-jet bursts, 9-jet tank, refill
 *   FRISBEE_LAUNCHER one disc at a time (target led), 1 deck + 5 cage, cage swap
 *   HEX_SNIPER       long-range tongue: grab (50) → reel in → bite (50)
 */
export class BotWeapon {
  readonly profile: BotWeaponProfile;

  private ammo = 0;
  private cooldown = 0;
  private reloadTimer = 0;
  // Water FAMAS running burst
  private burstSeed = 0;
  private burstJet = WF.jetsPerBurst;
  private burstClock = 0;
  // Goofy Basket: charge clock (-1 = idle) + post-throw lock (clip + catch)
  private basketCharge = -1;
  private basketLevel: 1 | 2 | 3 = 1;
  private basketBusy = 0;
  // Frisbee: deck loaded + discs left in the cage
  private frisbeeDeck = true;
  private frisbeeCage = FL.cageCapacity;
  // Hex Sniper tongue
  private hex: {
    phase: "extending" | "pulling" | "retracting";
    tip: THREE.Vector3;
    target: THREE.Vector3;
    victim: Combatant | null;
    victimOffset: THREE.Vector3;
    timer: number;
    /** The world (not this weapon) reels the victim (local player). */
    worldPull: boolean;
  } | null = null;

  // scratch
  private readonly eye = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly muzzle = new THREE.Vector3();
  private readonly pelletDirs = Array.from({ length: PC.pellets }, () => new THREE.Vector3());
  private readonly pelletHits = new Map<Combatant, { hits: PopcornPelletHit[]; point: THREE.Vector3 }>();

  constructor(
    readonly id: PrimaryWeaponId,
    private readonly bot: BotShooter,
  ) {
    this.profile = BOT_WEAPON_PROFILES[id];
    this.refill();
  }

  /** Hex Sniper: a victim is being reeled in right now. */
  get pulling(): boolean {
    return this.hex?.phase === "pulling";
  }

  private refill(): void {
    switch (this.id) {
      case "POPCORN_SHOTGUN":
        this.ammo = PC.shots;
        break;
      case "PAINTBALL_RIFLE":
        this.ammo = PB.capacity;
        break;
      case "WATER_FAMAS":
        this.ammo = WF.capacity;
        break;
      case "FRISBEE_LAUNCHER":
        this.frisbeeDeck = true;
        this.frisbeeCage = FL.cageCapacity;
        break;
      default:
        this.ammo = 1;
    }
  }

  /** Per frame (real seconds). `aimDir` = the AI aim (unit vector). */
  update(dt: number, aimDir: THREE.Vector3, intent: BotFireIntent, world: BotWeaponWorld): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.basketBusy = Math.max(0, this.basketBusy - dt);
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.reloadTimer = 0;
        this.refill();
      }
    }
    this.bot.getEyePosition(this.eye);

    switch (this.id) {
      case "PAINTBALL_RIFLE":
        this.updatePaintball(aimDir, intent, world);
        break;
      case "POPCORN_SHOTGUN":
        this.updatePopcorn(aimDir, intent, world);
        break;
      case "WATER_FAMAS":
        this.updateFamas(dt, aimDir, intent, world);
        break;
      case "GOOFY_BASKET":
        this.updateBasket(dt, aimDir, intent, world);
        break;
      case "FRISBEE_LAUNCHER":
        this.updateFrisbee(aimDir, intent, world);
        break;
      case "HEX_SNIPER":
        this.updateHex(dt, aimDir, intent, world);
        break;
    }
  }

  /** Death / removal: drop the tongue (and its pull) + any running action. */
  stop(world: BotWeaponWorld | null): void {
    this.releaseHex(false, world);
    this.burstJet = WF.jetsPerBurst;
    this.basketCharge = -1;
  }

  // ------------------------------------------------------------------
  // Shared helpers
  // ------------------------------------------------------------------

  private applyHit(hit: BotRayHit, amount: number, method: KillMethod, push: number, dir: THREE.Vector3): void {
    const c = hit.combatant;
    if (!c || !c.health.alive) return;
    c.registerImpact?.(this.tmp2.copy(dir).multiplyScalar(push), hit.point);
    c.health.applyDamage(amount, this.bot, method, hit.zone);
  }

  private startReload(seconds: number): void {
    if (this.reloadTimer > 0) return;
    this.reloadTimer = seconds;
    const w = this.bot.weapons;
    if (!w) return;
    if (this.id === "POPCORN_SHOTGUN") w.popcornAction("reload", null, 0);
    else if (this.id === "PAINTBALL_RIFLE") w.paintballAction("reload", null, 0);
    else if (this.id === "WATER_FAMAS") w.famasAction("reload", false, null, 0);
    else if (this.id === "FRISBEE_LAUNCHER") w.frisbeeAction("reload", { cage: 0, deckLoaded: this.frisbeeDeck }, 0);
  }


  // ------------------------------------------------------------------
  // PAINTBALL RIFLE — automatic 600 rpm, 32 balls, hopper swap
  // ------------------------------------------------------------------

  private updatePaintball(aimDir: THREE.Vector3, intent: BotFireIntent, world: BotWeaponWorld): void {
    if (this.reloadTimer > 0) return;
    if (this.ammo <= 0) {
      this.startReload(PB.timeline.reloadDuration);
      return;
    }
    if (!intent.wantFire || this.cooldown > 0) return;
    this.cooldown = PB.fireInterval;
    this.ammo--;
    this.dir.copy(aimDir);
    const hit = world.raycast(this.eye, this.dir, PB.maxRange, this.bot);
    if (hit?.combatant) {
      this.applyHit(hit, paintballDamage(hit.zone === HitZone.HEAD), KillMethod.PAINTBALL_RIFLE, 0.6, this.dir);
    }
    this.bot.weapons?.paintballAction("fire", this.ammo, 0);
    world.paintballShot(this.bot, this.eye, this.dir, hit, randomSeed());
  }

  // ------------------------------------------------------------------
  // POPCORN SHOTGUN — 12 pellets summed per victim, 2 loads, reload
  // ------------------------------------------------------------------

  private updatePopcorn(aimDir: THREE.Vector3, intent: BotFireIntent, world: BotWeaponWorld): void {
    if (this.reloadTimer > 0) return;
    if (this.ammo <= 0) {
      this.startReload(PC.timeline.reloadDuration);
      return;
    }
    if (!intent.wantFire || this.cooldown > 0) return;
    this.ammo--;
    this.cooldown = this.ammo > 0 ? PC.timeline.fireReady : PC.timeline.fireLastReady;
    popcornPelletDirections(aimDir, randomSeed(), this.pelletDirs);
    this.pelletHits.clear();
    for (const d of this.pelletDirs) {
      const hit = world.raycast(this.eye, d, PC.maxRange, this.bot);
      const c = hit?.combatant;
      if (!hit || !c) continue;
      let entry = this.pelletHits.get(c);
      if (!entry) {
        entry = { hits: [], point: hit.point.clone() };
        this.pelletHits.set(c, entry);
      }
      entry.hits.push({ distance: hit.distance, head: hit.zone === HitZone.HEAD });
    }
    // ONE summed damage event per victim (clean attribution, like the player).
    for (const [c, entry] of this.pelletHits) {
      if (!c.health.alive) continue;
      const dmg = popcornShotDamage(entry.hits, c.health.max, c.health.current);
      const zone = popcornShotIsHeadshot(entry.hits) ? HitZone.HEAD : HitZone.BODY;
      c.registerImpact?.(this.tmp2.copy(aimDir).multiplyScalar(2), entry.point);
      c.health.applyDamage(dmg, this.bot, KillMethod.POPCORN_SHOTGUN, zone);
    }
    this.bot.weapons?.popcornAction("fire", this.ammo, 0);
    world.popcornShot(this.bot, this.eye, this.pelletDirs);
  }

  // ------------------------------------------------------------------
  // WATER FAMAS — 3-jet bursts on the authored timeline, 9-jet tank
  // ------------------------------------------------------------------

  private updateFamas(dt: number, aimDir: THREE.Vector3, intent: BotFireIntent, world: BotWeaponWorld): void {
    // A pulled trigger is a whole burst: the jets leave on the authored
    // timeline even if the target slipped out of sight meanwhile.
    if (this.burstJet < WF.jetsPerBurst) {
      this.burstClock += dt;
      while (this.burstJet < WF.jetsPerBurst && this.ammo > 0 && this.burstClock >= WF.jetTimes[this.burstJet]) {
        this.fireFamasJet(this.burstJet, aimDir, world);
        this.burstJet++;
      }
      if (this.ammo <= 0) this.burstJet = WF.jetsPerBurst;
      return;
    }
    if (this.reloadTimer > 0) return;
    if (this.ammo <= 0) {
      this.startReload(WF.timeline.reloadDuration);
      return;
    }
    if (!intent.wantFire || this.cooldown > 0) return;
    this.cooldown = WF.burstInterval;
    this.burstSeed = randomSeed();
    this.burstClock = 0;
    this.bot.weapons?.famasAction("fire", false, this.ammo - 1, 0);
    this.fireFamasJet(0, aimDir, world);
    this.burstJet = 1;
  }

  private fireFamasJet(k: number, aimDir: THREE.Vector3, world: BotWeaponWorld): void {
    this.ammo--;
    const seed = waterFamasJetSeed(this.burstSeed, k);
    waterFamasJetDirection(aimDir, k, false, seed, this.dir);
    const hit = world.raycast(this.eye, this.dir, WF.maxRange, this.bot);
    if (hit?.combatant) {
      this.applyHit(hit, waterFamasJetDamage(hit.zone === HitZone.HEAD), KillMethod.WATER_FAMAS, 0.5, this.dir);
    }
    if (k > 0) this.bot.weapons?.famasSyncAmmo(this.ammo);
    world.famasJet(this.bot, this.eye, this.dir, hit, seed, k);
  }


  // ------------------------------------------------------------------
  // GOOFY BASKET — charge by distance, release, wait for the catch
  // ------------------------------------------------------------------

  private updateBasket(dt: number, aimDir: THREE.Vector3, intent: BotFireIntent, world: BotWeaponWorld): void {
    if (this.basketBusy > 0) return;
    if (this.basketCharge < 0) {
      if (!intent.wantFire) return;
      // Level from the distance: L1 close lob, L2 mid lob, L3 straight sniper ball.
      const d = intent.targetDistance;
      this.basketLevel = d > 20 ? 3 : d > 9 ? 2 : 1;
      this.basketCharge = 0;
      return;
    }
    this.basketCharge += dt;
    const needed = GB.levelThresholdsSeconds[this.basketLevel - 1];
    if (this.basketCharge < needed) return;
    // Release on target; a lost target keeps the charge a short while.
    if (!intent.wantFire && this.basketCharge < needed + 0.8) return;
    const level = this.basketLevel;
    this.basketCharge = -1;
    const def = GB.throws[level - 1];
    // Locked through the throw clip + the catch of the new ball (player rule).
    this.basketBusy = def.clipDuration + 0.58;
    this.bot.weapons?.basketThrow(level, 0);
    this.dir.copy(aimDir);
    // L1 / L2 are lobs under gravity: raise the aim to land on the target.
    if (level < 3 && Number.isFinite(intent.targetDistance)) {
      const t = intent.targetDistance / def.speed;
      const drop = 0.5 * GB.gravity * t * t;
      this.dir.y += Math.min(0.6, drop / Math.max(intent.targetDistance, 1));
      this.dir.normalize();
    }
    world.basketThrow(this.bot, this.eye, this.dir, level);
  }

  // ------------------------------------------------------------------
  // FRISBEE LAUNCHER — one disc at a time, 1 deck + 5 cage, cage swap
  // ------------------------------------------------------------------

  private updateFrisbee(aimDir: THREE.Vector3, intent: BotFireIntent, world: BotWeaponWorld): void {
    if (this.reloadTimer > 0) return;
    if (!this.frisbeeDeck) {
      // Last disc thrown → empty-cage swap at the authored (sped-up) rate.
      if (this.cooldown <= 0) this.startReload(FL.timeline.reloadEmpty.readyToFire / FL.reloadSpeed);
      return;
    }
    if (!intent.wantFire || this.cooldown > 0) return;
    const cageAtShot = this.frisbeeCage;
    this.bot.weapons?.frisbeeAction("fire", { aiming: false, cage: cageAtShot, deckLoaded: true }, 0);
    if (cageAtShot > 0) {
      this.frisbeeCage--;
      this.cooldown = FL.timeline.fire.readyToFire;
    } else {
      this.frisbeeDeck = false;
      this.cooldown = FL.timeline.fireLast.readyToReload;
    }
    frisbeeDirection(aimDir, false, randomSeed(), this.dir);
    const socket = this.bot.weapons?.frisbeeLaunchSocket ?? null;
    const from = socket ? socket.getWorldPosition(this.muzzle) : null;
    world.frisbeeThrow(this.bot, this.eye, this.dir, from);
  }


  // ------------------------------------------------------------------
  // HEX SNIPER — tongue grab (50) → reel in → bite (50) on arrival
  // ------------------------------------------------------------------

  private updateHex(dt: number, aimDir: THREE.Vector3, intent: BotFireIntent, world: BotWeaponWorld): void {
    const w = this.bot.weapons;
    const t = this.hex;
    if (!t) {
      if (!intent.wantFire || this.cooldown > 0) return;
      this.cooldown = HX.fireCooldown + 0.6; // bots never spam the tongue
      this.dir.copy(aimDir);
      const hit = world.raycast(this.eye, this.dir, HX.maxRange, this.bot);
      if (!w?.getMuzzleWorldPosition(this.muzzle)) this.muzzle.copy(this.eye);
      const target = hit ? hit.point.clone() : this.eye.clone().addScaledVector(this.dir, 120);
      const victimOffset = new THREE.Vector3();
      if (hit?.combatant) victimOffset.subVectors(target, hit.combatant.getPosition(this.tmp));
      this.hex = {
        phase: "extending",
        tip: this.muzzle.clone(),
        target,
        victim: hit?.combatant ?? null,
        victimOffset,
        timer: 0,
        worldPull: false,
      };
      w?.hexTongueBegin(this.hex.tip);
      world.hexEvent(this.bot, "shot", this.muzzle);
      return;
    }

    if (!w?.getMuzzleWorldPosition(this.muzzle)) this.muzzle.copy(this.eye);
    t.timer += dt;

    if (t.phase === "extending") {
      const step = hexCfg.projectileSpeed * dt;
      this.tmp.subVectors(t.target, t.tip);
      const remaining = this.tmp.length();
      if (remaining > step) {
        t.tip.addScaledVector(this.tmp, step / remaining);
      } else {
        t.tip.copy(t.target);
        const v = t.victim;
        if (v && v.health.alive && v.targetable !== false) {
          // GRAB: flat tongue damage, then the victim is reeled in.
          v.health.applyDamage(HX.tongueDamage, this.bot, KillMethod.HEX_SNIPER_TONGUE, HitZone.BODY);
          if (v.health.alive) {
            t.phase = "pulling";
            t.timer = 0;
            t.worldPull = !isPullable(v) && world.hexPullStart(this.bot, v);
            w?.hexTonguePull();
            world.hexEvent(this.bot, "grab", t.tip);
          } else {
            t.phase = "retracting";
          }
        } else {
          t.phase = "retracting";
        }
      }
    } else if (t.phase === "pulling") {
      this.updateHexPull(dt, t, world);
    }

    if (t.phase === "retracting") {
      const step = hexCfg.returnSpeed * dt;
      this.tmp.subVectors(this.muzzle, t.tip);
      const remaining = this.tmp.length();
      if (remaining <= step) {
        this.releaseHex(true, world);
        return;
      }
      t.tip.addScaledVector(this.tmp, step / remaining);
    }
    w?.hexTongueSetEndpoint(t.tip);
  }

  private updateHexPull(dt: number, t: NonNullable<BotWeapon["hex"]>, world: BotWeaponWorld): void {
    const v = t.victim;
    if (!v || !v.health.alive || v.targetable === false || t.timer > HX.pullMaxSeconds) {
      this.endHexPull(t, world);
      return;
    }
    v.getPosition(this.tmp);
    t.tip.copy(this.tmp).add(t.victimOffset);
    this.bot.getPosition(this.tmp2);
    let arrived = this.tmp.distanceTo(this.tmp2) <= HX.pullStopDistance + 0.35;
    if (!arrived && isPullable(v)) {
      const r = v.pullToward(this.tmp2, HX.pullSpeed * dt, HX.pullStopDistance, dt, hexCfg.pullBlockedRatio);
      if (r.reached) arrived = true;
      else if (r.blocked || r.valid === false) {
        this.endHexPull(t, world);
        return;
      }
    } else if (!arrived && t.worldPull) {
      // Player reeled by its own movement: same server-side arrival tolerance.
      arrived = this.tmp.distanceTo(this.tmp2) <= HX.pullStopDistance + HX.arrivalTolerance;
    } else if (!arrived) {
      // Nothing can move this victim: release instead of hanging forever.
      this.endHexPull(t, world);
      return;
    }
    if (!arrived) return;

    // BITE: flat damage + knockback away from the creature's mouth.
    this.tmp.sub(this.tmp2).setY(0);
    if (this.tmp.lengthSq() < 1e-6) this.tmp.set(0, 0, 1);
    this.tmp.normalize().multiplyScalar(HX.biteKnockback);
    this.tmp.y = HX.biteVerticalKnockback;
    this.endHexPull(t, world);
    v.registerImpact?.(this.tmp, null);
    v.health.applyDamage(HX.biteDamage, this.bot, KillMethod.HEX_SNIPER_BITE, HitZone.BODY);
    if (v.health.alive) v.applyImpulse(this.tmp);
    this.bot.weapons?.hexBite();
    world.hexEvent(this.bot, "bite", this.muzzle);
  }

  private endHexPull(t: NonNullable<BotWeapon["hex"]>, world: BotWeaponWorld | null): void {
    if (t.worldPull && t.victim) world?.hexPullStop(t.victim);
    t.worldPull = false;
    t.victim = null;
    t.phase = "retracting";
  }

  private releaseHex(animate: boolean, world: BotWeaponWorld | null): void {
    const t = this.hex;
    if (!t) return;
    if (t.worldPull && t.victim) world?.hexPullStop(t.victim);
    this.hex = null;
    if (animate) this.bot.weapons?.hexTongueEnd();
    else this.bot.weapons?.hexReset();
  }
}

