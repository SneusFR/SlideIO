import * as THREE from "three";

/**
 * COMMON WEAPON-PROFILE CONTRACT of the shared first/third-person weapon
 * presentation system.
 *
 * A profile describes everything presentation-related for ONE weapon:
 * asset URLs, mount matrices (how the whole weapon scene sits under the
 * rig's Weapon_R socket), the clip names of its FP/TP pose libraries and
 * its presentation rules. Gameplay classes (damage, projectiles,
 * raycasts, cooldowns) are NOT part of a profile — they keep their
 * existing weapon classes; a small per-weapon adapter bridges the two.
 *
 * The HexSniper is the first full integration (HexSniperProfile).
 * Future weapons (hammer, spear, revolver, plasma, BassBlaster, poison,
 * obliterreur) get their own profile once their pose libraries are
 * authored — until then they keep their legacy viewmodel adapters.
 *
 * TUNING A FUTURE WEAPON'S POSE: add its authored pose GLBs, then fill
 * `fpMount`/`tpMount` with the exported column-major matrices (applied
 * ONCE via Matrix4.fromArray — never transposed, never re-scaled) and the
 * clip names below. Nothing else in the system needs to change.
 */
export interface WeaponViewProfile {
  id: string;
  /** Whole-weapon GLB (scene + skeleton + internal animations). */
  weaponUrl: string;
  /** FP pose library GLB (clips only, no meshes) for the common arms. */
  fpPosesUrl: string;
  /** Column-major mount matrix under the FP rig's Weapon_R socket. */
  fpMount: number[];
  /** Column-major mount matrix under the TP character's Weapon_R socket. */
  tpMount: number[];
  /** FP arm clip names (resolved on the shared FP arms rig). */
  fpClips: {
    hold: string;
    run: string;
    aim: string;
    raise: string;
    lower: string;
    inspect?: string;
  };
  /** Weapon-internal inspection clip (played on the weapon's own mixer). */
  weaponInspectClip?: string;
  /** Inspection duration (seconds) — arms + weapon clips are equal. */
  inspectDuration?: number;
}

/** Build a mount group applying a profile matrix EXACTLY once. */
export function createWeaponMount(name: string, matrixColumnMajor: number[]): THREE.Group {
  const mount = new THREE.Group();
  mount.name = name;
  // Matrix4.fromArray consumes column-major data as delivered in the
  // profile — no transposition, no extra scale (the ~0.4 FP / ~0.35 TP
  // factors are already inside; the weapon root keeps its own 0.19).
  mount.matrix.fromArray(matrixColumnMajor);
  mount.matrixAutoUpdate = false;
  return mount;
}
