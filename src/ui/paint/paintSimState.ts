import type { PaintClusterSpec } from "./paintTypes";

/** Life cycle of a drip: fill → stretch → snap (droplet) → recoil → rest. */
export const Phase = { ACC: 0, STRETCH: 1, RECOIL: 2, REST: 3 } as const;
export type PhaseId = (typeof Phase)[keyof typeof Phase];

/** Runtime state of one paint cluster (springs + optional drip). */
export interface ClusterState {
  spec: PaintClusterSpec;
  /** First output node index. */
  start: number;
  staticCount: number;
  // jelly springs: position x / y and squash
  wx: number;
  wv: number;
  wy: number;
  wvy: number;
  sq: number;
  sqv: number;
  // drip
  hasDrip: boolean;
  phase: PhaseId;
  /** Fill 0..1 of the accumulate phase. */
  f: number;
  /** Extra tail length (px, can go negative during the recoil overshoot). */
  len: number;
  lv: number;
  vel: number;
  stretchBase: number;
  tipR: number;
  timer: number;
  dirX: number;
  dirY: number;
  // released droplet
  dropOn: boolean;
  dropX: number;
  dropY: number;
  dropVy: number;
  dropR: number;
}

export const smooth = (a: number, b: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
