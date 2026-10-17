import * as THREE from "three";
import type { Combatant } from "../combat/Combatant";
import { HitZone } from "../combat/HitZone";
import { PopcornShotgunConfig as PC, popcornRayVsPlayer } from "../../shared/combat/PopcornShotgunRules";
import { resolveBasketLaunch } from "../../shared/combat/BasketProjectileSim";
import { findFloorBelow } from "../weapons/popcorn/PopcornShotgunWeapon";
import type { PopcornShotgunWeapon } from "../weapons/popcorn/PopcornShotgunWeapon";
import type { PaintballRifleWeapon } from "../weapons/paintball/PaintballRifleWeapon";
import type { PaintHit } from "../weapons/paintball/PaintballProjectiles";
import type { WaterFamasWeapon } from "../weapons/waterfamas/WaterFamasWeapon";
import type { WaterJetHit } from "../weapons/waterfamas/WaterJets";
import type { GoofyBasketWeapon } from "../weapons/goofybasket/GoofyBasketWeapon";
import type { FrisbeeLauncherWeapon } from "../weapons/frisbee/FrisbeeLauncherWeapon";
import type { GameAudio } from "../audio/GameAudio";
import { audio } from "../audio/AudioManager";
import type { BotRayHit, BotShooter, BotWeaponWorld } from "./BotWeapons";

/** What the Game hands to the bot weapon world (all shared, never per bot). */
export interface BotWeaponWorldDeps {
  /** Map meshes + training targets (paint / wet decals, popcorn floors). */
  staticHittables: THREE.Object3D[];
  /** Static map + every combatant hit volume (rebuilt on roster change). */
  hittables: THREE.Object3D[];
  /** Skinned character root of a combatant (paint / wet target), or null. */
  characterRoot(c: Combatant): THREE.Object3D | null;
  /** Local player capsule center (popcorn visual stop) — null while dead. */
  localPlayerCenter(out: THREE.Vector3): THREE.Vector3 | null;
  popcorn: PopcornShotgunWeapon;
  paintball: PaintballRifleWeapon;
  famas: WaterFamasWeapon;
  basket: GoofyBasketWeapon;
  frisbee: FrisbeeLauncherWeapon;
  audio: GameAudio;
  /** Hex Sniper reel of a victim the bot can't move itself (the local player). */
  pullStart(bot: BotShooter, victim: Combatant): boolean;
  pullStop(victim: Combatant): void;
}

/** Walk up the parents for a userData tag (combatant / hitZone). */
function resolveUp<T>(object: THREE.Object3D, key: string): T | null {
  let o: THREE.Object3D | null = object;
  while (o) {
    const v = o.userData[key] as T | undefined;
    if (v) return v;
    o = o.parent;
  }
  return null;
}

function resolveZone(object: THREE.Object3D): HitZone {
  let o: THREE.Object3D | null = object;
  while (o) {
    const z = o.userData.hitZone as HitZone | undefined;
    if (z) return z;
    if (o.userData.combatant) break;
    o = o.parent;
  }
  return HitZone.BODY;
}

/**
 * The ONE world implementation shared by every bot: raycasts against the
 * same hit volumes as the player's weapons, and every visual goes through
 * the shared pools (paint jets, water jets, popcorn, basket balls, discs) —
 * a bot shot looks exactly like a remote player's shot.
 */
export class SharedBotWeaponWorld implements BotWeaponWorld {
  private readonly ray = new THREE.Raycaster();
  private readonly floorRay = new THREE.Raycaster();
  private readonly result: BotRayHit = {
    distance: 0,
    point: new THREE.Vector3(),
    combatant: null,
    zone: HitZone.BODY,
    intersection: null,
  };
  private readonly muzzle = new THREE.Vector3();
  private readonly to = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly center = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly launchOrigin = new THREE.Vector3();
  private readonly popTo = Array.from({ length: PC.pellets }, () => new THREE.Vector3());
  private readonly popNormals = Array.from({ length: PC.pellets }, () => new THREE.Vector3());
  private readonly popNormalRefs: (THREE.Vector3 | null)[] = new Array(PC.pellets).fill(null);
  private readonly popFloors: (number | null)[] = new Array(PC.pellets).fill(null);

  constructor(private readonly deps: BotWeaponWorldDeps) {
    this.ray.firstHitOnly = true;
    this.floorRay.firstHitOnly = true;
  }

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, far: number, owner: Combatant): BotRayHit | null {
    this.ray.set(origin, dir);
    this.ray.near = 0;
    this.ray.far = far;
    const hits = this.ray.intersectObjects(this.deps.hittables, true);
    for (const h of hits) {
      const c = resolveUp<Combatant>(h.object, "combatant");
      if (c && (c === owner || !c.health.alive || c.targetable === false)) continue;
      const r = this.result;
      r.distance = h.distance;
      r.point.copy(h.point);
      r.combatant = c;
      r.zone = c ? resolveZone(h.object) : HitZone.BODY;
      r.intersection = c ? null : h;
      return r;
    }
    return null;
  }

  /** Muzzle of the bot's drawn weapon (fallback: its eye). */
  private muzzleOf(bot: BotShooter, fallback: THREE.Vector3): THREE.Vector3 {
    if (!bot.weapons?.getMuzzleWorldPosition(this.muzzle)) this.muzzle.copy(fallback);
    return this.muzzle;
  }

  // ---- Hitscan visuals (same pools as the player / remote replays) ----

  paintballShot(bot: BotShooter, origin: THREE.Vector3, dir: THREE.Vector3, hit: BotRayHit | null, seed: number): void {
    const fx = this.deps.paintball.fx;
    this.to.copy(origin).addScaledVector(dir, hit ? hit.distance : 400);
    let paint: PaintHit | null = null;
    if (hit?.combatant) {
      const root = this.deps.characterRoot(hit.combatant);
      if (root) paint = fx.characterHit(root, origin, dir, hit.point);
    } else if (hit?.intersection && !resolveUp(hit.intersection.object, "trainingTarget")) {
      paint = fx.surfaceHit(hit.intersection, dir, seed);
    }
    fx.colorOf(seed % 3, this.color);
    const from = this.muzzleOf(bot, origin);
    fx.spawn(from, this.to, this.color, paint, (out) => bot.weapons?.getMuzzleWorldPosition(out) ?? false);
    this.deps.audio.paintballShotAt(from);
  }

  famasJet(bot: BotShooter, origin: THREE.Vector3, dir: THREE.Vector3, hit: BotRayHit | null, seed: number, jet: number): void {
    const fx = this.deps.famas.fx;
    this.to.copy(origin).addScaledVector(dir, hit ? hit.distance : 400);
    let wet: WaterJetHit | null = null;
    if (hit?.combatant) {
      const root = this.deps.characterRoot(hit.combatant);
      if (root) wet = fx.characterHit(root, origin, dir, hit.point);
    } else if (hit?.intersection && !resolveUp(hit.intersection.object, "trainingTarget")) {
      wet = fx.surfaceHit(hit.intersection, dir, seed);
    }
    const from = this.muzzleOf(bot, origin);
    fx.spawn(from, this.to, wet, (out) => bot.weapons?.getMuzzleWorldPosition(out) ?? false);
    this.deps.audio.famasJetAt(from, jet);
  }

  popcornShot(bot: BotShooter, origin: THREE.Vector3, dirs: readonly THREE.Vector3[]): void {
    const pool = this.deps.popcorn.projectiles;
    const from = this.muzzleOf(bot, origin);
    this.deps.audio.popcornShotAt(from);
    if (!pool) return;
    for (let i = 0; i < dirs.length; i++) {
      const dir = dirs[i];
      const nrm = this.popNormals[i];
      let best = PC.maxRange;
      let hit = false;
      let onCharacter = false;
      this.ray.set(origin, dir);
      this.ray.near = 0;
      this.ray.far = best;
      const statics = this.ray.intersectObjects(this.deps.staticHittables, true);
      if (statics.length > 0) {
        const h = statics[0];
        best = h.distance;
        hit = true;
        if (h.face) nrm.copy(h.face.normal).transformDirection(h.object.matrixWorld);
        else nrm.copy(dir).negate();
      }
      // The local player: the pellets visibly stop on him (shared volumes).
      const center = this.deps.localPlayerCenter(this.center);
      if (center) {
        const r = popcornRayVsPlayer(origin, dir, center, best);
        if (r && r.t < best) {
          best = r.t;
          hit = onCharacter = true;
        }
      }
      const to = this.popTo[i].copy(origin).addScaledVector(dir, best);
      if (!hit) {
        this.popNormalRefs[i] = null;
        this.popFloors[i] = null;
        continue;
      }
      if (onCharacter) nrm.copy(dir).negate();
      this.popNormalRefs[i] = nrm;
      this.popFloors[i] =
        onCharacter || nrm.y < 0.6 ? findFloorBelow(this.floorRay, to, nrm, this.deps.staticHittables) : null;
    }
    pool.spawn(from, this.popTo, this.popNormalRefs, this.popFloors);
  }

  // ---- Real projectiles (solo authority, kill credited to the bot) ----

  basketThrow(bot: BotShooter, eye: THREE.Vector3, dir: THREE.Vector3, level: 1 | 2 | 3): void {
    const projectiles = this.deps.basket.projectiles;
    const { start, vel } = resolveBasketLaunch(
      { x: eye.x, y: eye.y, z: eye.z },
      { x: dir.x, y: dir.y, z: dir.z },
      level,
      { x: bot.velocity.x, y: bot.velocity.y, z: bot.velocity.z },
      (from, d, maxDist) => projectiles.raycastWorld(from, d, maxDist),
    );
    this.launchOrigin.set(start.x, start.y, start.z);
    this.velocity.set(vel.x, vel.y, vel.z);
    projectiles.launch(this.launchOrigin, this.velocity, level, bot.targetKey, null, undefined, bot);
    // Same spatial release whoosh as a remote throw.
    audio.playAt("jump", eye, { bus: "weapons", volume: 0.35 + 0.12 * level, rate: 1.25 - 0.08 * level, rateVar: 0.05, refDistance: 7 });
  }

  frisbeeThrow(bot: BotShooter, eye: THREE.Vector3, dir: THREE.Vector3, visualFrom: THREE.Vector3 | null): void {
    this.deps.frisbee.fireSolo(bot, bot.targetKey, eye, dir, visualFrom);
    this.deps.audio.frisbeeShotAt(eye);
  }

  // ---- Hex Sniper ----

  hexEvent(_bot: BotShooter, kind: "shot" | "grab" | "bite", at: THREE.Vector3): void {
    if (kind === "shot") {
      audio.playAt("hex_tongue_whip", at, { bus: "weapons", volume: 0.7, rate: 1.15, rateVar: 0.05, refDistance: 8, maxDistance: 90 });
      audio.playAt("hex_tongue_out", at, { bus: "weapons", volume: 0.45, rate: 1.3, rateVar: 0.06, refDistance: 8 });
    } else if (kind === "grab") {
      audio.playAt("hex_tongue_grab", at, { bus: "impacts", volume: 0.8, rateVar: 0.08, refDistance: 8 });
    } else {
      audio.playAt("hex_chomp", at, { bus: "impacts", volume: 0.9, rate: 1.1, rateVar: 0.04, refDistance: 8, maxDistance: 90 });
      audio.playAt("hex_gulp", at, { bus: "weapons", volume: 0.6, rateVar: 0.05, delay: 0.42, refDistance: 8 });
    }
  }

  hexPullStart(bot: BotShooter, victim: Combatant): boolean {
    return this.deps.pullStart(bot, victim);
  }

  hexPullStop(victim: Combatant): void {
    this.deps.pullStop(victim);
  }
}

