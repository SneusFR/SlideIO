import { PlayerMatchStats, getKDRatio } from "../stats/MatchStatsManager";

/** Internal per-row DOM handle (one row per participant, reconciled by id). */
interface RowRefs {
  el: HTMLDivElement;
  rank: HTMLSpanElement;
  ping: HTMLSpanElement;
  name: HTMLSpanElement;
  k: HTMLSpanElement;
  d: HTMLSpanElement;
  a: HTMLSpanElement;
  kd: HTMLSpanElement;
}

/** Glanceable ping color buckets (ms → CSS class suffix). */
function pingClass(pingMs: number): string {
  if (pingMs < 60) return "good";
  if (pingMs < 120) return "ok";
  if (pingMs < 200) return "bad";
  return "awful";
}

/**
 * Live FFA mini-leaderboard (top-right): rank / name / K / D / A / K/D for
 * every participant, ranked by kills. Pure presentation — it only renders
 * what the MatchStatsManager reports, and ONLY when stats actually change
 * (kill / death / assist / bot added / bot removed). Never rebuilt per frame.
 *
 * Rows are absolutely positioned and moved with translateY so a rank change
 * animates with a short CSS transition instead of snapping.
 */
export class LeaderboardHUD {
  private static readonly ROW_HEIGHT = 21; // px — must match .lb-row in CSS

  private readonly root = document.getElementById("leaderboard-hud") as HTMLDivElement;
  private readonly rowsEl = document.getElementById("leaderboard-rows") as HTMLDivElement;

  private readonly rows = new Map<number, RowRefs>();
  /** Local player's last kill count → subtle pulse when it increases. */
  private lastLocalKills = 0;

  /** Re-render from the sorted stats (call only when stats changed). */
  refresh(sorted: PlayerMatchStats[]): void {
    const seen = new Set<number>();

    // MULTIPLAYER rows carry a ping — the panel switches to the grid that
    // includes the ping column. Local mode (bots) keeps the classic grid.
    const withPing = sorted.some((s) => s.pingMs !== undefined);
    this.root.classList.toggle("with-ping", withPing);

    sorted.forEach((s, index) => {
      seen.add(s.combatantId);
      let row = this.rows.get(s.combatantId);
      const isNew = !row;
      if (!row) {
        row = this.createRow(s);
        this.rows.set(s.combatantId, row);
      }

      row.rank.textContent = String(index + 1);
      if (s.pingMs !== undefined) {
        row.ping.textContent = `${Math.min(999, Math.round(s.pingMs))}`;
        row.ping.className = `lb-ping ${pingClass(s.pingMs)}`;
      } else {
        row.ping.textContent = "";
        row.ping.className = "lb-ping";
      }
      row.k.textContent = String(s.kills);
      row.d.textContent = String(s.deaths);
      row.a.textContent = String(s.assists);
      row.kd.textContent = getKDRatio(s).toFixed(2);
      row.el.style.transform = `translateY(${index * LeaderboardHUD.ROW_HEIGHT}px)`;

      // New rows are positioned BEFORE insertion → no fake slide-in animation.
      if (isNew) this.rowsEl.appendChild(row.el);

      // Subtle violet pulse on the local row when a kill lands (the medal
      // system stays the primary feedback — this is just a glance cue).
      if (s.isLocalPlayer) {
        if (s.kills > this.lastLocalKills) {
          row.el.classList.remove("kill-pulse");
          void row.el.offsetWidth; // reflow → retrigger the one-shot animation
          row.el.classList.add("kill-pulse");
        }
        this.lastLocalKills = s.kills;
      }
    });

    // Participants gone (bot removed from the Escape menu): clean removal.
    for (const [id, row] of this.rows) {
      if (!seen.has(id)) {
        row.el.remove();
        this.rows.delete(id);
      }
    }

    this.rowsEl.style.height = `${sorted.length * LeaderboardHUD.ROW_HEIGHT}px`;
    this.root.classList.toggle("hidden", sorted.length === 0);
  }

  private createRow(s: PlayerMatchStats): RowRefs {
    const el = document.createElement("div");
    el.className = s.isLocalPlayer ? "lb-row local" : "lb-row";

    const rank = document.createElement("span");
    rank.className = "lb-rank";

    const ping = document.createElement("span");
    ping.className = "lb-ping";

    const name = document.createElement("span");
    name.className = "lb-name";
    name.textContent = s.displayName.toUpperCase();
    if (s.isLocalPlayer) {
      const you = document.createElement("span");
      you.className = "lb-you";
      you.textContent = "YOU";
      name.appendChild(you);
    }

    const k = document.createElement("span");
    k.className = "lb-k";
    const d = document.createElement("span");
    d.className = "lb-d";
    const a = document.createElement("span");
    a.className = "lb-a";
    const kd = document.createElement("span");
    kd.className = "lb-kd";

    el.append(rank, ping, name, k, d, a, kd);
    return { el, rank, ping, name, k, d, a, kd };
  }
}