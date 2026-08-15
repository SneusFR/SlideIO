import * as THREE from "three";

/**
 * Main Menu configuration — everything visual that may need hand-tuning
 * lives here (weapon grips, camera framing, background density, colors).
 */

/** Hardcoded player info shown top-left. Swap for real data later. */
export const playerProfile = {
  name: "VALENTIN",
  level: 27,
  levelProgress: 0.62, // 0..1 XP bar fill
  currency: 1_245_870,
};

/**
 * Weapon → hand-bone attachments. The GLB weapons are normalized
 * (centered, uniformly scaled) before these offsets apply, so tweaking
 * is intuitive: position in meters relative to the hand bone, rotation
 * in radians, scale = world length of the weapon's longest axis.
 */
export interface WeaponAttachment {
  /** Skeleton bone name the weapon parents to. */
  bone: string;
  position: THREE.Vector3;
  rotation: THREE.Euler;
  /** Target world length (longest dimension, meters). */
  size: number;
}

export const hammerAttachment: WeaponAttachment = {
  bone: "RightHand",
  position: new THREE.Vector3(0.02, 0.16, 0.05),
  rotation: new THREE.Euler(0.15, 0, -0.2),
  size: 1.05,
};

export const plasmaAttachment: WeaponAttachment = {
  bone: "LeftHand",
  position: new THREE.Vector3(-0.02, 0.14, 0.06),
  rotation: new THREE.Euler(0.35, Math.PI / 2, 0.1),
  size: 0.95,
};

export const MenuSceneConfig = {
  /** Normalized character height (meters). */
  characterHeight: 1.8,
  /** Horizontal offset pushing the character to the right of the screen. */
  characterOffsetX: 0.95,

  camera: {
    fov: 33,
    position: new THREE.Vector3(0, 1.05, 4.6),
    lookAt: new THREE.Vector3(0, 0.92, 0),
  },

  colors: {
    violet: 0xa855f7,
    violetBright: 0xc084fc,
    violetDeep: 0x7c3aed,
    keyLight: 0xf2ecff,
    fillLight: 0x8090c0,
  },

  /** Mouse parallax: max offsets in world units / radians. Very subtle. */
  parallax: {
    cameraShift: 0.06,
    backgroundShift: 0.035,
    smoothing: 2.5,
  },

  background: {
    starCountFar: 900,
    starCountNear: 350,
    dustCount: 120,
    nebulaSprites: 5,
  },
};