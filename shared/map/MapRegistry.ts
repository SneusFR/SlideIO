/**
 * SHARED map registry — pure DATA, no Three.js / Rapier / Colyseus.
 *
 * Single source of truth for every playable map: its network id, display
 * name, backend hitscan boxes, spawn points and hazard zones. Imported by
 * BOTH the frontend (map selection, solo spawns) and the backend
 * (per-room hit detection, respawns, authoritative acid).
 *
 * Adding a map = one entry here + its frontend visual loader.
 */
import { MAP_COLLIDER_BOXES, type ColliderBox } from "./MapColliders";
import { MAP_SPAWN_POINTS, type MapSpawnPoint } from "./MapSpawns";
import {
  YARD_COLLIDER_BOXES,
  YARD_HAZARD_ZONES,
  type HazardZone,
} from "./YardColliders";
import { YARD_SPAWN_POINTS } from "./YardSpawns";

/** Stable network identity of every playable map. */
export enum MapId {
  JUNGLE = "JUNGLE",
  YARD = "YARD",
}

export function isMapId(raw: unknown): raw is MapId {
  return typeof raw === "string" && (Object.values(MapId) as string[]).includes(raw);
}

/** The default map (existing behavior — Ancient Jungle City). */
export const DEFAULT_MAP_ID = MapId.JUNGLE;

export interface MapDefinition {
  id: MapId;
  /** Short display name (menus / lobby browser rows). */
  name: string;
  /** Backend hitscan world (AABB list — walls occlude shots). */
  colliderBoxes: ColliderBox[];
  /** Capsule-center spawn points shared by both sides. */
  spawnPoints: MapSpawnPoint[];
  /** Server-authoritative danger volumes (empty = no hazards). */
  hazards: HazardZone[];
  /** Y below which a player is out of the world (safety respawn / death). */
  killPlaneY: number;
}

export const MAP_REGISTRY: Record<MapId, MapDefinition> = {
  [MapId.JUNGLE]: {
    id: MapId.JUNGLE,
    name: "JUNGLE CITY",
    colliderBoxes: MAP_COLLIDER_BOXES,
    spawnPoints: MAP_SPAWN_POINTS,
    hazards: [],
    killPlaneY: -25,
  },
  [MapId.YARD]: {
    id: MapId.YARD,
    name: "YARD 01",
    colliderBoxes: YARD_COLLIDER_BOXES,
    spawnPoints: YARD_SPAWN_POINTS,
    hazards: YARD_HAZARD_ZONES,
    // The acid pool floor sits at −3 m; the arena never goes lower. Keep a
    // margin so ragdolls/knockbacks never trip it accidentally.
    killPlaneY: -25,
  },
};

/** Registry lookup with a safe fallback to the default map. */
export function getMapDefinition(raw: unknown): MapDefinition {
  return isMapId(raw) ? MAP_REGISTRY[raw] : MAP_REGISTRY[DEFAULT_MAP_ID];
}
