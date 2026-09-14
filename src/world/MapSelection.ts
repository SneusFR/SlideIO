import { DEFAULT_MAP_ID, isMapId, MapId, MAP_REGISTRY } from "../../shared/map/MapRegistry";

/**
 * Persisted map selection (solo AND multiplayer lobby creation).
 *
 * The map is loaded ONCE during the single boot loading phase (same
 * pattern as the graphics-quality preset): changing it saves the new id
 * and reloads the page. Joining a lobby that plays another map follows
 * the same route (save + reload to /join/{roomId}).
 */
const STORAGE_KEY = "slideio.mapId";

export function loadMapSelection(): MapId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isMapId(raw) ? raw : DEFAULT_MAP_ID;
  } catch {
    return DEFAULT_MAP_ID;
  }
}

export function saveMapSelection(mapId: MapId): void {
  try {
    localStorage.setItem(STORAGE_KEY, mapId);
  } catch {
    /* private browsing — non-fatal */
  }
}

/** Display name for menus ("JUNGLE CITY" / "YARD 01"). */
export function mapDisplayName(mapId: MapId): string {
  return MAP_REGISTRY[mapId].name;
}

/** The next map in the cycle (MAP row of the server panel). */
export function nextMapId(current: MapId): MapId {
  const ids = Object.values(MapId);
  return ids[(ids.indexOf(current) + 1) % ids.length];
}

/** Every playable map, in registry order (lobby creation map picker). */
export function listMaps(): { id: MapId; name: string }[] {
  return Object.values(MapId).map((id) => ({ id, name: MAP_REGISTRY[id].name }));
}
