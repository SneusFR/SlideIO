// Camera poses of the Givre GPU benches (overdraw-bench.mjs, prepass-ab.mjs): the 8 spawns
// (shared/map/GivreSpawns.ts, eye 0.6 m above the capsule centre — MovementConfig.eyeOffsetStand),
// the village centre (0, 1.6, 0) facing N / E / S / W, the north gallery (upper level,
// CAM_4_GalerieNord of givre_01.physics.json) and an elevated view over the south edge. Angles in
// degrees (yaw = Object3D.rotation.y, 0 = facing −Z; pitch < 0 = looking down).
//   env POSES (JSON list [{name,x,y,z,yaw,pitch}]) replaces the list, ONLY (comma names) filters it.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function defaultPoses() {
  const src = readFileSync(resolve(here, "../../shared/map/GivreSpawns.ts"), "utf8");
  const spawns = [...src.matchAll(/\{\s*x:\s*(-?[\d.]+),\s*y:\s*(-?[\d.]+),\s*z:\s*(-?[\d.]+),\s*yaw:\s*(-?[\d.]+)\s*\}/g)].map(
    (m, i) => ({ name: `spawn${i + 1}`, x: +m[1], y: +m[2] + 0.6, z: +m[3], yaw: (+m[4] * 180) / Math.PI, pitch: 0 }),
  );
  if (spawns.length !== 8) throw new Error(`GivreSpawns.ts: ${spawns.length} spawns parsed`);
  return [
    ...spawns,
    ...[0, 90, 180, 270].map((yaw) => ({ name: `centre${yaw}`, x: 0, y: 1.6, z: 0, yaw, pitch: 0 })),
    { name: "galerie", x: -1.4, y: 7.6, z: -87.5, yaw: 180, pitch: -8 },
    { name: "elevated", x: 0, y: 30, z: 75, yaw: 0, pitch: -16 },
  ];
}

export function selectPoses(env = process.env) {
  let poses = env.POSES ? JSON.parse(env.POSES) : defaultPoses();
  if (env.ONLY) {
    const only = new Set(env.ONLY.split(","));
    poses = poses.filter((p) => only.has(p.name));
  }
  return poses;
}
