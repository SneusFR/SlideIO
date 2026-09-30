import { MedalType } from "./MedalType";
import { KillMethod } from "../combat/KillMethod";

/**
 * Central configuration for the medal system.
 * All timings, pitches and mappings live here — no magic numbers
 * scattered across components.
 */
export const MedalConfig = {
  // ---- Presentation timings (seconds) ----
  /** Pop-in animation (scale 0 → overshoot → settle). */
  medalEnterDuration: 0.16,
  /** Time the medal stays fully visible. */
  medalDisplayDuration: 0.95,
  /** Fade + drift-out animation. */
  medalExitDuration: 0.25,
  /** Gap between two queued medals (the game is fast — keep it snappy). */
  medalQueueDelay: 0.06,

  // ---- Medal sound pitch progression (per medal shown in ONE combo) ----
  /** Pitch of the first medal of a combo chain. */
  medalBasePitch: 1.0,
  /** Pitch added per additional medal in the SAME combo chain. */
  medalPitchStep: 0.05,
  /** Reasonable ceiling — the sting never becomes ridiculous. */
  medalMaxPitch: 1.35,

  /**
   * Special medals (SMASHED / HOMERUN) from one AoE impact are shown only
   * ONCE: kills arriving within this window (ms) merge their special medal.
   * Combo medals are NEVER merged — every kill counts individually.
   */
  specialMedalMergeMs: 200,
} as const;

/**
 * Combo count → combo medal registry. Extending later is a one-liner:
 *   4: MedalType.QUAD_KILL, 5: MedalType.PENTA_KILL, …
 * Counts without an entry keep the combo running but show no medal.
 */
export const ComboMedalRegistry: Readonly<Record<number, MedalType>> = {
  1: MedalType.KILL,
  2: MedalType.DOUBLE_KILL,
  3: MedalType.TRIPLE_KILL,
};

/** Kill method → special medal (methods without an entry give none). */
export const SpecialMedalRegistry: Readonly<Partial<Record<KillMethod, MedalType>>> = {
  [KillMethod.HAMMER_SWING]: MedalType.HOMERUN,
  [KillMethod.GROUND_SLAM]: MedalType.SMASHED,
  [KillMethod.OBLITERREUR]: MedalType.OBLITERATED,
  [KillMethod.MOLE_STRIKE]: MedalType.MOLED,
  [KillMethod.SPEAR_RUSH]: MedalType.IMPALED,
};

/** How a medal looks in the "Bean Sticker Arcade" HUD. */
export interface MedalStyle {
  /** Text printed on the ribbon. */
  readonly label: string;
  /** Accent colour (disc rim, ribbon, rays, confetti). */
  readonly color: string;
  /** Gold stars above the disc (combo medals: 1 / 2 / 3). 0 = none. */
  readonly stars: number;
}

/**
 * MedalType → sticker style. The art itself is vector (hudIcons.ts →
 * medalIconSvg), pre-rendered once by MedalHUD: no image to load on a kill.
 */
export const MedalStyles: Readonly<Record<MedalType, MedalStyle>> = {
  [MedalType.KILL]: { label: "KILL!", color: "#a8d94a", stars: 1 },
  [MedalType.DOUBLE_KILL]: { label: "DOUBLE KILL!", color: "#facc15", stars: 2 },
  [MedalType.TRIPLE_KILL]: { label: "TRIPLE KILL!", color: "#ff8a3d", stars: 3 },
  [MedalType.SMASHED]: { label: "SMASHED!", color: "#c98a4a", stars: 0 },
  [MedalType.HOMERUN]: { label: "HOME RUN!", color: "#5cc8ff", stars: 0 },
  [MedalType.OBLITERATED]: { label: "OBLITERATED!", color: "#ffb347", stars: 0 },
  [MedalType.MOLED]: { label: "MOLED!", color: "#a5774a", stars: 0 },
  [MedalType.IMPALED]: { label: "IMPALED!", color: "#8fd14f", stars: 0 },
  [MedalType.HEADSHOT]: { label: "HEADSHOT!", color: "#ff5a4e", stars: 0 },
};
