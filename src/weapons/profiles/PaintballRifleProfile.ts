import type { WeaponViewProfile } from "./WeaponProfile";
// Vite-resolved asset URLs (same bundler-safe ?url table as HexSniperProfile / PopcornShotgunProfile).
import weaponUrl from "../../assets/potato/PaintballRifle_Weapon.glb?url";
import fpPosesUrl from "../../assets/potato/PaintballRifle_FP_Poses.glb?url";
import tpPosesUrl from "../../assets/potato/PaintballRifle_TP_Poses.glb?url";
// Authored integration data (mount matrices, clips, action timelines, hopper).
import profileJson from "../../assets/potato/WeaponProfile_PaintballRifle.json";

/**
 * Paintball Rifle presentation profile — two-handed automatic rifle (32 balls), built on the HexSniper
 * conventions: mount matrices straight from WeaponProfile_PaintballRifle.json (applied once, column-major, no extra
 * scaling; the weapon root keeps its own 0.19), pose clips on the common FP arms.
 *
 * Priority actions (ViewmodelSystem.playAction keys):
 *   "fire"    — LOOP (0.1 s = 600 rpm, one kick per cycle) while shots keep coming → weapon clip "Fire" (loop)
 *   "fireEnd" — settle when the trigger is released (0.3 s)                         → weapon clip "Fire_End"
 *   "reload"  — hopper swap: release, drop, fetch, click, slap, charging handle (2.45 s) → weapon clip "Reload"
 * PaintballRifleController starts the weapon clip THE SAME FRAME as the arms action.
 */
export const PaintballRifleProfile: WeaponViewProfile = {
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
  // SlideIO: the burst plays the STRAIGHT variants (authored motion re-based
  // on the Aim pose — see weapons/paintball/PaintballStraightFire.ts): the gun
  // is held straight like in ADS while firing, then lowers back to Hold.
  // Derived at load (PaintballRifleWeapon awaits PAINTBALL_STRAIGHT_FIRE).
  fpActions: {
    fire: { clip: profileJson.fpActions.fire.clip + "_Straight", loop: true },
    fireEnd: { clip: profileJson.fpActions.fireEnd.clip + "_Straight", loop: false },
    reload: profileJson.fpActions.reload,
  },
  tpClips: {
    hold: profileJson.tpClips.hold,
    run: profileJson.tpClips.run,
    actions: {
      fire: profileJson.tpClips.actions.fire,
      fireEnd: profileJson.tpClips.actions.fireEnd,
      reload: profileJson.tpClips.actions.reload,
    },
  },
  upperBodyMask: profileJson.upperBodyMask,
  weaponInspectClip: profileJson.inspection.weaponClip,
  inspectDuration: profileJson.inspection.duration,
};

/** TP ADS trio (for PotatoCharacter, same role as the HexSniper's TP Aim/Raise/Lower). */
export const PAINTBALL_TP_AIM_CLIPS = {
  aim: profileJson.tpClips.aim,
  raise: profileJson.tpClips.raise,
  lower: profileJson.tpClips.lower,
} as const;

/** Authored FP clips the straight burst is derived from (Aim pose = new base). */
export const PAINTBALL_STRAIGHT_FIRE = {
  aim: profileJson.fpClips.aim,
  fire: profileJson.fpActions.fire.clip,
  fireEnd: profileJson.fpActions.fireEnd.clip,
} as const;

/** Action timelines (seconds) consumed by PaintballRifleController. */
export const PAINTBALL_RIFLE_TIMELINE = profileJson.actions;
