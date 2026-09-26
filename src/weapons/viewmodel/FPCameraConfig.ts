/**
 * COMMON first-person camera reference of the shared viewmodel system.
 *
 * Every authored weapon profile (HexSniper, BrickMaul, GoofyBasket) is
 * exported against this SAME projection — vertical FOV 65°, near 0.01,
 * far 100, axes +X right / +Y up / -Z forward. It belongs to the
 * ViewmodelSystem, not to any single weapon: a new weapon's pose library
 * must be authored for these values (see its WeaponProfile_*.json `camera`).
 */
export const FP_CAMERA = {
  verticalFovDegrees: 65,
  near: 0.01,
  far: 100,
} as const;
