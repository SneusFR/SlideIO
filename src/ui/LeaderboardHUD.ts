import { PlayerMatchStats } from "../stats/MatchStatsManager";
import { AnimHost } from "./leaderboard/leaderboardAnim";
import { Crown, CrownMove } from "./leaderboard/leaderboardCrown";
import { ParticlePool } from "./leaderboard/leaderboardFx";
import {
  LB_GEOM,
  LbDiff,
  LbEntry,
  crownOwner,
  diffLeaderboard,
  layoutSlots,
  sameSnapshot,
} from "./leaderboard/leaderboardLogic";
import { LbMotion, NORMAL, REDUCED } from "./leaderboard/leaderboardMotion";
import { RowMover } from "./leaderboard/leaderboardMoves";
import { Row, cancelRowAnims, createRow, displayedY, popScore, showGain, updateRow } from "./leaderboard/leaderboardRows";

/** Width of the reference frame the design was drawn on. */
const REF_WIDTH = 1816;

const y = (px: number): string => `translateY(${px}px)`;

/**
 * FFA leaderboard (top-right): five separate capsules under a cream
 * "CLASSEMENT" tab. Pure presentation: it receives the list already sorted by
 * the official rules (compareMatchStats) and never re-sorts or re-ranks.
 *
 *  - Rows are keyed by the stable player id and created ONCE; an update only
 *    touches what changed (FLIP: rows move from where they are DRAWN to their
 *    target slot, with the Web Animations API).
 *  - An update arriving mid-move restarts from the drawn position and heads
 *    for the latest target: nothing is queued, nothing teleports.
 *  - At rest nothing runs: no rAF, no timers, zero animations.
 */
export class LeaderboardHUD {
  private readonly root = document.getElementById("leaderboard-hud") as HTMLDivElement;
  private readonly list = document.getElementById("lb-list") as HTMLDivElement;
  private readonly host = new AnimHost();
  private readonly crown = new Crown(this.host);
  private readonly fx: ParticlePool;
  private readonly mover: RowMover;
  private readonly rows = new Map<number, Row>();
  /** Rows of players who left, fading out (tracked so dispose() can clean them). */
  private readonly leaving = new Set<HTMLElement>();
  private prev: LbEntry[] | null = null;

  private scale = 1;
  private motion: LbMotion = NORMAL;
  private forcedReduced: boolean | null = null;
  private readonly mq: MediaQueryList | null;
  private readonly onMq = (): void => this.syncMotion();
  private readonly onResize = (): void => this.syncScale();

  constructor() {
    const fxLayer = document.createElement("div");
    fxLayer.className = "lb-fx";
    this.list.appendChild(fxLayer);
    this.fx = new ParticlePool(this.host, fxLayer);
    this.mover = new RowMover(
      this.host,
      () => this.motion,
      () => this.motion === REDUCED,
    );
    this.mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    this.mq?.addEventListener("change", this.onMq);
    window.addEventListener("resize", this.onResize);
    this.syncMotion();
    this.syncScale();
  }

  /** Re-render from the sorted stats (call when stats changed; harmless otherwise). */
  refresh(sorted: PlayerMatchStats[]): void {
    const next: LbEntry[] = sorted.map((s) => ({
      id: s.combatantId,
      name: s.displayName.toUpperCase(),
      score: s.kills,
      isLocal: s.isLocalPlayer,
    }));
    this.root.classList.toggle("hidden", next.length === 0);
    // Ping jitter, damage, tie re-sorts that keep the official order: nothing to do.
    if (this.prev && sameSnapshot(this.prev, next)) return;
    const diff = diffLeaderboard(this.prev, next);
    this.prev = next;
    if (diff.first || diff.reset || next.length === 0) this.rebuild(next);
    else this.apply(next, diff);
  }

  /** Force reduced motion on/off (null = follow the OS setting). */
  setReducedMotion(v: boolean | null): void {
    this.forcedReduced = v;
    this.syncMotion();
  }

  /** Slow motion for tooling: 4 = four times slower (animations started afterwards). */
  setTimeScale(n: number): void {
    this.host.timeScale = Math.max(1, n);
  }

  /** Temporary things still alive (running animations + fading rows): 0 at rest. */
  get pending(): number {
    return this.host.active + this.leaving.size;
  }

  dispose(): void {
    this.mq?.removeEventListener("change", this.onMq);
    window.removeEventListener("resize", this.onResize);
    this.host.cancelAll();
    this.clearRows();
    this.crown.set(null, []);
    this.prev = null;
  }

  private syncMotion(): void {
    const r = this.forcedReduced ?? this.mq?.matches ?? false;
    this.motion = r ? REDUCED : NORMAL;
  }

  private syncScale(): void {
    this.scale = Math.min(2.6, Math.max(0.7, window.innerWidth / REF_WIDTH));
    this.root.style.setProperty("--lb-s", this.scale.toFixed(4));
  }

  private clearRows(): void {
    for (const row of this.rows.values()) {
      cancelRowAnims(row);
      row.el.remove();
    }
    this.rows.clear();
    for (const el of this.leaving) el.remove();
    this.leaving.clear();
  }

  /** Instant build: first snapshot, new match, mode switch. No animation at all. */
  private rebuild(next: LbEntry[]): void {
    this.host.cancelAll();
    this.clearRows();
    const { tops, height } = layoutSlots(next);
    this.list.style.height = `${height}px`;
    next.forEach((e, i) => {
      const row = createRow(e);
      updateRow(row, e, i);
      row.top = tops[i];
      row.el.style.transform = y(tops[i]);
      this.list.appendChild(row.el);
      this.rows.set(e.id, row);
    });
    const owner = crownOwner(next);
    this.crown.set(owner === null ? null : (this.rows.get(owner) ?? null), this.rows.values());
  }

  /** Incremental update: FLIP every row from its DRAWN position to its new slot. */
  private apply(next: LbEntry[], diff: LbDiff): void {
    const m = this.motion;
    const reduced = m === REDUCED;
    const L = diff.localId;

    // 1. Measure what is DRAWN right now (running animations included).
    const crownFrom = this.crown.measure();
    const drawn = new Map<number, number>();
    for (const [id, row] of this.rows) drawn.set(id, displayedY(row.el));

    // 2. Players who left fade out where they are drawn.
    const nextIds = new Set(next.map((e) => e.id));
    for (const [id, row] of [...this.rows]) {
      if (nextIds.has(id)) continue;
      this.rows.delete(id);
      this.mover.retire(row, drawn.get(id) ?? row.top, this.leaving);
    }

    // 3. New slots; contents are written immediately.
    const { tops, height } = layoutSlots(next);
    this.list.style.height = `${height}px`;
    const reward = diff.kind === "gain" && L !== null && diff.scoreDeltas.has(L);
    const lost = diff.kind === "loss";
    const passed = new Set(diff.passed);
    const heroMs = (reward && diff.tookLead ? m.leadMoveMs : m.gainMoveMs) + Math.min(60, 20 * Math.max(0, diff.places - 1));
    let landed: Row | null = null;

    next.forEach((e, i) => {
      const top = tops[i];
      let row = this.rows.get(e.id);
      if (!row) {
        row = createRow(e);
        this.rows.set(e.id, row);
        updateRow(row, e, i);
        row.top = top;
        row.el.style.transform = y(top);
        this.list.appendChild(row.el);
        this.mover.enter(row);
        return;
      }
      updateRow(row, e, i);
      const from = drawn.get(e.id) ?? top;
      row.top = top;
      row.move?.cancel();
      row.move = null;
      row.el.style.transform = y(top);
      if (Math.abs(from - top) < 0.5) {
        row.lateral?.cancel();
        row.lateral = null;
        return;
      }
      const isMe = e.id === L;
      if (isMe && reward && !reduced) {
        this.mover.hero(row, from, top, heroMs, diff.tookLead);
        landed = row;
      } else if (isMe && lost && !reduced) {
        this.mover.loss(row, from, top);
      } else {
        const ms = isMe && reward ? heroMs : passed.has(e.id) || isMe ? m.yieldMs : m.quietMs;
        this.mover.slide(row, from, top, ms);
      }
    });

    // 4. Counters: the value is already written; only the counter reacts.
    for (const [id, delta] of diff.scoreDeltas) {
      const row = this.rows.get(id);
      if (!row) continue;
      popScore(this.host, row, m, reduced);
      if (row.isLocal) showGain(this.host, row, delta, m);
    }

    // 5. The single crown.
    const owner = crownOwner(next);
    if (owner !== this.crown.ownerId) {
      const kind: CrownMove = reward && diff.tookLead ? "lead-gain" : lost && diff.lostLead ? "lead-loss" : "none";
      this.crown.move(owner === null ? null : (this.rows.get(owner) ?? null), this.rows.values(), crownFrom, kind, m, this.scale);
    }

    // 6. Landing dots (counts are 0 in reduced motion).
    const hero = landed as Row | null;
    if (hero && reward) {
      const lead = diff.tookLead;
      const count = lead ? m.particlesLead : m.particlesGain;
      const palette = lead ? ["#ffd60a", "#f7f0e2", "#22e3f0"] : ["#22e3f0", "#f7f0e2"];
      const x0 = lead ? 14 : 40;
      const x1 = lead ? 150 : LB_GEOM.WIDTH - 40;
      const yy = lead ? hero.top + 2 : hero.top + LB_GEOM.LOCAL_H - 3;
      this.fx.burst(x0, x1, yy, count, heroMs * 0.78, palette);
    }
  }
}
