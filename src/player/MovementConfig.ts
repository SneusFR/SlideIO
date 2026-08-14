/**
 * Central movement tuning.
 * Every gameplay-feel value lives here — no magic numbers elsewhere.
 * Units: meters, seconds, radians.
 */
export const MovementConfig = {
  // ---- Body / capsule ----
  capsuleRadius: 0.35,
  standHalfHeight: 0.55, // cylinder half-height (total height = 2 * (hh + radius))
  slideHalfHeight: 0.2,
  eyeOffsetStand: 0.6, // eye height above capsule center
  eyeOffsetSlide: 0.05,

  // ---- Gravity ----
  gravity: 26,
  maxFallSpeed: 42,

  // ---- Ground movement ----
  walkSpeed: 9.5, // auto-run speed
  groundAcceleration: 110,
  groundFriction: 8.5,

  // ---- Air movement ----
  airAcceleration: 32, // direct air control (capped at walkSpeed)
  airStrafeAcceleration: 100, // quake-style strafe accel (tiny wish-speed cap → speed gain)
  airStrafeMaxWishSpeed: 1.4,
  hardCapSpeed: 34, // absolute horizontal speed ceiling

  // ---- Jumping ----
  jumpForce: 8.8,
  coyoteTime: 0.12,
  jumpBufferTime: 0.14,

  // ---- Momentum / soft cap ----
  // Boosts from advanced movement shrink as speed approaches softCapSpeed
  softCapSpeed: 24,
  boostMinScale: 0.1,

  // ---- Slide ----
  slideMinSpeed: 6.0, // required speed to start a slide
  slideBoost: 3.4, // m/s added at slide start (diminishing with speed)
  slideFriction: 1.1, // much lower than ground friction
  slideDuration: 1.1,
  slideEndSpeed: 4.0, // slide auto-ends below this speed
  slideSteering: 2.0, // rad/s of directional control while sliding
  slideJumpBoost: 2.2, // m/s added when jumping out of a slide (diminishing)
  slideCooldown: 0.25,
  slideBufferTime: 0.15, // Shift pressed slightly early still starts a slide
  slideAirGrace: 0.15, // slide survives brief loss of ground contact

  // ---- Dash ----
  dashSpeed: 26, // impulse speed along the view direction (m/s)
  dashDuration: 0.18, // seconds of burst
  dashCooldown: 2.0, // fixed cooldown (required)
  dashGravityScale: 0.0, // gravity multiplier while dashing (0 = brief suspension)
  dashMomentumRetention: 0.5, // fraction of pre-dash speed along the dash dir added on top
  dashExitSpeed: 14, // exit horizontal speed cap floor (never clamps below pre-dash speed)
  dashExitMaxUpSpeed: 8.8, // vertical exit clamp so up-dashes stay controllable
  dashMinSpeedFraction: 0.25, // dash ends early if collisions slow it below this fraction
  dashFovBoost: 10, // extra FOV degrees while dashing

  // ---- Phase dash (dash through phaseable walls) ----
  // Traversal is allowed based on DASH STATE ONLY — never on player speed.
  phaseTraversalEnabled: true,
  phaseGraceTime: 0.15, // contact just after the dash ended still phases (s)
  maxPhaseWallThickness: 3.0, // walls thicker than this stay solid (m)
  phaseDuration: 0.18, // visual phase effect length (s) — movement never pauses
  phaseExitOffset: 0.08, // extra clearance beyond the far face (m)
  phaseReentryCooldown: 0.25, // blocks instantly re-phasing the same wall backwards (s)
  phaseMomentumRetention: 1.0, // 1.0 = 100% of velocity preserved through the wall
  phaseFovPunch: 14, // extra FOV degrees at the peak of the phase flash

  // ---- Wall slide / wall jump ----
  wallSlideGravity: 7,
  wallSlideMaxFallSpeed: 6,
  wallSlideDuration: 1.2, // can't stay glued forever
  wallSlideMinSpeed: 5.0, // required horizontal speed to grab a wall
  wallMaxNormalY: 0.25, // |normal.y| under this counts as a vertical wall
  wallStickAccel: 25, // gentle pull to stay in contact while wall sliding
  wallJumpHorizontalForce: 7.5, // push away from the wall
  wallJumpVerticalForce: 7.6,
  wallRegrabLock: 0.25, // delay before re-grabbing after a wall jump

  // ---- Camera feel ----
  mouseSensitivity: 0.0021,
  baseFov: 92,
  maxSpeedFov: 106,
  fovSpeedStart: 9.5, // fov starts widening above this speed
  fovSpeedFull: 23, // fov fully widened at this speed
  fovLerpSpeed: 7,
  strafeTiltMax: 0.02, // max roll from lateral velocity
  wallSlideTilt: 0.08, // roll toward the wall while wall sliding
  tiltLerpSpeed: 10,
  crouchLerpSpeed: 14, // eye height interpolation speed

  // ---- World / safety ----
  killPlaneY: -25,
  spawnPosition: { x: 0, y: 2.5, z: 40 }, // blue yard (south side)
  spawnYaw: 0, // facing -Z (down the street, toward the red side)
};

export type MovementConfigType = typeof MovementConfig;