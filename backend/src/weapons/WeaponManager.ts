import {
  NetworkWeaponConfig as W,
  NetworkWeaponId,
  NetworkHitZone,
  WeaponActionType,
  isNetworkWeaponId,
  PLAYER_EYE_OFFSET,
  PLAYER_FEET_OFFSET,
  WeaponActionMessage,
  WeaponActionConfirmedEvent,
} from "../../../shared/combat/NetworkWeapons";
import { DamageType, HitZone } from "../combat/DamageTypes";
import { DamageResult } from "../combat/DamageResult";
import { NetworkPlayer } from "../schemas/NetworkPlayer";
import {
  Vec3,
  HitTarget,
  hitscan,
  raycastMap,
  hasLineOfSight,
  pointAt,
  normalize,
  distance,
} from "./HitDetection";

/** Server → client extra action ids (never sent BY clients). */
export const SERVER_ACTION_REVOLVER_EXPLODE = "REVOLVER_EXPLODE";
export const SERVER_ACTION_OBLITERREUR_STOP = "OBLITERREUR_STOP";
/** Client aim refresh for the continuous plasma beam (low rate). */
export const ACTION_PLASMA_AIM = "PLASMA_AIM";

/** Fixed rewind used to reconstruct target positions at fire time (ms). */
const LAG_COMP_MS = 120;
/** Transform history retention (ms). */
const HISTORY_MS = 1000;
/** Fire origin must be within this distance of the player transform. */
const MAX_ORIGIN_DRIFT = 3.0;

interface HistoryEntry {
  t: number;
  x: number;
  y: number;
  z: number;
}

interface RevolverProjectile {
  ownerId: string;
  pos: Vec3;
  vel: Vec3;
  age: number;
}

/** Per-player server-side weapon state (never trusted from the client). */
class PlayerWeaponState {
  weapon: NetworkWeaponId = NetworkWeaponId.PLASMA_RIFLE;
  lastSeq = -1;
  // Plasma
  plasmaActive = false;
  plasmaSince = 0;
  plasmaDir: Vec3 = { x: 0, y: 0, z: -1 };
  plasmaOrigin: Vec3 | null = null;
  // Revolver
  revolverAmmo = W.revolver.capacity;
  lastRevolverShotAt = 0;
  revolverUnavailableUntil = 0;
  // Melee
  lastHammerSweepAt = 0;
  lastSpearSweepAt = 0;
  // Spear rush
  rushActive = false;
  rushEndsAt = 0;
  rushCooldownUntil = 0;
  rushDir: Vec3 = { x: 0, y: 0, z: -1 };
  rushHitIds = new Set<string>();
  // Obliterreur
  oblitA: Vec3 | null = null;
  oblitB: Vec3 | null = null;
  /** Fallback A/B alternation for clients that don't declare a slot. */
  oblitNextIndex: 0 | 1 = 0;
  beamSamples: Vec3[] | null = null;
  beamEndsAt = 0;
  // Mole strike (burrowed = INVULNERABLE + untargetable, mirrors local)
  burrowed = false;
  burrowedUntil = 0;
}

/** IO the room provides — WeaponManager stays free of Colyseus types. */
export interface WeaponManagerHost {
  getPlayer(id: string): NetworkPlayer | undefined;
  players(): Iterable<NetworkPlayer>;
  applyDamage(req: {
    attackerId: string | null;
    targetId: string;
    amount: number;
    damageType: DamageType;
    hitZone: HitZone;
  }): DamageResult;
  broadcastAction(event: WeaponActionConfirmedEvent): void;
  sendHitConfirmed(
    attackerId: string,
    ev: { targetId: string; hitZone: string; damageDealt: number; killed: boolean; weapon: string },
  ): void;
  sendDamageTaken(
    victimId: string,
    ev: { attackerId: string | null; amount: number; ax?: number; ay?: number; az?: number },
  ): void;
  sendImpulse(victimId: string, impulse: Vec3): void;
  now(): number;
}

/**
 * Phase 5 — server authority over every networked weapon.
 *
 * GameRoom stays an orchestrator: it forwards WEAPON_EQUIP /
 * WEAPON_ACTION messages here and runs tick() on a fixed simulation
 * interval. All damage flows through CombatManager.applyDamage() via the
 * host — spawn protection / death / K/D/A keep working unchanged.
 */
export class WeaponManager {
  private readonly states = new Map<string, PlayerWeaponState>();
  private readonly history = new Map<string, HistoryEntry[]>();
  private readonly projectiles: RevolverProjectile[] = [];

  constructor(private readonly host: WeaponManagerHost) {}

  private stateOf(id: string): PlayerWeaponState {
    let s = this.states.get(id);
    if (!s) {
      s = new PlayerWeaponState();
      this.states.set(id, s);
    }
    return s;
  }

  /** Called from the transform handler — feeds the lag-comp history. */
  recordTransform(player: NetworkPlayer): void {
    let h = this.history.get(player.id);
    if (!h) {
      h = [];
      this.history.set(player.id, h);
    }
    const now = this.host.now();
    h.push({ t: now, x: player.x, y: player.y, z: player.z });
    while (h.length > 0 && now - h[0].t > HISTORY_MS) h.shift();
  }

  /** Targets rewound ~LAG_COMP_MS into the past (alive players only). */
  private rewindTargets(excludeId: string): HitTarget[] {
    const t = this.host.now() - LAG_COMP_MS;
    const targets: HitTarget[] = [];
    for (const p of this.host.players()) {
      if (!p.isAlive || p.id === excludeId) continue;
      // A burrowed MOLE STRIKE player is untargetable — rays pass through.
      if (this.states.get(p.id)?.burrowed) continue;
      const h = this.history.get(p.id);
      let x = p.x;
      let y = p.y;
      let z = p.z;
      if (h && h.length > 0) {
        let best = h[h.length - 1];
        for (let i = h.length - 1; i >= 0; i--) {
          if (h[i].t <= t) {
            best = h[i];
            break;
          }
          best = h[i];
        }
        x = best.x;
        y = best.y;
        z = best.z;
      }
      targets.push({ id: p.id, x, y, z });
    }
    return targets;
  }

  // ------------------------------------------------------------------
  // Message entry points
  // ------------------------------------------------------------------

  /** WEAPON_EQUIP: logical ID only; refused for dead/unknown players. */
  handleEquip(player: NetworkPlayer, rawWeapon: unknown): void {
    if (!player.isAlive) return;
    if (!isNetworkWeaponId(rawWeapon)) return;
    const s = this.stateOf(player.id);
    if (s.weapon === rawWeapon) return;
    // Switching away drops continuous actions cleanly. Anchors never
    // survive a weapon swap (mirrors the local obliterreur.reset()).
    this.stopPlasma(player, s);
    this.cancelObliterreurBeam(player, s);
    s.oblitA = null;
    s.oblitB = null;
    s.oblitNextIndex = 0;
    s.weapon = rawWeapon;
    player.weapon = rawWeapon; // synced schema state → all clients
  }

  /** WEAPON_ACTION: validates + executes one gameplay action. */
  handleAction(player: NetworkPlayer, msg: WeaponActionMessage): void {
    if (!player.isAlive) return; // dead players cannot act, period
    const s = this.stateOf(player.id);

    const seq = typeof msg.seq === "number" && Number.isFinite(msg.seq) ? msg.seq : -1;
    if (seq <= s.lastSeq) return; // stale / duplicate / reordered
    s.lastSeq = seq;

    const origin = this.readOrigin(player, msg);
    const dir = this.readDir(msg);
    const action = msg.action;

    switch (action) {
      case WeaponActionType.PLASMA_START:
        if (s.weapon !== NetworkWeaponId.PLASMA_RIFLE || !origin || !dir) return;
        s.plasmaActive = true;
        s.plasmaSince = this.host.now();
        s.plasmaOrigin = origin;
        s.plasmaDir = dir;
        this.confirm(player, s.weapon, action, seq, origin, dir);
        return;
      case ACTION_PLASMA_AIM:
        if (!s.plasmaActive || !origin || !dir) return;
        s.plasmaOrigin = origin;
        s.plasmaDir = dir;
        return; // aim refresh is silent (remotes follow the transform)
      case WeaponActionType.PLASMA_STOP:
        if (!s.plasmaActive) return;
        this.stopPlasma(player, s, seq);
        return;
      case WeaponActionType.REVOLVER_FIRE:
        this.handleRevolverFire(player, s, seq, origin, dir);
        return;
      case WeaponActionType.REVOLVER_THROW:
        this.handleRevolverThrow(player, s, seq, origin, dir);
        return;
      case WeaponActionType.HAMMER_SWEEP:
        this.handleMeleeSweep(player, s, seq, origin, dir, NetworkWeaponId.HAMMER);
        return;
      case WeaponActionType.HAMMER_SLAM_START:
        if (!origin || !dir) return;
        this.confirm(player, NetworkWeaponId.HAMMER, action, seq, origin, dir);
        return;
      case WeaponActionType.HAMMER_SLAM_IMPACT:
        this.handleSlamImpact(player, s, seq, msg);
        return;
      case WeaponActionType.SPEAR_SWEEP:
        this.handleMeleeSweep(player, s, seq, origin, dir, NetworkWeaponId.SPEAR);
        return;
      case WeaponActionType.SPEAR_RUSH_START:
        this.handleSpearRushStart(player, s, seq, origin, dir);
        return;
      case WeaponActionType.SPEAR_RUSH_STOP:
        if (!s.rushActive) return;
        s.rushActive = false;
        s.rushCooldownUntil = this.host.now() + W.spear.rushCooldown * 1000;
        this.confirm(player, NetworkWeaponId.SPEAR, action, seq, this.playerPos(player), s.rushDir);
        return;
      case WeaponActionType.OBLITERREUR_PLACE:
        this.handleObliterreurPlace(player, s, seq, origin, dir, msg);
        return;
      case WeaponActionType.OBLITERREUR_FIRE:
        this.handleObliterreurFire(player, s, seq);
        return;
      case WeaponActionType.MOLE_BURROW:
        this.handleMoleBurrow(player, s, seq, msg);
        return;
      case WeaponActionType.MOLE_EMERGE:
        this.handleMoleEmerge(player, s, seq, msg);
        return;
      default:
        return; // unknown action — silently refused
    }
  }

  // ------------------------------------------------------------------
  // Fixed-rate combat tick (from GameRoom.setSimulationInterval)
  // ------------------------------------------------------------------

  tick(dt: number): void {
    const now = this.host.now();
    for (const player of this.host.players()) {
      const s = this.states.get(player.id);
      if (!s) continue;
      if (s.plasmaActive) this.tickPlasma(player, s, dt, now);
      if (s.rushActive) this.tickSpearRush(player, s, now);
      if (s.beamSamples && now < s.beamEndsAt) this.tickObliterreurBeam(player, s, dt);
      else if (s.beamSamples && now >= s.beamEndsAt) s.beamSamples = null;
      // Burrow safety: never invulnerable forever if MOLE_EMERGE is lost.
      if (s.burrowed && now >= s.burrowedUntil) s.burrowed = false;
    }
    this.tickProjectiles(dt);
  }

  private tickPlasma(player: NetworkPlayer, s: PlayerWeaponState, dt: number, now: number): void {
    if (!player.isAlive || now - s.plasmaSince > W.plasma.maxContinuousSeconds * 1000) {
      this.stopPlasma(player, s);
      return;
    }
    const origin = s.plasmaOrigin ?? this.eyePos(player);
    // Anchor the ray on the CURRENT transform (aim refreshed by PLASMA_AIM).
    origin.x = player.x;
    origin.z = player.z;
    origin.y = player.y + PLAYER_EYE_OFFSET;
    const hit = hitscan(origin, s.plasmaDir, W.plasma.range, this.rewindTargets(player.id), player.id);
    if (!hit || hit.kind !== "player" || !hit.targetId) return;

    const zone = hit.zone === NetworkHitZone.HEAD ? HitZone.HEAD : HitZone.BODY;
    const base = W.plasma.damagePerSecond * dt;
    const amount = zone === HitZone.HEAD ? base * W.plasma.headshotMultiplier : base;
    this.dealDamage(player, hit.targetId, amount, DamageType.PLASMA, zone, NetworkWeaponId.PLASMA_RIFLE);
  }

  private handleRevolverFire(
    player: NetworkPlayer,
    s: PlayerWeaponState,
    seq: number,
    origin: Vec3 | null,
    dir: Vec3 | null,
  ): void {
    if (s.weapon !== NetworkWeaponId.REVOLVER || !origin || !dir) return;
    const now = this.host.now();
    if (now < s.revolverUnavailableUntil) return; // materializing
    if (s.revolverAmmo <= 0) return;
    // Cadence: fan-fire interval is the fastest legal rate.
    const minInterval = W.revolver.fanFireInterval * (1 - W.revolver.cadenceTolerance) * 1000;
    if (now - s.lastRevolverShotAt < minInterval) return;
    s.lastRevolverShotAt = now;
    s.revolverAmmo--;

    const hit = hitscan(origin, dir, W.revolver.range, this.rewindTargets(player.id), player.id);
    const hitPoint = hit ? hit.point : pointAt(origin, dir, W.revolver.range);
    this.confirm(player, s.weapon, WeaponActionType.REVOLVER_FIRE, seq, origin, dir, hitPoint);

    if (hit && hit.kind === "player" && hit.targetId) {
      // Weapon-specific zone rule (NOT the global ×2): BODY 100, HEAD 50.
      const zone = hit.zone === NetworkHitZone.HEAD ? HitZone.HEAD : HitZone.BODY;
      const amount = zone === HitZone.HEAD ? W.revolver.headDamage : W.revolver.bodyDamage;
      this.dealDamage(player, hit.targetId, amount, DamageType.REVOLVER, zone, NetworkWeaponId.REVOLVER);
    }
  }

  private handleRevolverThrow(
    player: NetworkPlayer,
    s: PlayerWeaponState,
    seq: number,
    origin: Vec3 | null,
    dir: Vec3 | null,
  ): void {
    if (s.weapon !== NetworkWeaponId.REVOLVER || !origin || !dir) return;
    const now = this.host.now();
    if (now < s.revolverUnavailableUntil) return;
    s.revolverUnavailableUntil = now + W.revolver.materializeDuration * 1000;
    s.revolverAmmo = W.revolver.capacity; // fresh cylinder after materialize
    this.projectiles.push({
      ownerId: player.id,
      pos: { ...origin },
      vel: {
        x: dir.x * W.revolver.throwSpeed,
        y: dir.y * W.revolver.throwSpeed,
        z: dir.z * W.revolver.throwSpeed,
      },
      age: 0,
    });
    this.confirm(player, s.weapon, WeaponActionType.REVOLVER_THROW, seq, origin, dir);
  }

  private tickProjectiles(dt: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.age += dt;
      p.vel.y -= W.revolver.throwGravity * dt;
      const stepLen = Math.sqrt(p.vel.x ** 2 + p.vel.y ** 2 + p.vel.z ** 2) * dt;
      const dir = normalize(p.vel);
      let exploded = p.age >= W.revolver.projectileMaxLifetime;
      let impact: Vec3 = p.pos;

      if (!exploded && dir) {
        const wallT = raycastMap(p.pos, dir, stepLen);
        // Player contact: capsule proximity along the step.
        const hit = hitscan(p.pos, dir, stepLen, this.rewindTargets(p.ownerId), p.ownerId);
        const t =
          hit && (wallT === null || hit.distance <= wallT)
            ? hit.distance
            : wallT;
        if (t !== null && t <= stepLen) {
          exploded = true;
          impact = pointAt(p.pos, dir, t);
        } else {
          p.pos = pointAt(p.pos, dir, stepLen);
        }
      }

      if (exploded) {
        this.projectiles.splice(i, 1);
        this.explodeRevolver(p.ownerId, impact);
      }
    }
  }

  private explodeRevolver(ownerId: string, at: Vec3): void {
    const owner = this.host.getPlayer(ownerId);
    this.host.broadcastAction({
      playerId: ownerId,
      weapon: NetworkWeaponId.REVOLVER,
      action: SERVER_ACTION_REVOLVER_EXPLODE,
      seq: 0,
      ox: at.x,
      oy: at.y,
      oz: at.z,
      dx: 0,
      dy: 1,
      dz: 0,
      hx: at.x,
      hy: at.y,
      hz: at.z,
    });
    if (!owner) return;
    for (const target of this.host.players()) {
      if (!target.isAlive || target.id === ownerId) continue; // owner immune
      const center = { x: target.x, y: target.y, z: target.z };
      if (distance(center, at) > W.revolver.explosionRadius) continue;
      if (!hasLineOfSight(at, center)) continue;
      const amount = target.maxHealth * W.revolver.explosionDamageFraction;
      this.dealDamage(owner, target.id, amount, DamageType.REVOLVER_EXPLOSION, HitZone.BODY, NetworkWeaponId.REVOLVER);
    }
  }

  private handleMeleeSweep(
    player: NetworkPlayer,
    s: PlayerWeaponState,
    seq: number,
    origin: Vec3 | null,
    dir: Vec3 | null,
    weapon: NetworkWeaponId.HAMMER | NetworkWeaponId.SPEAR,
  ): void {
    if (!origin || !dir) return;
    const cfg = weapon === NetworkWeaponId.HAMMER ? W.hammer : W.spear;
    const now = this.host.now();
    const last = weapon === NetworkWeaponId.HAMMER ? s.lastHammerSweepAt : s.lastSpearSweepAt;
    if (now - last < cfg.sweepCooldown * 1000) return;
    if (weapon === NetworkWeaponId.HAMMER) s.lastHammerSweepAt = now;
    else s.lastSpearSweepAt = now;

    this.confirm(player, weapon, weapon === NetworkWeaponId.HAMMER ? WeaponActionType.HAMMER_SWEEP : WeaponActionType.SPEAR_SWEEP, seq, origin, dir);

    // Melee volume: horizontal arc in front of the attacker.
    const cosHalfArc = Math.cos(((cfg.sweepArcDegrees / 2) * Math.PI) / 180);
    const flatDir = normalize({ x: dir.x, y: 0, z: dir.z }) ?? { x: 0, y: 0, z: -1 };
    for (const target of this.rewindTargets(player.id)) {
      const t = this.host.getPlayer(target.id);
      if (!t || !t.isAlive) continue;
      const dx = target.x - player.x;
      const dy = target.y - player.y;
      const dz = target.z - player.z;
      const flatDist = Math.sqrt(dx * dx + dz * dz);
      if (flatDist > cfg.sweepRange || Math.abs(dy) > cfg.sweepHeight) continue;
      if (flatDist > 0.01) {
        const dot = (dx / flatDist) * flatDir.x + (dz / flatDist) * flatDir.z;
        if (dot < cosHalfArc) continue; // outside the frontal arc
      }
      const eye = this.eyePos(player);
      if (!hasLineOfSight(eye, { x: target.x, y: target.y, z: target.z })) continue;

      const amount =
        t.maxHealth *
        (weapon === NetworkWeaponId.HAMMER ? W.hammer.sweepDamageFraction : W.spear.sweepDamageFraction);
      const result = this.dealDamage(
        player,
        target.id,
        amount,
        weapon === NetworkWeaponId.HAMMER ? DamageType.HAMMER : DamageType.SPEAR,
        HitZone.BODY,
        weapon,
      );
      if (result.applied) {
        const kb = weapon === NetworkWeaponId.HAMMER ? W.hammer.sweepKnockback : W.spear.sweepKnockback;
        const kbV =
          weapon === NetworkWeaponId.HAMMER
            ? W.hammer.sweepVerticalKnockback
            : W.spear.sweepVerticalKnockback;
        const away = normalize({ x: dx, y: 0, z: dz }) ?? flatDir;
        this.host.sendImpulse(target.id, { x: away.x * kb, y: kbV, z: away.z * kb });
      }
    }
  }

  private handleSlamImpact(
    player: NetworkPlayer,
    s: PlayerWeaponState,
    seq: number,
    msg: WeaponActionMessage,
  ): void {
    const impact = this.readPoint(msg);
    if (!impact) return;
    // The impact must be plausibly at the attacker's feet.
    if (distance(impact, this.playerPos(player)) > W.hammer.slamMaxImpactDistance) return;

    this.confirm(player, NetworkWeaponId.HAMMER, WeaponActionType.HAMMER_SLAM_IMPACT, seq, impact, { x: 0, y: 1, z: 0 });

    for (const target of this.host.players()) {
      if (!target.isAlive || target.id === player.id) continue;
      const center = { x: target.x, y: target.y, z: target.z };
      const flat = Math.sqrt((center.x - impact.x) ** 2 + (center.z - impact.z) ** 2);
      if (flat > W.hammer.slamRadius) continue;
      if (Math.abs(center.y - impact.y) > W.hammer.slamHeightTolerance) continue;
      const result = this.dealDamage(
        player,
        target.id,
        target.maxHealth * W.hammer.slamDamageFraction,
        DamageType.HAMMER,
        HitZone.BODY,
        NetworkWeaponId.HAMMER,
      );
      if (result.applied) {
        const away = normalize({ x: center.x - impact.x, y: 0, z: center.z - impact.z }) ?? {
          x: 0,
          y: 0,
          z: 1,
        };
        this.host.sendImpulse(target.id, {
          x: away.x * W.hammer.slamKnockback,
          y: W.hammer.slamVerticalKnockback,
          z: away.z * W.hammer.slamKnockback,
        });
      }
    }
  }

  private handleSpearRushStart(
    player: NetworkPlayer,
    s: PlayerWeaponState,
    seq: number,
    origin: Vec3 | null,
    dir: Vec3 | null,
  ): void {
    if (!origin || !dir) return;
    const now = this.host.now();
    if (s.rushActive || now < s.rushCooldownUntil) return;
    s.rushActive = true;
    s.rushEndsAt = now + W.spear.rushMaxDuration * 1000;
    s.rushDir = dir;
    s.rushHitIds.clear();
    this.confirm(player, NetworkWeaponId.SPEAR, WeaponActionType.SPEAR_RUSH_START, seq, origin, dir);
  }

  private tickSpearRush(player: NetworkPlayer, s: PlayerWeaponState, now: number): void {
    if (!player.isAlive || now >= s.rushEndsAt) {
      s.rushActive = false;
      s.rushCooldownUntil = now + W.spear.rushCooldown * 1000;
      return;
    }
    // Tip position from the CURRENT transform + committed rush direction.
    const eye = this.eyePos(player);
    const tip = pointAt(eye, s.rushDir, W.spear.rushTipReach);
    for (const target of this.host.players()) {
      if (!target.isAlive || target.id === player.id || s.rushHitIds.has(target.id)) continue;
      const center = { x: target.x, y: target.y, z: target.z };
      if (distance(center, tip) > W.spear.rushHitRadius + 0.35) continue;
      s.rushHitIds.add(target.id);
      const result = this.dealDamage(
        player,
        target.id,
        target.maxHealth * W.spear.rushDamageFraction,
        DamageType.SPEAR,
        HitZone.BODY,
        NetworkWeaponId.SPEAR,
      );
      if (result.applied) {
        this.host.sendImpulse(target.id, {
          x: s.rushDir.x * W.spear.rushKnockback,
          y: W.spear.rushVerticalKnockback,
          z: s.rushDir.z * W.spear.rushKnockback,
        });
      }
    }
  }

  private handleObliterreurPlace(
    player: NetworkPlayer,
    s: PlayerWeaponState,
    seq: number,
    origin: Vec3 | null,
    dir: Vec3 | null,
    msg: WeaponActionMessage,
  ): void {
    if (s.weapon !== NetworkWeaponId.OBLITERREUR || !origin || !dir) return;

    // Server raycast along the aim ray (authoritative surface check).
    const t = raycastMap(origin, dir, W.obliterreur.placementRange);
    const serverHit = t !== null ? pointAt(origin, dir, t) : null;

    // The CLIENT's exact anchor point (px/py/pz) is used whenever it is
    // plausible — BOTH sides then show/damage the exact same point. A
    // client/server collider mismatch falls back to the server hit so a
    // placement the client saw succeed is almost never silently refused.
    const reported = this.readPoint(msg);
    let anchor: Vec3 | null = null;
    if (reported && distance(reported, origin) <= W.obliterreur.placementRange) {
      if (serverHit && distance(reported, serverHit) <= W.obliterreur.anchorTolerance) {
        anchor = reported; // both raycasts agree → client point wins
      } else {
        // Aim ray missed / disagreed: re-check straight toward the point.
        const toReported = normalize({
          x: reported.x - origin.x,
          y: reported.y - origin.y,
          z: reported.z - origin.z,
        });
        if (toReported) {
          const t2 = raycastMap(origin, toReported, W.obliterreur.placementRange);
          const d = distance(origin, reported);
          if (t2 !== null && Math.abs(t2 - d) <= W.obliterreur.anchorTolerance) {
            anchor = reported;
          }
        }
      }
    }
    if (!anchor) anchor = serverHit;
    if (!anchor) return; // nothing plausible was hit → refused

    // Active beam is cancelled by a new placement (mirrors local gameplay).
    this.cancelObliterreurBeam(player, s);

    // SLOT: the client drives the SAME 0→1→0→1 alternation as its local
    // weapon — replacing one slot NEVER clears the other (this was the
    // desync: the server used to wipe B when A was re-placed). Clients
    // that don't declare a slot fall back to the server alternation.
    const index: 0 | 1 = msg.pi === 0 || msg.pi === 1 ? msg.pi : s.oblitNextIndex;
    if (index === 0) s.oblitA = anchor;
    else s.oblitB = anchor;
    s.oblitNextIndex = index === 0 ? 1 : 0;

    this.confirm(player, s.weapon, WeaponActionType.OBLITERREUR_PLACE, seq, origin, dir, anchor, {
      x: index,
      y: 0,
      z: 0,
    });
  }

  private handleObliterreurFire(player: NetworkPlayer, s: PlayerWeaponState, seq: number): void {
    if (s.weapon !== NetworkWeaponId.OBLITERREUR) return;
    if (!s.oblitA || !s.oblitB || s.beamSamples) return;
    s.beamSamples = sampleObliterreurCurve(s.oblitA, s.oblitB);
    s.beamEndsAt = this.host.now() + W.obliterreur.beamDuration * 1000;
    this.host.broadcastAction({
      playerId: player.id,
      weapon: s.weapon,
      action: WeaponActionType.OBLITERREUR_FIRE,
      seq,
      ox: s.oblitA.x,
      oy: s.oblitA.y,
      oz: s.oblitA.z,
      dx: 0,
      dy: 0,
      dz: 0,
      px: s.oblitB.x,
      py: s.oblitB.y,
      pz: s.oblitB.z,
    });
  }

  private tickObliterreurBeam(player: NetworkPlayer, s: PlayerWeaponState, dt: number): void {
    if (!s.beamSamples) return;
    const reach = W.obliterreur.beamRadius + W.obliterreur.targetHitRadius;
    for (const target of this.host.players()) {
      if (!target.isAlive || target.id === player.id) continue;
      const center = { x: target.x, y: target.y, z: target.z };
      let inside = false;
      for (const sample of s.beamSamples) {
        if (distance(center, sample) <= reach) {
          inside = true;
          break;
        }
      }
      if (!inside) continue; // NOTE: walls are intentionally ignored (design)
      const amount = target.maxHealth * W.obliterreur.damagePerSecondFraction * dt;
      this.dealDamage(player, target.id, amount, DamageType.OBLITERREUR, HitZone.BODY, NetworkWeaponId.OBLITERREUR);
    }
  }

  // ------------------------------------------------------------------
  // Mole strike (killstreak — burrow / eruption AoE)
  // ------------------------------------------------------------------

  /** Dive underground: burrowed players are INVULNERABLE + untargetable. */
  private handleMoleBurrow(
    player: NetworkPlayer,
    s: PlayerWeaponState,
    seq: number,
    msg: WeaponActionMessage,
  ): void {
    if (s.burrowed) return;
    s.burrowed = true;
    s.burrowedUntil = this.host.now() + W.mole.maxBurrowSeconds * 1000;

    // Feet point for the dirt-burst VFX — must be plausibly at the player.
    const reported = this.readPoint(msg);
    const feet =
      reported && distance(reported, this.playerPos(player)) <= W.mole.maxImpactDistance
        ? reported
        : { x: player.x, y: player.y - PLAYER_FEET_OFFSET, z: player.z };

    this.confirm(player, s.weapon, WeaponActionType.MOLE_BURROW, seq, feet, { x: 0, y: -1, z: 0 });
  }

  /** Eruption: AoE damage + radial knockback around the emerge point. */
  private handleMoleEmerge(
    player: NetworkPlayer,
    s: PlayerWeaponState,
    seq: number,
    msg: WeaponActionMessage,
  ): void {
    if (!s.burrowed) return;
    s.burrowed = false;

    const reported = this.readPoint(msg);
    const impact =
      reported && distance(reported, this.playerPos(player)) <= W.mole.maxImpactDistance
        ? reported
        : { x: player.x, y: player.y - PLAYER_FEET_OFFSET, z: player.z };

    this.confirm(player, s.weapon, WeaponActionType.MOLE_EMERGE, seq, impact, { x: 0, y: 1, z: 0 });

    for (const target of this.host.players()) {
      if (!target.isAlive || target.id === player.id) continue;
      const center = { x: target.x, y: target.y, z: target.z };
      const flat = Math.sqrt((center.x - impact.x) ** 2 + (center.z - impact.z) ** 2);
      if (flat > W.mole.radius) continue;
      if (Math.abs(center.y - impact.y) > W.mole.heightTolerance) continue;
      const result = this.dealDamage(
        player,
        target.id,
        target.maxHealth * W.mole.damageFraction,
        DamageType.MOLE_STRIKE,
        HitZone.BODY,
        s.weapon,
      );
      if (result.applied) {
        const away = normalize({ x: center.x - impact.x, y: 0, z: center.z - impact.z }) ?? {
          x: 0,
          y: 0,
          z: 1,
        };
        this.host.sendImpulse(target.id, {
          x: away.x * W.mole.knockback,
          y: W.mole.verticalKnockback,
          z: away.z * W.mole.knockback,
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // Lifecycle hooks (death / respawn / leave)
  // ------------------------------------------------------------------

  /** Death: every continuous action stops — no ghost beams from corpses. */
  onPlayerDeath(playerId: string): void {
    const s = this.states.get(playerId);
    const player = this.host.getPlayer(playerId);
    if (!s) return;
    if (player) {
      this.stopPlasma(player, s);
      this.cancelObliterreurBeam(player, s);
    }
    s.rushActive = false;
    s.oblitA = null;
    s.oblitB = null;
    s.oblitNextIndex = 0;
    s.burrowed = false;
  }

  /** Respawn: clean combat state + fresh revolver cylinder. */
  onPlayerRespawn(playerId: string): void {
    const s = this.states.get(playerId);
    if (!s) return;
    s.plasmaActive = false;
    s.rushActive = false;
    s.rushHitIds.clear();
    s.beamSamples = null;
    s.oblitA = null;
    s.oblitB = null;
    s.oblitNextIndex = 0;
    s.burrowed = false;
    s.revolverAmmo = W.revolver.capacity;
    s.revolverUnavailableUntil = 0;
  }

  removePlayer(playerId: string): void {
    this.states.delete(playerId);
    this.history.delete(playerId);
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      if (this.projectiles[i].ownerId === playerId) this.projectiles.splice(i, 1);
    }
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private stopPlasma(player: NetworkPlayer, s: PlayerWeaponState, seq = 0): void {
    if (!s.plasmaActive) return;
    s.plasmaActive = false;
    this.confirm(player, NetworkWeaponId.PLASMA_RIFLE, WeaponActionType.PLASMA_STOP, seq, this.eyePos(player), s.plasmaDir);
  }

  private cancelObliterreurBeam(player: NetworkPlayer, s: PlayerWeaponState): void {
    if (!s.beamSamples) return;
    s.beamSamples = null;
    this.host.broadcastAction({
      playerId: player.id,
      weapon: NetworkWeaponId.OBLITERREUR,
      action: SERVER_ACTION_OBLITERREUR_STOP,
      seq: 0,
      ox: player.x,
      oy: player.y,
      oz: player.z,
      dx: 0,
      dy: 0,
      dz: 0,
    });
  }

  /** applyDamage + HIT_CONFIRMED (attacker) + DAMAGE_TAKEN (victim). */
  private dealDamage(
    attacker: NetworkPlayer,
    targetId: string,
    amount: number,
    damageType: DamageType,
    hitZone: HitZone,
    weapon: NetworkWeaponId,
  ): DamageResult {
    // A burrowed MOLE STRIKE player is INVULNERABLE (mirrors the local
    // health.invulnerable flag) — no weapon can damage them server-side.
    if (this.states.get(targetId)?.burrowed) {
      return { applied: false, damageDealt: 0, victimDied: false, refusedReason: "target_untargetable" };
    }
    const result = this.host.applyDamage({
      attackerId: attacker.id,
      targetId,
      amount,
      damageType,
      hitZone,
    });
    if (result.applied) {
      this.host.sendHitConfirmed(attacker.id, {
        targetId,
        hitZone,
        damageDealt: result.damageDealt,
        killed: result.victimDied,
        weapon,
      });
      this.host.sendDamageTaken(targetId, {
        attackerId: attacker.id,
        amount: result.damageDealt,
        ax: attacker.x,
        ay: attacker.y,
        az: attacker.z,
      });
    }
    return result;
  }

  private confirm(
    player: NetworkPlayer,
    weapon: NetworkWeaponId,
    action: string,
    seq: number,
    origin: Vec3,
    dir: Vec3,
    hit?: Vec3,
    extra?: Vec3,
  ): void {
    this.host.broadcastAction({
      playerId: player.id,
      weapon,
      action,
      seq,
      ox: origin.x,
      oy: origin.y,
      oz: origin.z,
      dx: dir.x,
      dy: dir.y,
      dz: dir.z,
      ...(hit ? { hx: hit.x, hy: hit.y, hz: hit.z } : {}),
      ...(extra ? { px: extra.x, py: extra.y, pz: extra.z } : {}),
    });
  }

  private eyePos(player: NetworkPlayer): Vec3 {
    return { x: player.x, y: player.y + PLAYER_EYE_OFFSET, z: player.z };
  }

  private playerPos(player: NetworkPlayer): Vec3 {
    return { x: player.x, y: player.y, z: player.z };
  }

  /** Validated fire origin: finite + close to the player's transform. */
  private readOrigin(player: NetworkPlayer, msg: WeaponActionMessage): Vec3 | null {
    const ox = fin(msg.ox);
    const oy = fin(msg.oy);
    const oz = fin(msg.oz);
    if (ox === null || oy === null || oz === null) return null;
    const origin = { x: ox, y: oy, z: oz };
    if (distance(origin, this.playerPos(player)) > MAX_ORIGIN_DRIFT) return null;
    return origin;
  }

  private readDir(msg: WeaponActionMessage): Vec3 | null {
    const dx = fin(msg.dx);
    const dy = fin(msg.dy);
    const dz = fin(msg.dz);
    if (dx === null || dy === null || dz === null) return null;
    return normalize({ x: dx, y: dy, z: dz });
  }

  private readPoint(msg: WeaponActionMessage): Vec3 | null {
    const px = fin(msg.px);
    const py = fin(msg.py);
    const pz = fin(msg.pz);
    if (px === null || py === null || pz === null) return null;
    return { x: px, y: py, z: pz };
  }
}

function fin(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** Quadratic-bezier polyline between the two anchors (upward bulge). */
export function sampleObliterreurCurve(a: Vec3, b: Vec3): Vec3[] {
  const chord = distance(a, b);
  const handle = Math.min(
    Math.max(chord * W.obliterreur.curveStrength, W.obliterreur.curveHandleMin),
    W.obliterreur.curveHandleMax,
  );
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + handle, z: (a.z + b.z) / 2 };
  const samples: Vec3[] = [];
  const n = W.obliterreur.curveSampleCount;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    samples.push({
      x: u * u * a.x + 2 * u * t * mid.x + t * t * b.x,
      y: u * u * a.y + 2 * u * t * mid.y + t * t * b.y,
      z: u * u * a.z + 2 * u * t * mid.z + t * t * b.z,
    });
  }
  return samples;
}