import type { WeaponViewProfile } from "./WeaponProfile";
// Vite-resolved asset URLs (same bundler-safe ?url table as HexSniperProfile).
import weaponUrl from "../../assets/potato/PopcornShotgun_Weapon.glb?url";
import fpPosesUrl from "../../assets/potato/PopcornShotgun_FP_Poses.glb?url";
import tpPosesUrl from "../../assets/potato/PopcornShotgun_TP_Poses.glb?url";
// Authored integration data (mount matrices, clips, action timelines, popcorn tank).
import profileJson from "../../assets/potato/WeaponProfile_PopcornShotgun.json";

/**
 * Popcorn Shotgun presentation profile — two-handed, built on the HexSniper conventions:
 * mount matrices straight from WeaponProfile_PopcornShotgun.json (applied once, column-major,
 * no extra scaling; the weapon root keeps its own 0.19), pose clips on the common FP arms.
 *
 * Priority actions (ViewmodelSystem.playAction keys):
 *   "fire"     — recoil + left-hand pump rack (0.9 s)       → weapon clip "Fire"
 *   "fireLast" — recoil only, last popcorn load (0.55 s)    → weapon clip "Fire_Last"
 *   "reload"   — lid flick, sprinkle, lid shut, pops, rack (2.2 s) → weapon clip "Reload"
 * Start the weapon clip THE SAME FRAME as the arms action (PopcornShotgunController does it).
 */
export const PopcornShotgunProfile: WeaponViewProfile = {
  id: profileJson.id,
  weaponUrl,
  fpPosesUrl,
  tpPosesUrl,
  fpMount: profileJson.mounts.fp.matrixColumnMajor,
  tpMount: profileJson.mounts.tp.matrixColumnMajor,
  fpClips: {
    hold: profileJson.fpClips.hold,
    run: profileJson.fpClips.run,
    aim: profileJson.fpClips.aim,
    raise: profileJson.fpClips.raise,
    lower: profileJson.fpClips.lower,
    inspect: profileJson.fpClips.inspect,
    equip: profileJson.fpClips.equip,
    unequip: profileJson.fpClips.unequip,
  },
  // SlideIO: the shots play the STRAIGHT variants (authored motion re-based on
  // the Aim pose — see weapons/popcorn/PopcornStraightFire.ts) so the FP gun
  // points where remote players see it point. The clips are derived at load
  // (PopcornShotgunWeapon awaits POPCORN_STRAIGHT_FIRE before equipping).
  fpActions: {
    fire: { clip: profileJson.fpActions.fire.clip + "_Straight", loop: false },
    fireLast: { clip: profileJson.fpActions.fireLast.clip + "_Straight", loop: false },
    reload: profileJson.fpActions.reload,
  },
  tpClips: {
    hold: profileJson.tpClips.hold,
    run: profileJson.tpClips.run,
    actions: {
      fire: profileJson.tpClips.actions.fire,
      fireLast: profileJson.tpClips.actions.fireLast,
      reload: profileJson.tpClips.actions.reload,
    },
  },
  upperBodyMask: profileJson.upperBodyMask,
  weaponInspectClip: profileJson.inspection.weaponClip,
  inspectDuration: profileJson.inspection.duration,
};

/** TP ADS trio (for PotatoCharacter, same role as the HexSniper's TP Aim/Raise/Lower). */
export const POPCORN_TP_AIM_CLIPS = {
  aim: profileJson.tpClips.aim,
  raise: profileJson.tpClips.raise,
  lower: profileJson.tpClips.lower,
} as const;

/** Authored FP clips the straight shots are derived from (Aim pose = new base). */
export const POPCORN_STRAIGHT_FIRE = {
  aim: profileJson.fpClips.aim,
  sources: [profileJson.fpActions.fire.clip, profileJson.fpActions.fireLast.clip],
} as const;

/** Action timelines (seconds) consumed by PopcornShotgunController. */
export const POPCORN_SHOTGUN_TIMELINE = profileJson.actions;
