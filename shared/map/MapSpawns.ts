/**
 * SHARED spawn points — pure DATA, no Three.js.
 *
 * AUTO-GENERATED from src/assets/MAP/ancient_jungle_city.physics.json
 * by scripts/generate-map-colliders.mjs — DO NOT EDIT BY HAND.
 *
 * Positions are CAPSULE CENTERS (capsule 0.55 half-height / 0.35 radius,
 * small ground margin already included). yaw is in radians (0 = facing -Z).
 * Used by the frontend SpawnManager AND the backend RespawnManager so
 * both sides always agree on where players can appear.
 */
export interface MapSpawnPoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export const MAP_SPAWN_POINTS: MapSpawnPoint[] = [
  { x: -47, y: 0.93, z: 48, yaw: 0 }, // spawn_01
  { x: -47, y: 1.055, z: -49, yaw: 3.141592653589793 }, // spawn_02
  { x: -12, y: 3.93, z: -48, yaw: 3.141592653589793 }, // spawn_03
  { x: 12, y: 3.93, z: -48, yaw: 3.141592653589793 }, // spawn_04
  { x: 47, y: 1.68, z: -49, yaw: 3.141592653589793 }, // spawn_05
  { x: 47, y: 0.93, z: 49, yaw: 0 }, // spawn_06
  { x: -12, y: -0.57, z: 48, yaw: 0 }, // spawn_07
  { x: 12, y: -0.57, z: 48, yaw: 0 }, // spawn_08
];
