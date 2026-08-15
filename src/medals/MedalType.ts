/**
 * All medal identities. Adding a new medal later (QUAD_KILL, AIRSHOT…)
 * only requires a new entry here + an asset mapping in MedalConfig —
 * no logic rewrite anywhere.
 */
export enum MedalType {
  KILL = "KILL",
  DOUBLE_KILL = "DOUBLE_KILL",
  TRIPLE_KILL = "TRIPLE_KILL",
  SMASHED = "SMASHED",
  HOMERUN = "HOMERUN",
  /** Kill with the OBLITERREUR black-vortex beam. */
  OBLITERATED = "OBLITERATED",
  /** Kill with the MOLE STRIKE killstreak emergence blast. */
  MOLED = "MOLED",
  /** Kill with the Astral Lance charged rush. */
  IMPALED = "IMPALED",
}
