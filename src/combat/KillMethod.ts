/**
 * Explicit cause of a kill. Every damage source tags its damage with a
 * method, so a death event always knows HOW the victim died — never a
 * fragile "what weapon was the killer holding?" guess.
 *
 * HAMMER_SWING → HOMERUN medal
 * GROUND_SLAM  → SMASHED medal

 * ENVIRONMENT  → kill plane / suicide (no killer, no medal)
 */
export enum KillMethod {

  HAMMER_SWING = "HAMMER_SWING",
  GROUND_SLAM = "GROUND_SLAM",
  /** Astral Lance quick horizontal sweep (no special medal yet). */
  SPEAR_SWEEP = "SPEAR_SWEEP",
  /** Astral Lance charged rush impact → IMPALED medal. */
  SPEAR_RUSH = "SPEAR_RUSH",
  /** MOLE STRIKE killstreak emergence blast → MOLED medal. */
  MOLE_STRIKE = "MOLE_STRIKE",

  /** HEX SNIPER tongue grab (LMB — flat hit damage on the grabbed player). */
  HEX_SNIPER_TONGUE = "HEX_SNIPER_TONGUE",
  /** HEX SNIPER monster-head bite (automatic after every tongue shot). */
  HEX_SNIPER_BITE = "HEX_SNIPER_BITE",
  /** GOOFY BASKET bouncing basketball (flat hit, no special medal). */
  GOOFY_BASKET = "GOOFY_BASKET",
  /** POPCORN SHOTGUN pellets (one summed hit per shot and per victim). */
  POPCORN_SHOTGUN = "POPCORN_SHOTGUN",
  /** PAINTBALL RIFLE balls (hitscan, 23 body / 34.5 head, no special medal). */
  PAINTBALL_RIFLE = "PAINTBALL_RIFLE",
  /** WATER FAMAS jets (hitscan, 23 body / 34.5 head per jet, no special medal). */
  WATER_FAMAS = "WATER_FAMAS",
  /** FRISBEE LAUNCHER bouncing disc (projectile, 75 body / 100 head, no special medal). */
  FRISBEE_LAUNCHER = "FRISBEE_LAUNCHER",
  ENVIRONMENT = "ENVIRONMENT",
}
