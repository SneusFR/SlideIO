/**
 * Leaderboard motion presets — every tunable in one place (design px / ms).
 * `normal` = full motion; `reduced` = prefers-reduced-motion: same information
 * (positions, +N, crown) with short plain fades — no overshoot, no squash,
 * no lateral kick, no particles, no crown bounce.
 */
export interface LbMotion {
  /** Score counter: squash → overshoot → rest. */
  scoreMs: number;
  scoreSquash: [number, number];
  scoreOver: [number, number];
  /** "+N" life cycle. */
  gainMs: number;
  gainRise: number;
  /** Local row moving up (gain). */
  gainMoveMs: number;
  gainLateral: number;
  gainOvershoot: number;
  gainShell: number;
  /** Local row taking the lead (same move, then the crown). */
  leadMoveMs: number;
  leadTotalMs: number;
  crownDropFrom: number;
  /** Local row losing places (restrained). */
  lossMoveMs: number;
  lossOvershoot: number;
  lossShell: number;
  /** Rows that yield their slot. */
  yieldMs: number;
  /** Opponents' discreet reorders. */
  quietMs: number;
  particlesGain: number;
  particlesLead: number;
  bounce: boolean;
}

export const NORMAL: LbMotion = {
  scoreMs: 240,
  scoreSquash: [0.9, 1.12],
  scoreOver: [1.08, 0.95],
  gainMs: 700,
  gainRise: 12,
  gainMoveMs: 440,
  gainLateral: 6,
  gainOvershoot: 2.5,
  gainShell: 0.04,
  leadMoveMs: 440,
  leadTotalMs: 720,
  crownDropFrom: 18,
  lossMoveMs: 380,
  lossOvershoot: 1.2,
  lossShell: 0.02,
  yieldMs: 340,
  quietMs: 280,
  particlesGain: 4,
  particlesLead: 8,
  bounce: true,
};

export const REDUCED: LbMotion = {
  ...NORMAL,
  scoreMs: 160,
  scoreSquash: [1, 1],
  scoreOver: [1, 1],
  gainMs: 600,
  gainRise: 0,
  gainMoveMs: 200,
  gainLateral: 0,
  gainOvershoot: 0,
  gainShell: 0,
  leadMoveMs: 200,
  leadTotalMs: 320,
  crownDropFrom: 0,
  lossMoveMs: 200,
  lossOvershoot: 0,
  lossShell: 0,
  yieldMs: 200,
  quietMs: 160,
  particlesGain: 0,
  particlesLead: 0,
  bounce: false,
};
