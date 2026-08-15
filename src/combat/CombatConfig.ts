/**
 * Central tuning for combat, health, spawning and bot AI.
 * Every important gameplay value for the FFA sandbox lives here.
 * Units: meters, seconds, HP, radians unless noted.
 */
export const CombatConfig = {
  // ---- Health ----
  playerMaxHealth: 100,
  botMaxHealth: 70, // lower than the player: bots die in ~1.3s of sustained beam

  // ---- Bots ----
  maxBotCount: 8,
  defaultBotCount: 4,

  // ---- Respawn ----
  playerRespawnDelay: 2.5,
  botRespawnDelayMin: 2.0,
  botRespawnDelayMax: 4.0,
  spawnProtectionDuration: 0.75,

  // ---- Spawn scoring ----
  spawnMinComfortDistance: 6, // spawns closer than this to an enemy are heavily penalized
  spawnLosPenalty: 0.3, // score multiplier when an enemy has line of sight to the spawn
  spawnTopChoices: 4, // pick randomly among the N best spawns

  // ---- Bot perception ----
  botPerceptionRange: 55,
  botFovDegrees: 160,
  botCloseHearingRange: 7, // enemies this close are noticed even outside the FOV
  botMemoryDuration: 3.0, // seconds a lost target's last position is remembered
  botPerceptionInterval: 0.25, // seconds between perception updates (staggered per bot)
  botLosLostToSearchTime: 1.1, // engaged target unseen for this long → SEARCHING

  // ---- Bot reaction / targeting ----
  botReactionMin: 0.2,
  botReactionMax: 0.45,
  botTargetSwitchDelay: 1.2, // minimum time between opportunistic target switches
  botSwitchDistanceRatio: 0.55, // candidate must be this fraction of current target distance

  // ---- Bot aim (imperfection lives HERE, never in the weapon) ----
  botAimSpeedMin: 3.2, // rad/s max rotation of the aim direction
  botAimSpeedMax: 5.2,
  botAimErrorMin: 0.5, // meters of wander around the target at reference distance
  botAimErrorMax: 1.1,
  botAimErrorRefDistance: 18, // error scales with distance relative to this
  botAimErrorRepickMin: 0.25, // seconds between error offset re-rolls
  botAimErrorRepickMax: 0.6,
  botAimFireConeDegrees: 6, // bot only pulls the trigger when aim is within this cone

  // ---- Bot combat movement ----
  botPreferredRangeMin: 10,
  botPreferredRangeMax: 18,
  botStrafeIntervalMin: 0.5,
  botStrafeIntervalMax: 1.4,
  botJumpChancePerSecond: 0.35,
  botSlideChancePerSecond: 0.4,
  botDashChancePerSecond: 0.25,
  botDashOnDamageChance: 0.3, // chance to dodge-dash when taking damage (rate limited)
  botDashDecisionCooldown: 3.0,

  // ---- Bot heat management ----
  botHeatHoldMin: 0.6, // release the trigger above this heat ratio…
  botHeatHoldMax: 0.9, // …randomized per bot (sloppy bots can overheat)
  botHeatResumeMin: 0.25,
  botHeatResumeMax: 0.45,

  // ---- Bot navigation ----
  botPathUpdateInterval: 0.6, // minimum seconds between path recomputations
  botWaypointReachDistance: 0.9,
  botStuckSpeedThreshold: 0.5, // m/s — below this while trying to move = possibly stuck
  botStuckTime: 1.4, // seconds of no progress → jump + repath
  botRoamMinGoalDistance: 12,
  botSearchScanTime: 1.2, // seconds spent looking around at the last known position

  // ---- Bot body / speed ----
  botSpeedScaleMin: 0.9, // bots run slightly slower than the player (fairness)
  botSpeedScaleMax: 1.0,

  // ---- Bot weapon visuals (kept light: up to 8 beams at once) ----
  botImpactParticleRate: 14,
  botMuzzleParticleRate: 10,

  // ---- Player damage feedback ----
  damageVignetteDecay: 2.2, // opacity units per second
  damageVignetteMax: 0.55,
  killFeedbackDuration: 0.9,

  // ---- Directional damage indicator (screen-space, temporary) ----
  damageDirectionDuration: 0.45, // seconds a directional flash stays after the last hit
  damageDirectionMaxOpacity: 0.8,
  damageDirectionMergeAngle: 0.6, // rad — hits closer than this refresh the same indicator

  // ---- Low-health vignette (persistent, HP-driven) ----
  lowHealthThreshold: 0.9, // vignette starts building below this HP ratio
  damageOverlayIntensity: 0.5, // max vignette opacity at ~0 HP
  lowHealthCriticalRatio: 0.2, // below this the vignette pulses
  healFeedbackDuration: 0.9,

  // ---- Enemy visual readability ----
  enemyOutlineEnabled: true,
  enemyOutlineThickness: 0.025, // meters of red hull around the silhouette
  enemyOutlineColor: 0xff2d2d,
  enemyHealthBarVisible: true,
  enemyNameVisible: true,
  enemyVisibilityMaxDistance: 120, // outline/UI never shown beyond this
  enemyVisibilityBodyRadius: 1.2, // frustum culling sphere radius around a bot

  // ---- Health bars ----
  botHealthBarVisibleRange: 70,
};

export type CombatConfigType = typeof CombatConfig;