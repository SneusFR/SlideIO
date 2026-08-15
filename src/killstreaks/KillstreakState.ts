/**
 * Lifecycle of ONE equipped killstreak slot during a single life.
 *
 * LOCKED → (enough kills) → READY → (activated) → ACTIVE → (done) → SPENT
 * Death at ANY point resets the slot back to LOCKED with 0 kills.
 * SPENT slots never progress again until the next life (single use per life).
 */
export enum KillstreakState {
  /** Still charging: kills accumulate toward the requirement. */
  LOCKED = "LOCKED",
  /** Requirement met — waiting for the player to press the slot key. */
  READY = "READY",
  /** The ability is currently running. */
  ACTIVE = "ACTIVE",
  /** Already used this life — dead slot until respawn. */
  SPENT = "SPENT",
}