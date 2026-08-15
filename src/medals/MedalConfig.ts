import { MedalType } from "./MedalType";
import killUrl from "../assets/KILL.png";
import doubleKillUrl from "../assets/doublekill.png";
import tripleKillUrl from "../assets/triplekill.png";
import smashedUrl from "../assets/SMASHED.png";
import homerunUrl from "../assets/homerun.png";
import obliteratedUrl from "../assets/OBLITERATED.svg";
import moledUrl from "../assets/MOLED.svg";
import impaledUrl from "../assets/IMPALED.svg";
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

/**
 * MedalType → graphic asset. The real project images are used directly
 * (bundled by Vite); MedalHUD preloads all of them at construction so a
 * kill never triggers an asset load.
 */
export const MedalAssets: Readonly<Record<MedalType, string>> = {
  [MedalType.KILL]: killUrl,
  [MedalType.DOUBLE_KILL]: doubleKillUrl,
  [MedalType.TRIPLE_KILL]: tripleKillUrl,
  [MedalType.SMASHED]: smashedUrl,
  [MedalType.HOMERUN]: homerunUrl,
  [MedalType.OBLITERATED]: obliteratedUrl,
  [MedalType.MOLED]: moledUrl,
  [MedalType.IMPALED]: impaledUrl,
};
