import * as THREE from "three";
import { audio } from "../../audio/AudioManager";
import { MoleStrikeConfig as mole } from "../../killstreaks/mole/MoleStrikeConfig";
import type { ParticleSystem } from "../../effects/ParticleSystem";
import {
  NetworkWeaponConfig as W,
  NetworkWeaponId,
  WeaponActionType,
  WeaponActionConfirmedEvent,
  PLAYER_FEET_OFFSET,
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
} from "../../../shared/combat/NetworkWeapons";
import { HexSniperConfig as hexCfg } from "../../weapons/hexsniper/HexSniperConfig";
import type { RemotePlayerManager } from "../RemotePlayerManager";



/** One remote MOLE STRIKE burrow in progress (dirt trail follower). */
interface RemoteBurrow {
  trailAccum: number;
  /** Local-elapsed safety expiry (the emerge event normally ends it). */
  expiresAt: number;
}

/**
 * One remote HEX SNIPER tongue in flight / holding / returning. Pure
 * replay of the server-confirmed sequence: the tip flies from the remote
 * creature's mouth to the confirmed end point (grab point or wall), then
 * either sticks to the grabbed avatar (pull) or snaps straight back.
 */
interface RemoteTongue {
  phase: "extending" | "holding" | "retracting";
  /** Confirmed end point of the flight (grab point / wall). */
  target: THREE.Vector3;
  /** Current world tip. */
  tip: THREE.Vector3;
  /** Grabbed victim (holding phase) — the tip follows this avatar. */
  victimId: string | null;
  /** Offset kept between the avatar center and the grab point. */
  victimOffset: THREE.Vector3;
  /**
   * Play the Bite clip once the tip is home. ALWAYS true (local parity:
   * every tongue shot — hit, miss or released pull — ends with the jaws
   * snapping once the tongue is back in the mouth).
   */
  biteOnReturn: boolean;
}

/** Generic short-lived expanding + fading mesh (explosions, slam rings). */
interface Burst {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  age: number;
  life: number;
  fromScale: number;
  toScale: number;
}

/**
 * Replays SERVER-CONFIRMED weapon actions of REMOTE players as pure
 * visuals + spatial audio (Phase 5): melee swings / slam rings, Hex
 * Sniper tongues, mole strike dirt, and the per-weapon routing of the
 * projectile weapons whose shared pools live in the Game.
 *
 * NEVER runs for the LOCAL player (local prediction already renders those)
 * and NEVER computes damage — the server owns every gameplay result.
 */
export class RemoteCombatVFXController {
  private readonly burrows = new Map<string, RemoteBurrow>();
  /** Remote HexSniper tongues by shooter id (one per player at a time). */
  private readonly tongues = new Map<string, RemoteTongue>();
  private readonly bursts: Burst[] = [];
  /** Shared particle system (suction/spark parity with the local beam). */
  private particles: ParticleSystem | null = null;
  /** LOCAL player capsule center (a remote tongue can be reeling US in). */
  private localPosition: ((out: THREE.Vector3) => THREE.Vector3) | null = null;
  /**
   * GOOFY BASKET remote projectiles live in the Game's physics-aware
   * projectile system (shared integration rule + Rapier sweeps): LAUNCH /
   * BOUNCE / END confirms of OTHER players are forwarded here. The
   * avatar's Throw / Catch phases are replayed through `remotes`.
   */
  onBasketProjectile: ((ev: WeaponActionConfirmedEvent) => void) | null = null;
  /** POPCORN SHOTGUN: remote players' fire / reload confirms (wired by the Game). */
  onPopcornAction: ((ev: WeaponActionConfirmedEvent) => void) | null = null;
  /** PAINTBALL RIFLE: remote players' fire / reload confirms (wired by the Game). */
  onPaintballAction: ((ev: WeaponActionConfirmedEvent) => void) | null = null;
  /** WATER FAMAS: remote players' per-jet fire / reload confirms (wired by the Game). */
  onWaterFamasAction: ((ev: WeaponActionConfirmedEvent) => void) | null = null;
  /** FRISBEE LAUNCHER: remote players' fire / reload confirms + disc BOUNCE / HIT / END corrections (wired by the Game). */
  onFrisbeeAction: ((ev: WeaponActionConfirmedEvent) => void) | null = null;

  private elapsed = 0;
  private disposed = false;

  // Scratch
  private readonly poseScratch = { pos: new THREE.Vector3(), yaw: 0, pitch: 0 };
  private readonly originScratch = new THREE.Vector3();
  private readonly vecScratch = new THREE.Vector3();
  private readonly particlePosScratch = new THREE.Vector3();
  private readonly particleVelScratch = new THREE.Vector3();

  // Mole strike palette (identical to the local MoleStrikeVFX).
  private readonly moleDirt = new THREE.Color(mole.moleStrikeDirtColor);
  private readonly moleDirtDark = new THREE.Color(mole.moleStrikeDirtDarkColor);
  private readonly moleBlast = new THREE.Color(mole.moleStrikeBlastColor);
  private readonly moleFlash = new THREE.Color(mole.moleStrikeFlashColor);
  private readonly upVec = new THREE.Vector3(0, 1, 0);

  constructor(
    private readonly scene: THREE.Scene,
    private readonly remotes: RemotePlayerManager,
    private readonly getLocalId: () => string | null,
  ) {
  }

  /** Shared ParticleSystem: remote beams emit the same suction/sparks. */
  setParticles(particles: ParticleSystem): void {
    this.particles = particles;
  }

  /** Local player position provider (remote tongue latched on US). */
  setLocalPosition(provider: (out: THREE.Vector3) => THREE.Vector3): void {
    this.localPosition = provider;
  }

  /**
   * Pre-compile every VFX material/pipeline by rendering one instance of
   * each far below the map for a few frames. Without this, the FIRST
   * remote shot / explosion would trigger shader compilation mid-fight
   * (a visible one-time hitch).
   */
  warmUp(): void {
    if (this.disposed) return;
    const far = { x: 0, y: -400, z: 0 };
    // Additive transparent MeshBasicMaterial family (bursts / rings).
    this.spawnBurst(new THREE.SphereGeometry(0.5, 8, 6), 0xc084fc, far, 0.5, 1, 0.4);
    this.spawnGroundRing(far, 2, 0.4, 0xa855f7);
  }

  /**
   * Immediately end the warm-up (the Game renders its own warm frames):
   * the transient warm-up meshes/materials are removed BEFORE gameplay so
   * the Game's follow-up renders (and the LOW-preset shadow bake) see the
   * real runtime scene. FX lights are pooled (FXLightPool) — the scene
   * light count never changes, warm-up or not.
   */
  finishWarmUp(): void {
    // Nothing transient to drop: the bursts expire on their own.
  }

  // ------------------------------------------------------------------
  // Server event entry point
  // ------------------------------------------------------------------

  handleAction(ev: WeaponActionConfirmedEvent): void {
    if (this.disposed) return;
    // NEVER double the local shooter's VFX — local prediction covers it.
    if (ev.playerId === this.getLocalId()) return;

    switch (ev.action) {
      case WeaponActionType.HAMMER_SWEEP:
        // Brick Maul WHIRLWIND: TP clip resumed at the server-start offset
        // (late / duplicated confirms land on the right turn).
        this.remotes.maulWhirlwind(ev.playerId, this.remotes.elapsedSince(ev.ts));
        this.playSwingSound(ev);
        return;
      case WeaponActionType.MELEE_SHOW:
        this.remotes.setMeleeHeld(ev.playerId, true);
        return;
      case WeaponActionType.MELEE_HIDE:
        this.remotes.setMeleeHeld(ev.playerId, false);
        return;
      case WeaponActionType.INSPECT_START:
        // Brick Maul: the local player can only inspect it while HOLDING it
        // (slot 2), which the MELEE_SHOW state already mirrors here. The
        // event's weapon is the server primary (unchanged by the melee
        // slot): a GoofyBasket primary NOT stowed inspects the ball.
        if (this.remotes.isMeleeHeld(ev.playerId)) {
          this.remotes.maulInspectStart(ev.playerId, this.remotes.elapsedSince(ev.ts));
        } else if (ev.weapon === NetworkWeaponId.GOOFY_BASKET) {
          this.remotes.basketInspectStart(ev.playerId, this.remotes.elapsedSince(ev.ts));
        }
        return;
      case WeaponActionType.INSPECT_CANCEL:
        this.remotes.maulInspectCancel(ev.playerId);
        this.remotes.basketInspectCancel(ev.playerId);
        return;
      case BASKET_ACTION_THROW:
        // Throw_Ln resumed at the server start (then Catch) — layer over the legs.
        this.remotes.basketThrow(ev.playerId, (ev.lv === 2 || ev.lv === 3 ? ev.lv : 1) as 1 | 2 | 3, this.remotes.elapsedSince(ev.ts));
        return;
      case BASKET_ACTION_LAUNCH:
        // Remote ball left the hand: release whoosh at the launch point,
        // scaled by the server-locked level (same feel as the local
        // basketThrow). Bounces are heard through the shared projectile
        // system's onBounce (the remote ball is simulated locally too).
        this.basketLaunchSound(ev);
        this.onBasketProjectile?.(ev);
        return;
      case BASKET_ACTION_BOUNCE:
      case BASKET_ACTION_REST:
      case BASKET_ACTION_END:
        this.onBasketProjectile?.(ev);
        return;
      case WeaponActionType.SPEAR_SWEEP:
        this.remotes.triggerMeleeSwing(ev.playerId, NetworkWeaponId.SPEAR, "sweep");
        this.playSwingSound(ev);
        return;
      case WeaponActionType.HAMMER_SLAM_START:
        // Slam_Start (0.20 s) → Slam_Dive loop until the confirmed impact.
        this.remotes.maulSlamStart(ev.playerId, this.remotes.elapsedSince(ev.ts));
        audio.playAt("hammer_slam_descent", { x: ev.ox, y: ev.oy, z: ev.oz }, {
          bus: "weapons",
          volume: 0.7,
        });
        return;
      case WeaponActionType.HAMMER_SLAM_IMPACT:
        this.hammerSlamImpact(ev);
        return;
      case WeaponActionType.SPEAR_RUSH_START:
        this.remotes.triggerMeleeSwing(ev.playerId, NetworkWeaponId.SPEAR, "sweep");
        audio.playAt("dash_energy", { x: ev.ox, y: ev.oy, z: ev.oz }, {
          bus: "movement",
          volume: 0.8,
        });
        return;
      case WeaponActionType.SPEAR_RUSH_STOP:
        return; // movement itself already reads as the feedback
      case WeaponActionType.MOLE_BURROW:
        this.moleBurrow(ev);
        return;
      case WeaponActionType.MOLE_EMERGE:
        this.moleEmerge(ev);
        return;
      case HEX_ACTION_TONGUE_HIT:
      case HEX_ACTION_TONGUE_MISS:
        this.hexTongueShot(ev, ev.action === HEX_ACTION_TONGUE_HIT);
        return;
      case HEX_ACTION_PULL_END:
        this.hexTongueRelease(ev.playerId, false);
        return;
      case HEX_ACTION_BITE:
        this.hexBite(ev);
        return;
      case WeaponActionType.POPCORN_FIRE:
      case WeaponActionType.POPCORN_RELOAD:
      case WeaponActionType.POPCORN_RELOAD_CANCEL:
        // Popcorn Shotgun: TP clips + weapon clip + shared visual popcorns
        // + positional SFX are owned by the Game (single projectile pool).
        this.onPopcornAction?.(ev);
        return;
      case WeaponActionType.PAINTBALL_FIRE:
      case WeaponActionType.PAINTBALL_RELOAD:
      case WeaponActionType.PAINTBALL_RELOAD_CANCEL:
        // Paintball Rifle: TP clips + weapon clip + shared visual balls /
        // paint + positional SFX are owned by the Game (single FX instance).
        this.onPaintballAction?.(ev);
        return;
      case WeaponActionType.WATER_FAMAS_FIRE:
      case WeaponActionType.WATER_FAMAS_RELOAD:
      case WeaponActionType.WATER_FAMAS_RELOAD_CANCEL:
        // Water FAMAS: TP clips + weapon clip + shared visible jets / wet marks
        // + positional SFX are owned by the Game (single WaterJets / WetMarks).
        this.onWaterFamasAction?.(ev);
        return;
      case WeaponActionType.FRISBEE_FIRE:
      case WeaponActionType.FRISBEE_RELOAD:
      case WeaponActionType.FRISBEE_RELOAD_CANCEL:
      case FRISBEE_ACTION_BOUNCE:
      case FRISBEE_ACTION_HIT:
      case FRISBEE_ACTION_END:
        // Frisbee Launcher: TP clips + weapon clip + the shared disc pool + positional SFX are
        // owned by the Game (single FrisbeeProjectiles / DroppedCages instance).
        this.onFrisbeeAction?.(ev);
        return;
      default:
        return; // unknown action — silently ignored
    }
  }

  /** A player died: no ghost beams / anchors / dirt trails from corpses. */
  onPlayerDied(playerId: string): void {
    // A dead shooter's tongue vanishes with the creature; a dead VICTIM
    // simply stops being followed (the server retracts the shooter's
    // tongue through HEX_PULL_END right after).
    if (this.tongues.has(playerId)) {
      this.tongues.delete(playerId);
      this.remotes.hexReset(playerId);
    }
    for (const t of this.tongues.values()) {
      if (t.victimId === playerId) t.victimId = null;
    }
    this.burrows.delete(playerId);
  }

  /** Drop every per-player VFX whose owner left the room. */
  prune(validIds: ReadonlySet<string>): void {
    for (const id of [...this.burrows.keys()]) {
      if (!validIds.has(id)) this.burrows.delete(id);
    }
    for (const id of [...this.tongues.keys()]) {
      if (!validIds.has(id)) this.tongues.delete(id); // avatar (and tether) already disposed
    }
  }

  // ------------------------------------------------------------------
  // Per-frame animation
  // ------------------------------------------------------------------

  update(dt: number): void {
    if (this.disposed) return;
    this.elapsed += dt;

    // ---- HEX SNIPER remote tongues (replay of the confirmed sequence) ----
    this.updateTongues(dt);

    // ---- Generic bursts (explosion flash / slam ring) ----
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.age += dt;
      const p = Math.min(b.age / b.life, 1);
      const eased = 1 - (1 - p) * (1 - p); // ease-out
      const s = b.fromScale + (b.toScale - b.fromScale) * eased;
      b.mesh.scale.setScalar(Math.max(s, 0.0001));
      b.mat.opacity = (1 - p) * 0.85;
      if (p >= 1) {
        this.scene.remove(b.mesh);
        b.mesh.geometry.dispose();
        b.mat.dispose();
        this.bursts.splice(i, 1);
      }
    }

    // ---- Mole strike: dirt trail follows every burrowed remote player ----
    for (const [id, burrow] of this.burrows) {
      if (this.elapsed >= burrow.expiresAt) {
        this.burrows.delete(id);
        continue;
      }
      if (!this.remotes.getBurrowPosition(id, this.vecScratch)) continue;
      // Ground surface ≈ the feet of the (hidden) capsule while burrowed.
      this.vecScratch.y -= PLAYER_FEET_OFFSET;
      burrow.trailAccum += mole.moleStrikeTrailParticleRate * dt;
      while (burrow.trailAccum >= 1) {
        burrow.trailAccum -= 1;
        this.moleTrailPuff(this.vecScratch);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const b of this.bursts) {
      this.scene.remove(b.mesh);
      b.mesh.geometry.dispose();
      b.mat.dispose();
    }
    this.bursts.length = 0;
    this.tongues.clear();
    this.burrows.clear();
  }

  // ------------------------------------------------------------------
  // Melee
  // ------------------------------------------------------------------

  /** GOOFY BASKET remote release: airy whoosh at the launch point, level-scaled. */
  private basketLaunchSound(ev: WeaponActionConfirmedEvent): void {
    const level = ev.lv === 2 || ev.lv === 3 ? ev.lv : 1;
    const at = { x: ev.ox, y: ev.oy, z: ev.oz };
    audio.playAt("jump", at, {
      bus: "weapons",
      volume: 0.35 + 0.12 * level,
      rate: 1.25 - 0.08 * level,
      rateVar: 0.05,
      refDistance: 7,
    });
    if (level >= 2) {
      audio.playAt("dash_whoosh", at, {
        bus: "weapons",
        volume: 0.18 * (level - 1),
        rate: 1.4,
        delay: 0.02,
        refDistance: 7,
      });
    }
  }

  private playSwingSound(ev: WeaponActionConfirmedEvent): void {
    const keys = ["hammer_swing_01", "hammer_swing_02", "hammer_swing_03"];
    audio.playAt(keys[Math.floor(Math.random() * keys.length)], { x: ev.ox, y: ev.oy, z: ev.oz }, {
      bus: "weapons",
      volume: 0.7,
      rateVar: 0.05,
    });
  }

  private hammerSlamImpact(ev: WeaponActionConfirmedEvent): void {
    // The confirm carries the validated impact point in ox/oy/oz. The TP
    // animation enters Slam_Land at the real impact (not just sound/VFX).
    this.remotes.maulSlamImpact(ev.playerId, this.remotes.elapsedSince(ev.ts));
    const at = { x: ev.ox, y: ev.oy, z: ev.oz };
    this.spawnGroundRing(at, W.hammer.slamRadius, 0.5, 0xd8b4fe);
    audio.playAt("hammer_slam_impact", at, { bus: "weapons", volume: 1 });
    audio.playAt("hammer_slam_sub", at, { bus: "weapons", volume: 0.85 });
  }

  // ------------------------------------------------------------------
  // HEX SNIPER — remote tongue (creature clips + world tether)
  // ------------------------------------------------------------------

  /**
   * HEX_TONGUE_HIT / MISS: the tongue leaves the remote creature's mouth
   * toward the confirmed end point (hx/hy/hz). A hit sticks to the victim
   * avatar on arrival (hold while the server reels it in); a miss snaps
   * back the moment the tip reaches the wall.
   */
  private hexTongueShot(ev: WeaponActionConfirmedEvent, grabbed: boolean): void {
    // Any previous tongue of this shooter is superseded (server = one at a time).
    if (!this.remotes.getMuzzleWorldPosition(ev.playerId, this.originScratch)) {
      this.originScratch.set(ev.ox, ev.oy, ev.oz);
    }
    const target = new THREE.Vector3(
      ev.hx ?? ev.ox + ev.dx * 50,
      ev.hy ?? ev.oy + ev.dy * 50,
      ev.hz ?? ev.oz + ev.dz * 50,
    );
    const tongue: RemoteTongue = {
      phase: "extending",
      target,
      tip: this.originScratch.clone(),
      victimId: grabbed && ev.tid ? ev.tid : null,
      victimOffset: new THREE.Vector3(),
      biteOnReturn: true, // every shot bites when the tongue is home
    };
    // Grab point relative to the victim's DISPLAYED center at confirm time
    // — the tip then follows the avatar with this offset while it is reeled.
    if (tongue.victimId) {
      let haveCenter = false;
      if (tongue.victimId === this.getLocalId() && this.localPosition) {
        this.localPosition(this.poseScratch.pos);
        haveCenter = true;
      } else if (this.remotes.getPose(tongue.victimId, this.poseScratch)) {
        haveCenter = true;
      }
      if (haveCenter) {
        tongue.victimOffset.subVectors(target, this.poseScratch.pos);
        // Clamp an implausible offset (lag-comp rewind vs displayed pose).
        if (tongue.victimOffset.lengthSq() > 1.5 * 1.5) tongue.victimOffset.set(0, 0.2, 0);
      }
    }
    this.tongues.set(ev.playerId, tongue);
    this.remotes.hexTongueBegin(ev.playerId, tongue.tip);
    // Whip crack + wet tongue smack (same samples as the local hexTongueShot).
    audio.playAt("hex_tongue_whip", this.originScratch, {
      bus: "weapons",
      volume: 0.7,
      rate: 1.15,
      rateVar: 0.05,
      refDistance: 8,
      maxDistance: 90,
    });
    audio.playAt("hex_tongue_out", this.originScratch, {
      bus: "weapons",
      volume: 0.45,
      rate: 1.3,
      rateVar: 0.06,
      refDistance: 8,
    });
  }

  /**
   * HEX_PULL_END / HEX_BITE: start the return. The bite-when-home flag is
   * only ever raised here (a tongue always bites once it is back; `bite`
   * is kept for call-site readability / future audio differentiation).
   */
  private hexTongueRelease(playerId: string, bite: boolean): void {
    const t = this.tongues.get(playerId);
    if (!t) return;
    t.biteOnReturn = t.biteOnReturn || bite;
    if (t.phase === "retracting") return;
    t.phase = "retracting";
    t.victimId = null;
  }

  /** HEX_BITE: the victim arrived — heavy arrival thud, big chomp + gulp, then the jaws. */
  private hexBite(ev: WeaponActionConfirmedEvent): void {
    const at = { x: ev.hx ?? ev.ox, y: ev.hy ?? ev.oy, z: ev.hz ?? ev.oz };
    audio.playAt("hammer_slam_impact", at, { bus: "impacts", volume: 0.7, rate: 1.05, rateVar: 0.03, refDistance: 8 });
    audio.playAt("hex_chomp", at, { bus: "impacts", volume: 0.9, rate: 1.1, rateVar: 0.04, delay: 0.04, refDistance: 8, maxDistance: 90 });
    audio.playAt("hex_gulp", at, { bus: "weapons", volume: 0.6, rateVar: 0.05, delay: 0.42, refDistance: 8 });
    const t = this.tongues.get(ev.playerId);
    if (t) {
      this.hexTongueRelease(ev.playerId, true);
    } else {
      // Tongue already home (events coalesced): bite right away.
      this.hexPlayBite(ev.playerId);
    }
  }

  private hexPlayBite(playerId: string): void {
    this.remotes.hexBite(playerId);
    if (this.remotes.getMuzzleWorldPosition(playerId, this.originScratch)) {
      // Jaws snapping — same crunchy bite samples as the local hexBite.
      const key = Math.random() < 0.5 ? "hex_bite_01" : "hex_bite_02";
      audio.playAt(key, this.originScratch, {
        bus: "weapons",
        volume: 0.75,
        volumeVar: 0.06,
        rate: 1,
        rateVar: 0.08,
        refDistance: 8,
      });
    }
  }

  /**
   * Per-frame tongue motion — same speeds as the local kit (projectile /
   * return) so a spectator sees the exact same snap. The mouth position
   * is read every frame (the shooter keeps moving while it holds).
   */
  private updateTongues(dt: number): void {
    for (const [id, t] of this.tongues) {
      const hasMouth = this.remotes.getMuzzleWorldPosition(id, this.originScratch);
      if (!hasMouth) {
        // Avatar hidden / dead / weapon swapped: drop the visual silently.
        this.tongues.delete(id);
        this.remotes.hexReset(id);
        continue;
      }

      if (t.phase === "extending") {
        const step = hexCfg.projectileSpeed * dt;
        this.vecScratch.subVectors(t.target, t.tip);
        const remaining = this.vecScratch.length();
        if (remaining <= step) {
          t.tip.copy(t.target);
          if (t.victimId) {
            t.phase = "holding";
            this.remotes.hexTonguePull(id);
            // Wet grab splat + energy latch (same layers as the local hexTongueGrab).
            audio.playAt("hex_tongue_grab", t.tip, { bus: "impacts", volume: 0.8, rateVar: 0.08, refDistance: 8 });
            audio.playAt("phase_warp", t.tip, { bus: "weapons", volume: 0.35, rate: 1.2 });
          } else {
            t.phase = "retracting";
          }
        } else {
          t.tip.addScaledVector(this.vecScratch, step / remaining);
        }
      } else if (t.phase === "holding") {
        if (t.victimId === this.getLocalId() && t.victimId !== null && this.localPosition) {
          // WE are the one being reeled in: the remote tongue follows our
          // own capsule (no remote avatar exists for the local player).
          this.localPosition(this.vecScratch);
          t.tip.copy(this.vecScratch).add(t.victimOffset);
        } else if (t.victimId && this.remotes.getPose(t.victimId, this.poseScratch)) {
          t.tip.copy(this.poseScratch.pos).add(t.victimOffset);
        } else {
          // Victim vanished (death / leave): the server releases shortly —
          // hold the last tip meanwhile.
          t.victimId = null;
        }
      } else {
        const step = hexCfg.returnSpeed * dt;
        this.vecScratch.subVectors(this.originScratch, t.tip);
        const remaining = this.vecScratch.length();
        if (remaining <= step) {
          this.tongues.delete(id);
          this.remotes.hexTongueEnd(id);
          if (t.biteOnReturn) this.hexPlayBite(id);
          continue;
        }
        t.tip.addScaledVector(this.vecScratch, step / remaining);
      }
      this.remotes.hexTongueSetEndpoint(id, t.tip);
    }
  }

  // ------------------------------------------------------------------
  // Mole strike (killstreak) — same visuals as the local MoleStrikeVFX
  // ------------------------------------------------------------------

  /** Dive-in: dirt burst at the feet, then the trail follows the player. */
  private moleBurrow(ev: WeaponActionConfirmedEvent): void {
    const feet = { x: ev.ox, y: ev.oy, z: ev.oz };
    this.burrows.set(ev.playerId, {
      trailAccum: 0,
      expiresAt: this.elapsed + W.mole.maxBurrowSeconds,
    });

    if (this.particles) {
      this.vecScratch.set(feet.x, feet.y, feet.z);
      this.particles.burst(this.vecScratch, 40, 6, 0.7, this.moleDirt, 12);
      this.particles.burst(this.vecScratch, 24, 3.5, 0.55, this.moleDirtDark, 10);
      this.particles.ring(this.vecScratch, this.upVec, 22, 0.7, 5, 0.5, this.moleDirt);
    }
    this.spawnGroundRing(feet, 2.2, 0.4, mole.moleStrikeDirtColor);

    audio.playAt("hammer_slam_descent", feet, { bus: "movement", volume: 0.7, rate: 0.8 });
  }

  /** Eruption: massive dirt blast + expanding ring at the emerge point. */
  private moleEmerge(ev: WeaponActionConfirmedEvent): void {
    this.burrows.delete(ev.playerId);
    const at = { x: ev.ox, y: ev.oy, z: ev.oz };

    if (this.particles) {
      this.vecScratch.set(at.x, at.y, at.z);
      this.particles.burst(this.vecScratch, 70, 11, 0.9, this.moleDirt, 14);
      this.particles.burst(this.vecScratch, 40, 7, 0.7, this.moleBlast, 10);
      this.particles.burst(this.vecScratch, 24, 14, 0.45, this.moleFlash, 6);
      this.particles.ring(this.vecScratch, this.upVec, 36, 1.2, 9, 0.6, this.moleDirt);
      this.particles.ring(this.vecScratch, this.upVec, 26, 0.8, 6, 0.5, this.moleBlast);
    }
    this.spawnGroundRing(at, mole.moleStrikeRadius, 0.55, mole.moleStrikeBlastColor);

    audio.playAt("hammer_slam_impact", at, { bus: "impacts", volume: 1, rateVar: 0.03 });
    audio.playAt("hammer_slam_sub", at, { bus: "impacts", volume: 0.85 });
  }

  /** One small dirt spurt at the ground surface (burrow trail). */
  private moleTrailPuff(surface: THREE.Vector3): void {
    if (!this.particles) return;
    const pos = this.particlePosScratch;
    const vel = this.particleVelScratch;
    vel.set(
      (Math.random() - 0.5) * 2.2,
      1.5 + Math.random() * 2.5,
      (Math.random() - 0.5) * 2.2,
    );
    pos.set(
      surface.x + (Math.random() - 0.5) * 0.6,
      surface.y + 0.05,
      surface.z + (Math.random() - 0.5) * 0.6,
    );
    const color = Math.random() < 0.65 ? this.moleDirt : this.moleDirtDark;
    this.particles.spawn(pos, vel, 0.4 + Math.random() * 0.3, color, 9, 0.5);
  }

  // ------------------------------------------------------------------
  // Generic short-lived VFX helpers
  // ------------------------------------------------------------------

  private spawnBurst(
    geometry: THREE.BufferGeometry,
    color: number,
    at: { x: number; y: number; z: number },
    fromScale: number,
    toScale: number,
    life: number,
  ): void {
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(at.x, at.y, at.z);
    mesh.scale.setScalar(fromScale);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.bursts.push({ mesh, mat, age: 0, life, fromScale, toScale });
  }

  /** Flat expanding shockwave-style ring (unit radius, scaled per frame). */
  private spawnGroundRing(
    at: { x: number; y: number; z: number },
    radius: number,
    life: number,
    color: number,
  ): void {
    const geo = new THREE.RingGeometry(0.82, 1, 48);
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(at.x, at.y + 0.06, at.z);
    mesh.scale.setScalar(0.2);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.bursts.push({ mesh, mat, age: 0, life, fromScale: 0.2, toScale: radius });
  }
}
