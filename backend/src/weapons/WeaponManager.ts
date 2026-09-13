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
  HexPullEvent,
  HEX_ACTION_TONGUE_HIT,
  HEX_ACTION_TONGUE_MISS,
  HEX_ACTION_PULL_END,
  HEX_ACTION_BITE,
  BASKET_ACTION_THROW,
  BASKET_ACTION_LAUNCH,
  BASKET_ACTION_BOUNCE,
  BASKET_ACTION_END,
  goofyBasketLevelForHold,
} from "../../../shared/combat/NetworkWeapons";
import {
  type BasketProjectileState,
  basketLaunchVelocity,
  createBasketProjectileState,
  stepBasketProjectile,
} from "../../../shared/combat/BasketProjectileSim";
import { DamageType, HitZone } from "../combat/DamageTypes";
import { DamageResult } from "../combat/DamageResult";
import { NetworkPlayer } from "../schemas/NetworkPlayer";
import { MAP_COLLIDER_BOXES, type ColliderBox } from "../../../shared/map/MapColliders";
import {
  Vec3,
  HitTarget,
  hitscan,
  raycastMap,
  sweepBasketSphere,
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
/** Client aim refresh for the continuous poison spray (low rate). */
export const ACTION_POISON_AIM = "POISON_AIM";

/**
 * FALLBACK rewind when an action carries no (or an aberrant) viewTime —
 * old clients / malformed packets still get a conservative estimate of
 * "what the shooter saw" (ms).
 */
const LAG_COMP_FALLBACK_MS = 120;
/**
 * HARD CAP on the client-requested rewind (ms). The shooter's viewTime
 * legitimately trails the server by ≈ RTT + interpolation delay; anything
 * far beyond that is clamped so a client can never ask the server to
 * resurrect very old positions. NOTE: this clamp is a safety net, NOT a
 * complete anti-cheat.
 */
const LAG_COMP_MAX_REWIND_MS = 350;
/** viewTime outside this plausibility window is treated as ABSENT (ms). */
const LAG_COMP_ABERRANT_FUTURE_MS = 1000;
const LAG_COMP_ABERRANT_PAST_MS = 5000;
/**
 * History spans larger than this are idle-suppression gaps (the sender
 * stood still and sent nothing): the player truly WAS at the older
 * position for the whole gap — hold it instead of lerping across.
 */
const HISTORY_LERP_MAX_SPAN_MS = 250;
/** Transform history retention (ms). */
const HISTORY_MS = 1000;
/** Fire origin must be within this distance of the player transform. */
const MAX_ORIGIN_DRIFT = 3.0;
/** Direction placeholder for direction-less visual events. */
const UP: Vec3 = { x: 0, y: 1, z: 0 };

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

/** One in-flight Bass Blaster musical note (server-simulated, no gravity). */
interface BassNoteProjectile {
  ownerId: string;
  pos: Vec3;
  vel: Vec3;
  age: number;
  /** Shooter view delay (now − viewTime) captured at fire time — every
   *  flight tick rewinds the targets by this amount (already clamped). */
  viewDelayMs: number;
}

/**
 * One GOOFY BASKET throw sequence engaged by a validated release. The
 * projectile is created in tick() when the server clock reaches
 * `launchAt` (authored release marker, + an accepted gather delay) — never
 * at the request itself. The player is busy until `readyAt` (Throw
 * recovery + the full 0.58 s Catch), then may charge again.
 */
interface BasketThrowState {
  id: number;
  level: 1 | 2 | 3;
  /** Server clock (ms) of the Throw phase start (sent as `ts`). */
  startedAt: number;
  launchAt: number;
  readyAt: number;
  origin: Vec3;
  dir: Vec3;
  launched: boolean;
  viewDelayMs: number;
}

/** One in-flight GOOFY BASKET ball (server-simulated, shared integration). */
interface BasketProjectile {
  id: number;
  ownerId: string;
  state: BasketProjectileState;
  viewDelayMs: number;
}

/**
 * One engaged BRICK MAUL attack (server-authoritative, advanced in tick()).
 *   WHIRLWIND: damage is applied inside [activeStart, activeEnd] from the
 *   authoritative start — the tick tests the OVERLAP of the elapsed span
 *   with the window (a long tick never skips it); each victim is hit at
 *   most ONCE for the whole attack (three visual turns = one victim set).
 *   SLAM: started by HAMMER_SLAM_START, the ONE impact is consumed by the
 *   first valid HAMMER_SLAM_IMPACT (duplicates refused even with a new
 *   seq), then the attack stays engaged for the 0.72 s recovery.
 */
interface HammerAttackState {
  kind: "WHIRLWIND" | "SLAM";
  /** Server clock (ms) at the authoritative start (also sent as `ts`). */
  startedAt: number;
  /** Elapsed seconds already processed by the tick (overlap test). */
  processed: number;
  /** Shooter view delay captured at start (rewind of the victims). */
  viewDelayMs: number;
  hitIds: Set<string>;
  /** SLAM: true once the single impact has been resolved. */
  impactConsumed: boolean;
  /** Absolute end (ms) — recomputed at the slam impact (recovery). */
  endsAt: number;
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
  /** Shooter view delay (now − viewTime) refreshed by START/AIM — the
   *  continuous beam tick rewinds targets by this amount every tick. */
  plasmaViewDelayMs = LAG_COMP_FALLBACK_MS;
  // Poison sprayer (continuous short-range stream — plasma-style state)
  poisonActive = false;
  poisonSince = 0;
  poisonDir: Vec3 = { x: 0, y: 0, z: -1 };
  poisonViewDelayMs = LAG_COMP_FALLBACK_MS;
  // Revolver
  revolverAmmo = W.revolver.capacity;
  lastRevolverShotAt = 0;
  revolverUnavailableUntil = 0;
  // Bass Blaster (cadence floor — the magazine/reload stay client-paced,
  // the low per-note damage makes the fan-fire-style tolerance safe)
  lastBassShotAt = 0;
  // Melee
  lastSpearSweepAt = 0;
  /**
   * BRICK MAUL bounded attack state (authoritative start, active window,
   * ONE victim set per attack). Null = no hammer attack engaged. The
   * anti-spam floor IS the engaged attack: a new HAMMER_* start is refused
   * until the running one (whirlwind 1.35 s / slam until recovery) ends.
   */
  hammerAttack: HammerAttackState | null = null;
  /** Visual-only inspection running (replicated start / cancel dedup). */
  inspecting = false;
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
  // Hex sniper (tongue pull in progress — ONE victim at a time)
  hexLastFireAt = 0;
  /** Victim currently being reeled in (null = no pull running). */
  hexVictimId: string | null = null;
  hexPullSince = 0;
  /** Stall detection: best (smallest) distance so far + when it improved. */
  hexBestDist = Infinity;
  hexLastProgressAt = 0;
  // Goofy Basket (server-owned charge clock + engaged throw sequence)
  /** Server clock (ms) of the accepted BASKET_CHARGE_START, or 0. */
  basketChargeStart = 0;
  /** Engaged throw (Throw phase + Catch) — null = free to charge / throw. */
  basketThrow: BasketThrowState | null = null;
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
  /** HEX SNIPER: tell the VICTIM to start / stop reeling toward the attacker. */
  sendHexPull(victimId: string, ev: HexPullEvent): void;
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
  private readonly bassProjectiles: BassNoteProjectile[] = [];
  private readonly basketProjectiles: BasketProjectile[] = [];
  /** Monotonic GoofyBasket projectile / throw id (room-wide). */
  private nextBasketId = 1;

  /**
   * @param mapBoxes the room's map collision world (shared MapRegistry) —
   *        every wall occlusion / placement raycast uses THIS list, so a
   *        Yard room never occludes shots against Jungle walls.
   */
  constructor(
    private readonly host: WeaponManagerHost,
    private readonly mapBoxes: ColliderBox[] = MAP_COLLIDER_BOXES,
  ) {}

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

  /**
   * Resolve the rewind timestamp for one action:
   *  - client-declared viewTime (`vt`) when plausible, HARD-CLAMPED to
   *    [now − LAG_COMP_MAX_REWIND_MS, now];
   *  - aberrant / missing values → fixed conservative fallback.
   */
  private resolveRewindTime(msg: WeaponActionMessage): number {
    const now = this.host.now();
    const vt = fin(msg.vt);
    if (
      vt === null ||
      vt > now + LAG_COMP_ABERRANT_FUTURE_MS ||
      vt < now - LAG_COMP_ABERRANT_PAST_MS
    ) {
      return now - LAG_COMP_FALLBACK_MS;
    }
    return Math.min(now, Math.max(now - LAG_COMP_MAX_REWIND_MS, vt));
  }

  /**
   * Position of one player at `t` (server ms) from its transform history:
   * INTERPOLATED between the two bracketing entries (never sample-and-hold
   * inside normal send spacing). Idle-suppression gaps hold the OLDER
   * entry — the sender truly stood there for the whole silent window.
   */
  private historyPositionAt(p: NetworkPlayer, t: number): Vec3 {
    const h = this.history.get(p.id);
    if (!h || h.length === 0) return { x: p.x, y: p.y, z: p.z };
    const first = h[0];
    if (t <= first.t) return { x: first.x, y: first.y, z: first.z };
    const last = h[h.length - 1];
    if (t >= last.t) return { x: last.x, y: last.y, z: last.z };
    for (let i = h.length - 1; i >= 1; i--) {
      if (h[i - 1].t <= t) {
        const a = h[i - 1];
        const b = h[i];
        const span = b.t - a.t;
        // Idle-suppression gap: hold the older sample (see constant doc).
        if (span > HISTORY_LERP_MAX_SPAN_MS) return { x: a.x, y: a.y, z: a.z };
        const k = span > 0 ? (t - a.t) / span : 1;
        return {
          x: a.x + (b.x - a.x) * k,
          y: a.y + (b.y - a.y) * k,
          z: a.z + (b.z - a.z) * k,
        };
      }
    }
    return { x: first.x, y: first.y, z: first.z };
  }

  /**
   * Targets rewound to `rewindTime` (alive players only). When omitted,
   * uses the conservative fallback rewind.
   */
  private rewindTargets(excludeId: string, rewindTime?: number): HitTarget[] {
    const t = rewindTime ?? this.host.now() - LAG_COMP_FALLBACK_MS;
    const targets: HitTarget[] = [];
    for (const p of this.host.players()) {
      if (!p.isAlive || p.id === excludeId) continue;
      // A burrowed MOLE STRIKE player is untargetable — rays pass through.
      if (this.states.get(p.id)?.burrowed) continue;
      const pos = this.historyPositionAt(p, t);
      targets.push({ id: p.id, x: pos.x, y: pos.y, z: pos.z });
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
    this.stopPoison(player, s);
    this.cancelObliterreurBeam(player, s);
    // Unequipping the HexSniper mid-pull releases the victim (local parity:
    // hexSniper.reset() cancels the tongue on every weapon swap).
    this.releaseHexPull(player, s, true);
    s.oblitA = null;
    s.oblitB = null;
    s.oblitNextIndex = 0;
    s.inspecting = false; // a weapon swap always ends an inspection
    // A weapon swap cancels a basket charge / a throw whose ball has NOT
    // left the hand yet; an already launched projectile keeps flying.
    s.basketChargeStart = 0;
    if (s.basketThrow && !s.basketThrow.launched) s.basketThrow = null;
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
        s.plasmaViewDelayMs = this.host.now() - this.resolveRewindTime(msg);
        this.confirm(player, s.weapon, action, seq, origin, dir);
        return;
      case ACTION_PLASMA_AIM:
        if (!s.plasmaActive || !origin || !dir) return;
        s.plasmaOrigin = origin;
        s.plasmaDir = dir;
        s.plasmaViewDelayMs = this.host.now() - this.resolveRewindTime(msg);
        return; // aim refresh is silent (remotes follow the transform)
      case WeaponActionType.PLASMA_STOP:
        if (!s.plasmaActive) return;
        this.stopPlasma(player, s, seq);
        return;
      case WeaponActionType.POISON_START:
        if (s.weapon !== NetworkWeaponId.POISON_SPRAYER || !origin || !dir) return;
        s.poisonActive = true;
        s.poisonSince = this.host.now();
        s.poisonDir = dir;
        s.poisonViewDelayMs = this.host.now() - this.resolveRewindTime(msg);
        this.confirm(player, s.weapon, action, seq, origin, dir);
        return;
      case ACTION_POISON_AIM:
        if (!s.poisonActive || !dir) return;
        s.poisonDir = dir;
        s.poisonViewDelayMs = this.host.now() - this.resolveRewindTime(msg);
        return; // aim refresh is silent (remotes follow the transform)
      case WeaponActionType.POISON_STOP:
        if (!s.poisonActive) return;
        this.stopPoison(player, s, seq);
        return;
      case WeaponActionType.REVOLVER_FIRE:
        this.handleRevolverFire(player, s, seq, origin, dir, this.resolveRewindTime(msg));
        return;
      case WeaponActionType.REVOLVER_THROW:
        this.handleRevolverThrow(player, s, seq, origin, dir);
        return;
      case WeaponActionType.HAMMER_SWEEP:
        this.handleHammerWhirlwind(player, s, seq, origin, dir, this.resolveRewindTime(msg));
        return;
      case WeaponActionType.HAMMER_SLAM_START:
        this.handleHammerSlamStart(player, s, seq, origin, dir);
        return;
      case WeaponActionType.HAMMER_SLAM_IMPACT:
        this.handleSlamImpact(player, s, seq, msg);
        return;
      case WeaponActionType.SPEAR_SWEEP:
        this.handleMeleeSweep(player, s, seq, origin, dir, this.resolveRewindTime(msg));
        return;
      // ---- VISUAL-ONLY replication (no damage, no state authority) ----
      case WeaponActionType.MELEE_SHOW:
      case WeaponActionType.MELEE_HIDE:
        // Melee held / stowed: the authoritative primary never changes.
        this.confirm(player, NetworkWeaponId.HAMMER, action, seq, this.playerPos(player), dir ?? UP);
        return;
      case WeaponActionType.INSPECT_START:
        // Only while no attack is engaged (an inspection never hides one).
        if (s.hammerAttack || s.rushActive || s.inspecting) return;
        s.inspecting = true;
        this.confirm(player, s.weapon, action, seq, this.playerPos(player), dir ?? UP);
        return;
      case WeaponActionType.INSPECT_CANCEL:
        if (!s.inspecting) return;
        s.inspecting = false;
        this.confirm(player, s.weapon, action, seq, this.playerPos(player), dir ?? UP);
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
      case WeaponActionType.BASS_FIRE:
        this.handleBassFire(player, s, seq, origin, dir, msg);
        return;
      case WeaponActionType.MOLE_BURROW:
        this.handleMoleBurrow(player, s, seq, msg);
        return;
      case WeaponActionType.MOLE_EMERGE:
        this.handleMoleEmerge(player, s, seq, msg);
        return;
      case WeaponActionType.HEX_TONGUE_FIRE:
        this.handleHexTongueFire(player, s, seq, origin, dir, this.resolveRewindTime(msg));
        return;
      case WeaponActionType.BASKET_CHARGE_START:
        this.handleBasketChargeStart(player, s);
        return;
      case WeaponActionType.BASKET_CHARGE_CANCEL:
        if (s.weapon !== NetworkWeaponId.GOOFY_BASKET) return;
        s.basketChargeStart = 0; // silent: remotes only replay validated throws
        return;
      case WeaponActionType.BASKET_THROW_REQUEST:
        this.handleBasketThrowRequest(player, s, seq, origin, dir, msg);
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
      if (s.poisonActive) this.tickPoison(player, s, dt, now);
      if (s.rushActive) this.tickSpearRush(player, s, now);
      if (s.hammerAttack) this.tickHammerAttack(player, s, now);
      if (s.beamSamples && now < s.beamEndsAt) this.tickObliterreurBeam(player, s, dt);
      else if (s.beamSamples && now >= s.beamEndsAt) s.beamSamples = null;
      // Burrow safety: never invulnerable forever if MOLE_EMERGE is lost.
      if (s.burrowed && now >= s.burrowedUntil) s.burrowed = false;
      if (s.hexVictimId !== null) this.tickHexPull(player, s, now);
      if (s.basketThrow) this.tickBasketThrow(player, s, now);
    }
    this.tickProjectiles(dt);
    this.tickBassProjectiles(dt);
    this.tickBasketProjectiles(dt);
  }

  // ------------------------------------------------------------------
  // GOOFY BASKET — charge clock, throw sequence, bouncing projectile
  // ------------------------------------------------------------------

  /** BASKET_CHARGE_START: record the authoritative charge start (silent). */
  private handleBasketChargeStart(_player: NetworkPlayer, s: PlayerWeaponState): void {
    if (s.weapon !== NetworkWeaponId.GOOFY_BASKET) return;
    const now = this.host.now();
    // Busy (throw / catch engaged) → the charge cannot start; the client
    // predicts the same refusal from the same timings.
    if (s.basketThrow && now < s.basketThrow.readyAt) return;
    if (s.basketThrow) s.basketThrow = null;
    if (s.basketChargeStart !== 0) return; // already charging (duplicate)
    if (s.inspecting) s.inspecting = false; // a charge interrupts an inspection
    s.basketChargeStart = now;
  }

  /**
   * BASKET_THROW_REQUEST: the release. The level comes from the SERVER
   * charge clock (a request without a prior START is a tap = level 1); the
   * Throw phase starts now, the projectile is created at the authored
   * release marker (+ an accepted short gather delay, `pi` = 1).
   */
  private handleBasketThrowRequest(
    player: NetworkPlayer,
    s: PlayerWeaponState,
    seq: number,
    origin: Vec3 | null,
    dir: Vec3 | null,
    msg: WeaponActionMessage,
  ): void {
    if (s.weapon !== NetworkWeaponId.GOOFY_BASKET || !origin || !dir) return;
    const now = this.host.now();
    const B = W.goofyBasket;
    // Sequence engaged (throw recovery + catch) → repeated / early release refused.
    if (s.basketThrow && now < s.basketThrow.readyAt) return;
    let held = 0;
    if (s.basketChargeStart !== 0) {
      held = (now - s.basketChargeStart) / 1000;
      // A stale charge (lost release, absurd window) is dropped: tap level.
      if (held < 0 || held > B.maxChargeHoldSeconds) held = 0;
    }
    s.basketChargeStart = 0;
    const level = goofyBasketLevelForHold(held);
    const def = B.throws[level - 1];
    const gather = msg.pi === 1 ? B.maxGatherDelaySeconds : 0;
    const startedAt = now + gather * 1000;
    const id = this.nextBasketId++;
    s.basketThrow = {
      id,
      level,
      startedAt,
      launchAt: startedAt + def.releaseAt * 1000,
      readyAt: startedAt + (def.clipDuration + B.catchDuration) * 1000,
      origin,
      dir,
      launched: false,
      viewDelayMs: now - this.resolveRewindTime(msg),
    };
    s.inspecting = false;
    this.host.broadcastAction({
      playerId: player.id,
      weapon: NetworkWeaponId.GOOFY_BASKET,
      action: BASKET_ACTION_THROW,
      seq,
      ts: startedAt,
      ox: origin.x,
      oy: origin.y,
      oz: origin.z,
      dx: dir.x,
      dy: dir.y,
      dz: dir.z,
      pid: id,
      lv: level,
    });
  }

  /** Throw phase clock: create the projectile at the release marker, then free the player. */
  private tickBasketThrow(player: NetworkPlayer, s: PlayerWeaponState, now: number): void {
    const t = s.basketThrow!;
    if (!t.launched && now >= t.launchAt) {
      t.launched = true;
      this.launchBasket(player, t);
    }
    if (t.launched && now >= t.readyAt) s.basketThrow = null;
  }

  /**
   * Create the ball at the marker. Origin = the VALIDATED eye origin of the
   * release (already within MAX_ORIGIN_DRIFT of the transform), pushed
   * forward by the ball radius; a wall closer than that blocks the exit
   * and the ball starts at the eye instead (never inside geometry).
   */
  private launchBasket(player: NetworkPlayer, t: BasketThrowState): void {
    const r = W.goofyBasket.projectileRadius;
    let start = t.origin;
    const exitBlocked = raycastMap(t.origin, t.dir, r * 1.5, this.mapBoxes);
    if (exitBlocked === null) start = pointAt(t.origin, t.dir, r);
    const vel = basketLaunchVelocity(t.dir, t.level);
    this.basketProjectiles.push({
      id: t.id,
      ownerId: player.id,
      state: createBasketProjectileState(start, vel, t.level),
      viewDelayMs: t.viewDelayMs,
    });
    this.basketEvent(player.id, BASKET_ACTION_LAUNCH, start, vel, { pid: t.id, lv: t.level });
  }

  private tickBasketProjectiles(dt: number): void {
    const B = W.goofyBasket;
    for (let i = this.basketProjectiles.length - 1; i >= 0; i--) {
      const p = this.basketProjectiles[i];
      const targets = this.rewindTargets(p.ownerId, this.host.now() - p.viewDelayMs);
      const events = stepBasketProjectile(
        p.state,
        dt,
        {
          sweep: (from, dir, maxDist, radius, excludeId) =>
            sweepBasketSphere(from, dir, maxDist, radius, targets, excludeId, this.mapBoxes),
        },
        p.ownerId,
        B.projectileRadius,
      );
      let ended = false;
      for (const ev of events) {
        if (ev.type === "bounce") {
          this.basketEvent(p.ownerId, BASKET_ACTION_BOUNCE, ev.pos, ev.vel, {
            pid: p.id,
            bn: ev.index,
            hx: ev.normal.x,
            hy: ev.normal.y,
            hz: ev.normal.z,
          });
          continue;
        }
        ended = true;
        if (ev.type === "hit") {
          const owner = this.host.getPlayer(p.ownerId);
          // FLAT 25 on every level, BODY zone, first accepted hit consumes.
          if (owner && owner.isAlive) {
            this.dealDamage(owner, ev.targetId, B.damage, DamageType.GOOFY_BASKET, HitZone.BODY, NetworkWeaponId.GOOFY_BASKET);
          }
          this.basketEvent(p.ownerId, BASKET_ACTION_END, p.state.pos, UP, {
            pid: p.id,
            hx: ev.point.x,
            hy: ev.point.y,
            hz: ev.point.z,
            tid: ev.targetId,
          });
        } else {
          this.basketEvent(p.ownerId, BASKET_ACTION_END, p.state.pos, UP, {
            pid: p.id,
            hx: ev.point.x,
            hy: ev.point.y,
            hz: ev.point.z,
          });
        }
        break;
      }
      if (ended) this.basketProjectiles.splice(i, 1);
    }
  }

  /** Server-only GoofyBasket broadcast (dx/dy/dz carry a VELOCITY, not a unit dir). */
  private basketEvent(
    ownerId: string,
    action: string,
    pos: Vec3,
    vel: Vec3,
    extra: Partial<Pick<WeaponActionConfirmedEvent, "pid" | "lv" | "bn" | "hx" | "hy" | "hz" | "tid">>,
  ): void {
    this.host.broadcastAction({
      playerId: ownerId,
      weapon: NetworkWeaponId.GOOFY_BASKET,
      action,
      seq: 0,
      ts: this.host.now(),
      ox: pos.x,
      oy: pos.y,
      oz: pos.z,
      dx: vel.x,
      dy: vel.y,
      dz: vel.z,
      ...extra,
    });
  }

  /** Live GoofyBasket projectiles (tests / diagnostics). */
  get basketProjectileCount(): number {
    return this.basketProjectiles.length;
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
    // Rewind by the shooter's DECLARED view delay (refreshed on START/AIM,
    // already hard-clamped) so the beam hits what the shooter sees.
    const rewindTime = now - Math.min(s.plasmaViewDelayMs, LAG_COMP_MAX_REWIND_MS);
    const hit = hitscan(origin, s.plasmaDir, W.plasma.range, this.rewindTargets(player.id, rewindTime), player.id, this.mapBoxes);
    if (!hit || hit.kind !== "player" || !hit.targetId) return;

    const zone = hit.zone === NetworkHitZone.HEAD ? HitZone.HEAD : HitZone.BODY;
    const base = W.plasma.damagePerSecond * dt;
    const amount = zone === HitZone.HEAD ? base * W.plasma.headshotMultiplier : base;
    this.dealDamage(player, hit.targetId, amount, DamageType.PLASMA, zone, NetworkWeaponId.PLASMA_RIFLE);
  }

  /** Poison stream: identical rewind/tick scheme as plasma, SHORT range. */
  private tickPoison(player: NetworkPlayer, s: PlayerWeaponState, dt: number, now: number): void {
    if (!player.isAlive || now - s.poisonSince > W.poison.maxContinuousSeconds * 1000) {
      this.stopPoison(player, s);
      return;
    }
    // Anchor the ray on the CURRENT transform (aim refreshed by POISON_AIM).
    const origin = this.eyePos(player);
    const rewindTime = now - Math.min(s.poisonViewDelayMs, LAG_COMP_MAX_REWIND_MS);
    const hit = hitscan(origin, s.poisonDir, W.poison.range, this.rewindTargets(player.id, rewindTime), player.id, this.mapBoxes);
    if (!hit || hit.kind !== "player" || !hit.targetId) return;

    // No headshot bonus: a poison cone has no precise impact point.
    const amount = W.poison.damagePerSecond * dt;
    this.dealDamage(player, hit.targetId, amount, DamageType.POISON, HitZone.BODY, NetworkWeaponId.POISON_SPRAYER);
  }

  private stopPoison(player: NetworkPlayer, s: PlayerWeaponState, seq = 0): void {
    if (!s.poisonActive) return;
    s.poisonActive = false;
    this.confirm(player, NetworkWeaponId.POISON_SPRAYER, WeaponActionType.POISON_STOP, seq, this.eyePos(player), s.poisonDir);
  }

  private handleRevolverFire(
    player: NetworkPlayer,
    s: PlayerWeaponState,
    seq: number,
    origin: Vec3 | null,
    dir: Vec3 | null,
    rewindTime?: number,
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

    const hit = hitscan(origin, dir, W.revolver.range, this.rewindTargets(player.id, rewindTime), player.id, this.mapBoxes);
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
        const wallT = raycastMap(p.pos, dir, stepLen, this.mapBoxes);
        // Player contact: capsule proximity along the step.
        const hit = hitscan(p.pos, dir, stepLen, this.rewindTargets(p.ownerId), p.ownerId, this.mapBoxes);
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
      if (!hasLineOfSight(at, center, this.mapBoxes)) continue;
      const amount = target.maxHealth * W.revolver.explosionDamageFraction;
      this.dealDamage(owner, target.id, amount, DamageType.REVOLVER_EXPLOSION, HitZone.BODY, NetworkWeaponId.REVOLVER);
    }
  }

  /**
   * BASS_FIRE: one musical note projectile. The server owns the flight
   * (speed / lifetime / wall stop) and the per-hit damage; the client's
   * px/py/pz carry the MUSIC GRAIN metadata (track index / playhead
   * offset / note index) which is ECHOED verbatim in the confirm so every
   * remote client replays the exact same spatialized fragment.
   */
  private handleBassFire(
    player: NetworkPlayer,
    s: PlayerWeaponState,
    seq: number,
    origin: Vec3 | null,
    dir: Vec3 | null,
    msg: WeaponActionMessage,
  ): void {
    if (s.weapon !== NetworkWeaponId.BASS_BLASTER || !origin || !dir) return;
    const now = this.host.now();
    // Cadence floor (same tolerance policy as the revolver fan-fire).
    const minInterval = W.bassBlaster.fireInterval * (1 - W.bassBlaster.cadenceTolerance) * 1000;
    if (now - s.lastBassShotAt < minInterval) return;
    s.lastBassShotAt = now;

    this.bassProjectiles.push({
      ownerId: player.id,
      pos: { ...origin },
      vel: {
        x: dir.x * W.bassBlaster.projectileSpeed,
        y: dir.y * W.bassBlaster.projectileSpeed,
        z: dir.z * W.bassBlaster.projectileSpeed,
      },
      age: 0,
      viewDelayMs: Math.min(now - this.resolveRewindTime(msg), LAG_COMP_MAX_REWIND_MS),
    });

    // Grain metadata (track / offset / note) — echoed for remote replay.
    const grain = this.readPoint(msg) ?? { x: 0, y: 0, z: 0 };
    this.confirm(player, s.weapon, WeaponActionType.BASS_FIRE, seq, origin, dir, undefined, grain);
  }

  /** Straight CCD flight of every note: walls stop it, players take damage. */
  private tickBassProjectiles(dt: number): void {
    const now = this.host.now();
    for (let i = this.bassProjectiles.length - 1; i >= 0; i--) {
      const p = this.bassProjectiles[i];
      p.age += dt;
      if (p.age >= W.bassBlaster.projectileLifetime) {
        this.bassProjectiles.splice(i, 1);
        continue;
      }
      const dir = normalize(p.vel);
      if (!dir) {
        this.bassProjectiles.splice(i, 1);
        continue;
      }
      const stepLen = W.bassBlaster.projectileSpeed * dt;
      // Rewind targets by the shooter's captured view delay so the note
      // hits what the shooter aimed at when it was fired.
      const rewindTime = now - p.viewDelayMs;
      const wallT = raycastMap(p.pos, dir, stepLen, this.mapBoxes);
      const hit = hitscan(p.pos, dir, stepLen, this.rewindTargets(p.ownerId, rewindTime), p.ownerId, this.mapBoxes);

      if (
        hit &&
        hit.kind === "player" &&
        hit.targetId &&
        (wallT === null || hit.distance <= wallT)
      ) {
        const owner = this.host.getPlayer(p.ownerId);
        if (owner) {
          const zone = hit.zone === NetworkHitZone.HEAD ? HitZone.HEAD : HitZone.BODY;
          const amount = zone === HitZone.HEAD ? W.bassBlaster.headDamage : W.bassBlaster.bodyDamage;
          this.dealDamage(owner, hit.targetId, amount, DamageType.BASS_BLASTER, zone, NetworkWeaponId.BASS_BLASTER);
        }
        this.bassProjectiles.splice(i, 1);
        continue;
      }

      // Wall (from either raycast) stops the note silently server-side —
      // clients render their own local impact "plink"/burst.
      const blockT =
        hit && hit.kind === "wall"
          ? wallT !== null
            ? Math.min(wallT, hit.distance)
            : hit.distance
          : wallT;
      if (blockT !== null && blockT <= stepLen) {
        this.bassProjectiles.splice(i, 1);
        continue;
      }
      p.pos = pointAt(p.pos, dir, stepLen);
    }
  }

  /** SPEAR sweep — immediate arc resolve (unchanged legacy path). */
  private handleMeleeSweep(
    player: NetworkPlayer,
    s: PlayerWeaponState,
    seq: number,
    origin: Vec3 | null,
    dir: Vec3 | null,
    rewindTime?: number,
  ): void {
    if (!origin || !dir) return;
    const weapon = NetworkWeaponId.SPEAR;
    const cfg = W.spear;
    const now = this.host.now();
    if (now - s.lastSpearSweepAt < cfg.sweepCooldown * 1000) return;
    s.lastSpearSweepAt = now;

    this.confirm(player, weapon, WeaponActionType.SPEAR_SWEEP, seq, origin, dir);

    // Melee volume: horizontal arc in front of the attacker.
    const cosHalfArc = Math.cos(((cfg.sweepArcDegrees / 2) * Math.PI) / 180);
    const flatDir = normalize({ x: dir.x, y: 0, z: dir.z }) ?? { x: 0, y: 0, z: -1 };
    for (const target of this.rewindTargets(player.id, rewindTime)) {
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
      if (!hasLineOfSight(eye, { x: target.x, y: target.y, z: target.z }, this.mapBoxes)) continue;

      const result = this.dealDamage(
        player,
        target.id,
        t.maxHealth * cfg.sweepDamageFraction,
        DamageType.SPEAR,
        HitZone.BODY,
        weapon,
      );
      if (result.applied) {
        const away = normalize({ x: dx, y: 0, z: dz }) ?? flatDir;
        this.host.sendImpulse(target.id, {
          x: away.x * cfg.sweepKnockback,
          y: cfg.sweepVerticalKnockback,
          z: away.z * cfg.sweepKnockback,
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // BRICK MAUL — bounded attack state (whirlwind window / single slam)
  // ------------------------------------------------------------------

  /**
   * HAMMER_SWEEP → engage a WHIRLWIND. Refused while another hammer attack
   * is engaged (the 1.35 s attack IS the anti-spam floor). Damage is NOT
   * applied here: the tick resolves the 0.20–1.04 s active window.
   */
  private handleHammerWhirlwind(
    player: NetworkPlayer,
    s: PlayerWeaponState,
    seq: number,
    origin: Vec3 | null,
    dir: Vec3 | null,
    rewindTime?: number,
  ): void {
    if (!origin || !dir) return;
    const now = this.host.now();
    if (s.hammerAttack && now < s.hammerAttack.endsAt) return; // engaged → refused
    s.inspecting = false;
    const viewDelay = rewindTime !== undefined ? now - rewindTime : LAG_COMP_FALLBACK_MS;
    s.hammerAttack = {
      kind: "WHIRLWIND",
      startedAt: now,
      processed: 0,
      viewDelayMs: Math.max(0, Math.min(viewDelay, LAG_COMP_MAX_REWIND_MS)),
      hitIds: new Set(),
      impactConsumed: false,
      endsAt: now + W.hammer.sweepDuration * 1000,
    };
    this.confirm(player, NetworkWeaponId.HAMMER, WeaponActionType.HAMMER_SWEEP, seq, origin, dir);
  }

  /** HAMMER_SLAM_START → engage a SLAM waiting for its single impact. */
  private handleHammerSlamStart(
    player: NetworkPlayer,
    s: PlayerWeaponState,
    seq: number,
    origin: Vec3 | null,
    dir: Vec3 | null,
  ): void {
    if (!origin || !dir) return;
    const now = this.host.now();
    if (s.hammerAttack && now < s.hammerAttack.endsAt) return; // engaged → refused
    s.inspecting = false;
    s.hammerAttack = {
      kind: "SLAM",
      startedAt: now,
      processed: 0,
      viewDelayMs: LAG_COMP_FALLBACK_MS,
      hitIds: new Set(),
      impactConsumed: false,
      // Safety cap: a lost IMPACT can never lock the melee forever.
      endsAt: now + W.hammer.slamMaxAirSeconds * 1000,
    };
    this.confirm(player, NetworkWeaponId.HAMMER, WeaponActionType.HAMMER_SLAM_START, seq, origin, dir);
  }

  /**
   * Fixed tick of an engaged hammer attack: whirlwind window overlap test
   * + damage (one hit per victim per attack), then expiry.
   */
  private tickHammerAttack(player: NetworkPlayer, s: PlayerWeaponState, now: number): void {
    const a = s.hammerAttack!;
    if (!player.isAlive) {
      s.hammerAttack = null; // death drops the attack (no late damage)
      return;
    }
    if (a.kind === "WHIRLWIND") {
      const elapsed = (now - a.startedAt) / 1000;
      const prev = a.processed;
      a.processed = elapsed;
      // Overlap of [prev, elapsed] with the active window: a long tick that
      // jumps across the window still resolves it exactly once.
      if (elapsed >= W.hammer.sweepActiveStart && prev <= W.hammer.sweepActiveEnd) {
        this.resolveWhirlwindHits(player, a, now);
      }
    }
    if (now >= a.endsAt) s.hammerAttack = null;
  }

  /** 360° melee volume around the attacker — FLAT damage, once per victim. */
  private resolveWhirlwindHits(player: NetworkPlayer, a: HammerAttackState, now: number): void {
    const cfg = W.hammer;
    const rewindTime = now - a.viewDelayMs;
    const fullCircle = cfg.sweepArcDegrees >= 360;
    const cosHalfArc = Math.cos(((cfg.sweepArcDegrees / 2) * Math.PI) / 180);
    const eye = this.eyePos(player);
    for (const target of this.rewindTargets(player.id, rewindTime)) {
      if (a.hitIds.has(target.id)) continue; // one hit per victim per attack
      const t = this.host.getPlayer(target.id);
      if (!t || !t.isAlive) continue;
      const dx = target.x - player.x;
      const dy = target.y - player.y;
      const dz = target.z - player.z;
      const flatDist = Math.sqrt(dx * dx + dz * dz);
      if (flatDist > cfg.sweepRange || Math.abs(dy) > cfg.sweepHeight) continue;
      if (!fullCircle && flatDist > 0.01) {
        // Kept for a non-360 tuning: frontal arc around the player's yaw.
        const fwd = { x: -Math.sin(player.yaw), z: -Math.cos(player.yaw) };
        const dot = (dx / flatDist) * fwd.x + (dz / flatDist) * fwd.z;
        if (dot < cosHalfArc) continue;
      }
      if (!hasLineOfSight(eye, { x: target.x, y: target.y, z: target.z }, this.mapBoxes)) continue;

      a.hitIds.add(target.id);
      const result = this.dealDamage(player, target.id, cfg.sweepDamage, DamageType.HAMMER, HitZone.BODY, NetworkWeaponId.HAMMER);
      if (result.applied) {
        const away = normalize({ x: dx, y: 0, z: dz }) ?? { x: 0, y: 0, z: -1 };
        this.host.sendImpulse(target.id, {
          x: away.x * cfg.sweepKnockback,
          y: cfg.sweepVerticalKnockback,
          z: away.z * cfg.sweepKnockback,
        });
      }
    }
  }

  /**
   * HAMMER_SLAM_IMPACT: consumed ONCE per engaged SLAM (a second impact of
   * the same attack — even with a fresh seq — is refused, as is an impact
   * without a start). Impact point validated against the attacker.
   */
  private handleSlamImpact(
    player: NetworkPlayer,
    s: PlayerWeaponState,
    seq: number,
    msg: WeaponActionMessage,
  ): void {
    const a = s.hammerAttack;
    if (!a || a.kind !== "SLAM" || a.impactConsumed) return;
    const impact = this.readPoint(msg);
    if (!impact) return;
    // The impact must be plausibly at the attacker's feet.
    if (distance(impact, this.playerPos(player)) > W.hammer.slamMaxImpactDistance) return;

    const now = this.host.now();
    a.impactConsumed = true;
    a.endsAt = now + W.hammer.slamRecovery * 1000; // recovery keeps it engaged

    this.confirm(player, NetworkWeaponId.HAMMER, WeaponActionType.HAMMER_SLAM_IMPACT, seq, impact, UP);

    for (const target of this.host.players()) {
      if (!target.isAlive || target.id === player.id) continue;
      if (a.hitIds.has(target.id)) continue;
      const center = { x: target.x, y: target.y, z: target.z };
      const flat = Math.sqrt((center.x - impact.x) ** 2 + (center.z - impact.z) ** 2);
      if (flat > W.hammer.slamRadius) continue;
      if (Math.abs(center.y - impact.y) > W.hammer.slamHeightTolerance) continue;
      a.hitIds.add(target.id);
      const result = this.dealDamage(
        player,
        target.id,
        W.hammer.slamDamage,
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
    const t = raycastMap(origin, dir, W.obliterreur.placementRange, this.mapBoxes);
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
          const t2 = raycastMap(origin, toReported, W.obliterreur.placementRange, this.mapBoxes);
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
  // HEX SNIPER — tongue hitscan + server-driven pull + arrival bite
  // ------------------------------------------------------------------

  /**
   * LMB tongue shot. The tongue is a swept ball with no weapon range:
   * a lag-compensated hitscan against the players (inflated by the tongue
   * radius) and the map walls. A grabbed player takes the flat tongue
   * damage immediately, then the PULL starts: the victim is told to reel
   * toward the attacker (HEX_PULL) and every client replays the grab.
   * A wall / nothing → empty return (HEX_TONGUE_MISS), no damage.
   */
  private handleHexTongueFire(
    player: NetworkPlayer,
    s: PlayerWeaponState,
    seq: number,
    origin: Vec3 | null,
    dir: Vec3 | null,
    rewindTime: number,
  ): void {
    if (s.weapon !== NetworkWeaponId.HEX_SNIPER || !origin || !dir) return;
    if (s.hexVictimId !== null) return; // one attack at a time (local parity)
    const now = this.host.now();
    if (now - s.hexLastFireAt < W.hexSniper.fireCooldown * 1000) return;
    s.hexLastFireAt = now;

    const hit = hitscan(
      origin,
      dir,
      W.hexSniper.maxRange,
      this.rewindTargets(player.id, rewindTime),
      player.id,
      this.mapBoxes,
      W.hexSniper.tongueRadius,
    );

    if (!hit || hit.kind !== "player" || !hit.targetId) {
      // Empty tongue: the tip stops at the wall (or the ray end) and
      // returns — the shooter re-arms locally the moment it is back.
      const end = hit ? hit.point : pointAt(origin, dir, W.hexSniper.maxRange);
      this.confirmHex(player, HEX_ACTION_TONGUE_MISS, seq, origin, dir, end);
      return;
    }

    const victimId = hit.targetId;
    const result = this.dealDamage(
      player,
      victimId,
      W.hexSniper.tongueDamage,
      DamageType.HEX_SNIPER_TONGUE,
      HitZone.BODY, // the tongue grabs the body — no headshot rule
      NetworkWeaponId.HEX_SNIPER,
    );
    if (!result.applied) {
      // Spawn-protected / untargetable victim: the tongue bounces off
      // like a wall — never a pull on a player that can't be damaged.
      this.confirmHex(player, HEX_ACTION_TONGUE_MISS, seq, origin, dir, hit.point);
      return;
    }
    const victim = this.host.getPlayer(victimId);
    if (result.victimDied || !victim || !victim.isAlive) {
      // Killed by the grab itself: the tongue snaps back empty, no pull.
      this.confirmHex(player, HEX_ACTION_TONGUE_HIT, seq, origin, dir, hit.point, victimId);
      this.confirmHex(player, HEX_ACTION_PULL_END, 0, origin, dir);
      return;
    }

    // Grab confirmed → start the pull.
    s.hexVictimId = victimId;
    s.hexPullSince = now;
    s.hexBestDist = distance(this.playerPos(player), this.playerPos(victim));
    s.hexLastProgressAt = now;
    this.confirmHex(player, HEX_ACTION_TONGUE_HIT, seq, origin, dir, hit.point, victimId);
    this.host.sendHexPull(victimId, { attackerId: player.id, active: true });
  }

  /**
   * Pull tick (20 Hz): the victim's client moves it toward the attacker;
   * the server only checks ARRIVAL on its own transforms (bite + release),
   * and releases on stall / timeout / death / disconnect — a victim can
   * never stay hooked forever.
   */
  private tickHexPull(player: NetworkPlayer, s: PlayerWeaponState, now: number): void {
    const victimId = s.hexVictimId;
    if (victimId === null) return;
    const victim = this.host.getPlayer(victimId);
    if (!player.isAlive || !victim || !victim.isAlive || s.weapon !== NetworkWeaponId.HEX_SNIPER) {
      this.releaseHexPull(player, s, true);
      return;
    }
    if (now - s.hexPullSince > W.hexSniper.pullMaxSeconds * 1000) {
      this.releaseHexPull(player, s, true);
      return;
    }

    const attackerPos = this.playerPos(player);
    const victimPos = this.playerPos(victim);
    const dist = distance(attackerPos, victimPos);

    // Arrival → INSTANT bite (local parity: bitePending → tryBite), then
    // the tongue is free again.
    if (dist <= W.hexSniper.pullStopDistance + W.hexSniper.arrivalTolerance) {
      s.hexVictimId = null;
      this.host.sendHexPull(victimId, { attackerId: null, active: false });
      const bite = this.dealDamage(
        player,
        victimId,
        W.hexSniper.biteDamage,
        DamageType.HEX_SNIPER,
        HitZone.BODY,
        NetworkWeaponId.HEX_SNIPER,
      );
      // Knockback AWAY from the shooter (mirrors the local bite: camera
      // forward, flattened, plus a small pop-up).
      const away = normalize({
        x: victimPos.x - attackerPos.x,
        y: 0,
        z: victimPos.z - attackerPos.z,
      }) ?? { x: 0, y: 0, z: 1 };
      if (bite.applied) {
        this.host.sendImpulse(victimId, {
          x: away.x * W.hexSniper.biteKnockback,
          y: W.hexSniper.biteVerticalKnockback,
          z: away.z * W.hexSniper.biteKnockback,
        });
      }
      this.confirmHex(player, HEX_ACTION_BITE, 0, this.eyePos(player), away, victimPos, victimId);
      return;
    }

    // Stall detection: the reel must keep closing the gap — a wall / ledge
    // blocking the victim releases the grab (local "pull-blocked" rule).
    if (dist < s.hexBestDist - W.hexSniper.pullStallMinProgress) {
      s.hexBestDist = dist;
      s.hexLastProgressAt = now;
    } else if (now - s.hexLastProgressAt > W.hexSniper.pullStallSeconds * 1000) {
      this.releaseHexPull(player, s, true);
    }
  }

  /** Release the current victim WITHOUT a bite (retract everywhere). */
  private releaseHexPull(player: NetworkPlayer, s: PlayerWeaponState, broadcast: boolean): void {
    const victimId = s.hexVictimId;
    if (victimId === null) return;
    s.hexVictimId = null;
    this.host.sendHexPull(victimId, { attackerId: null, active: false });
    if (broadcast) {
      this.confirmHex(player, HEX_ACTION_PULL_END, 0, this.eyePos(player), { x: 0, y: 0, z: -1 });
    }
  }

  /** HexSniper confirm with the optional victim id (`tid`). */
  private confirmHex(
    player: NetworkPlayer,
    action: string,
    seq: number,
    origin: Vec3,
    dir: Vec3,
    hit?: Vec3,
    tid?: string,
  ): void {
    this.host.broadcastAction({
      playerId: player.id,
      weapon: NetworkWeaponId.HEX_SNIPER,
      action,
      seq,
      ox: origin.x,
      oy: origin.y,
      oz: origin.z,
      dx: dir.x,
      dy: dir.y,
      dz: dir.z,
      ...(hit ? { hx: hit.x, hy: hit.y, hz: hit.z } : {}),
      ...(tid !== undefined ? { tid } : {}),
    });
  }

  // ------------------------------------------------------------------
  // Lifecycle hooks (death / respawn / leave)
  // ------------------------------------------------------------------

  /** Death: every continuous action stops — no ghost beams from corpses. */
  onPlayerDeath(playerId: string): void {
    const s = this.states.get(playerId);
    const player = this.host.getPlayer(playerId);
    // A dying VICTIM is released by whoever is pulling it (the pulling
    // player's state owns the pull — scan for it).
    this.releaseHexVictim(playerId);
    if (!s) return;
    if (player) {
      this.stopPlasma(player, s);
      this.stopPoison(player, s);
      this.cancelObliterreurBeam(player, s);
      this.releaseHexPull(player, s, true);
    }
    s.rushActive = false;
    s.hammerAttack = null; // a corpse never finishes its whirlwind / slam
    s.inspecting = false;
    s.oblitA = null;
    s.oblitB = null;
    s.oblitNextIndex = 0;
    s.burrowed = false;
    s.hexVictimId = null;
    // A corpse never releases a ball: the planned launch is dropped. An
    // already flying ball keeps its lifecycle (owner alive check at hit).
    s.basketChargeStart = 0;
    s.basketThrow = null;
  }

  /** Whoever is pulling `victimId` drops the grab (victim died / left). */
  private releaseHexVictim(victimId: string): void {
    for (const [attackerId, st] of this.states) {
      if (st.hexVictimId !== victimId) continue;
      const attacker = this.host.getPlayer(attackerId);
      if (attacker) this.releaseHexPull(attacker, st, true);
      else st.hexVictimId = null;
    }
  }

  /** Respawn: clean combat state + fresh revolver cylinder. */
  onPlayerRespawn(playerId: string): void {
    const s = this.states.get(playerId);
    if (!s) return;
    s.plasmaActive = false;
    s.poisonActive = false;
    s.rushActive = false;
    s.rushHitIds.clear();
    s.hammerAttack = null;
    s.inspecting = false;
    s.beamSamples = null;
    s.oblitA = null;
    s.oblitB = null;
    s.oblitNextIndex = 0;
    s.burrowed = false;
    s.hexVictimId = null;
    s.revolverAmmo = W.revolver.capacity;
    s.revolverUnavailableUntil = 0;
    s.basketChargeStart = 0;
    s.basketThrow = null;
  }

  removePlayer(playerId: string): void {
    // Leaving mid-pull: the remaining side must never stay hooked to a
    // ghost — release the victim (attacker left) / drop the attacker's
    // pull (victim left).
    const leaving = this.states.get(playerId);
    if (leaving?.hexVictimId) {
      this.host.sendHexPull(leaving.hexVictimId, { attackerId: null, active: false });
      leaving.hexVictimId = null;
    }
    this.releaseHexVictim(playerId);
    this.states.delete(playerId);
    this.history.delete(playerId);
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      if (this.projectiles[i].ownerId === playerId) this.projectiles.splice(i, 1);
    }
    for (let i = this.bassProjectiles.length - 1; i >= 0; i--) {
      if (this.bassProjectiles[i].ownerId === playerId) this.bassProjectiles.splice(i, 1);
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
      // Authoritative phase start: late/duplicated arrivals reconstruct the
      // elapsed time from it (whirlwind turns, slam phases, inspection).
      ts: this.host.now(),
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