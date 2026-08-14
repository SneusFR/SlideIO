import RAPIER from "@dimforge/rapier3d-compat";

/**
 * Thin wrapper around the Rapier world.
 * Owns initialization (WASM) and static geometry creation.
 */
export class PhysicsWorld {
  world!: RAPIER.World;

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
   */
  addStaticBox(
    x: number,
    y: number,
    z: number,
    sizeX: number,
    sizeY: number,
    sizeZ: number,
    rotation?: { x: number; y: number; z: number; w: number },
  ): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(sizeX / 2, sizeY / 2, sizeZ / 2)
      .setTranslation(x, y, z)
      .setFriction(0)
      .setRestitution(0);
    if (rotation) desc.setRotation(rotation);
    return this.world.createCollider(desc);
  }
}

export { RAPIER };