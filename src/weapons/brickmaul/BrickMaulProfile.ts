import type { WeaponViewProfile } from "../profiles/WeaponProfile";
// Vite-resolved asset URLs (bundler-safe in dev AND production builds —
// the profile JSON file names are relative to the assets folder).
import weaponUrl from "../../assets/brickmaul/BrickMaul_Weapon.glb?url";
import fpPosesUrl from "../../assets/brickmaul/Potato_FP_BrickMaul.glb?url";
import tpPosesUrl from "../../assets/brickmaul/Potato_TP_BrickMaul.glb?url";
// Authored integration data (r5): mounts, clips, mask, action timings, eyes.
import profileJson from "../../assets/brickmaul/WeaponProfile_BrickMaul.json";

/** Action keys shared by the FP adapter, the TP controller and the network. */
export type BrickMaulActionKey =
  | "whirlwind"
  | "slamStart"
  | "slamDive"
  | "slamLand";

type ClipKind = (typeof profileJson.clips.fp)[number]["kind"];

function clipName(view: "fp" | "tp", kind: ClipKind): string {
  const entry = profileJson.clips[view].find((c) => c.kind === kind);
  if (!entry) throw new Error(`BrickMaul profile: ${view} clip "${kind}" missing`);
  return entry.clip;
}

function actionTable(view: "fp" | "tp"): Record<BrickMaulActionKey, { clip: string; loop: boolean }> {
  return {
    whirlwind: { clip: clipName(view, "Whirlwind"), loop: false },
    slamStart: { clip: clipName(view, "Slam_Start"), loop: false },
    slamDive: { clip: clipName(view, "Slam_Dive"), loop: true },
    slamLand: { clip: clipName(view, "Slam_Land"), loop: false },
  };
}

/** Authored action timings (seconds) — the single source for FP/TP/network. */
export const BRICKMAUL_TIMING = {
  whirlwind: {
    duration: profileJson.actions.whirlwind.duration, // 1.35
    activeStart: profileJson.actions.whirlwind.activeStart, // 0.20
    activeEnd: profileJson.actions.whirlwind.activeEnd, // 1.04
    turns: profileJson.actions.whirlwind.turns,
  },
  slam: {
    startDuration: profileJson.actions.slam.startDuration, // 0.20
    diveLoopDuration: profileJson.actions.slam.diveLoopDuration, // 0.40
    landClipDuration: profileJson.actions.slam.landClipDuration, // 0.82
    enterLandAt: profileJson.actions.slam.enterLandAt, // 0.10
    recoveryAfterGroundContact: profileJson.actions.slam.recoveryAfterGroundContact, // 0.72
  },
  /**
   * Equip clip playback rate (FP + TP alike). The Equip clip is authored at
   * 0.65 s — too slow for a slot switch; both mixers play it at this rate
   * so the local arms and the remote avatar stay in lockstep.
   */
  equipTimeScale: 1.8,
  /** EFFECTIVE equip duration (s) = 0.65 / equipTimeScale ≈ 0.36. */
  equip: 0.65 / 1.8,
  unequip: 0.3,
  inspect: profileJson.actions.inspect.duration, // 3.6
} as const;

/** Moving-pupil authoring data (bone names, eye white centers, radii). */
export type BrickMaulEyesConfig = typeof profileJson.eyes;
export const BRICKMAUL_EYES: BrickMaulEyesConfig = profileJson.eyes;

/**
 * Brick Maul r5 presentation profile — mount matrices, clip names, mask and
 * timings come straight from WeaponProfile_BrickMaul.json (mounts applied
 * ONCE, column-major, scale included, no extra correction).
 */
export const BrickMaulProfile: WeaponViewProfile = {
  id: profileJson.id,
  weaponUrl,
  fpPosesUrl,
  tpPosesUrl,
  fpMount: profileJson.mounts.fp.matrixColumnMajor,
  tpMount: profileJson.mounts.tp.matrixColumnMajor,
  fpClips: {
    hold: clipName("fp", "Hold"),
    run: clipName("fp", "Run"),
    equip: clipName("fp", "Equip"),
    unequip: clipName("fp", "Unequip"),
    inspect: clipName("fp", "Inspect"),
    // No ADS on the hammer: aim / raise / lower intentionally absent.
  },
  fpActions: actionTable("fp"),
  tpClips: {
    hold: clipName("tp", "Hold"),
    run: clipName("tp", "Run"),
    equip: clipName("tp", "Equip"),
    unequip: clipName("tp", "Unequip"),
    inspect: clipName("tp", "Inspect"),
    actions: actionTable("tp"),
  },
  upperBodyMask: profileJson.upperBodyMask,
  inspectDuration: profileJson.actions.inspect.duration,
};
