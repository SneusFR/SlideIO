import { MapId, MAP_REGISTRY, isMapId } from "../../shared/map/MapRegistry";
import type { MatchResults } from "../../shared/match/MatchResultsTracker";
import { compareMatchStats, type PlayerMatchStats } from "../stats/MatchStatsManager";
import type { EndScreenMap, EndScreenMatchData } from "../endscreen/EndScreen";
import jungleThumb from "../endscreen/maps/jungle.webp";
import yardThumb from "../endscreen/maps/yard.webp";
import givreThumb from "../endscreen/maps/givre.webp";

/**
 * Converts the game's REAL end-of-match results into the EndScreen data
 * format (src/endscreen/README.md): ranking with the leaderboard's own
 * comparator, vote cards with the real map screenshots.
 */

/** Vote card per map: real in-game screenshot (tools/endscreen) + tagline. */
const MAP_CARDS: Record<MapId, { image: string; subtitle: string }> = {
  [MapId.JUNGLE]: { image: jungleThumb, subtitle: "Cité antique · 8 joueurs" },
  [MapId.YARD]: { image: yardThumb, subtitle: "Cour industrielle · 8 joueurs" },
  [MapId.GIVRE]: { image: givreThumb, subtitle: "Station alpine · 8 joueurs" },
};

/** Card display name: "JUNGLE CITY" → "Jungle City" (the card uppercases it). */
function prettyName(id: MapId): string {
  return MAP_REGISTRY[id].name.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

export function endScreenMaps(ids: readonly string[]): EndScreenMap[] {
  return ids.filter(isMapId).map((id) => ({
    id,
    name: prettyName(id),
    subtitle: MAP_CARDS[id].subtitle,
    image: MAP_CARDS[id].image,
  }));
}

/**
 * Build the EndScreen payload. The placement uses `compareMatchStats` (the
 * exact rules of the in-game leaderboard): kills → deaths → assists → K/D.
 * `stableId` breaks perfect ties deterministically (identical on every
 * client in multiplayer since it only depends on the shared results).
 */
export function buildEndScreenData(
  results: MatchResults,
  localPlayerId: string,
  mapId: string,
  voteMapIds: readonly string[],
): EndScreenMatchData {
  const order = [...results.players].sort((a, b) => a.id.localeCompare(b.id));
  const rows: (PlayerMatchStats & { key: string })[] = order.map((p, i) => ({
    key: p.id,
    combatantId: i,
    displayName: p.name,
    isLocalPlayer: p.id === localPlayerId,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
  }));
  rows.sort(compareMatchStats);
  const rank = new Map(rows.map((r, i) => [r.key, i + 1]));

  return {
    mode: "FFA",
    mapName: isMapId(mapId) ? prettyName(mapId) : "",
    duration: results.duration,
    localPlayerId,
    players: results.players.map((p) => ({
      id: p.id,
      name: p.name,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      rank: rank.get(p.id),
      // Score shown on the board / pill: 100 per kill, 50 per assist.
      score: p.kills * 100 + p.assists * 50,
      damage: p.damage,
      shotsFired: p.shotsFired,
      shotsHit: p.shotsHit,
    })),
    killFeed: results.killFeed,
    maps: endScreenMaps(voteMapIds),
  };
}
