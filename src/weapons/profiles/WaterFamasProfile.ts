import type { WeaponViewProfile } from "./WeaponProfile";
// Vite-resolved asset URLs (same bundler-safe ?url table as HexSniperProfile / PaintballRifleProfile).
import weaponUrl from "../../assets/potato/WaterFamas_Weapon.glb?url";
import fpPosesUrl from "../../assets/potato/WaterFamas_FP_Poses.glb?url";
import tpPosesUrl from "../../assets/potato/WaterFamas_TP_Poses.glb?url";
// Authored integration data (mount matrices, clips, action timelines, tank).
import profileJson from "../../assets/potato/WeaponProfile_WaterFamas.json";

/**
 * Water FAMAS presentation profile — ONE-HANDED burst water gun (9 jets = 3 bursts of 3), built on the HexSniper
 * conventions: mount matrices straight from WeaponProfile_WaterFamas.json (applied once, column-major, no extra
 * scaling; the weapon root keeps its own 0.19), pose clips on the common FP arms.
 *
 * Priority actions (ViewmodelSystem.playAction keys):
 *   "fire"    — one trigger pull = one 3-jet burst (0.42 s, one-shot)          → weapon clip "Fire"
 *   "fireAim" — the same burst while aiming (tighter kick)                      → weapon clip "Fire"
 *   "reload"  — unscrew the cap, swing it open, pour a bottle, close, screw (3.3 s) → weapon clip "Reload"
 * WaterFamasController starts the weapon clip THE SAME FRAME as the arms action.
 */
export const WaterFamasProfile: WeaponViewProfile = {
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
  // SlideIO: the hip burst plays the STRAIGHT variant (authored motion re-based
  // on the Aim pose — see waterfamas/WaterFamasStraightFire.ts): the gun snaps
  // straight like in ADS while firing, then returns to Hold very quickly.
  // Derived at load (WaterFamasWeapon awaits it before equipping). The aimed
  // burst (fireAim) is already straight and stays as authored.
  fpActions: {
    fire: { clip: profileJson.fpActions.fire.clip + "_Straight", loop: false },
    fireAim: profileJson.fpActions.fireAim,
    reload: profileJson.fpActions.reload,
  },
  tpClips: {
    hold: profileJson.tpClips.hold,
    run: profileJson.tpClips.run,
    actions: {
      fire: profileJson.tpClips.actions.fire,
      reload: profileJson.tpClips.actions.reload,
    },
  },
  upperBodyMask: profileJson.upperBodyMask,
  weaponInspectClip: profileJson.inspection.weaponClip,
  inspectDuration: profileJson.inspection.duration,
};

/** TP ADS trio (for PotatoCharacter, same role as the HexSniper's TP Aim/Raise/Lower). */
export const WATER_FAMAS_TP_AIM_CLIPS = {
  aim: profileJson.tpClips.aim,
  raise: profileJson.tpClips.raise,
  lower: profileJson.tpClips.lower,
} as const;

/** Authored FP clips the straight hip burst is derived from (Aim pose = new base). */
export const WATER_FAMAS_STRAIGHT_FIRE = {
  aim: profileJson.fpClips.aim,
  fire: profileJson.fpActions.fire.clip,
} as const;

/** Action timelines (seconds) consumed by WaterFamasController. */
export const WATER_FAMAS_TIMELINE = profileJson.actions;
