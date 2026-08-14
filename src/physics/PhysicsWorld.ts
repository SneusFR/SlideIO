import RAPIER from "@dimforge/rapier3d-compat";

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