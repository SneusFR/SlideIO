/**
 * SHARED end-of-match statistics — pure TS, no Three.js / Colyseus.
 *
 * Kills / deaths / assists already have an authoritative owner (server
 * NetworkPlayer in multiplayer, MatchStatsManager in solo). This tracker
 * records what the END SCREEN needs on top of them:
 *   - the kill feed (rival / prey / best streak / momentum curve),
 *   - damage dealt to other players,
 *   - accuracy (shots fired / shots that hit).
 *
 * Accuracy rules (identical in solo and multiplayer):
 *   - DISCRETE weapons: one fired projectile / bullet / jet / throw = one
 *     shot; a shot "hits" when it damages a player. Several victims of the
 *     same shot (shotgun pellets, explosion) count once: hits of the same
 *     attacker + weapon at the same `stamp` are merged.
 *   - Melee, killstreaks and the Hex Sniper bite are not
 *     aimed shots: they count for damage only.
 */

/** Damage tags (KillMethod / DamageType strings) counted as discrete hits. */
const DISCRETE_HIT_TAGS: ReadonlySet<string> = new Set([
  "HEX_SNIPER_TONGUE",
  "GOOFY_BASKET",
  "POPCORN_SHOTGUN",
  "PAINTBALL_RIFLE",
  "WATER_FAMAS",
  "FRISBEE_LAUNCHER",
]);


/**
 * Server-confirmed weapon actions that are one fired shot each
 * (WEAPON_ACTION_CONFIRMED `action` field).
 */
const SHOT_ACTIONS: ReadonlySet<string> = new Set([
  "HEX_TONGUE_HIT",
  "HEX_TONGUE_MISS",
  "BASKET_THROW",
  "POPCORN_FIRE",
  "PAINTBALL_FIRE",
  "WATER_FAMAS_FIRE",
  "FRISBEE_FIRE",
]);


/** Upper bound of kill-feed entries kept (bounded network payload). */
const MAX_FEED = 800;

export interface MatchKillEntry {
  /** Seconds since the match start. */
  t: number;
  /** Killer id, or null (environment / suicide). */
  killer: string | null;
  victim: string;
  assisters: string[];
}

/** Authoritative K/D/A row supplied by the caller when building results. */
export interface MatchPlayerBase {
  id: string;
  name: string;
  kills: number;
  deaths: number;
  assists: number;
}

export interface MatchPlayerResult extends MatchPlayerBase {
  damage: number;
  shotsFired: number;
  shotsHit: number;
}

export interface MatchResults {
  /** Played seconds. */
  duration: number;
  players: MatchPlayerResult[];
  killFeed: MatchKillEntry[];
}

interface Entry {
  damage: number;
  shots: number;
  hits: number;
  /** Last discrete hit key ("TAG@stamp") — merges multi-victim shots. */
  lastHitKey: string;
}

export class MatchResultsTracker {
  private readonly entries = new Map<string, Entry>();
  private feed: MatchKillEntry[] = [];

  /** Fresh match: every counter and the kill feed cleared. */
  reset(): void {
    this.entries.clear();
    this.feed = [];
  }

  /** A participant left: drop its counters (its feed entries stay). */
  remove(id: string): void {
    this.entries.delete(id);
  }

  /** True when a server-confirmed weapon action is one fired shot. */
  static isShotAction(action: string): boolean {
    return SHOT_ACTIONS.has(action);
  }

  /** One discrete shot fired by `id`. */
  recordShot(id: string): void {
    this.entry(id).shots += 1;
  }

  /** Damage dealt by `attackerId` to ANOTHER player (self / world ignored). */
  recordDamage(attackerId: string | null, victimId: string, amount: number): void {
    if (attackerId === null || attackerId === victimId || !(amount > 0)) return;
    this.entry(attackerId).damage += amount;
  }

  /**
   * A hit landed with weapon `tag` (KillMethod / DamageType string).
   * `stamp` identifies the simulation instant (server ms / client frame):
   * the same attacker + tag + stamp counts once.
   */
  recordHit(attackerId: string | null, victimId: string, tag: string, stamp: number): void {
    if (attackerId === null || attackerId === victimId) return;
    if (!DISCRETE_HIT_TAGS.has(tag)) return;
    const e = this.entry(attackerId);
    const key = `${tag}@${stamp}`;
    if (e.lastHitKey === key) return;
    e.lastHitKey = key;
    e.hits += 1;
  }

  recordKill(t: number, killerId: string | null, victimId: string, assisterIds: readonly string[]): void {
    if (this.feed.length >= MAX_FEED) return;
    this.feed.push({
      t: Math.max(0, Math.round(t * 10) / 10),
      killer: killerId !== null && killerId !== victimId ? killerId : null,
      victim: victimId,
      assisters: assisterIds.filter((id) => id !== victimId && id !== killerId),
    });
  }

  /** Merge the authoritative K/D/A rows with the tracked extras. */
  build(players: readonly MatchPlayerBase[], duration: number): MatchResults {
    return {
      duration: Math.max(1, Math.round(duration)),
      players: players.map((p) => {
        const e = this.entries.get(p.id);
        const shots = e?.shots ?? 0;
        return {
          id: p.id,
          name: p.name,
          kills: p.kills,
          deaths: p.deaths,
          assists: p.assists,
          damage: Math.round(e?.damage ?? 0),
          shotsFired: shots,
          shotsHit: Math.min(shots, e?.hits ?? 0),
        };
      }),
      killFeed: this.feed.slice(),
    };
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) {
      e = { damage: 0, shots: 0, hits: 0, lastHitKey: "" };
      this.entries.set(id, e);
    }
    return e;
  }
}

/** Defensive parse of a MATCH_ENDED payload received over the network. */
export function sanitizeMatchResults(raw: unknown): MatchResults | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { duration?: unknown; players?: unknown; killFeed?: unknown };
  if (!Array.isArray(r.players)) return null;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const players: MatchPlayerResult[] = [];
  for (const p of r.players as Record<string, unknown>[]) {
    if (!p || typeof p.id !== "string") continue;
    players.push({
      id: p.id,
      name: (typeof p.name === "string" ? p.name : "PLAYER").slice(0, 24),
      kills: num(p.kills),
      deaths: num(p.deaths),
      assists: num(p.assists),
      damage: num(p.damage),
      shotsFired: num(p.shotsFired),
      shotsHit: num(p.shotsHit),
    });
  }
  if (players.length === 0) return null;
  const killFeed: MatchKillEntry[] = [];
  if (Array.isArray(r.killFeed)) {
    for (const e of r.killFeed as Record<string, unknown>[]) {
      if (!e || typeof e.victim !== "string") continue;
      killFeed.push({
        t: num(e.t),
        killer: typeof e.killer === "string" ? e.killer : null,
        victim: e.victim,
        assisters: Array.isArray(e.assisters)
          ? e.assisters.filter((a): a is string => typeof a === "string")
          : [],
      });
    }
  }
  return { duration: Math.max(1, num(r.duration)), players, killFeed };
}
