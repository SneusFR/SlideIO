/**
 * BRICK MAUL r6 — WHIRLWIND CAMERA SPIN (local first-person only).
 *
 * The FP Whirlwind clip holds the maul out in front of the spinning view;
 * the three turns of the scenery come from a RENDER-ONLY yaw applied to the
 * world camera right before the world + FP passes (see Game.frame). This
 * helper is the single source of that yaw: a PURE function of the elapsed
 * attack time (HammerWeapon.whirlwindElapsedSeconds) — never integrated
 * frame to frame, never a second clock.
 *
 * The curve is EXACTLY the TP Root yaw of TP_BrickMaul_Whirlwind:
 *   u = clamp((t - start) / (end - start), 0, 1), symmetric piecewise
 *   quadratic ramps of fraction r = 0.08 (quadratic ease-in, constant speed,
 *   quadratic ease-out), progress 0 → 1 mapped to 0 → 3 turns (+6π,
 *   UNWRAPPED — a quaternion interpolation between 0 and 6π would collapse
 *   the turns). The full angle is held through the recovery (equivalent to
 *   the identity, so dropping the effect at the end is continuous).
 *
 * Constants mirror `actions.whirlwind.cameraSpin` of the authored profile.
 */
import profileJson from "../../assets/brickmaul/WeaponProfile_BrickMaul.json";

const spin = profileJson.actions.whirlwind.cameraSpin;

export const WHIRLWIND_SPIN = {
  /** Active window (s from the attack start) — same as the damage window. */
  start: spin.start, // 0.20
  end: spin.end, // 1.04
  /** Whole attack (s) — the angle is held at its full value until then. */
  attackDuration: spin.attackDuration, // 1.35
  /** Ramp fraction of the progress spent accelerating / decelerating. */
  rampFraction: spin.rampFraction, // 0.08
  turns: spin.turns, // 3
  /** +1 = counter-clockwise seen from above (world +Y), the TP Root sense. */
  sign: spin.sign, // 1
  enabled: spin.enabled,
} as const;

/**
 * Normalized progress 0..1 of the spin for a normalized time u in [0, 1]:
 * quadratic ease-in over [0, r], constant speed over [r, 1 - r], quadratic
 * ease-out over [1 - r, 1]. Continuous in value and velocity.
 */
export function whirlwindSpinProgress(u: number): number {
  const r = WHIRLWIND_SPIN.rampFraction;
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  // Peak (constant) speed such that the total area is 1: v = 1 / (1 - r).
  const v = 1 / (1 - r);
  if (u < r) return (v * u * u) / (2 * r);
  if (u <= 1 - r) return (v * r) / 2 + v * (u - r);
  const w = 1 - u;
  return 1 - (v * w * w) / (2 * r);
}

/**
 * UNWRAPPED world-yaw (radians) of the whirlwind camera spin at
 * `elapsedSeconds` since the attack start: 0 until 0.20 s, +6π at 1.04 s,
 * held at +6π until the end of the attack (1.35 s) and beyond. Negative /
 * NaN input (no attack) → 0.
 */
export function sampleBrickMaulWhirlwindYaw(elapsedSeconds: number): number {
  if (!WHIRLWIND_SPIN.enabled || !(elapsedSeconds > 0)) return 0;
  const { start, end, turns, sign } = WHIRLWIND_SPIN;
  const u = Math.min(1, Math.max(0, (elapsedSeconds - start) / (end - start)));
  return sign * whirlwindSpinProgress(u) * turns * Math.PI * 2;
}
