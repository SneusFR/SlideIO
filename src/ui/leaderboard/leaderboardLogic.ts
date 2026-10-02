/**
 * Leaderboard — pure logic (no DOM): geometry, layout slots and the diff between
 * two official snapshots. The HUD never sorts anything itself: it receives the
 * order decided by the real ranking rules (compareMatchStats) and only works out
 * WHAT CHANGED between two snapshots, keyed by the stable player id.
 */

/** Design-space geometry (px at the 1816×866 reference). The CSS scales it by --u. */
export const LB_GEOM = {
  WIDTH: 267,
  ROW_H: 41,
  /** The local row is a little taller and wider than the others. */
  LOCAL_H: 48,
  GAP: 2,
  /** How far the local row bleeds out of the column on each side. */
  LOCAL_BLEED: 9,
} as const;

export interface LbEntry {
  /** Stable player id (combatantId / network numeric id) — the ONLY row identity. */
  id: number;
  name: string;
  score: number;
  isLocal: boolean;
}

export interface LbDiff {
  /** No previous snapshot (or it was empty): build instantly, nothing to animate. */
  first: boolean;
  /** Snapshots are unrelated (new match / mode switch / scores went down): rebuild instantly. */
  reset: boolean;
  joined: number[];
  left: number[];
  /** Score gains only (id → +N). */
  scoreDeltas: Map<number, number>;
  /** Relative order of the players present in both snapshots changed. */
  orderChanged: boolean;
  localId: number | null;
  /** What happened to the LOCAL player's rank, counted by real overtakes (not by index shifts). */
  kind: "none" | "gain" | "loss";
  /** gain: rows I passed · loss: rows that passed me. */
  passed: number[];
  places: number;
  tookLead: boolean;
  lostLead: boolean;
  crownFrom: number | null;
  crownTo: number | null;
}

/** The crown belongs to the official first place, once somebody has actually scored. */
export function crownOwner(list: readonly LbEntry[]): number | null {
  return list.length > 0 && list[0].score > 0 ? list[0].id : null;
}

export function sameSnapshot(a: readonly LbEntry[], b: readonly LbEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.id !== y.id || x.score !== y.score || x.name !== y.name || x.isLocal !== y.isLocal) return false;
  }
  return true;
}

export function diffLeaderboard(prev: readonly LbEntry[] | null, next: readonly LbEntry[]): LbDiff {
  const base: LbDiff = {
    first: false,
    reset: false,
    joined: [],
    left: [],
    scoreDeltas: new Map(),
    orderChanged: false,
    localId: next.find((e) => e.isLocal)?.id ?? null,
    kind: "none",
    passed: [],
    places: 0,
    tookLead: false,
    lostLead: false,
    crownFrom: prev ? crownOwner(prev) : null,
    crownTo: crownOwner(next),
  };
  if (!prev || prev.length === 0) return { ...base, first: true };

  const prevIdx = new Map<number, number>();
  prev.forEach((e, i) => prevIdx.set(e.id, i));
  const nextIdx = new Map<number, number>();
  next.forEach((e, i) => nextIdx.set(e.id, i));

  const common = next.filter((e) => prevIdx.has(e.id));
  base.joined = next.filter((e) => !prevIdx.has(e.id)).map((e) => e.id);
  base.left = prev.filter((e) => !nextIdx.has(e.id)).map((e) => e.id);

  // Unrelated snapshots → rebuild. Scores never go down in a match: a decrease = a new match.
  let decreased = false;
  for (const e of common) {
    const old = prev[prevIdx.get(e.id)!];
    if (e.score < old.score) decreased = true;
    else if (e.score > old.score) base.scoreDeltas.set(e.id, e.score - old.score);
    // Somebody became / stopped being "me": different viewer → rebuild instantly.
    if (e.isLocal !== old.isLocal) decreased = true;
  }
  if ((next.length > 0 && common.length === 0) || decreased) {
    base.scoreDeltas.clear();
    return { ...base, reset: true };
  }

  // Relative order of the survivors.
  const prevSeq = prev.filter((e) => nextIdx.has(e.id)).map((e) => e.id);
  const nextSeq = common.map((e) => e.id);
  base.orderChanged = prevSeq.some((id, i) => id !== nextSeq[i]);

  // Local rank change measured by REAL overtakes, so a row leaving above me never reads as a reward.
  const L = base.localId;
  if (L !== null && prevIdx.has(L)) {
    const pL = prevIdx.get(L)!;
    const nL = nextIdx.get(L)!;
    const iPassed: number[] = [];
    const passedMe: number[] = [];
    for (const e of common) {
      if (e.id === L) continue;
      const p = prevIdx.get(e.id)!;
      const n = nextIdx.get(e.id)!;
      if (p < pL && n > nL) iPassed.push(e.id);
      else if (p > pL && n < nL) passedMe.push(e.id);
    }
    if (iPassed.length > passedMe.length) {
      base.kind = "gain";
      base.passed = iPassed;
      base.places = iPassed.length;
      base.tookLead = nL === 0;
    } else if (passedMe.length > iPassed.length) {
      base.kind = "loss";
      base.passed = passedMe;
      base.places = passedMe.length;
      base.lostLead = pL === 0;
    }
  }
  return base;
}

/** Vertical slots (design px) of every row, top to bottom, in display order. */
export function layoutSlots(list: readonly { isLocal: boolean }[]): { tops: number[]; height: number } {
  const tops: number[] = [];
  let y = 0;
  for (let i = 0; i < list.length; i++) {
    tops.push(y);
    y += (list[i].isLocal ? LB_GEOM.LOCAL_H : LB_GEOM.ROW_H) + (i < list.length - 1 ? LB_GEOM.GAP : 0);
  }
  return { tops, height: y };
}

/** Multi-digit scores shrink inside their fixed-width pill — columns never move. */
export function scoreDigitsClass(score: number): "" | "d4" | "d5" {
  const n = String(Math.max(0, Math.floor(score))).length;
  return n >= 5 ? "d5" : n === 4 ? "d4" : "";
}

