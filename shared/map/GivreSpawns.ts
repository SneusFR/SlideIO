/**
 * SHARED GIVRE 01 spawn points — pure DATA, no Three.js.
 *
 * AUTO-GENERATED from src/assets/MAP/Givre/givre_01.physics.json
 * by scripts/generate-givre-colliders.mjs — DO NOT EDIT BY HAND.
 *
 * Positions are CAPSULE CENTERS (capsule 0.55 half-height / 0.35 radius,
 * small ground margin already included — the export's "position", NOT the
 * "feet" field). yaw is in radians (Object3D.rotation.y, 0 = facing -Z);
 * each spawn faces the centre of its corner room. Used by the frontend
 * SpawnManager AND the backend RespawnManager so both sides always agree.
 */
import type { MapSpawnPoint } from "./MapSpawns";

export const GIVRE_SPAWN_POINTS: MapSpawnPoint[] = [
  { x: -115, y: 0.93, z: -115, yaw: -2.37958 }, // SPAWN_01 (STOCK)
  { x: -116, y: 0.93, z: -70, yaw: -0.75763 }, // SPAWN_02 (STOCK)
  { x: 115, y: 0.93, z: -70, yaw: 0.73132 }, // SPAWN_03 (CHAUFFERIE)
  { x: 98, y: 0.93, z: -118, yaw: -3.29122 }, // SPAWN_04 (CHAUFFERIE)
  { x: -120, y: 0.93, z: 90, yaw: -1.69575 }, // SPAWN_05 (ATELIER)
  { x: -115, y: 0.93, z: 117, yaw: -0.72106 }, // SPAWN_06 (ATELIER)
  { x: 116, y: 0.93, z: 117, yaw: 0.74147 }, // SPAWN_07 (TRANSIT)
  { x: 115, y: 0.93, z: 96, yaw: 1.43903 }, // SPAWN_08 (TRANSIT)
];
