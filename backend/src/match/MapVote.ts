import { MapId, isMapId } from "../../../shared/map/MapRegistry";

/**
 * Server-side end-of-match MAP VOTE (pure logic, no Colyseus types).
 * One vote per player, changeable until the vote closes; ballots of
 * players who leave are dropped. The winner is the most-voted map, ties
 * broken at random (no vote at all → random map among the options).
 */
export class MapVote {
  private readonly ballots = new Map<string, MapId>();
  private closed = false;

  constructor(readonly options: readonly MapId[]) {}

  get isClosed(): boolean {
    return this.closed;
  }

  /** Register / change a ballot. Returns true when the tally changed. */
  cast(playerId: string, raw: unknown): boolean {
    if (this.closed || !isMapId(raw) || !this.options.includes(raw)) return false;
    if (this.ballots.get(playerId) === raw) return false;
    this.ballots.set(playerId, raw);
    return true;
  }

  /** Drop a leaving player's ballot. Returns true when the tally changed. */
  remove(playerId: string): boolean {
    return !this.closed && this.ballots.delete(playerId);
  }

  /** { mapId: [playerIds] } — the shape the end screen consumes. */
  tally(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const id of this.options) out[id] = [];
    for (const [playerId, mapId] of this.ballots) out[mapId].push(playerId);
    return out;
  }

  /** Close the vote and pick the winner (random among tied maps). */
  close(random: () => number = Math.random): MapId {
    this.closed = true;
    const counts = this.tally();
    let best = -1;
    let tied: MapId[] = [];
    for (const id of this.options) {
      const n = counts[id].length;
      if (n > best) {
        best = n;
        tied = [id];
      } else if (n === best) {
        tied.push(id);
      }
    }
    return tied[Math.min(tied.length - 1, Math.floor(random() * tied.length))];
  }
}
