/**
 * Explicit cause of a kill. Every damage source tags its damage with a
 * method, so a death event always knows HOW the victim died — never a
 * fragile "what weapon was the killer holding?" guess.
 *
 * HAMMER_SWING → HOMERUN medal
 * GROUND_SLAM  → SMASHED medal
 * PLASMA       → no special medal
 * ENVIRONMENT  → kill plane / suicide (no killer, no medal)
 */
export enum KillMethod {
  PLASMA = "PLASMA",
  HAMMER_SWING = "HAMMER_SWING",
  GROUND_SLAM = "GROUND_SLAM",
  ENVIRONMENT = "ENVIRONMENT",
}