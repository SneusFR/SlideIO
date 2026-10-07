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
  { x: 98, y: 0.93, z: -118, yaw: 2.99197 }, // SPAWN_04 (CHAUFFERIE)
  { x: -100, y: 0.93, z: 59, yaw: -1.45619 }, // SPAWN_05 (VESTIBULE_SUD_OUEST)
  { x: -98, y: 0.93, z: 27, yaw: -1.5405 }, // SPAWN_06 (VESTIBULE_SUD_OUEST)
  { x: 96, y: 0.93, z: 59, yaw: 1.23471 }, // SPAWN_07 (COUDE_EST)
  { x: 101, y: 0.93, z: 38, yaw: 0.36461 }, // SPAWN_08 (COUDE_EST)
];
