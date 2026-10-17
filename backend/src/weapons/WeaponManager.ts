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
  BASKET_ACTION_REST,
  BASKET_ACTION_END,
  FRISBEE_ACTION_BOUNCE,
  FRISBEE_ACTION_HIT,
  FRISBEE_ACTION_END,
  goofyBasketLevelForHold,
} from "../../../shared/combat/NetworkWeapons";
import { DEFAULT_WEAPON_SKIN, sanitizeWeaponSkin } from "../../../shared/combat/WeaponSkins";
import {
  type BasketProjectileState,
  createBasketProjectileState,
  resolveBasketLaunch,
  stepBasketProjectile,
} from "../../../shared/combat/BasketProjectileSim";
import { DamageType, HitZone } from "../combat/DamageTypes";
import { sanitizePopcornSeed } from "../../../shared/combat/PopcornShotgunRules";
import {
  PopcornShotgunState,
  resolvePopcornFire,
  startPopcornReload,
  cancelPopcornReload,
} from "./PopcornShotgunServer";
import {
  sanitizePaintballSeed,
  sanitizePaintballColor,
  quantizePaintballSpread,
} from "../../../shared/combat/PaintballRifleRules";
import {
  PaintballRifleState,
  resolvePaintballFire,
  startPaintballReload,
  cancelPaintballReload,
} from "./PaintballRifleServer";
import {
  sanitizeWaterFamasSeed,
  sanitizeWaterFamasJetIndex,
} from "../../../shared/combat/WaterFamasRules";
import {
  WaterFamasState,
  resolveWaterFamasFire,
  startWaterFamasReload,
  cancelWaterFamasReload,
} from "./WaterFamasServer";
import {
  FrisbeeLauncherConfig as FL,
  frisbeeDirection,
  sanitizeFrisbeeSeed,
} from "../../../shared/combat/FrisbeeLauncherRules";
import { SharedFrisbeeSim, type FrisbeeHitEvent } from "../../../shared/combat/FrisbeeSim";
import {
  FrisbeeLauncherState,
  resolveFrisbeeFire,
  startFrisbeeReload,
  cancelFrisbeeReload,
  createFrisbeeCast,
} from "./FrisbeeLauncherServer";
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
  /** Shooter velocity reported at the release (clamped) — inherited by the ball. */
  shooterVel: Vec3;
  launched: boolean;
  viewDelayMs: number;
  /** COSMETIC skin captured at the throw (replicated on THROW / LAUNCH only). */
  skin: string;
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
  weapon: NetworkWeaponId = NetworkWeaponId.GOOFY_BASKET;
  /** COSMETIC skin of `weapon` (validated whitelist id) — never a gameplay input. */
  skin: string = DEFAULT_WEAPON_SKIN;
  lastSeq = -1;
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
  // Popcorn Shotgun (server-owned ammo / cadence / reload clock)
  popcorn = new PopcornShotgunState();
  // Paintball Rifle (server-owned ammo / cadence / hopper swap clock)
  paintball = new PaintballRifleState();
  // Water FAMAS (server-owned ammo / burst cadence / refill clock)
  waterFamas = new WaterFamasState();
  // Frisbee Launcher (server-owned ammo = deck + cage / cadence / cage swap clock)
  frisbee = new FrisbeeLauncherState();
}

/** One in-flight FRISBEE LAUNCHER disc (server-simulated, shared 1/120 s fixed step). */
interface FrisbeeDisc {
  id: number;
  ownerId: string;
  sim: SharedFrisbeeSim;
  /** Shooter view delay (now − viewTime) captured at fire time (already clamped). */
  viewDelayMs: number;
  /** Time debt (s) still to simulate (fixed steps, caught up over the ticks). */
  acc: number;
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
  private readonly basketProjectiles: BasketProjectile[] = [];
  /** Monotonic GoofyBasket projectile / throw id (room-wide). */
  private nextBasketId = 1;
  private readonly frisbees: FrisbeeDisc[] = [];
  /** Monotonic Frisbee Launcher disc id (room-wide). */
  private nextFrisbeeId = 1;

  /**
   * @param mapBoxes the room's map collision world (shared MapRegistry) —
   *        every wall occlusion / placement raycast uses THIS list, so a
   *        Yard room never occludes shots against Jungle walls.
   */
  constructor(
    private readonly host: WeaponManagerHost,
    private mapBoxes: ColliderBox[] = MAP_COLLIDER_BOXES,
  ) {}

  /**
   * The room switched map (end-of-match vote): new collision world, and
   * nothing of the previous match may keep flying in it.
   */
  setMapBoxes(boxes: ColliderBox[]): void {
    this.mapBoxes = boxes;
    this.basketProjectiles.length = 0;
    this.frisbees.length = 0;
    this.states.clear();
    this.history.clear();
  }

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

  /**
   * WEAPON_EQUIP: logical ID (+ cosmetic skin id) only; refused for
   * dead/unknown players. A SKIN CHANGE ALONE (same weapon) only updates
   * the replicated skin: it never cancels a charge, a throw, a beam or an
   * inspection — unlike a real weapon swap below.
   */
  handleEquip(player: NetworkPlayer, rawWeapon: unknown, rawSkin: unknown = DEFAULT_WEAPON_SKIN): void {
    if (!player.isAlive) return;
    if (!isNetworkWeaponId(rawWeapon)) return;
    const s = this.stateOf(player.id);
    const skin = sanitizeWeaponSkin(rawWeapon, rawSkin);
    if (s.weapon === rawWeapon) {
      if (s.skin !== skin) {
        s.skin = skin;
        player.skin = skin; // synced schema state → all clients (late joiners included)
      }
      return;
    }
    // Switching away drops continuous actions cleanly.
    // Unequipping the HexSniper mid-pull releases the victim (local parity:
    // hexSniper.reset() cancels the tongue on every weapon swap).
    this.releaseHexPull(player, s, true);
    s.inspecting = false; // a weapon swap always ends an inspection
    // A weapon swap cancels a basket charge / a throw whose ball has NOT
    // left the hand yet; an already launched projectile keeps flying.
    s.basketChargeStart = 0;
    if (s.basketThrow && !s.basketThrow.launched) s.basketThrow = null;
    // Leaving the shotgun mid-reload: before the refill point the ammo is
    // unchanged (local parity: controller.cancelReload()). Ammo persists
    // across weapon swaps, like the local controller instance.
    cancelPopcornReload(s.popcorn, this.host.now());
    // Same rule for the paintball hopper swap (cancel before the click).
    cancelPaintballReload(s.paintball, this.host.now());
    // Water FAMAS: leaving mid-refill keeps the old ammo (before the pour ends).
    cancelWaterFamasReload(s.waterFamas, this.host.now());
    // Frisbee Launcher: an unfinished cage swap is undone before cageIn; a re-cock in
    // progress is completed (the disc ends on the deck). Discs in flight keep flying.
    s.frisbee.cancel(this.host.now());
    s.weapon = rawWeapon;
    s.skin = skin;
    player.weapon = rawWeapon; // synced schema state → all clients
    player.skin = skin;
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
      case WeaponActionType.POPCORN_FIRE:
        this.handlePopcornFire(player, s, seq, origin, dir, msg);
        return;
      case WeaponActionType.POPCORN_RELOAD:
        if (s.weapon !== NetworkWeaponId.POPCORN_SHOTGUN) return;
        if (!startPopcornReload(s.popcorn, this.host.now())) return;
        this.confirmPopcorn(player, action, seq, this.eyePos(player), dir ?? UP, s.popcorn.ammo);
        return;
      case WeaponActionType.POPCORN_RELOAD_CANCEL:
        if (s.weapon !== NetworkWeaponId.POPCORN_SHOTGUN) return;
        if (!cancelPopcornReload(s.popcorn, this.host.now())) return;
        this.confirmPopcorn(player, action, seq, this.eyePos(player), dir ?? UP, s.popcorn.ammo);
        return;
      case WeaponActionType.PAINTBALL_FIRE:
        this.handlePaintballFire(player, s, seq, origin, dir, msg);
        return;
      case WeaponActionType.PAINTBALL_RELOAD:
        if (s.weapon !== NetworkWeaponId.PAINTBALL_RIFLE) return;
        if (!startPaintballReload(s.paintball, this.host.now())) return;
        this.confirmPaintball(player, action, seq, this.eyePos(player), dir ?? UP, s.paintball.ammo);
        return;
      case WeaponActionType.PAINTBALL_RELOAD_CANCEL:
        if (s.weapon !== NetworkWeaponId.PAINTBALL_RIFLE) return;
        if (!cancelPaintballReload(s.paintball, this.host.now())) return;
        this.confirmPaintball(player, action, seq, this.eyePos(player), dir ?? UP, s.paintball.ammo);
        return;
      case WeaponActionType.WATER_FAMAS_FIRE:
        this.handleWaterFamasFire(player, s, seq, origin, dir, msg);
        return;
      case WeaponActionType.WATER_FAMAS_RELOAD:
        if (s.weapon !== NetworkWeaponId.WATER_FAMAS) return;
        if (!startWaterFamasReload(s.waterFamas, this.host.now())) return;
        this.confirmWaterFamas(player, action, seq, this.eyePos(player), dir ?? UP, s.waterFamas.ammo);
        return;
      case WeaponActionType.WATER_FAMAS_RELOAD_CANCEL:
        if (s.weapon !== NetworkWeaponId.WATER_FAMAS) return;
        if (!cancelWaterFamasReload(s.waterFamas, this.host.now())) return;
        this.confirmWaterFamas(player, action, seq, this.eyePos(player), dir ?? UP, s.waterFamas.ammo);
        return;
      case WeaponActionType.FRISBEE_FIRE:
        this.handleFrisbeeFire(player, s, seq, origin, dir, msg);
        return;
      case WeaponActionType.FRISBEE_RELOAD: {
        if (s.weapon !== NetworkWeaponId.FRISBEE_LAUNCHER) return;
        const r = startFrisbeeReload(s.frisbee, this.host.now());
        if (!r.started) return;
        this.confirmFrisbee(player, action, seq, this.eyePos(player), dir ?? UP, {
          am: s.frisbee.ammo,
          cg: r.cageBefore,
          dk: r.deckBefore ? 1 : 0,
        });
        return;
      }
      case WeaponActionType.FRISBEE_RELOAD_CANCEL:
        if (s.weapon !== NetworkWeaponId.FRISBEE_LAUNCHER) return;
        if (!cancelFrisbeeReload(s.frisbee, this.host.now())) return;
        this.confirmFrisbee(player, action, seq, this.eyePos(player), dir ?? UP, {
          am: s.frisbee.ammo,
          cg: s.frisbee.cage,
          dk: s.frisbee.deck ? 1 : 0,
        });
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
      if (s.rushActive) this.tickSpearRush(player, s, now);
      if (s.hammerAttack) this.tickHammerAttack(player, s, now);
      // Burrow safety: never invulnerable forever if MOLE_EMERGE is lost.
      if (s.burrowed && now >= s.burrowedUntil) s.burrowed = false;
      if (s.hexVictimId !== null) this.tickHexPull(player, s, now);
      if (s.basketThrow) this.tickBasketThrow(player, s, now);
    }
    this.tickBasketProjectiles(dt);
    this.tickFrisbees(dt);
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
    // Shooter velocity (px/py/pz): the ball inherits the momentum along the
    // aim. Plausibility-clamped to the shared max (never trusted raw); a
    // missing / malformed value = standing shooter.
    let shooterVel: Vec3 = this.readPoint(msg) ?? { x: 0, y: 0, z: 0 };
    const sLen = Math.hypot(shooterVel.x, shooterVel.y, shooterVel.z);
    if (sLen > B.maxShooterSpeed) {
      const k = B.maxShooterSpeed / sLen;
      shooterVel = { x: shooterVel.x * k, y: shooterVel.y * k, z: shooterVel.z * k };
    }
    s.basketThrow = {
      id,
      level,
      startedAt,
      launchAt: startedAt + def.releaseAt * 1000,
      readyAt: startedAt + (def.clipDuration + B.catchDuration) * 1000,
      origin,
      dir,
      shooterVel,
      launched: false,
      viewDelayMs: now - this.resolveRewindTime(msg),
      // COSMETIC: the skin equipped at the throw is captured with the
      // projectile id — a later skin change never recolors this ball.
      skin: s.skin,
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
      sk: s.skin,
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
   * Create the ball at the marker. Origin = the RIGHT HAND launch point
   * (shared rule from the VALIDATED eye origin + aim — never the head); if
   * the segment eye → hand crosses map geometry (hand through a wall) the
   * ball starts at the eye pushed forward by its radius instead (never
   * inside geometry). Velocity = shared rule: level speed converging on
   * the aim line + the shooter's inherited momentum.
   */
  private launchBasket(player: NetworkPlayer, t: BasketThrowState): void {
    const { start, vel } = resolveBasketLaunch(t.origin, t.dir, t.level, t.shooterVel, (from, dir, maxDist) =>
      raycastMap(from, dir, maxDist, this.mapBoxes),
    );
    this.basketProjectiles.push({
      id: t.id,
      ownerId: player.id,
      state: createBasketProjectileState(start, vel, t.level),
      viewDelayMs: t.viewDelayMs,
    });
    this.basketEvent(player.id, BASKET_ACTION_LAUNCH, start, vel, { pid: t.id, lv: t.level, sk: t.skin });
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
        if (ev.type === "rest") {
          // NOT terminal: the ball sits at the contact until its expiry.
          // Clients snap theirs to the exact rest pose (zero velocity).
          this.basketEvent(p.ownerId, BASKET_ACTION_REST, p.state.pos, p.state.vel, {
            pid: p.id,
            hx: ev.normal.x,
            hy: ev.normal.y,
            hz: ev.normal.z,
          });
          continue;
        }
        ended = true;
        if (ev.type === "hit") {
          const owner = this.host.getPlayer(p.ownerId);
          // FLAT 75 on every level, BODY zone, first accepted hit consumes.
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
    extra: Partial<Pick<WeaponActionConfirmedEvent, "pid" | "lv" | "bn" | "hx" | "hy" | "hz" | "tid" | "sk">>,
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

  // ------------------------------------------------------------------
  // POPCORN SHOTGUN — 12 seeded pellets, summed ONCE per victim
  // ------------------------------------------------------------------

  /**
   * POPCORN_FIRE: validate ammo / cadence / reload gate, recompute the 12
   * pellets from the client's seed + aim (shared rule — identical on every
   * client), raycast them against the lag-compensated targets and apply
   * ONE summed damage event per victim (head pellet = at least the
   * remaining HP). Every accepted shot is confirmed (sd + am) so remotes
   * replay the same popcorns and the TP Fire / FireLast clip.
   */
  private handlePopcornFire(
    player: NetworkPlayer,
    s: PlayerWeaponState,
    seq: number,
    origin: Vec3 | null,
    dir: Vec3 | null,
    msg: WeaponActionMessage,
  ): void {
    if (s.weapon !== NetworkWeaponId.POPCORN_SHOTGUN || !origin || !dir) return;
    const seed = sanitizePopcornSeed(msg.sd);
    if (seed === null) return;
    const now = this.host.now();
    const result = resolvePopcornFire(
      s.popcorn,
      now,
      origin,
      dir,
      seed,
      this.rewindTargets(player.id, this.resolveRewindTime(msg)),
      player.id,
      this.mapBoxes,
      (id) => {
        const t = this.host.getPlayer(id);
        return t && t.isAlive ? [t.maxHealth, t.health] : null;
      },
    );
    if (!result.accepted) return;
    this.confirmPopcorn(player, WeaponActionType.POPCORN_FIRE, seq, origin, dir, result.ammoLeft, seed, result.centerPoint);
    for (const v of result.victims) {
      this.dealDamage(
        player,
        v.targetId,
        v.amount,
        DamageType.POPCORN_SHOTGUN,
        v.headshot ? HitZone.HEAD : HitZone.BODY,
        NetworkWeaponId.POPCORN_SHOTGUN,
      );
    }
  }

  /** Popcorn confirm: the regular confirm + pellet seed (`sd`) + server ammo (`am`). */
  private confirmPopcorn(
    player: NetworkPlayer,
    action: string,
    seq: number,
    origin: Vec3,
    dir: Vec3,
    ammo: number,
    seed?: number,
    hit?: Vec3,
  ): void {
    this.host.broadcastAction({
      playerId: player.id,
      weapon: NetworkWeaponId.POPCORN_SHOTGUN,
      action,
      seq,
      ts: this.host.now(),
      ox: origin.x,
      oy: origin.y,
      oz: origin.z,
      dx: dir.x,
      dy: dir.y,
      dz: dir.z,
      ...(hit ? { hx: hit.x, hy: hit.y, hz: hit.z } : {}),
      ...(seed !== undefined ? { sd: seed } : {}),
      am: ammo,
    });
  }

  // ------------------------------------------------------------------
  // FRISBEE LAUNCHER — one real disc per shot, shared fixed-step flight,
  // bounces on the scenery, damage + knockback on the FIRST player touched
  // ------------------------------------------------------------------

  /**
   * FRISBEE_FIRE: validate the deck / cadence / cage-swap gate, rebuild the
   * launch direction from the client's seed + aim (shared rule — identical on
   * every client) and create the disc at the validated EYE origin. The disc is
   * then simulated by tickFrisbees() with the SHARED SharedFrisbeeSim. Every
   * accepted shot is confirmed (sd + pc + pid + am + cg + FINAL direction) so
   * the clients replay the same disc and the TP fire / fireLast clip.
   */
  private handleFrisbeeFire(
    player: NetworkPlayer,
    s: PlayerWeaponState,
    seq: number,
    origin: Vec3 | null,
    dir: Vec3 | null,
    msg: WeaponActionMessage,
  ): void {
    if (s.weapon !== NetworkWeaponId.FRISBEE_LAUNCHER || !origin || !dir) return;
    const seed = sanitizeFrisbeeSeed(msg.sd);
    if (seed === null) return;
    const result = resolveFrisbeeFire(s.frisbee, this.host.now());
    if (!result.accepted) return;
    const aiming = msg.pc === 1;
    const launchDir = frisbeeDirection(dir, aiming, seed, { x: 0, y: 0, z: 0 });
    const id = this.nextFrisbeeId++;
    if (this.frisbees.length >= FL.maxDiscs) {
      const old = this.frisbees.shift();
      if (old) {
        const p = old.sim.pos;
        this.frisbeeEvent(old.ownerId, FRISBEE_ACTION_END, p, UP, { pid: old.id, hx: p.x, hy: p.y, hz: p.z });
      }
    }
    this.frisbees.push({
      id,
      ownerId: player.id,
      sim: new SharedFrisbeeSim(id, origin, launchDir, player.id),
      viewDelayMs: this.host.now() - this.resolveRewindTime(msg),
      acc: 0,
    });
    s.inspecting = false;
    this.confirmFrisbee(player, WeaponActionType.FRISBEE_FIRE, seq, origin, launchDir, {
      sd: seed,
      pc: aiming ? 1 : 0,
      pid: id,
      am: result.ammoAfter,
      cg: result.cageAtShot,
    });
  }

  /** Advance every disc by FIXED steps (time debt kept, like the client), apply touches, broadcast corrections. */
  private tickFrisbees(dt: number): void {
    if (this.frisbees.length === 0) return;
    const step = FL.simStep;
    for (let i = this.frisbees.length - 1; i >= 0; i--) {
      const d = this.frisbees[i];
      d.acc = Math.min(d.acc + dt, 0.5);
      const targets = this.rewindTargets(d.ownerId, this.host.now() - d.viewDelayMs);
      const cast = createFrisbeeCast(targets, this.mapBoxes);
      let n = 0;
      while (d.acc >= step && n++ < 36 && d.sim.alive) {
        d.acc -= step;
        const hits: FrisbeeHitEvent[] = [];
        let bounceSpeed = 0;
        const bounceNormal: Vec3 = { x: 0, y: 1, z: 0 };
        d.sim.step(cast, {
          onHit: (e) => hits.push(e),
          onBounce: (_id, _point, normal, speed) => {
            bounceSpeed = speed;
            bounceNormal.x = normal.x;
            bounceNormal.y = normal.y;
            bounceNormal.z = normal.z;
          },
        });
        for (const h of hits) this.applyFrisbeeHit(d, h);
        // A slow disc sliding on the floor is not worth a message (the client simulates the same
        // rest); a real bounce (> 3 m/s) corrects the client copy.
        if (bounceSpeed > 3) {
          this.frisbeeEvent(d.ownerId, FRISBEE_ACTION_BOUNCE, d.sim.pos, d.sim.vel, {
            pid: d.id,
            bn: d.sim.bounces,
            hx: bounceNormal.x,
            hy: bounceNormal.y,
            hz: bounceNormal.z,
          });
        }
      }
      if (!d.sim.alive) {
        const p = d.sim.pos;
        this.frisbeeEvent(d.ownerId, FRISBEE_ACTION_END, p, UP, { pid: d.id, hx: p.x, hy: p.y, hz: p.z });
        this.frisbees.splice(i, 1);
      }
    }
  }

  /**
   * ONE touch per disc (the sim clears canDamage): damage 75 body / 100 head
   * (x0.6 after a bounce) + a small knockback impulse on the victim (same
   * host.sendImpulse path as the hammer / spear / hex bite). A dead shooter
   * deals nothing (basket rule).
   */
  private applyFrisbeeHit(d: FrisbeeDisc, e: FrisbeeHitEvent): void {
    const owner = this.host.getPlayer(d.ownerId);
    if (owner && owner.isAlive) {
      const result = this.dealDamage(
        owner,
        e.target,
        e.damage,
        DamageType.FRISBEE_LAUNCHER,
        e.headshot ? HitZone.HEAD : HitZone.BODY,
        NetworkWeaponId.FRISBEE_LAUNCHER,
      );
      // A small push, never a stun: skipped on a kill (the ragdoll takes over).
      const victim = this.host.getPlayer(e.target);
      if (result.applied && !result.victimDied && victim && victim.isAlive) this.host.sendImpulse(e.target, e.impulse);
    }
    this.frisbeeEvent(d.ownerId, FRISBEE_ACTION_HIT, d.sim.pos, d.sim.vel, {
      pid: d.id,
      tid: e.target,
      hx: e.point.x,
      hy: e.point.y,
      hz: e.point.z,
    });
  }

  /** Frisbee confirm: the regular confirm + seed / aim flag / disc id / ammo / cage / deck flag. */
  private confirmFrisbee(
    player: NetworkPlayer,
    action: string,
    seq: number,
    origin: Vec3,
    dir: Vec3,
    extra: Partial<Pick<WeaponActionConfirmedEvent, "sd" | "pc" | "pid" | "am" | "cg" | "dk">>,
  ): void {
    this.host.broadcastAction({
      playerId: player.id,
      weapon: NetworkWeaponId.FRISBEE_LAUNCHER,
      action,
      seq,
      ts: this.host.now(),
      ox: origin.x,
      oy: origin.y,
      oz: origin.z,
      dx: dir.x,
      dy: dir.y,
      dz: dir.z,
      ...extra,
    });
  }

  /** Server-only Frisbee broadcast (dx/dy/dz carry a VELOCITY, not a unit dir). */
  private frisbeeEvent(
    ownerId: string,
    action: string,
    pos: Vec3,
    vel: Vec3,
    extra: Partial<Pick<WeaponActionConfirmedEvent, "pid" | "bn" | "hx" | "hy" | "hz" | "tid">>,
  ): void {
    this.host.broadcastAction({
      playerId: ownerId,
      weapon: NetworkWeaponId.FRISBEE_LAUNCHER,
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

  /** Live Frisbee Launcher discs (tests / diagnostics). */
  get frisbeeCount(): number {
    return this.frisbees.length;
  }

  // ------------------------------------------------------------------
  // PAINTBALL RIFLE — automatic hitscan, one seeded ball per message
  // ------------------------------------------------------------------

  /**
   * PAINTBALL_FIRE: validate ammo / cadence (≥ 0.1 s) / swap gate, rebuild
   * the ball direction from the client's seed + spread + aim (shared rule
   * — identical on every client), hitscan it against the lag-compensated
   * targets and apply the damage IMMEDIATELY (23 body / 34.5 head, no
   * falloff). Every accepted ball is confirmed (sd + sp + am + end point +
   * victim id) so remotes replay the same visual ball and paint.
   */
  private handlePaintballFire(
    player: NetworkPlayer,
    s: PlayerWeaponState,
    seq: number,
    origin: Vec3 | null,
    dir: Vec3 | null,
    msg: WeaponActionMessage,
  ): void {
    if (s.weapon !== NetworkWeaponId.PAINTBALL_RIFLE || !origin || !dir) return;
    const seed = sanitizePaintballSeed(msg.sd);
    if (seed === null) return;
    const spread = quantizePaintballSpread(msg.sp);
    const result = resolvePaintballFire(
      s.paintball,
      this.host.now(),
      origin,
      dir,
      seed,
      spread,
      this.rewindTargets(player.id, this.resolveRewindTime(msg)),
      player.id,
      this.mapBoxes,
    );
    if (!result.accepted) return;
    this.confirmPaintball(
      player,
      WeaponActionType.PAINTBALL_FIRE,
      seq,
      origin,
      dir,
      result.ammoLeft,
      seed,
      spread,
      result.endPoint,
      result.victim?.targetId,
      sanitizePaintballColor(msg.pc),
    );
    const v = result.victim;
    if (v) {
      this.dealDamage(
        player,
        v.targetId,
        v.amount,
        DamageType.PAINTBALL_RIFLE,
        v.headshot ? HitZone.HEAD : HitZone.BODY,
        NetworkWeaponId.PAINTBALL_RIFLE,
      );
    }
  }

  /** Paintball confirm: the regular confirm + seed / spread / ammo / victim. */
  private confirmPaintball(
    player: NetworkPlayer,
    action: string,
    seq: number,
    origin: Vec3,
    dir: Vec3,
    ammo: number,
    seed?: number,
    spread?: number,
    hit?: Vec3,
    victimId?: string,
    color?: number,
  ): void {
    this.host.broadcastAction({
      playerId: player.id,
      weapon: NetworkWeaponId.PAINTBALL_RIFLE,
      action,
      seq,
      ts: this.host.now(),
      ox: origin.x,
      oy: origin.y,
      oz: origin.z,
      dx: dir.x,
      dy: dir.y,
      dz: dir.z,
      ...(hit ? { hx: hit.x, hy: hit.y, hz: hit.z } : {}),
      ...(seed !== undefined ? { sd: seed } : {}),
      ...(spread !== undefined ? { sp: spread } : {}),
      ...(victimId ? { tid: victimId } : {}),
      ...(color !== undefined ? { pc: color } : {}),
      am: ammo,
    });
  }

  // ------------------------------------------------------------------
  // WATER FAMAS — 3-jet burst, ONE seeded hitscan per jet message
  // ------------------------------------------------------------------

  /**
   * WATER_FAMAS_FIRE: ONE jet of a burst (`pi` = 0 / 1 / 2). Validates ammo /
   * burst cadence (>= 0.45 s between burst starts, jets 1 and 2 in order at
   * 0.075 / 0.15 s) / refill gate, rebuilds the jet direction from the seed +
   * aim + jet index (shared rule — identical on every client), hitscans it
   * against the lag-compensated targets (no range limit) and applies the damage
   * IMMEDIATELY (23 body / 34.5 head, no falloff). Every accepted jet is
   * confirmed (sd + pi + pc + am + FINAL direction + end point + victim id) so
   * remotes replay the same visible jet and the same wet mark.
   */
  private handleWaterFamasFire(
    player: NetworkPlayer,
    s: PlayerWeaponState,
    seq: number,
    origin: Vec3 | null,
    dir: Vec3 | null,
    msg: WeaponActionMessage,
  ): void {
    if (s.weapon !== NetworkWeaponId.WATER_FAMAS || !origin || !dir) return;
    const seed = sanitizeWaterFamasSeed(msg.sd);
    const jet = sanitizeWaterFamasJetIndex(msg.pi);
    if (seed === null || jet === null) return;
    const aiming = msg.pc === 1;
    const result = resolveWaterFamasFire(
      s.waterFamas,
      this.host.now(),
      origin,
      dir,
      seed,
      jet,
      aiming,
      this.rewindTargets(player.id, this.resolveRewindTime(msg)),
      player.id,
      this.mapBoxes,
    );
    if (!result.accepted) return;
    this.confirmWaterFamas(
      player,
      WeaponActionType.WATER_FAMAS_FIRE,
      seq,
      origin,
      result.jetDir,
      result.ammoLeft,
      seed,
      jet,
      aiming,
      result.endPoint,
      result.victim?.targetId,
    );
    const v = result.victim;
    if (v) {
      this.dealDamage(
        player,
        v.targetId,
        v.amount,
        DamageType.WATER_FAMAS,
        v.headshot ? HitZone.HEAD : HitZone.BODY,
        NetworkWeaponId.WATER_FAMAS,
      );
    }
  }

  /** Water FAMAS confirm: the regular confirm + seed / jet index / ADS flag / ammo / victim. */
  private confirmWaterFamas(
    player: NetworkPlayer,
    action: string,
    seq: number,
    origin: Vec3,
    dir: Vec3,
    ammo: number,
    seed?: number,
    jet?: number,
    aiming?: boolean,
    hit?: Vec3,
    victimId?: string,
  ): void {
    this.host.broadcastAction({
      playerId: player.id,
      weapon: NetworkWeaponId.WATER_FAMAS,
      action,
      seq,
      ts: this.host.now(),
      ox: origin.x,
      oy: origin.y,
      oz: origin.z,
      dx: dir.x,
      dy: dir.y,
      dz: dir.z,
      ...(hit ? { hx: hit.x, hy: hit.y, hz: hit.z } : {}),
      ...(seed !== undefined ? { sd: seed } : {}),
      ...(jet !== undefined ? { pi: jet } : {}),
      ...(aiming !== undefined ? { pc: aiming ? 1 : 0 } : {}),
      ...(victimId ? { tid: victimId } : {}),
      am: ammo,
    });
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

  /** Death: every engaged action stops (a corpse never keeps attacking). */
  onPlayerDeath(playerId: string): void {
    const s = this.states.get(playerId);
    const player = this.host.getPlayer(playerId);
    // A dying VICTIM is released by whoever is pulling it (the pulling
    // player's state owns the pull — scan for it).
    this.releaseHexVictim(playerId);
    if (!s) return;
    if (player) {
      this.releaseHexPull(player, s, true);
    }
    s.rushActive = false;
    s.hammerAttack = null; // a corpse never finishes its whirlwind / slam
    s.inspecting = false;
    s.burrowed = false;
    s.hexVictimId = null;
    // A corpse never releases a ball: the planned launch is dropped. An
    // already flying ball keeps its lifecycle (owner alive check at hit).
    s.basketChargeStart = 0;
    s.basketThrow = null;
    cancelPopcornReload(s.popcorn, this.host.now()); // a corpse never finishes a reload
    cancelPaintballReload(s.paintball, this.host.now());
    cancelWaterFamasReload(s.waterFamas, this.host.now());
    s.frisbee.cancel(this.host.now()); // a corpse never finishes a cage swap
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

  /** Respawn: clean combat state + full magazines. */
  onPlayerRespawn(playerId: string): void {
    const s = this.states.get(playerId);
    if (!s) return;
    s.rushActive = false;
    s.rushHitIds.clear();
    s.hammerAttack = null;
    s.inspecting = false;
    s.burrowed = false;
    s.hexVictimId = null;
    s.basketChargeStart = 0;
    s.basketThrow = null;
    s.popcorn.reset(); // respawn = full tank (local parity: setAmmo(2))
    s.paintball.reset(); // respawn = full hopper (local parity: setAmmo(32))
    s.waterFamas.reset(); // respawn = full tank (local parity: setAmmo(9))
    s.frisbee.reset(); // respawn = loaded deck + full cage (local parity: setAmmo(true, 5))
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
    // The discs of a leaving player are dropped silently (clients expire theirs on their own clock).
    for (let i = this.frisbees.length - 1; i >= 0; i--) {
      if (this.frisbees[i].ownerId === playerId) this.frisbees.splice(i, 1);
    }
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

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
