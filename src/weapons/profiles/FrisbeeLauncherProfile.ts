import type { WeaponViewProfile } from "./WeaponProfile";
// Vite-resolved asset URLs (same bundler-safe ?url table as HexSniperProfile / PaintballRifleProfile).
import weaponUrl from "../../assets/potato/FrisbeeLauncher_Weapon.glb?url";
import fpPosesUrl from "../../assets/potato/FrisbeeLauncher_FP_Poses.glb?url";
import tpPosesUrl from "../../assets/potato/FrisbeeLauncher_TP_Poses.glb?url";
// Authored integration data (mount matrices, clips, action timelines).
import profileJson from "../../assets/potato/WeaponProfile_FrisbeeLauncher.json";

/**
 * Frisbee Launcher presentation profile — TWO-HANDED crossbow that throws flying discs (1 on the deck + a 5-disc cage),
 * built on the HexSniper conventions: mount matrices straight from WeaponProfile_FrisbeeLauncher.json (applied once,
 * column-major, no extra scaling; the weapon root keeps its own 0.19), pose clips on the common FP arms.
 *
 * Priority actions (ViewmodelSystem.playAction keys):
 *   "fire" / "fireAim"         — throw the disc + automatic re-cock (pull the sled, take a disc from the cage, lay it)
 *   "fireLast" / "fireLastAim" — throw the last disc (cage empty: the launcher stays empty)
 *   "reload"                   — swap the cage (the deck was loaded)
 *   "reloadEmpty"              — swap the cage + re-cock
 * FrisbeeLauncherController starts the weapon clip THE SAME FRAME as the arms action.
 */
export const FrisbeeLauncherProfile: WeaponViewProfile = {
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
  fpActions: {
    fire: profileJson.fpActions.fire,
    fireAim: profileJson.fpActions.fireAim,
    fireLast: profileJson.fpActions.fireLast,
    fireLastAim: profileJson.fpActions.fireLastAim,
    reload: profileJson.fpActions.reload,
    reloadEmpty: profileJson.fpActions.reloadEmpty,
  },
  tpClips: {
    hold: profileJson.tpClips.hold,
    run: profileJson.tpClips.run,
    actions: {
      fire: profileJson.tpClips.actions.fire,
      fireLast: profileJson.tpClips.actions.fireLast,
      reload: profileJson.tpClips.actions.reload,
      reloadEmpty: profileJson.tpClips.actions.reloadEmpty,
    },
  },
  upperBodyMask: profileJson.upperBodyMask,
  weaponInspectClip: profileJson.inspection.weaponClip,
  inspectDuration: profileJson.inspection.duration,
};

/** TP ADS trio (for PotatoCharacter, same role as the HexSniper's TP Aim/Raise/Lower). */
export const FRISBEE_LAUNCHER_TP_AIM_CLIPS = {
  aim: profileJson.tpClips.aim,
  raise: profileJson.tpClips.raise,
  lower: profileJson.tpClips.lower,
} as const;

/** Action timelines (seconds) consumed by FrisbeeLauncherController. */
export const FRISBEE_LAUNCHER_TIMELINE = profileJson.actions;
