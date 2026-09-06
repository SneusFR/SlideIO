import type { WeaponViewProfile } from "./WeaponProfile";
// Vite-resolved asset URLs (the profile JSON's file names are relative to
// the assets folder, NOT to the page URL — this explicit ?url import table
// is the bundler-safe resolution, valid in dev AND production builds).
import weaponUrl from "../../assets/potato/HexSniper_Weapon.glb?url";
import fpPosesUrl from "../../assets/potato/HexSniper_FP_Poses.glb?url";
// Authored integration data (mount matrices, clips, camera, contacts).
import profileJson from "../../assets/potato/WeaponProfile_HexSniper.json";

/** Reference FP camera parameters from the authored profile. */
export const HEX_FP_CAMERA = {
  verticalFovDegrees: profileJson.camera.verticalFovDegrees,
  near: profileJson.camera.near,
  far: profileJson.camera.far,
} as const;

/**
 * HexSniper presentation profile — mount matrices and clip names come
 * straight from the authored WeaponProfile_HexSniper.json (applied once,
 * column-major, no extra scaling; see WeaponProfile).
 */
export const HexSniperProfile: WeaponViewProfile = {
  id: profileJson.id,
  weaponUrl,
  fpPosesUrl,
  fpMount: profileJson.mounts.fp.matrixColumnMajor,
  tpMount: profileJson.mounts.tp.matrixColumnMajor,
  fpClips: {
    hold: "FP_HexSniper_Hold",
    run: "FP_HexSniper_Run",
    aim: "FP_Aim_HexSniper",
    raise: "FP_Raise_HexSniper",
    lower: "FP_Lower_HexSniper",
    inspect: "FP_Inspect_HexSniper",
  },
  weaponInspectClip: profileJson.inspection.creatureClip,
  inspectDuration: profileJson.inspection.duration,
};
