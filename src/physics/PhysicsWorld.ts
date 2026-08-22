import RAPIER from "@dimforge/rapier3d-compat";

/**
 * Rapier interaction groups (packed `membership << 16 | filter`).
 *
 * - STATIC world geometry keeps the DEFAULT groups (membership 0xffff /
 *   filter 0xffff) — nothing to change there.
 * - CHARACTER capsules (player + bots) live in their own membership bit so
 *   ragdolls can explicitly IGNORE them: corpses never block doorways and
 *   the gameplay capsule never fights the physical body of a knocked-down
 *   character. Their filter stays 0xffff → capsule↔capsule and
 *   capsule↔world collisions behave exactly as before.
 * - RAGDOLL bodies collide with the WORLD bit only: they hit static
 *   geometry (default membership includes bit 0) but never characters and
 *   never OTHER ragdoll parts (no self-collision explosions between
 *   jointed limbs, no corpse-vs-corpse jitter piles).
 */
export const CollisionGroups = {
  /** Character capsules: member of bit 2, collides with everything. */
  CHARACTER: (0x0004 << 16) | 0xffff,
  /** Ragdoll parts: member of bit 1, collides with the world bit only. */
  RAGDOLL: (0x0002 << 16) | 0x0001,
} as const;

/**
 * Thin wrapper around the Rapier world.
 * Owns initialization (WASM) and static geometry creation.
 */
export class PhysicsWorld {
  world!: RAPIER.World;

  /** Collider handles explicitly marked as phase-dashable walls. */
  private readonly phaseableHandles = new Set<number>();

  static async create(): Promise<PhysicsWorld> {
    await RAPIER.init();
    const physics = new PhysicsWorld();
    // Gravity is handled manually by the player movement (kinematic body),
    // but the world still needs a value for potential future dynamic bodies.
    physics.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    return physics;
  }

  step(dt: number): void {
    this.world.timestep = dt;
    this.world.step();
  }

  /**
   * Force a scene-query refresh (broad-phase update) so raycasts and shape
   * intersections see freshly created colliders. Rapier only updates its
   * query structures during `world.step()`, so anything built from queries
   * BEFORE the first step (e.g. the NavGrid) would see an empty world.
   * A zero-dt step updates the queries without advancing the simulation.
   */
  refreshQueries(): void {
    this.world.timestep = 0;
    this.world.step();
  }

  /**
   * Static cuboid collider. Sizes are FULL sizes (not half extents).
   * Optional quaternion rotation for ramps.
   * `phaseable: true` marks the wall as traversable by the Phase Dash —
   * an explicit opt-in so future maps can be designed around the mechanic.
   */
  addStaticBox(
    x: number,
    y: number,
    z: number,
    sizeX: number,
    sizeY: number,
    sizeZ: number,
    rotation?: { x: number; y: number; z: number; w: number },
    options?: { phaseable?: boolean },
  ): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(sizeX / 2, sizeY / 2, sizeZ / 2)
      .setTranslation(x, y, z)
      .setFriction(0)
      .setRestitution(0);
    if (rotation) desc.setRotation(rotation);
    const collider = this.world.createCollider(desc);
    if (options?.phaseable) this.phaseableHandles.add(collider.handle);
    return collider;
  }

  /** True if this collider was explicitly marked as a phase-dashable wall. */
  isPhaseable(collider: RAPIER.Collider): boolean {
    return this.phaseableHandles.has(collider.handle);
  }
}

export { RAPIER };