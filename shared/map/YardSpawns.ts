/**
 * SHARED YARD 01 Expanded spawn points — pure DATA, no Three.js.
 *
 * AUTO-GENERATED from src/assets/MAP/Yard/yard_01.physics.json
 * by scripts/generate-yard-colliders.mjs — DO NOT EDIT BY HAND.
 *
 * Positions are CAPSULE CENTERS (capsule 0.55 half-height / 0.35 radius,
 * small ground margin already included — the export's "position", NOT the
 * "feet" field). yaw is in radians (0 = facing -Z). Used by the frontend
 * SpawnManager AND the backend RespawnManager so both sides always agree.
 */
import type { MapSpawnPoint } from "./MapSpawns";

export const YARD_SPAWN_POINTS: MapSpawnPoint[] = [
  { x: -36, y: 0.93, z: 99, yaw: 0 }, // S01
  { x: 36, y: 0.93, z: 99, yaw: 0 }, // S02
  { x: -40, y: 5.73, z: -49, yaw: 4.71238898038469 }, // S03
  { x: 40, y: 5.73, z: -49, yaw: 1.5707963267948966 }, // S04
  { x: -11, y: 5.73, z: -48, yaw: 3.141592653589793 }, // S05
  { x: 11, y: 5.73, z: -47, yaw: 3.141592653589793 }, // S06
  { x: -37, y: 0.93, z: 4, yaw: 0 }, // S07
  { x: 37, y: 0.93, z: 4, yaw: 0 }, // S08
];
