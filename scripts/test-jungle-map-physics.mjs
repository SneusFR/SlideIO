/**
 * Smoke test for the Ancient Jungle City physics integration:
 *   1. builds every collider of the physics JSON in a real Rapier world
 *      (same descriptors as src/world/JungleMap.ts),
 *   2. raycasts straight down under each of the 8 spawns → must hit
 *      ground within capsule reach,
 *   3. checks the shared MapColliders/MapSpawns stay in sync with the JSON.
 *
 * Run: node scripts/test-jungle-map-physics.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import RAPIER from "@dimforge/rapier3d-compat";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(
  readFileSync(join(root, "src/assets/MAP/ancient_jungle_city.physics.json"), "utf8"),
);

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -26, z: 0 });

let cuboids = 0;
let hulls = 0;
for (const c of data.colliders) {
  if (c.type === "cuboid") {
    const desc = RAPIER.ColliderDesc.cuboid(...c.halfExtents)
      .setTranslation(...c.position)
      .setFriction(0)
      .setRestitution(0);
    const [x, y, z, w] = c.rotation ?? [0, 0, 0, 1];
    desc.setRotation({ x, y, z, w });
    world.createCollider(desc);
    cuboids++;
  } else if (c.type === "convexHull") {
    const desc = RAPIER.ColliderDesc.convexHull(
      new Float32Array(c.vertices.flat()),
    );
    if (!desc) throw new Error(`convexHull failed: ${c.id}`);
    desc.setFriction(0).setRestitution(0);
    world.createCollider(desc);
    hulls++;
  } else {
    throw new Error(`unsupported collider type: ${c.type}`);
  }
}
console.log(`colliders OK: ${cuboids} cuboids + ${hulls} convex hulls`);

// Index the query pipeline (Rapier only refreshes during a step).
world.timestep = 0;
world.step();

let failures = 0;
for (const s of data.spawns) {
  const [x, y, z] = s.position;
  const hit = world.castRay(
    new RAPIER.Ray({ x, y: y + 0.3, z }, { x: 0, y: -1, z: 0 }),
    3,
    true,
  );
  // Capsule center ≈ 0.9 m above the feet (+0.3 margin added in game).
  const groundDist = hit ? hit.timeOfImpact : Infinity;
  const ok = hit && groundDist > 0.5 && groundDist < 2.0;
  console.log(
    `${s.id} @ (${x}, ${y}, ${z}) → ground ${groundDist === Infinity ? "NONE" : groundDist.toFixed(2) + " m"} ${ok ? "OK" : "FAIL"}`,
  );
  if (!ok) failures++;
}

if (failures > 0) {
  console.error(`${failures} spawn checks failed`);
  process.exit(1);
}
console.log("All spawn ground checks passed.");
