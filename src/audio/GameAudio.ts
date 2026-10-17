import * as THREE from "three";
import { audio, LoopHandle } from "./AudioManager";
import { PlayerMovement, MoveState, MovementSfxListener } from "../player/PlayerMovement";

import { Health, Combatant } from "../combat/Combatant";
import { BotManager } from "../bots/BotManager";
import { Bot } from "../bots/Bot";
import { ComboConfig as comboCfg } from "../combo/ComboConfig";
import { FrisbeeLauncherConfig } from "../../shared/combat/FrisbeeLauncherRules";

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
  // Energy hum (kill-combo layer)
  plasma_heat_loop: `${A}/plasma/plasma_heat_loop_01.mp3`,
  // Hit confirmation (local player damage feedback)
  hit_body: `${A}/hits/hit_body_03.mp3`,
  hit_head: `${A}/hits/hit_head_02.mp3`,

  // Goofy Basket (real basketball bounces — CC0, see ATTRIBUTION.md)
  basket_bounce_01: `${A}/basket/basket_bounce_01.mp3`,
  basket_bounce_02: `${A}/basket/basket_bounce_02.mp3`,
  basket_bounce_03: `${A}/basket/basket_bounce_03.mp3`,
  // Popcorn Shotgun (shot / pump / pop / dry click — CC0, see ATTRIBUTION.md)
  popcorn_shot: `${A}/popcorn/popcorn_shot_01.mp3`,
  popcorn_pump_back: `${A}/popcorn/popcorn_pump_back_01.mp3`,
  popcorn_pump_forward: `${A}/popcorn/popcorn_pump_forward_01.mp3`,
  popcorn_pop: `${A}/popcorn/popcorn_pop_01.mp3`,
  popcorn_dry_fire: `${A}/popcorn/popcorn_dry_fire_01.mp3`,
  popcorn_lid_click: `${A}/ui/ui_click_plop_01.mp3`,
  // Paintball Rifle (compressed-air shot / charging handle — CC0, see ATTRIBUTION.md;
  // dry click + hopper clicks reuse popcorn_dry_fire / ui_click_plop)
  paintball_shot: `${A}/paintball/paintball_shot_01.mp3`,
  paintball_charge: `${A}/paintball/paintball_charge_01.mp3`,
  // Paintball Rifle paint SFX (gooey blorp + liquid gush + squish shot, wet splat hits — CC0,
  // see ATTRIBUTION.md; the compressed-air paintball_shot above is still used by the Water Famas)
  paintball_blorp: `${A}/paintball/paintball_blorp_01.mp3`,
  paintball_gush: `${A}/paintball/paintball_gush_01.mp3`,
  paintball_gooey: `${A}/paintball/paintball_gooey_01.mp3`,
  paintball_splat_01: `${A}/paintball/paintball_splat_01.mp3`,
  paintball_splat_02: `${A}/paintball/paintball_splat_02.mp3`,
  // Frisbee Launcher (elastic twang / disc whirl / plastic latch / band snap — CC0, see ATTRIBUTION.md;
  // dry click + bounces reuse popcorn_dry_fire / basket_bounce)
  frisbee_twang: `${A}/frisbee/frisbee_twang_01.mp3`,
  frisbee_whirl: `${A}/frisbee/frisbee_whirl_01.mp3`,
  frisbee_latch: `${A}/frisbee/frisbee_latch_01.mp3`,
  frisbee_band: `${A}/frisbee/frisbee_band_01.mp3`,
  // Hex Sniper (tongue whip / wet grab / jaws / eating — CC0, see ATTRIBUTION.md)
  hex_tongue_whip: `${A}/hexsniper/hex_tongue_whip_01.mp3`,
  hex_tongue_out: `${A}/hexsniper/hex_tongue_out_01.mp3`,
  hex_tongue_grab: `${A}/hexsniper/hex_tongue_grab_01.mp3`,
  hex_bite_01: `${A}/hexsniper/hex_bite_01.mp3`,
  hex_bite_02: `${A}/hexsniper/hex_bite_02.mp3`,
  hex_chomp: `${A}/hexsniper/hex_chomp_01.mp3`,
  hex_gulp: `${A}/hexsniper/hex_gulp_01.mp3`,
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
  // Kill confirmation (local player scored a kill — the dopamine hit)
  kill_confirm: `${A}/kills/kill_confirm_01.mp3`,
  // Pickups
  health_pickup: `${A}/pickups/health_pickup_01.mp3`,
  coin_pickup: `${A}/pickups/coin_pickup_01.mp3`,
  // UI
  ready_ping: `${A}/ui/ready_ping_01.mp3`,
  // Medals / combo
  medal_unlock: `${A}/medals/medal_unlock_01.mp3`,
  // Ambience
  ambience_village: `${A}/ambience/ambience_village_loop_01.mp3`,
  ambience_musicbox: `${A}/ambience/ambience_musicbox_01.mp3`,
};

/** Number of individual steps inside the footsteps sample sheet. */
const FOOTSTEP_SLICES = 8;

// ---- Hit confirmation mix (tweak here) ----
/** Body hitmarker gain on the "impacts" bus — loud by default. */
const HIT_BODY_VOLUME = 1.0;
/**
 * hit_body_03 (Freesound 322640) starts with ~0.1 s of silence — skip it so
 * the tick lands ON the hit instead of a beat late. Kept slightly under 0.1 s
 * so the decoder's own start padding never clips the transient.
 */
const HIT_BODY_START_OFFSET = 0.08;
/** Headshot ding gain on the "impacts" bus. */
const HIT_HEAD_VOLUME = 0.9;
/**
 * Simultaneous hitmarker voices per key. The Paintball confirms every ball
 * (one per 0.1 s) and the headshot ding lasts ~0.63 s → up to ~7 overlap;
 * the default cap (5) would silently drop the end of a burst.
 */
const HIT_SOUND_MAX_INSTANCES = 8;

// ---- Winter village ambience (tweak here) ----
/** Village bed loop volume (on the "ambience" bus). */
const VILLAGE_LOOP_VOLUME = 0.5;
/** Distant Christmas music box: base volume (very soft). */
const MUSICBOX_VOLUME = 0.14;
/** Low-pass cutoff (Hz) — lower = more muffled / farther away. */
const MUSICBOX_LOWPASS_HZ = 1600;
/** Soft fade-in / fade-out of each melody (seconds). */
const MUSICBOX_FADE = 2.5;
/** Delay before the first melody after the game starts (seconds). */
const MUSICBOX_FIRST_DELAY: [number, number] = [15, 30];
/** Random silence between two melodies, counted after one ends (seconds). */
const MUSICBOX_GAP: [number, number] = [45, 100];

function randRange([min, max]: [number, number]): number {
  return min + Math.random() * (max - min);
}

export interface GameAudioFrame {
  camera: THREE.Camera;
  movement: PlayerMovement;
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
  private heartbeatLoop: LoopHandle | null = null;
  private ambienceLoop: LoopHandle | null = null;
  /** Seconds until the next distant music-box melody. */
  private musicBoxTimer = randRange(MUSICBOX_FIRST_DELAY);
  /** Subtle energetic hum while a kill combo is active. */
  private comboLoop: LoopHandle | null = null;
  /** Muffled rumble layer while burrowed with MOLE STRIKE. */
  private undergroundLoop: LoopHandle | null = null;
  // ---- Bot respawn edge detection ----
  private readonly botWasAlive = new Map<Bot, boolean>();

  // ---- Edge-detection state ----
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
  }

  /**
   * Body-hit confirmation: classic punchy hitmarker tick, played LOUD by
   * default so every landed shot is unmistakable. The sample's leading
   * silence is skipped (HIT_BODY_START_OFFSET) so it fires exactly on the
   * hit. Small pitch wobble so a plasma stream stays lively.
   */
  hitBody(): void {
    audio.play("hit_body", {
      bus: "impacts",
      volume: HIT_BODY_VOLUME,
      rate: 1,
      rateVar: 0.05,
      offset: HIT_BODY_START_OFFSET,
      throttleMs: 70,
      maxInstances: HIT_SOUND_MAX_INSTANCES,
    });
  }

  /** Bright, clearly DISTINCT headshot ding — never just a louder body hit. */
  hitHead(): void {
    audio.play("hit_head", {
      bus: "impacts",
      volume: HIT_HEAD_VOLUME,
      rate: 1,
      rateVar: 0.03,
      throttleMs: 70,
      maxInstances: HIT_SOUND_MAX_INSTANCES,
    });
  }

  /**
   * LOCAL PLAYER scored a kill: bright rising "level-up" chime — the
   * dopamine payoff that makes you want to chain the next one. Slight
   * pitch-up variation keeps back-to-back kills feeling escalating,
   * and it sits ABOVE the hit sounds in the mix (this is the reward).
   */
  killConfirm(): void {
    audio.play("kill_confirm", {
      bus: "ui",
      volume: 0.85,
      rate: 1.15,
      rateVar: 0.06,
      throttleMs: 90,
    });
  }


  // ------------------------------------------------------------------
  // HEX SNIPER (dedicated samples: tongue whip / wet grab / jaws / gulp)
  // ------------------------------------------------------------------

  /**
   * Tongue shot: a sharp whip crack (the tongue leaves the mouth at sniper
   * speed) layered with a short wet "tongue out" smack so it reads as a
   * creature, never as a gun.
   */
  hexTongueShot(): void {
    audio.play("hex_tongue_whip", {
      bus: "weapons",
      volume: 0.7,
      volumeVar: 0.05,
      rate: 1.15,
      rateVar: 0.05,
      throttleMs: 80,
    });
    audio.play("hex_tongue_out", {
      bus: "weapons",
      volume: 0.45,
      rate: 1.3,
      rateVar: 0.06,
      throttleMs: 80,
    });
  }

  /** Tongue tagged a player: wet splat + the existing energy latch. */
  hexTongueGrab(): void {
    audio.play("hex_tongue_grab", {
      bus: "impacts",
      volume: 0.8,
      volumeVar: 0.05,
      rate: 1,
      rateVar: 0.08,
      throttleMs: 80,
    });
    audio.play("phase_warp", {
      bus: "weapons",
      volume: 0.35,
      rate: 1.2,
      throttleMs: 80,
    });
  }

  /**
   * Reeled-in victim ARRIVED at the creature's mouth: heavy thud then the
   * big open-mouth chomp — this is the "it eats you" moment.
   */
  hexPlayerArrived(): void {
    audio.play("hammer_slam_impact", {
      bus: "impacts",
      volume: 0.7,
      rate: 1.05,
      rateVar: 0.03,
      throttleMs: 100,
    });
    audio.play("hex_chomp", {
      bus: "impacts",
      volume: 0.9,
      rate: 1.1,
      rateVar: 0.04,
      delay: 0.04,
      throttleMs: 100,
    });
    audio.play("hex_gulp", {
      bus: "weapons",
      volume: 0.6,
      rate: 1,
      rateVar: 0.05,
      delay: 0.42,
      throttleMs: 100,
    });
  }

  /** Jaws snapping (every tongue return bites): quick crunchy bite. */
  hexBite(): void {
    const key = Math.random() < 0.5 ? "hex_bite_01" : "hex_bite_02";
    audio.play(key, {
      bus: "weapons",
      volume: 0.75,
      volumeVar: 0.06,
      rate: 1,
      rateVar: 0.08,
      throttleMs: 90,
    });
  }

  // ------------------------------------------------------------------
  // GOOFY BASKET (real basketball bounce samples)
  // ------------------------------------------------------------------

  /**
   * Ball left the hand: airy release whoosh — louder and slightly lower
   * for a stronger charge level (1 → 3).
   */
  basketThrow(level: 1 | 2 | 3): void {
    audio.play("jump", {
      bus: "weapons",
      volume: 0.35 + 0.12 * level,
      rate: 1.25 - 0.08 * level,
      rateVar: 0.05,
      throttleMs: 80,
    });
    if (level >= 2) {
      audio.play("dash_whoosh", {
        bus: "weapons",
        volume: 0.18 * (level - 1),
        rate: 1.4,
        delay: 0.02,
        throttleMs: 80,
      });
    }
  }

  /**
   * Basketball bounce on the world, spatialized at the contact. Three
   * rotating samples + small pitch wobble so a dribbling sequence never
   * sounds machine-gunned; polyphony-capped for multiple balls in flight.
   */
  basketBounce(pos: THREE.Vector3): void {
    const keys = ["basket_bounce_01", "basket_bounce_02", "basket_bounce_03"];
    audio.playAt(keys[Math.floor(Math.random() * keys.length)], pos, {
      bus: "impacts",
      volume: 0.8,
      volumeVar: 0.08,
      rate: 1,
      rateVar: 0.07,
      throttleMs: 40,
      maxInstances: 6,
      refDistance: 6,
      maxDistance: 70,
    });
  }

  // ------------------------------------------------------------------
  // POPCORN SHOTGUN (CC0 shot / pump / pop samples + existing clicks)
  // ------------------------------------------------------------------

  /** Low "pop" detonation: shotgun sample pitched down + a popcorn pop on top. */
  popcornShot(): void {
    audio.play("popcorn_shot", { bus: "weapons", volume: 0.7, volumeVar: 0.04, rate: 0.82, rateVar: 0.03, maxInstances: 3 });
    audio.play("popcorn_pop", { bus: "weapons", volume: 0.55, rate: 0.6, rateVar: 0.05, delay: 0.01 });
  }

  /** Empty tank: dry trigger click. */
  popcornDryFire(): void {
    audio.play("popcorn_dry_fire", { bus: "weapons", volume: 0.6, rateVar: 0.04, throttleMs: 120 });
  }

  /** Pump "clac" (back) / "clac" (forward). */
  popcornPump(forward: boolean): void {
    audio.play(forward ? "popcorn_pump_forward" : "popcorn_pump_back", {
      bus: "weapons",
      volume: 0.65,
      rateVar: 0.04,
      throttleMs: 60,
    });
  }

  /** Plastic lid click (open / close). */
  popcornLid(open: boolean): void {
    audio.play("popcorn_lid_click", { bus: "weapons", volume: 0.45, rate: open ? 1.25 : 0.95, rateVar: 0.04, throttleMs: 80 });
  }

  /** Kernels sprinkled into the tank: a short rattle of tiny clicks. */
  popcornKernels(): void {
    for (let i = 0; i < 6; i++) {
      audio.play("popcorn_dry_fire", {
        bus: "weapons",
        volume: 0.12,
        rate: 2.4,
        rateVar: 0.35,
        delay: i * 0.03 + Math.random() * 0.02,
        maxInstances: 6,
      });
    }
  }

  /**
   * One kernel popped (up to 72 per reload, crescendo). Voices limited:
   * ≈ 30 / s max (throttle 33 ms) and 6 simultaneous instances; pitch
   * wobble so the crescendo never sounds machine-gunned.
   */
  popcornPop(): void {
    audio.play("popcorn_pop", {
      bus: "weapons",
      volume: 0.35,
      volumeVar: 0.12,
      rate: 1.1,
      rateVar: 0.3,
      throttleMs: 33,
      maxInstances: 6,
    });
  }

  /** Remote shooter: spatialized shot at the shooter position. */
  popcornShotAt(pos: THREE.Vector3): void {
    audio.playAt("popcorn_shot", pos, { bus: "weapons", volume: 0.85, rate: 0.82, rateVar: 0.03, refDistance: 8, maxInstances: 4 });
  }

  /** Remote reload: a burst of spatialized pops (few voices, cheap). */
  popcornReloadAt(pos: THREE.Vector3): void {
    for (let i = 0; i < 5; i++) {
      audio.playAt("popcorn_pop", pos, {
        bus: "weapons",
        volume: 0.3,
        rate: 1.1,
        rateVar: 0.3,
        delay: 0.95 + i * 0.16,
        refDistance: 5,
        maxInstances: 5,
      });
    }
  }

  // ------------------------------------------------------------------
  // PAINTBALL RIFLE (CC0 air shot / cocking sample + existing clicks)
  // ------------------------------------------------------------------

  /**
   * Thick paint "blorp": a wet splat pop (body) + a liquid gush (the jet
   * leaving the barrel) + a low gooey squish tail. 600 rpm: short slices,
   * few voices, wide pitch wobble so a burst stays squishy, never metronomic.
   */
  paintballShot(): void {
    audio.play("paintball_blorp", { bus: "weapons", volume: 0.55, volumeVar: 0.06, rate: 1.15, rateVar: 0.15, duration: 0.3, maxInstances: 4 });
    audio.play("paintball_gush", { bus: "weapons", volume: 0.3, volumeVar: 0.05, rate: 1.4, rateVar: 0.15, duration: 0.2, maxInstances: 4 });
    audio.play("paintball_gooey", { bus: "weapons", volume: 0.35, volumeVar: 0.05, rate: 0.85, rateVar: 0.1, duration: 0.25, delay: 0.03, maxInstances: 3 });
  }

  /**
   * Paint ball connects with a player (local shooter feedback): the SHARED
   * hitmarker (hitBody / hitHead) leads, so a paintball hit is confirmed by
   * the same unmistakable tick / ding as every other weapon — the wet splat
   * alone blended into the gooey shot layers and read as no feedback at all.
   * Under it, a quieter paint texture: wet "splat" on the body (two
   * variants), a fatter gooey squish on a headshot. Never throttled harder
   * than 40 ms so every ball of a 600 rpm burst is heard.
   *
   * Voice caps: the samples last 0.5-1 s (the head squish ≈ 0.8 s at this rate) and a burst starts one every
   * 0.1 s, so the caps must cover duration × 10 /s or the per-key instance limit silently drops the later hits of
   * the burst (the "gooey" key is also used by paintballShot, whose own cap is 3).
   */
  paintballHit(head: boolean): void {
    if (head) {
      this.hitHead();
      audio.play("paintball_gooey", { bus: "impacts", volume: 0.5, volumeVar: 0.05, rate: 1.2, rateVar: 0.05, throttleMs: 40, maxInstances: 14 });
      audio.play("paintball_splat_01", { bus: "impacts", volume: 0.35, rate: 1.5, rateVar: 0.05, throttleMs: 40, maxInstances: 10 });
      return;
    }
    this.hitBody();
    const key = Math.random() < 0.5 ? "paintball_splat_01" : "paintball_splat_02";
    audio.play(key, { bus: "impacts", volume: 0.4, volumeVar: 0.06, rate: 1.05, rateVar: 0.12, throttleMs: 40, maxInstances: 10 });
  }

  /** Empty hopper: dry trigger click. */
  paintballDryFire(): void {
    audio.play("popcorn_dry_fire", { bus: "weapons", volume: 0.55, rate: 1.2, rateVar: 0.04, throttleMs: 120 });
  }

  /** Hopper release button / new hopper clicked in (plastic clicks). */
  paintballHopperClick(seat: boolean): void {
    audio.play("popcorn_lid_click", { bus: "weapons", volume: seat ? 0.6 : 0.4, rate: seat ? 0.85 : 1.3, rateVar: 0.04, throttleMs: 60 });
  }

  /** Empty hopper dropped (dull plastic knock). */
  paintballHopperDrop(): void {
    audio.play("popcorn_dry_fire", { bus: "weapons", volume: 0.3, rate: 0.55, rateVar: 0.05, delay: 0.18 });
  }

  /** Palm slap on the hopper (balls rattle). */
  paintballSlap(): void {
    for (let i = 0; i < 4; i++) {
      audio.play("popcorn_dry_fire", {
        bus: "weapons",
        volume: 0.14,
        rate: 2.2,
        rateVar: 0.35,
        delay: i * 0.025 + Math.random() * 0.02,
        maxInstances: 6,
      });
    }
  }

  /** Charging handle racked back (sample) / released (short click). */
  paintballCharge(release: boolean): void {
    if (release) audio.play("popcorn_lid_click", { bus: "weapons", volume: 0.5, rate: 0.75, rateVar: 0.04, throttleMs: 60 });
    else audio.play("paintball_charge", { bus: "weapons", volume: 0.55, rate: 1.15, rateVar: 0.03, duration: 0.45, throttleMs: 120 });
  }

  /** Remote shooter: spatialized paint blorp (same 3 layers) at the shooter position. */
  paintballShotAt(pos: THREE.Vector3): void {
    audio.playAt("paintball_blorp", pos, { bus: "weapons", volume: 0.7, volumeVar: 0.06, rate: 1.15, rateVar: 0.15, duration: 0.3, refDistance: 6, maxInstances: 6 });
    audio.playAt("paintball_gush", pos, { bus: "weapons", volume: 0.38, volumeVar: 0.05, rate: 1.4, rateVar: 0.15, duration: 0.2, refDistance: 6, maxInstances: 6 });
    audio.playAt("paintball_gooey", pos, { bus: "weapons", volume: 0.45, volumeVar: 0.05, rate: 0.85, rateVar: 0.1, duration: 0.25, delay: 0.03, refDistance: 6, maxInstances: 4 });
  }

  /** Remote hopper swap: release click, seat click, charging handle. */
  paintballReloadAt(pos: THREE.Vector3): void {
    audio.playAt("popcorn_lid_click", pos, { bus: "weapons", volume: 0.45, rate: 1.3, delay: 0.4, refDistance: 5, maxInstances: 4 });
    audio.playAt("popcorn_lid_click", pos, { bus: "weapons", volume: 0.55, rate: 0.85, delay: 1.52, refDistance: 5, maxInstances: 4 });
    audio.playAt("paintball_charge", pos, { bus: "weapons", volume: 0.5, rate: 1.15, delay: 1.98, duration: 0.45, refDistance: 5, maxInstances: 3 });
  }

  // ------------------------------------------------------------------
  // WATER FAMAS (no dedicated sample: the compressed-air "pfft" of the
  // paintball shot, pitched up and layered with a soft click, reads as a
  // pressurised water squirt; clicks are the existing plastic ones)
  // ------------------------------------------------------------------

  /** One water jet "pssht" (3 per burst, 75 ms apart: few voices, pitch wobble). */
  famasJet(k = 0): void {
    audio.play("paintball_shot", {
      bus: "weapons",
      volume: 0.42 - k * 0.03,
      volumeVar: 0.05,
      rate: 1.55 + k * 0.06,
      rateVar: 0.06,
      duration: 0.16,
      maxInstances: 6,
    });
  }

  /** Empty tank: small click + a dull "pff". */
  famasDryFire(): void {
    audio.play("popcorn_dry_fire", { bus: "weapons", volume: 0.5, rate: 1.3, rateVar: 0.04, throttleMs: 120 });
    audio.play("paintball_shot", { bus: "weapons", volume: 0.16, rate: 0.9, duration: 0.12, delay: 0.03, throttleMs: 120 });
  }

  /** Cap thread (creak) / cap popped off / hinge & bottle plastic clicks / final screw "clac". */
  famasCap(kind: "grab" | "off" | "screwed"): void {
    if (kind === "grab") audio.play("popcorn_lid_click", { bus: "weapons", volume: 0.3, rate: 1.6, rateVar: 0.05, throttleMs: 60 });
    else if (kind === "off") audio.play("popcorn_pop", { bus: "weapons", volume: 0.3, rate: 1.4, rateVar: 0.05, duration: 0.2, throttleMs: 80 });
    else audio.play("popcorn_lid_click", { bus: "weapons", volume: 0.55, rate: 0.8, rateVar: 0.04, throttleMs: 60 });
  }

  famasClick(open: boolean): void {
    audio.play("popcorn_lid_click", { bus: "weapons", volume: 0.45, rate: open ? 1.25 : 0.95, rateVar: 0.04, throttleMs: 80 });
  }

  famasBottle(): void {
    audio.play("popcorn_dry_fire", { bus: "weapons", volume: 0.28, rate: 0.7, rateVar: 0.06, throttleMs: 80 });
  }

  /** Water glugging into the tank (~0.54 s): a few soft bubbles. */
  famasPour(): void {
    for (let i = 0; i < 6; i++) {
      audio.play("popcorn_pop", {
        bus: "weapons",
        volume: 0.16,
        rate: 0.7 + Math.random() * 0.5,
        duration: 0.1,
        delay: i * 0.085 + Math.random() * 0.03,
        maxInstances: 8,
      });
    }
  }

  /** Tank full again. */
  famasFull(): void {
    audio.play("popcorn_lid_click", { bus: "weapons", volume: 0.4, rate: 1.9, rateVar: 0.04, throttleMs: 80 });
  }

  /** Remote shooter: spatialized jet at the shooter position. */
  famasJetAt(pos: THREE.Vector3, k = 0): void {
    audio.playAt("paintball_shot", pos, { bus: "weapons", volume: 0.55, rate: 1.55 + k * 0.06, rateVar: 0.06, duration: 0.16, refDistance: 6, maxInstances: 8 });
  }

  /** Remote refill: cap, pour glugs, final clac (same clock as the animation). */
  famasReloadAt(pos: THREE.Vector3): void {
    audio.playAt("popcorn_lid_click", pos, { bus: "weapons", volume: 0.35, rate: 1.6, delay: 0.32, refDistance: 5, maxInstances: 4 });
    audio.playAt("popcorn_pop", pos, { bus: "weapons", volume: 0.3, rate: 1.4, delay: 0.66, duration: 0.2, refDistance: 5, maxInstances: 4 });
    for (let i = 0; i < 6; i++) {
      audio.playAt("popcorn_pop", pos, { bus: "weapons", volume: 0.14, rate: 0.7 + Math.random() * 0.5, delay: 1.44 + i * 0.085, duration: 0.1, refDistance: 5, maxInstances: 8 });
    }
    audio.playAt("popcorn_lid_click", pos, { bus: "weapons", volume: 0.5, rate: 0.8, delay: 2.86, refDistance: 5, maxInstances: 4 });
  }

  // ------------------------------------------------------------------
  // FRISBEE LAUNCHER (CC0 twang / whirl / latch / band samples + existing
  // plastic clicks and the basketball bounces for the disc knocks)
  // ------------------------------------------------------------------

  /** The elastic cord snaps and the disc leaves: low twang + the whirl of the disc. */
  frisbeeShot(): void {
    audio.play("frisbee_twang", { bus: "weapons", volume: 0.6, volumeVar: 0.05, rate: 0.85, rateVar: 0.04, duration: 0.55, maxInstances: 3 });
    audio.play("frisbee_band", { bus: "weapons", volume: 0.35, rate: 0.9, delay: 0.005, maxInstances: 3 });
    audio.play("frisbee_whirl", { bus: "weapons", volume: 0.4, rate: 1.1, rateVar: 0.05, duration: 0.6, delay: 0.03, maxInstances: 4 });
  }

  /** Empty deck: small trigger click. */
  frisbeeDryFire(): void {
    audio.play("popcorn_dry_fire", { bus: "weapons", volume: 0.5, rate: 1.15, rateVar: 0.04, throttleMs: 120 });
  }

  /** Sled latch (click-clack) of the automatic re-cock. */
  frisbeeCocked(): void {
    audio.play("frisbee_latch", { bus: "weapons", volume: 0.5, rate: 1.2, rateVar: 0.04, duration: 0.35, throttleMs: 80 });
  }

  /** A disc slides out of the cage (`seated` = the plastic "clac" on the deck). */
  frisbeeDisc(seated: boolean): void {
    if (seated) audio.play("popcorn_lid_click", { bus: "weapons", volume: 0.5, rate: 0.85, rateVar: 0.04, throttleMs: 60 });
    else audio.play("frisbee_whirl", { bus: "weapons", volume: 0.18, rate: 1.6, rateVar: 0.05, duration: 0.18, throttleMs: 60 });
  }

  /** Cage swap: release click + slide (`out`), big enclenchement click (`in`). */
  frisbeeCage(kind: "out" | "in"): void {
    if (kind === "out") audio.play("frisbee_latch", { bus: "weapons", volume: 0.4, rate: 1.05, rateVar: 0.04, duration: 0.4, throttleMs: 80 });
    else audio.play("frisbee_latch", { bus: "weapons", volume: 0.65, rate: 0.8, rateVar: 0.03, duration: 0.45, throttleMs: 80 });
  }

  /** The empty cage hits the ground ~0.3 s after it is thrown away (plastic clack). */
  frisbeeCageDropAt(pos: THREE.Vector3): void {
    audio.playAt("popcorn_lid_click", pos, { bus: "weapons", volume: 0.55, rate: 0.7, delay: 0.3, refDistance: 5, maxInstances: 4 });
  }

  /** Disc knock on the scenery (plastic "tok"), louder when fast; spatialized at the contact. */
  frisbeeBounce(pos: THREE.Vector3, speed: number): void {
    const k = Math.min(1, speed / FrisbeeLauncherConfig.tuning.speed);
    audio.playAt("popcorn_lid_click", pos, { bus: "impacts", volume: 0.25 + 0.5 * k, rate: 0.9 + 0.4 * (1 - k), rateVar: 0.06, throttleMs: 40, maxInstances: 6, refDistance: 6, maxDistance: 60 });
  }

  /** A disc touches a player: soft rubbery boing at the contact. */
  frisbeeHitAt(pos: THREE.Vector3): void {
    audio.playAt("frisbee_band", pos, { bus: "impacts", volume: 0.5, rate: 0.8, rateVar: 0.05, throttleMs: 60, maxInstances: 4, refDistance: 6, maxDistance: 60 });
  }

  /** Remote shooter: spatialized shot at the shooter position. */
  frisbeeShotAt(pos: THREE.Vector3): void {
    audio.playAt("frisbee_twang", pos, { bus: "weapons", volume: 0.7, rate: 0.85, rateVar: 0.04, duration: 0.55, refDistance: 8, maxInstances: 4 });
    audio.playAt("frisbee_whirl", pos, { bus: "weapons", volume: 0.4, rate: 1.1, duration: 0.6, delay: 0.03, refDistance: 8, maxInstances: 4 });
  }

  /** Remote cage swap on the authored clock (release, drop clack, click-in). */
  frisbeeReloadAt(pos: THREE.Vector3): void {
    audio.playAt("frisbee_latch", pos, { bus: "weapons", volume: 0.35, rate: 1.05, delay: 0.4, duration: 0.4, refDistance: 5, maxInstances: 4 });
    audio.playAt("frisbee_latch", pos, { bus: "weapons", volume: 0.55, rate: 0.8, delay: 1.1, duration: 0.45, refDistance: 5, maxInstances: 4 });
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
    this.updateAmbience(dt);

    if (f.running) {
      const alive = f.playerHealth.alive;
      this.updateFootsteps(dt, f.movement, alive);
      this.updateSlideLoops(f.movement, alive);
      this.updateDashReady(f.movement, alive);
      this.updateHeartbeat(f.playerHealth);
      this.updateBots(f.botManager);
    } else {
      // Escape menu: fade every transient loop (ambience keeps playing).
      this.stopMovementLoops();
      this.stopComboLayer();
      this.stopUndergroundLayer();
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

  private updateAmbience(dt: number): void {
    // Calm winter-village bed (loop).
    if (!this.ambienceLoop || this.ambienceLoop.stopped) {
      this.ambienceLoop = audio.loop("ambience_village", {
        bus: "ambience",
        volume: VILLAGE_LOOP_VOLUME,
        rate: 1,
        fadeIn: 3,
      });
    }

    // Distant Christmas music box, at random intervals. The timer only runs
    // once the buffer is decoded, so the first melody is never "lost".
    if (!audio.has("ambience_musicbox")) return;
    this.musicBoxTimer -= dt;
    if (this.musicBoxTimer > 0) return;

    audio.play("ambience_musicbox", {
      bus: "ambience",
      volume: MUSICBOX_VOLUME,
      volumeVar: 0.03,
      rate: 1,
      rateVar: 0.02,
      lowpassHz: MUSICBOX_LOWPASS_HZ,
      fade: MUSICBOX_FADE,
      maxInstances: 1,
    });
    // Next one: melody length + a random silence.
    this.musicBoxTimer =
      audio.duration("ambience_musicbox") + randRange(MUSICBOX_GAP);
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
   * Bot respawns get a quiet spatial cue when nearby. (Bot weapon shots are
   * spatial one-shots fired by the Game from each bot's weapon events.)
   */
  private updateBots(botManager: BotManager): void {
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
    }
    // Forget bots removed from the roster.
    if (this.botWasAlive.size > botManager.bots.length) {
      for (const bot of [...this.botWasAlive.keys()]) {
        if (!botManager.bots.includes(bot)) this.botWasAlive.delete(bot);
      }
    }
  }

  // ------------------------------------------------------------------
  // Loop teardown helpers
  // ------------------------------------------------------------------


  private stopMovementLoops(): void {
    this.slideLoop?.stop(0.1);
    this.slideLoop = null;
    this.wallSlideLoop?.stop(0.1);
    this.wallSlideLoop = null;
  }
}

// Re-export for convenient wiring in Game.
export type { Combatant };