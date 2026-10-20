/**
 * HUD ↔ game protocol — the in-match DOM HUD in its own document.
 *
 * WHY (PERFORMANCE.md, « Le plafond à 240 Hz ») — at 244 Hz a frame is
 * 4.1 ms, and the game's JS (~3 ms) and the browser's work for the HUD
 * (style, layout, paint: ~1 ms at rest, 2.5 ms on average and 8 ms at worst
 * right after a kill) ran one AFTER the other on the page's main thread.
 * The HUD now lives in its own document: a sandboxed iframe laid over the
 * game canvas, which Chrome (site isolation) runs in its OWN renderer
 * process — its style / layout / paint run in parallel with the game, and
 * a frame costs the slower of the two instead of their sum.
 *
 * HOW
 * - The game never touches HUD DOM. It calls the `HudApi` facades (same
 *   method names as the old widgets), which read live game objects into the
 *   plain "views" below and emit `HudCommand`s.
 * - FRAME mode (production default): commands are batched per game frame and
 *   posted to the HUD iframe (one structured clone per frame), whose runtime
 *   applies them to the real widgets in order.
 * - INLINE mode (fallback: no isolation, iframe failed to load, DEV default,
 *   `?hud=inline`): the SAME runtime runs in the game page and every command
 *   is applied synchronously, at the call — exactly the old behaviour.
 * - Only plain data crosses: numbers, strings, booleans, null, and plain
 *   objects / arrays of those (no functions, no class instances, no DOM).
 *
 * Widget construction order, DOM, CSS and timings are unchanged: the runtime
 * builds the widgets in the order Game used to, in the HUD document.
 */
import type * as THREE from "three";
import type { Combatant } from "../combat/Combatant";
import type { HitZone } from "../combat/HitZone";
import type { KillstreakState } from "../killstreaks/KillstreakState";
import type { MedalDisplay } from "../medals/MedalManager";
import type { MedalType } from "../medals/MedalType";
import type { PlayerMatchStats } from "../stats/MatchStatsManager";
import type { CrosshairKick } from "../ui/CrosshairHUD";
import type { CrosshairSettings } from "../ui/CrosshairSettings";

// ---------------------------------------------------------------------------
// Views: what each widget actually reads (the live game objects satisfy them;
// the facades copy them into plain objects).
// ---------------------------------------------------------------------------

/** CombatHUD ← the local player's Health. */
export interface HealthView {
  readonly current: number;
  readonly max: number;
  readonly ratio: number;
  readonly alive: boolean;
}

/** DashHUD ← PlayerMovement. */
export interface DashView {
  readonly dashCooldownRemaining: number;
  readonly isDashing: boolean;
}

/** SpearHUD ← SpearWeapon. */
export interface SpearView {
  readonly rushCooldownRemaining: number;
  readonly isRushing: boolean;
}

/** ComboHUD ← ComboManager. */
export interface ComboView {
  readonly active: boolean;
  readonly comboCount: number;
  readonly ratio: number;
  readonly timeRemaining: number;
}

/** PaintballRifleHUD / WaterFamasHUD ← their weapon. */
export interface AmmoView {
  readonly ammo: number;
  readonly isReloading: boolean;
}

/** PopcornShotgunHUD ← PopcornShotgunWeapon (same fields as PopcornHudSource). */
export interface PopcornView extends AmmoView {
  /** Bumped once per shot ACTUALLY fired. */
  readonly shotSerial: number;
}

/** FrisbeeLauncherHUD ← FrisbeeLauncherWeapon (same fields as FrisbeeHudSource). */
export interface FrisbeeView {
  readonly deckLoaded: boolean;
  readonly cageCount: number;
  readonly discInHand: boolean;
  readonly isReloading: boolean;
  readonly shotSerial: number;
}

/** KillstreakHUD ← one KillstreakSlot (same public fields). */
export interface KillstreakSlotView {
  readonly def: { readonly id: string; readonly requiredKills: number } | null;
  readonly state: KillstreakState;
  readonly kills: number;
}

/** KillstreakHUD ← KillstreakManager (`slots`). */
export interface KillstreakView {
  readonly slots: readonly KillstreakSlotView[];
}

/** LeaderboardHUD rows: already plain data (copied by the facade). */
export type LeaderboardRow = PlayerMatchStats;

/** A combatant a damage number FOLLOWS while it lives (solo bots). */
export interface FollowTarget {
  readonly health: { readonly alive: boolean };
  getEyePosition(out: THREE.Vector3): THREE.Vector3;
}

// ---------------------------------------------------------------------------
// Damage numbers across the boundary
// ---------------------------------------------------------------------------

/**
 * Merge key of a damage number: a Combatant becomes `"#c<id>"`, a network
 * sessionId stays as is (it never starts with "#").
 */
export type DamageKey = string;

/** World position. */
export type Vec3 = [number, number, number];

/**
 * The camera of a damage-number projection: `matrixWorld`,
 * `matrixWorldInverse` and `projectionMatrix`, 3 × 16 floats, column-major
 * (THREE.Matrix4.elements order) — everything `Vector3.project(camera)` and
 * `setFromMatrixPosition(camera.matrixWorld)` read.
 */
export type CameraSnapshot = number[];

/** A followed target this frame: alive flag + eye position (getEyePosition). */
export interface FollowSnapshot {
  readonly key: DamageKey;
  readonly alive: boolean;
  readonly eye: Vec3;
}

// ---------------------------------------------------------------------------
// Commands (game → HUD), applied in order
// ---------------------------------------------------------------------------

export type PlateId = "popcorn" | "paintball" | "famas" | "frisbee";

/** Elements whose classes the game page toggles in the HUD document. */
export type DocTarget = "root" | "body" | "hud";

export type HudCommand =
  // CombatHUD: Bean Buddy card, HP tube, vignettes, heal, damage direction, death screen
  | ["combat.update", dt: number, health: HealthView, deathTimer: number]
  | ["combat.knockdown", down: boolean, canGetUp: boolean]
  | ["combat.damage", amount: number, angle: number | null]
  | ["combat.heal", amount: number]
  | ["combat.kill"]
  | ["combat.name", name: string]
  // DashHUD, SpearHUD
  | ["dash.update", dt: number, view: DashView]
  | ["spear.visible", visible: boolean]
  | ["spear.update", view: SpearView]
  // Weapon plates
  | ["plate.visible", plate: PlateId, visible: boolean]
  | ["plate.popcorn", view: PopcornView]
  | ["plate.paintball", view: AmmoView]
  | ["plate.famas", view: AmmoView]
  | ["plate.frisbee", view: FrisbeeView]
  // ComboHUD, MedalHUD (driven by the game's MedalManager), KillstreakHUD
  | ["combo.kill"]
  | ["combo.update", view: ComboView]
  | ["medal.show", medal: MedalType, chainIndex: number]
  | ["medal.exit"]
  | ["medal.hide"]
  | ["killstreak.render", slots: KillstreakSlotView[]]
  | ["killstreak.ready", slotIndex: number]
  // LeaderboardHUD, MatchClockHUD, InteractHUD (Yard)
  | ["leaderboard.refresh", rows: LeaderboardRow[]]
  | ["clock.set", secondsLeft: number | null]
  | ["interact.prompt", label: string | null]
  // Full-screen overlays
  | ["phase.opacity", opacity: number]
  | ["mole.opacity", opacity: number]
  // CrosshairHUD (+ the menu's crosshair settings), HitmarkerHUD
  | ["crosshair.fire", kick: CrosshairKick]
  | ["crosshair.aim", on: boolean]
  | ["crosshair.flush"]
  | ["crosshair.settings", settings: CrosshairSettings]
  | ["hitmarker.show", zone: HitZone, durationSec: number | null, kill: boolean]
  | ["hitmarker.flush"]
  // DamageNumbersHUD
  | ["damage.hit", key: DamageKey, damage: number, zone: HitZone, anchor: Vec3, follow: DamageKey | null, kill: boolean]
  | ["damage.orphan", key: DamageKey, damage: number, kill: boolean]
  /** Before `damage.update`: eye positions of the targets numbers may follow (absent key = not alive). */
  | ["damage.follow", targets: FollowSnapshot[]]
  | ["damage.update", dt: number, camera: CameraSnapshot]
  // Classes the game page toggles (#hud.menu-active, body.game-paused…)
  | ["doc.class", target: DocTarget, className: string, on: boolean];

export type HudCommandName = HudCommand[0];

// ---------------------------------------------------------------------------
// Runtime (HUD document side)
// ---------------------------------------------------------------------------

/** Constructor arguments of the widgets (from the game's configs). */
export interface HudInit {
  popcornShots: number;
  paintballCapacity: number;
  famasCapacity: number;
  frisbeeCageCapacity: number;
  /** Yard map: the terminal prompt (InteractHUD) exists. */
  interact: boolean;
  /** Crosshair settings at boot (the menu re-sends them on every change). */
  crosshair: CrosshairSettings;
  /**
   * The game page's viewport when init is sent (innerWidth / innerHeight /
   * devicePixelRatio, browser zoom included). The HUD document must see the
   * same one — otherwise the HUD would be drawn at another scale: the iframe
   * then answers `{ t: "error" }` instead of `ready`, and the host falls back
   * to the inline HUD. Tolerance: 1 CSS px, 0.01 DPR.
   */
  viewport: { width: number; height: number; dpr: number };
}

/** The HUD runtime: same code in the iframe (frame mode) and in the game page (inline mode). */
export interface HudRuntime {
  /** Injects the HUD markup and builds every widget, in the order Game used to. Once. */
  init(init: HudInit): void;
  /** Applies commands, in order. */
  apply(cmds: readonly HudCommand[]): void;
  /** Applies ONE command (inline mode: synchronous, at the call). */
  run(cmd: HudCommand): void;
  /**
   * The HUD warm-up (ui/HudWarmup.ts warmUpHud, with the runtime's own
   * leaderboard hooks), drawn behind the loading screen. `gpuIdle` resolves
   * when the game page's shader compile is over (it may take longer while
   * both share the GPU process).
   */
  warmUp(gpuIdle: Promise<unknown> | null): Promise<void>;
  /** DEV: GPU time of the weapon plates' paint context (PaintGL), last sample, or null. */
  takePaintGpuMs(): number | null;
}

/** `createHudRuntime` — exported by src/hud/runtime/HudRuntime.ts. */
export type CreateHudRuntime = () => HudRuntime;

// ---------------------------------------------------------------------------
// Messages (frame mode)
// ---------------------------------------------------------------------------

/**
 * Handshake on `window.postMessage`: the HUD document posts
 * `{ [HUD_HELLO]: 1 }` to its parent once its runtime module is loaded; the
 * parent answers `{ [HUD_CONNECT]: 1 }` with a MessagePort (transferred);
 * every other message goes through that port.
 */
export const HUD_HELLO = "__slideioHudHello";
export const HUD_CONNECT = "__slideioHudConnect";

/** Game page → HUD document (on the port). */
export type HudDownMessage =
  /** Isolation check: answer with the number of rAF frames seen so far. */
  | { t: "ping" }
  | { t: "init"; init: HudInit }
  | { t: "batch"; cmds: HudCommand[] }
  | { t: "warmup" }
  /** The game page's shader compile is over (warm-up budget may start). */
  | { t: "gpu-idle" };

/** HUD document → game page (on the port). */
export type HudUpMessage =
  | { t: "pong"; frames: number }
  /** `init` done: markup + widgets built, fonts loaded. */
  | { t: "ready" }
  | { t: "warmup-done"; ms: number }
  /**
   * Every 500 ms: the HUD document's own frame rate, main-thread work per
   * frame (command application, then the browser's style / layout / paint),
   * the DEV paint GPU time, and the viewport it sees (the game page checks it
   * still matches its own — same tolerance as at init).
   * Their silence during the match tells the game page the iframe is gone.
   */
  | {
      t: "stats";
      fps: number;
      applyMs: number;
      renderMs: number;
      paintGpuMs: number | null;
      viewport?: HudInit["viewport"];
    }
  | { t: "error"; message: string };

// ---------------------------------------------------------------------------
// Game-side API (facades) — what Game.ts / main.ts / HitFeedbackManager call
// ---------------------------------------------------------------------------

export interface HudApi {
  readonly combat: {
    update(dt: number, health: HealthView, deathTimer: number): void;
    setKnockdown(down: boolean, canGetUp: boolean): void;
    notifyDamage(amount: number, angle?: number | null): void;
    notifyHeal(amount: number): void;
    notifyKill(): void;
    setPlayerName(name: string): void;
  };
  readonly dash: { update(dt: number, movement: DashView): void };
  readonly spear: { setVisible(visible: boolean): void; update(spear: SpearView): void };
  readonly popcorn: { setVisible(visible: boolean): void; update(weapon: PopcornView): void };
  readonly paintball: { setVisible(visible: boolean): void; update(weapon: AmmoView): void };
  readonly famas: { setVisible(visible: boolean): void; update(weapon: AmmoView): void };
  readonly frisbee: { setVisible(visible: boolean): void; update(weapon: FrisbeeView): void };
  readonly combo: { notifyKill(): void; update(combo: ComboView): void };
  /** Given to the game's MedalManager. */
  readonly medal: MedalDisplay;
  readonly killstreak: {
    /** The manager whose `slots` render() copies (KillstreakManager satisfies KillstreakView). */
    bind(view: KillstreakView): void;
    render(): void;
    notifyReady(slotIndex: number): void;
  };
  readonly leaderboard: { refresh(rows: readonly LeaderboardRow[]): void };
  readonly clock: { set(secondsLeft: number | null): void };
  readonly interact: { setPrompt(label: string | null): void };
  readonly crosshair: { fire(kick?: CrosshairKick): void; setAiming(on: boolean): void; flush(): void };
  readonly hitmarker: { show(zone: HitZone, durationSec?: number, kill?: boolean): void; flush(): void };
  readonly damageNumbers: {
    addHit(
      key: Combatant | string,
      damage: number,
      zone: HitZone,
      anchor: THREE.Vector3,
      target?: Combatant | null,
      isKill?: boolean,
    ): void;
    addOrphanHit(key: Combatant | string, damage: number, isKill?: boolean): void;
    update(dt: number, camera: THREE.Camera): void;
  };
  setPhaseOpacity(opacity: number): void;
  setMoleOpacity(opacity: number): void;
  setDocClass(target: DocTarget, className: string, on: boolean): void;
  applyCrosshairSettings(settings: CrosshairSettings): void;
}
