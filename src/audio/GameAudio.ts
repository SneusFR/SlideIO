import * as THREE from "three";
import { audio, LoopHandle } from "./AudioManager";
import { PlayerMovement, MoveState, MovementSfxListener } from "../player/PlayerMovement";
import { PlasmaRifle } from "../weapons/PlasmaRifle";
import { Health, Combatant } from "../combat/Combatant";
import { BotManager } from "../bots/BotManager";
import { Bot } from "../bots/Bot";
import { ComboConfig as comboCfg } from "../combo/ComboConfig";

const A = "/assets/audio";

/** Every SFX used by the game — loaded once at startup, cached forever. */
export const AUDIO_MANIFEST: Record<string, string> = {
  // Movement
  footsteps: `${A}/movement/footsteps_run_sheet_01.mp3`,
  jump: `${A}/movement/jump_whoosh_soft_01.mp3`,
  walljump: `${A}/movement/walljump_whoosh_01.mp3`,
  landing_soft_01: `${A}/movement/landing_soft_01.mp3`,
  landing_soft_02: `${A}/movement/landing_soft_02.mp3`,
  landing_heavy: `${A}/movement/landing_heavy_01.mp3`,
  slide_loop: `${A}/movement/slide_loop_01.mp3`,
  // Dash / phase
  dash_whoosh: `${A}/dash/dash_whoosh_01.mp3`,
  dash_energy: `${A}/dash/dash_energy_01.mp3`,
  phase_warp: `${A}/phase/phase_warp_01.mp3`,
  // Plasma
  plasma_start: `${A}/plasma/plasma_fire_start_01.mp3`,
  plasma_loop: `${A}/plasma/plasma_fire_loop_01.mp3`,
  plasma_stop: `${A}/plasma/plasma_fire_stop_01.mp3`,
  plasma_impact_loop: `${A}/plasma/plasma_impact_loop_01.mp3`,
  plasma_heat_loop: `${A}/plasma/plasma_heat_loop_01.mp3`,
  plasma_overheat: `${A}/plasma/plasma_overheat_01.mp3`,
  plasma_cooling_loop: `${A}/plasma/plasma_cooling_loop_01.mp3`,
  // Hit confirmation (local player damage feedback)
  hit_body: `${A}/hits/hit_body_01.mp3`,
  hit_head: `${A}/hits/hit_head_01.mp3`,
  // Revolver (arcade ballistic revolver — CC0, see ATTRIBUTION.md)
  revolver_shot: `${A}/revolver/revolver_shot_01.mp3`,
  // Hammer
  hammer_swing_01: `${A}/hammer/hammer_swing_01.mp3`,
  hammer_swing_02: `${A}/hammer/hammer_swing_02.mp3`,
  hammer_swing_03: `${A}/hammer/hammer_swing_03.mp3`,
  hammer_hit_01: `${A}/hammer/hammer_hit_01.mp3`,
  hammer_hit_02: `${A}/hammer/hammer_hit_02.mp3`,
  hammer_slam_impact: `${A}/hammer/hammer_slam_impact_01.mp3`,
  hammer_slam_sub: `${A}/hammer/hammer_slam_sub_01.mp3`,
  hammer_slam_descent: `${A}/hammer/hammer_slam_descent_01.mp3`,
  // Damage / death
  player_hit_01: `${A}/damage/player_hit_01.mp3`,
  player_hit_02: `${A}/damage/player_hit_02.mp3`,
  heartbeat: `${A}/damage/heartbeat_low_01.mp3`,
  player_death: `${A}/death/player_death_01.mp3`,
  respawn: `${A}/death/respawn_01.mp3`,
  // Bots
  bot_death: `${A}/bots/bot_death_01.mp3`,
  // Pickups
  health_pickup: `${A}/pickups/health_pickup_01.mp3`,
  coin_pickup: `${A}/pickups/coin_pickup_01.mp3`,
  // UI
  ready_ping: `${A}/ui/ready_ping_01.mp3`,
  // Medals / combo
  medal_unlock: `${A}/medals/medal_unlock_01.mp3`,
  // Ambience
  ambience_wind: `${A}/ambience/ambience_wind_loop_01.mp3`,
};

/** Number of individual steps inside the footsteps sample sheet. */
const FOOTSTEP_SLICES = 8;

export interface GameAudioFrame {
  camera: THREE.Camera;
  movement: PlayerMovement;
  rifle: PlasmaRifle;
  playerHealth: Health;
  botManager: BotManager;
  /** False while the Escape menu is open (game paused). */
  running: boolean;
}

/**
 * Glue between gameplay state and the AudioManager. Purely observational:
 * it reads existing state / consumes existing events and NEVER changes any
 * gameplay value.
 */
export class GameAudio {
  // ---- Player-local loop handles ----
  private slideLoop: LoopHandle | null = null;
  private wallSlideLoop: LoopHandle | null = null;
  private plasmaLoop: LoopHandle | null = null;
  private plasmaImpactLoop: LoopHandle | null = null;
  private heatLoop: LoopHandle | null = null;
  private coolingLoop: LoopHandle | null = null;
  private heartbeatLoop: LoopHandle | null = null;
  private ambienceLoop: LoopHandle | null = null;
  /** Subtle energetic hum while a kill combo is active. */
  private comboLoop: LoopHandle | null = null;
  /** Muffled rumble layer while burrowed with MOLE STRIKE. */
  private undergroundLoop: LoopHandle | null = null;
  // ---- OBLITERREUR vortex-beam spatial loops (layered existing SFX) ----
  private obliHumLoop: LoopHandle | null = null;
  private obliRumbleLoop: LoopHandle | null = null;
  private obliCrackleLoop: LoopHandle | null = null;

  // ---- Spatial loops for bot rifles (max N simultaneous) ----
  private readonly botFireLoops = new Map<Bot, LoopHandle>();
  private readonly botWasAlive = new Map<Bot, boolean>();
  private static readonly MAX_BOT_FIRE_LOOPS = 5;

  // ---- Edge-detection state ----
  private prevFiring = false;
  private prevOverheated = false;
  private prevDashReady = true;
  private stepTimer = 0;

  // Scratch
  private readonly tmp = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3();
  private readonly camFwd = new THREE.Vector3();
  private readonly camUp = new THREE.Vector3();

  /** Kick off (or resume) loading every SFX. Safe to call several times. */
  preload(): Promise<void> {
    return audio.preload(AUDIO_MANIFEST);
  }

  unlock(): void {
    audio.unlock();
  }

  // ------------------------------------------------------------------
  // Pickups (loot dropped by dead bots)
  // ------------------------------------------------------------------

  /** Medkit consumed → positive heal confirmation. */
  healthPickup(): void {
    audio.play("health_pickup", {
      bus: "ui",
      volume: 0.55,
      rate: 1,
      rateVar: 0.03,
      throttleMs: 120,
    });
  }

  // Coin pickup anti-cacophony: rapid consecutive coins raise the pitch
  // (arcade "streak" feel) instead of stacking identical dings, and a
  // short throttle stops 10 same-frame pickups from playing 10 sounds.
  private coinStreak = 0;
  private lastCoinTime = 0;

  coinPickup(): void {
    const now = performance.now();
    if (now - this.lastCoinTime < 900) {
      this.coinStreak = Math.min(this.coinStreak + 1, 8);
    } else {
      this.coinStreak = 0;
    }
    this.lastCoinTime = now;

    audio.play("coin_pickup", {
      bus: "ui",
      volume: 0.4,
      volumeVar: 0.04,
      rate: 1 + this.coinStreak * 0.06, // rising pitch on quick streaks
      rateVar: 0.02,
      throttleMs: 60, // several coins in one slide → a few dings, not ten
    });
  }

  // ------------------------------------------------------------------
  // Movement events (wired as PlayerMovement.sfx — fire-and-forget)
  // ------------------------------------------------------------------

  readonly movementSfx: MovementSfxListener = {
    jump: () => {
      // Soft airy whoosh — quieter and slightly slowed for a smooth feel.
      audio.play("jump", {
        bus: "movement",
        volume: 0.32,
        volumeVar: 0.05,
        rate: 0.95,
        rateVar: 0.05,
        throttleMs: 90,
      });
    },
    wallJump: () => {
      audio.play("walljump", {
        bus: "movement",
        volume: 0.5,
        rate: 1.05,
        rateVar: 0.07,
        throttleMs: 90,
      });
    },
    land: (fallSpeed: number) => {
      // Intensity scales with the vertical speed at impact.
      if (fallSpeed < 3) return;
      if (fallSpeed > 15) {
        const v = THREE.MathUtils.clamp(0.45 + (fallSpeed - 15) * 0.03, 0.45, 0.9);
        audio.play("landing_heavy", {
          bus: "movement",
          volume: v,
          rate: 1,
          rateVar: 0.05,
          throttleMs: 120,
        });
      } else {
        const v = THREE.MathUtils.clamp(0.2 + fallSpeed * 0.025, 0.2, 0.55);
        const key = Math.random() < 0.5 ? "landing_soft_01" : "landing_soft_02";
        audio.play(key, {
          bus: "movement",
          volume: v,
          rate: 1,
          rateVar: 0.08,
          throttleMs: 120,
        });
      }
    },
    slideStart: () => {
      // Small entry scuff; the friction loop itself is managed per-frame.
      audio.play("landing_soft_01", {
        bus: "movement",
        volume: 0.28,
        rate: 1.15,
        rateVar: 0.06,
        throttleMs: 150,
      });
    },
    slideEnd: () => {
      /* loop fade-out handled by the per-frame poll */
    },
    dash: () => {
      // Layered: fast sci-fi whoosh + short energy burst.
      audio.play("dash_whoosh", {
        bus: "movement",
        volume: 0.85,
        rate: 1,
        rateVar: 0.05,
        throttleMs: 120,
      });
      audio.play("dash_energy", {
        bus: "movement",
        volume: 0.45,
        rate: 1.1,
        rateVar: 0.05,
        throttleMs: 120,
      });
    },
  };

  // ------------------------------------------------------------------
  // Discrete gameplay events (called from Game wiring)
  // ------------------------------------------------------------------

  /** Phase dash traversal: enter WHUM + exit variation of the same warp. */
  phaseTraversal(): void {
    audio.play("phase_warp", {
      bus: "movement",
      volume: 0.8,
      rate: 1,
      rateVar: 0.04,
      throttleMs: 150,
    });
    audio.play("phase_warp", {
      bus: "movement",
      volume: 0.55,
      rate: 1.3,
      delay: 0.09,
      throttleMs: 0,
      maxInstances: 6,
    });
  }

  hammerSwing(): void {
    const keys = ["hammer_swing_01", "hammer_swing_02", "hammer_swing_03"];
    audio.play(keys[Math.floor(Math.random() * keys.length)], {
      bus: "impacts",
      volume: 0.7,
      volumeVar: 0.08,
      rate: 1,
      rateVar: 0.08,
      throttleMs: 100,
    });
  }

  /** Hammer connected with a combatant — much heavier than the swing. */
  hammerHit(pos: THREE.Vector3 | null): void {
    const key = Math.random() < 0.5 ? "hammer_hit_01" : "hammer_hit_02";
    if (pos) {
      audio.playAt(key, pos, {
        bus: "impacts",
        volume: 1,
        rate: 1,
        rateVar: 0.06,
        throttleMs: 90,
        refDistance: 8,
      });
    } else {
      audio.play(key, {
        bus: "impacts",
        volume: 1,
        rate: 1,
        rateVar: 0.06,
        throttleMs: 90,
      });
    }
  }

  /** Ground Slam descent: short wind rush while diving. */
  slamDescent(): void {
    audio.play("hammer_slam_descent", {
      bus: "movement",
      volume: 0.5,
      rate: 0.9,
      throttleMs: 200,
    });
  }

  /**
   * Ground Slam impact: massive layered boom. A single extra hit-confirm
   * layer when at least one combatant was caught — never 8 stacked booms.
   */
  slamImpact(hitCount: number): void {
    audio.play("hammer_slam_impact", {
      bus: "impacts",
      volume: 1,
      rate: 1,
      rateVar: 0.03,
    });
    audio.play("hammer_slam_sub", { bus: "impacts", volume: 0.9, rate: 1 });
    if (hitCount > 0) {
      audio.play("hammer_hit_01", {
        bus: "impacts",
        volume: 0.6,
        rate: 0.92,
        delay: 0.05,
      });
    }
  }

  /** Player took damage (continuous beams are throttled here). */
  playerDamaged(): void {
    const key = Math.random() < 0.5 ? "player_hit_01" : "player_hit_02";
    audio.play(key, {
      bus: "impacts",
      volume: 0.55,
      volumeVar: 0.06,
      rate: 1,
      rateVar: 0.08,
      throttleMs: 200,
    });
  }

  playerDeath(): void {
    this.stopCombatLoops();
    this.stopMovementLoops();
    audio.play("player_death", { bus: "impacts", volume: 0.9, rate: 1 });
  }

  playerRespawn(): void {
    audio.play("respawn", { bus: "ui", volume: 0.55, rate: 1 });
  }

  botKilled(bot: Bot): void {
    bot.getPosition(this.tmp);
    audio.playAt("bot_death", this.tmp, {
      bus: "impacts",
      volume: 0.55,
      rate: 1,
      rateVar: 0.08,
      throttleMs: 60,
      refDistance: 8,
    });
    const loop = this.botFireLoops.get(bot);
    if (loop) {
      loop.stop(0.05);
      this.botFireLoops.delete(bot);
    }
  }

  /** Short energetic body-hit confirmation tick (throttled by the feedback manager too). */
  hitBody(): void {
    audio.play("hit_body", {
      bus: "impacts",
      volume: 0.38,
      rate: 1,
      rateVar: 0.05,
      throttleMs: 70,
    });
  }

  /** Bright, clearly DISTINCT headshot ping — never just a louder body hit. */
  hitHead(): void {
    audio.play("hit_head", {
      bus: "impacts",
      volume: 0.5,
      rate: 1,
      rateVar: 0.03,
      throttleMs: 70,
    });
  }

  /** Rifle overheat burst (wired to PlasmaRifle.onOverheat). */
  overheat(): void {
    audio.play("plasma_overheat", { bus: "weapons", volume: 0.85, rate: 1 });
  }

  // ------------------------------------------------------------------
  // REVOLVER (ballistic gunshot sample + layered existing SFX)
  // ------------------------------------------------------------------

  /**
   * Revolver gunshot: soft-stylized arcade "BANG" (real ballistic sample,
   * never a laser). Fan-fire shots are slightly quieter with a small pitch
   * variance and capped polyphony so the fast BANG-BANG-BANG-BANG never
   * saturates the mix.
   */
  revolverShot(fanFire: boolean): void {
    audio.play("revolver_shot", {
      bus: "weapons",
      volume: fanFire ? 0.5 : 0.62,
      volumeVar: 0.04,
      rate: fanFire ? 1.06 : 1,
      rateVar: fanFire ? 0.06 : 0.03,
      throttleMs: fanFire ? 45 : 0,
      maxInstances: 4, // polyphony limiter for the fan fire
    });
  }

  /** Weapon leaves the hand: short throw whoosh. */
  revolverThrow(): void {
    audio.play("jump", { bus: "weapons", volume: 0.55, rate: 1.35, rateVar: 0.06 });
    audio.play("dash_whoosh", { bus: "weapons", volume: 0.3, rate: 1.5, delay: 0.02 });
  }

  /** Thrown revolver detonation: bass punch + short energy burst. */
  revolverExplosion(pos: THREE.Vector3): void {
    audio.playAt("hammer_slam_impact", pos, {
      bus: "impacts",
      volume: 0.95,
      rate: 1.1,
      rateVar: 0.04,
      throttleMs: 60,
      refDistance: 9,
    });
    audio.playAt("hammer_slam_sub", pos, {
      bus: "impacts",
      volume: 0.85,
      rate: 1,
      throttleMs: 60,
      refDistance: 9,
    });
    audio.playAt("dash_energy", pos, {
      bus: "impacts",
      volume: 0.5,
      rate: 0.75,
      delay: 0.03,
      throttleMs: 60,
      refDistance: 9,
    });
  }

  /** Fresh revolver holographically assembling in the hand. */
  revolverMaterialize(): void {
    audio.play("phase_warp", { bus: "weapons", volume: 0.4, rate: 1.7, throttleMs: 80 });
    audio.play("dash_energy", { bus: "weapons", volume: 0.4, rate: 1.4, delay: 0.05 });
    audio.play("ready_ping", { bus: "ui", volume: 0.3, rate: 1.5, delay: 0.3 });
  }

  // ------------------------------------------------------------------
  // Killstreaks (layered from existing SFX — no new assets)
  // ------------------------------------------------------------------

  /** A killstreak slot just became READY: bright unlock + energy ping. */
  killstreakReady(): void {
    audio.play("medal_unlock", { bus: "ui", volume: 0.6, rate: 1.5 });
    audio.play("ready_ping", { bus: "ui", volume: 0.5, rate: 1.6, delay: 0.12 });
  }

  /** MOLE STRIKE dive-in: heavy descent + dirt thud + energy layer. */
  moleEnter(): void {
    audio.play("hammer_slam_descent", { bus: "movement", volume: 0.7, rate: 0.8 });
    audio.play("landing_heavy", { bus: "impacts", volume: 0.8, rate: 0.65, delay: 0.12 });
    audio.play("dash_energy", { bus: "movement", volume: 0.5, rate: 0.7 });
  }

  /**
   * MOLE STRIKE emergence: massive eruption. One extra hit-confirm layer
   * when at least one combatant was caught — never N stacked booms.
   */
  moleEmerge(hitCount: number): void {
    audio.play("hammer_slam_impact", { bus: "impacts", volume: 1, rate: 1, rateVar: 0.03 });
    audio.play("hammer_slam_sub", { bus: "impacts", volume: 0.9, rate: 0.85 });
    audio.play("phase_warp", { bus: "movement", volume: 0.6, rate: 0.9 });
    if (hitCount > 0) {
      audio.play("hammer_hit_01", { bus: "impacts", volume: 0.6, rate: 0.92, delay: 0.05 });
    }
  }

  /**
   * Continuous muffled "digging" rumble while burrowed. Idempotent:
   * MoleStrike calls it every frame while underground (so the layer
   * survives a pause/resume) and once with false on emergence/abort.
   */
  setUndergroundLayer(active: boolean): void {
    if (active) {
      if (!this.undergroundLoop || this.undergroundLoop.stopped) {
        this.undergroundLoop = audio.loop("slide_loop", {
          bus: "movement",
          volume: 0.45,
          rate: 0.5,
          fadeIn: 0.15,
        });
      }
    } else {
      this.stopUndergroundLayer();
    }
  }

  private stopUndergroundLayer(): void {
    if (this.undergroundLoop && !this.undergroundLoop.stopped) {
      this.undergroundLoop.stop(0.2);
    }
    this.undergroundLoop = null;
  }

  // ------------------------------------------------------------------
  // OBLITERREUR (layered from existing SFX — no new assets)
  // ------------------------------------------------------------------

  /** Anchor point placed: sharp "dark energy snap". */
  obliterreurPlace(): void {
    audio.play("phase_warp", { bus: "weapons", volume: 0.5, rate: 1.45, throttleMs: 80 });
    audio.play("dash_energy", { bus: "weapons", volume: 0.5, rate: 0.55, delay: 0.04 });
  }

  /** Vortex beam fired: massive sub boom + warp + dark energy swell. */
  obliterreurActivate(): void {
    audio.play("hammer_slam_sub", { bus: "weapons", volume: 0.95, rate: 0.7 });
    audio.play("phase_warp", { bus: "weapons", volume: 0.7, rate: 0.8 });
    audio.play("dash_energy", { bus: "weapons", volume: 0.5, rate: 0.5, delay: 0.08 });
  }

  /** Vortex collapsed (natural expiry or RMB cancel — higher pitch). */
  obliterreurBeamEnd(cancelled: boolean): void {
    audio.play("phase_warp", {
      bus: "weapons",
      volume: 0.45,
      rate: cancelled ? 1.6 : 1.25,
    });
    audio.play("plasma_stop", { bus: "weapons", volume: 0.4, rate: 0.7 });
  }

  /**
   * Spatial black-hole drone while the vortex is open: deep hum + sub
   * rumble + energy crackle, all anchored to the closest beam point.
   * Idempotent per frame; stops with a short fade when the beam dies.
   */
  updateObliterreurBeam(active: boolean, pos: THREE.Vector3): void {
    if (!audio.unlocked) return;
    if (!active) {
      this.stopObliterreurLoops();
      return;
    }

    const spatial = {
      spatial: true,
      refDistance: 10,
      maxDistance: 90,
    } as const;

    if (!this.obliHumLoop || this.obliHumLoop.stopped) {
      this.obliHumLoop = audio.loop("plasma_heat_loop", {
        bus: "weapons",
        volume: 0.85,
        rate: 0.5, // deep black-hole hum
        fadeIn: 0.12,
        ...spatial,
      });
    }
    if (!this.obliRumbleLoop || this.obliRumbleLoop.stopped) {
      this.obliRumbleLoop = audio.loop("slide_loop", {
        bus: "weapons",
        volume: 0.5,
        rate: 0.35, // sub rumble
        fadeIn: 0.15,
        ...spatial,
      });
    }
    if (!this.obliCrackleLoop || this.obliCrackleLoop.stopped) {
      this.obliCrackleLoop = audio.loop("plasma_cooling_loop", {
        bus: "weapons",
        volume: 0.35,
        rate: 0.6, // unstable energy crackle
        fadeIn: 0.12,
        ...spatial,
      });
    }

    this.obliHumLoop?.setPosition(pos.x, pos.y, pos.z);
    this.obliRumbleLoop?.setPosition(pos.x, pos.y, pos.z);
    this.obliCrackleLoop?.setPosition(pos.x, pos.y, pos.z);
  }

  private stopObliterreurLoops(): void {
    this.obliHumLoop?.stop(0.2);
    this.obliHumLoop = null;
    this.obliRumbleLoop?.stop(0.2);
    this.obliRumbleLoop = null;
    this.obliCrackleLoop?.stop(0.2);
    this.obliCrackleLoop = null;
  }

  // ------------------------------------------------------------------
  // Medals / combo
  // ------------------------------------------------------------------

  /**
   * Medal sting, synced with the visual pop. The MedalManager passes a
   * rising pitch per medal of the SAME combo chain (DING → DING↑ → DING↑↑),
   * already capped at a reasonable maximum.
   */
  medalPop(pitch: number): void {
    audio.play("medal_unlock", {
      bus: "ui",
      volume: 0.6,
      rate: pitch,
      throttleMs: 40, // queue spacing already separates medals
      maxInstances: 3,
    });
  }

  /**
   * Very discreet combo-active layer (reuses the cached energy hum loop).
   * Intensity/pitch rise slightly per combo level; ends with a short
   * fade-out (never a hard cutoff) on timeout or death.
   */
  setComboLayer(active: boolean, level: number): void {
    if (active) {
      if (!this.comboLoop || this.comboLoop.stopped) {
        this.comboLoop = audio.loop("plasma_heat_loop", {
          bus: "ui",
          volume: 0.001,
          rate: comboCfg.comboHumBaseRate,
          fadeIn: 0.15,
        });
      }
      const lvl = Math.max(0, level - 1);
      const vol = Math.min(
        comboCfg.comboHumBaseVolume + lvl * comboCfg.comboHumVolumePerLevel,
        comboCfg.comboHumMaxVolume,
      );
      const rate = Math.min(
        comboCfg.comboHumBaseRate + lvl * comboCfg.comboHumRatePerLevel,
        comboCfg.comboHumMaxRate,
      );
      this.comboLoop?.setVolume(vol);
      this.comboLoop?.setRate(rate);
    } else {
      this.stopComboLayer();
    }
  }

  private stopComboLayer(): void {
    if (this.comboLoop && !this.comboLoop.stopped) {
      this.comboLoop.stop(comboCfg.comboAudioFadeOut);
    }
    this.comboLoop = null;
  }

  // ------------------------------------------------------------------
  // Per-frame polling (loops, cadence, edges)
  // ------------------------------------------------------------------

  update(dt: number, f: GameAudioFrame): void {
    if (!audio.unlocked) return;

    this.updateListener(f.camera);
    this.updateAmbience();

    if (f.running) {
      const alive = f.playerHealth.alive;
      this.updateFootsteps(dt, f.movement, alive);
      this.updateSlideLoops(f.movement, alive);
      this.updatePlasma(f.rifle, alive);
      this.updateDashReady(f.movement, alive);
      this.updateHeartbeat(f.playerHealth);
      this.updateBots(f.botManager);
    } else {
      // Escape menu: fade every transient loop (ambience keeps playing).
      this.stopCombatLoops();
      this.stopMovementLoops();
      this.stopBotLoops();
      this.stopComboLayer();
      this.stopUndergroundLayer();
      this.stopObliterreurLoops();
    }
  }

  private updateListener(camera: THREE.Camera): void {
    camera.getWorldPosition(this.camPos);
    camera.getWorldDirection(this.camFwd);
    this.camUp.set(0, 1, 0);
    audio.setListener(
      this.camPos.x,
      this.camPos.y,
      this.camPos.z,
      this.camFwd.x,
      this.camFwd.y,
      this.camFwd.z,
      this.camUp.x,
      this.camUp.y,
      this.camUp.z,
    );
  }

  private updateAmbience(): void {
    if (!this.ambienceLoop || this.ambienceLoop.stopped) {
      this.ambienceLoop = audio.loop("ambience_wind", {
        bus: "ambience",
        volume: 0.35,
        rate: 1,
        fadeIn: 2,
      });
    }
  }

  private updateFootsteps(dt: number, movement: PlayerMovement, alive: boolean): void {
    const running =
      alive &&
      movement.state === MoveState.GROUNDED &&
      movement.grounded &&
      movement.horizontalSpeed > 4;

    if (!running) {
      this.stepTimer = 0.06; // tiny delay so the first step lands naturally
      return;
    }

    this.stepTimer -= dt;
    if (this.stepTimer > 0) return;

    // Cadence follows speed but is clamped — slide hopping at mach 3 never
    // becomes a footstep machine gun.
    const speed = movement.horizontalSpeed;
    this.stepTimer = THREE.MathUtils.clamp(3.1 / speed, 0.27, 0.5);

    const sheetDur = audio.duration("footsteps");
    if (sheetDur <= 0) return;
    const sliceDur = sheetDur / FOOTSTEP_SLICES;
    const idx = Math.floor(Math.random() * FOOTSTEP_SLICES);
    audio.play("footsteps", {
      bus: "movement",
      volume: 0.34,
      volumeVar: 0.07,
      rate: 1,
      rateVar: 0.07,
      offset: idx * sliceDur,
      duration: Math.min(0.3, sliceDur),
      maxInstances: 3,
    });
  }

  private updateSlideLoops(movement: PlayerMovement, alive: boolean): void {
    // Floor slide friction loop.
    const sliding = alive && movement.state === MoveState.SLIDING;
    if (sliding) {
      if (!this.slideLoop || this.slideLoop.stopped) {
        this.slideLoop = audio.loop("slide_loop", {
          bus: "movement",
          volume: 0.42,
          rate: 0.95,
          fadeIn: 0.06,
        });
      }
      // Pitch follows speed a little (more speed → more friction energy).
      this.slideLoop?.setRate(0.9 + Math.min(movement.horizontalSpeed, 30) * 0.008);
    } else if (this.slideLoop && !this.slideLoop.stopped) {
      this.slideLoop.stop(0.15);
      this.slideLoop = null;
    }

    // Wall slide: same material family, higher pitch, quieter — clearly
    // distinct from the floor slide.
    const wallSliding = alive && movement.state === MoveState.WALL_SLIDING;
    if (wallSliding) {
      if (!this.wallSlideLoop || this.wallSlideLoop.stopped) {
        this.wallSlideLoop = audio.loop("slide_loop", {
          bus: "movement",
          volume: 0.22,
          rate: 1.4,
          fadeIn: 0.05,
        });
      }
    } else if (this.wallSlideLoop && !this.wallSlideLoop.stopped) {
      this.wallSlideLoop.stop(0.12);
      this.wallSlideLoop = null;
    }
  }

  private updatePlasma(rifle: PlasmaRifle, alive: boolean): void {
    const firing = alive && rifle.isFiring;

    // Fire start / loop / stop — short fades, no clicks.
    if (firing && !this.prevFiring) {
      audio.play("plasma_start", { bus: "weapons", volume: 0.5, rate: 1, rateVar: 0.04 });
      this.plasmaLoop = audio.loop("plasma_loop", {
        bus: "weapons",
        volume: 0.5,
        rate: 1,
        fadeIn: 0.04,
      });
    } else if (!firing && this.prevFiring) {
      this.plasmaLoop?.stop(0.07);
      this.plasmaLoop = null;
      audio.play("plasma_stop", { bus: "weapons", volume: 0.35, rate: 1, rateVar: 0.04 });
    }
    this.prevFiring = firing;

    // Beam impact: a subtle continuous crackle while the beam burns
    // something; slightly hotter when it's an actual combatant (§21).
    const impacting = firing && rifle.beamHit;
    if (impacting) {
      if (!this.plasmaImpactLoop || this.plasmaImpactLoop.stopped) {
        this.plasmaImpactLoop = audio.loop("plasma_impact_loop", {
          bus: "weapons",
          volume: 0.001,
          rate: 1,
          fadeIn: 0.05,
        });
      }
      const onTarget = rifle.hittingTarget;
      this.plasmaImpactLoop?.setVolume(onTarget ? 0.34 : 0.2);
      this.plasmaImpactLoop?.setRate(onTarget ? 1.22 : 1.0);
    } else if (this.plasmaImpactLoop && !this.plasmaImpactLoop.stopped) {
      this.plasmaImpactLoop.stop(0.08);
      this.plasmaImpactLoop = null;
    }

    // Rising tension as heat builds (audible from ~60%, obvious at 90%).
    const ratio = rifle.heat.ratio;
    const heatAudible = ratio > 0.55 && !rifle.heat.overheated;
    if (heatAudible) {
      if (!this.heatLoop || this.heatLoop.stopped) {
        this.heatLoop = audio.loop("plasma_heat_loop", {
          bus: "weapons",
          volume: 0.001,
          rate: 1,
          fadeIn: 0.1,
        });
      }
      const k = (ratio - 0.55) / 0.45;
      this.heatLoop?.setVolume(k * k * 0.5);
      this.heatLoop?.setRate(0.9 + ratio * 0.5);
    } else if (this.heatLoop && !this.heatLoop.stopped) {
      this.heatLoop.stop(0.2);
      this.heatLoop = null;
    }

    // Forced cooldown vent hiss + "weapon ready" ping when it re-arms.
    const overheated = rifle.heat.overheated;
    if (overheated) {
      if (!this.coolingLoop || this.coolingLoop.stopped) {
        this.coolingLoop = audio.loop("plasma_cooling_loop", {
          bus: "weapons",
          volume: 0.3,
          rate: 1,
          fadeIn: 0.15,
        });
      }
    } else if (this.coolingLoop && !this.coolingLoop.stopped) {
      this.coolingLoop.stop(0.25);
      this.coolingLoop = null;
    }
    if (this.prevOverheated && !overheated) {
      audio.play("ready_ping", { bus: "ui", volume: 0.4, rate: 0.85 });
    }
    this.prevOverheated = overheated;
  }

  private updateDashReady(movement: PlayerMovement, alive: boolean): void {
    const ready = movement.dashReady;
    if (alive && ready && !this.prevDashReady) {
      // Very subtle energy ping — "dash available again".
      audio.play("ready_ping", { bus: "ui", volume: 0.32, rate: 1.25 });
    }
    this.prevDashReady = ready;
  }

  private updateHeartbeat(health: Health): void {
    const low = health.alive && health.ratio <= 0.25;
    if (low) {
      if (!this.heartbeatLoop || this.heartbeatLoop.stopped) {
        this.heartbeatLoop = audio.loop("heartbeat", {
          bus: "ui",
          volume: 0.4,
          rate: 1,
          fadeIn: 0.4,
        });
      }
    } else if (this.heartbeatLoop && !this.heartbeatLoop.stopped) {
      this.heartbeatLoop.stop(0.5);
      this.heartbeatLoop = null;
    }
  }

  /**
   * Bot rifles: spatialized fire loops that follow each bot, capped so a
   * full 8-bot brawl never saturates the mix. Bot respawns get a quiet
   * spatial cue when nearby.
   */
  private updateBots(botManager: BotManager): void {
    // Clean up loops for bots that were removed from the roster.
    for (const [bot, loop] of this.botFireLoops) {
      if (!botManager.bots.includes(bot)) {
        loop.stop(0.05);
        this.botFireLoops.delete(bot);
      }
    }

    for (const bot of botManager.bots) {
      // Respawn detection (alive edge).
      const wasAlive = this.botWasAlive.get(bot) ?? true;
      if (!wasAlive && bot.health.alive) {
        bot.getPosition(this.tmp);
        audio.playAt("respawn", this.tmp, {
          bus: "impacts",
          volume: 0.35,
          rate: 1.1,
          throttleMs: 80,
          refDistance: 5,
          maxDistance: 40,
        });
      }
      this.botWasAlive.set(bot, bot.health.alive);

      // Spatial fire loop management.
      const firing = bot.health.alive && bot.isFiring;
      const existing = this.botFireLoops.get(bot);

      if (firing) {
        if (!existing || existing.stopped) {
          if (this.botFireLoops.size >= GameAudio.MAX_BOT_FIRE_LOOPS) continue;
          const loop = audio.loop("plasma_loop", {
            bus: "weapons",
            volume: 0.45,
            rate: 0.94, // slightly lower than the player's — distinguishable
            fadeIn: 0.05,
            spatial: true,
            refDistance: 7,
            maxDistance: 90,
          });
          if (loop) {
            bot.getPosition(this.tmp);
            loop.setPosition(this.tmp.x, this.tmp.y, this.tmp.z);
            this.botFireLoops.set(bot, loop);
          }
        } else {
          bot.getPosition(this.tmp);
          existing.setPosition(this.tmp.x, this.tmp.y, this.tmp.z);
        }
      } else if (existing) {
        existing.stop(0.07);
        this.botFireLoops.delete(bot);
      }
    }
  }

  // ------------------------------------------------------------------
  // Loop teardown helpers
  // ------------------------------------------------------------------

  private stopCombatLoops(): void {
    this.plasmaLoop?.stop(0.06);
    this.plasmaLoop = null;
    this.plasmaImpactLoop?.stop(0.06);
    this.plasmaImpactLoop = null;
    this.heatLoop?.stop(0.1);
    this.heatLoop = null;
    this.prevFiring = false;
  }

  private stopMovementLoops(): void {
    this.slideLoop?.stop(0.1);
    this.slideLoop = null;
    this.wallSlideLoop?.stop(0.1);
    this.wallSlideLoop = null;
  }

  private stopBotLoops(): void {
    for (const [, loop] of this.botFireLoops) loop.stop(0.08);
    this.botFireLoops.clear();
  }
}

// Re-export for convenient wiring in Game.
export type { Combatant };