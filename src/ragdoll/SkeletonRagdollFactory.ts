import * as THREE from "three";
import { RagdollPartDef, RagdollShape } from "./RagdollController";
import { RagdollConfig as rc } from "./RagdollConfig";

/**
 * Builds ragdoll part definitions from the REAL Meshy character skeleton
 * (inspected in the GLB exports — scripts/inspect-glb.mjs):
 *
 *   Hips → Spine → Spine01 → Spine02 → neck → Head → headfront/head_end
 *   Spine02 → Left/RightShoulder → Left/RightArm → ForeArm → Hand
 *   Hips → Left/RightUpLeg → Left/RightLeg → Foot → ToeBase
 *
 * 11 rigid bodies (quality/performance compromise):
 *   pelvis (Hips), chest (Spine02), head (Head),
 *   upper+lower arms ×2, upper+lower legs ×2.
 *
 * Intermediate bones (Spine, Spine01, neck, shoulders, hands, feet) keep
 * their pose-local transforms and simply follow their driven ancestors.
 *
 * NOTHING is assumed about bone local axes: every capsule is oriented
 * from the WORLD positions of its two end joints (shoulder→elbow,
 * elbow→wrist, hip→knee, knee→ankle) captured from the live pose, and
 * its dimensions are derived from the actual limb lengths — the system
 * stays coherent whatever the model scale is.
 */

/** Bone name → THREE.Object3D lookup with exact-name matching. */
function findBones(root: THREE.Object3D): Map<string, THREE.Object3D> {
  const map = new Map<string, THREE.Object3D>();
  root.traverse((obj) => {
    if (!map.has(obj.name)) map.set(obj.name, obj);
  });
  return map;
}

const REQUIRED_BONES = [
  "Hips",
  "Spine01",
  "Spine02",
  "neck",
  "Head",
  "LeftArm",
  "LeftForeArm",
  "LeftHand",
  "RightArm",
  "RightForeArm",
  "RightHand",
  "LeftUpLeg",
  "LeftLeg",
  "LeftFoot",
  "RightUpLeg",
  "RightLeg",
  "RightFoot",
];

const UP = new THREE.Vector3(0, 1, 0);

/** Quaternion rotating +Y onto `dir` (capsules are Y-aligned in Rapier). */
function quatFromYAxis(dir: THREE.Vector3): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
}

function worldPos(obj: THREE.Object3D): THREE.Vector3 {
  return obj.getWorldPosition(new THREE.Vector3());
}

/** Capsule body between two world joints, driven by `node`. */
function limbPart(
  name: string,
  node: THREE.Object3D,
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  mass: number,
  parent: string,
  anchor: THREE.Vector3,
): RagdollPartDef {
  const dir = to.clone().sub(from);
  const len = Math.max(dir.length(), 0.05);
  const halfHeight = Math.max(len / 2 - radius, 0.02);
  const shape: RagdollShape = { type: "capsule", halfHeight, radius };
  return {
    name,
    node,
    shape,
    mass,
    bodyPosition: from.clone().add(to).multiplyScalar(0.5),
    bodyQuaternion: quatFromYAxis(dir),
    parent,
    joint: { type: "spherical", anchor: anchor.clone() },
  };
}

/**
 * Build the part definitions from the model's CURRENT pose.
 * Returns null when the skeleton doesn't match the expected Meshy rig
 * (callers fall back to the legacy non-ragdoll behavior).
 */
export function buildSkeletonRagdollParts(root: THREE.Object3D): RagdollPartDef[] | null {
  root.updateMatrixWorld(true);
  const bones = findBones(root);
  for (const name of REQUIRED_BONES) {
    if (!bones.has(name)) return null;
  }
  const b = (name: string) => bones.get(name)!;

  // ---- Key world positions from the LIVE pose ----
  const hips = worldPos(b("Hips"));
  const spine01 = worldPos(b("Spine01"));
  const neck = worldPos(b("neck"));
  const head = worldPos(b("Head"));
  const headEnd = bones.has("head_end") ? worldPos(b("head_end")) : null;

  const lShoulder = worldPos(b("LeftArm"));
  const lElbow = worldPos(b("LeftForeArm"));
  const lWrist = worldPos(b("LeftHand"));
  const rShoulder = worldPos(b("RightArm"));
  const rElbow = worldPos(b("RightForeArm"));
  const rWrist = worldPos(b("RightHand"));

  const lHip = worldPos(b("LeftUpLeg"));
  const lKnee = worldPos(b("LeftLeg"));
  const lAnkle = worldPos(b("LeftFoot"));
  const rHip = worldPos(b("RightUpLeg"));
  const rKnee = worldPos(b("RightLeg"));
  const rAnkle = worldPos(b("RightFoot"));

  // ---- Proportions derived from the real skeleton (never hardcoded) ----
  const hipWidth = lHip.distanceTo(rHip);
  const shoulderWidth = lShoulder.distanceTo(rShoulder);
  const armLen = lShoulder.distanceTo(lElbow);
  const legLen = lHip.distanceTo(lKnee);
  const armRadius = THREE.MathUtils.clamp(armLen * 0.28, 0.035, 0.09);
  const legRadius = THREE.MathUtils.clamp(legLen * 0.3, 0.05, 0.12);

  const m = rc.mass;
  const parts: RagdollPartDef[] = [];

  // ---- Pelvis (root — no joint) ----
  const pelvisUp = spine01.clone().sub(hips).normalize();
  parts.push({
    name: "pelvis",
    node: b("Hips"),
    shape: {
      type: "box",
      hx: Math.max(hipWidth * 0.7, 0.1),
      hy: Math.max(hipWidth * 0.35, 0.07),
      hz: Math.max(hipWidth * 0.4, 0.08),
    },
    mass: m.pelvis,
    bodyPosition: hips.clone(),
    bodyQuaternion: quatFromYAxis(pelvisUp),
    ccd: true,
  });

  // ---- Chest (Spine02 drives the whole upper torso) ----
  const chestCenter = spine01.clone().add(neck).multiplyScalar(0.5);
  const chestUp = neck.clone().sub(spine01);
  parts.push({
    name: "chest",
    node: b("Spine02"),
    shape: {
      type: "capsule",
      halfHeight: Math.max(chestUp.length() / 2 - shoulderWidth * 0.2, 0.03),
      radius: Math.max(shoulderWidth * 0.34, 0.09),
    },
    mass: m.chest,
    bodyPosition: chestCenter,
    bodyQuaternion: quatFromYAxis(chestUp),
    parent: "pelvis",
    joint: { type: "spherical", anchor: spine01.clone() },
    ccd: true,
  });

  // ---- Head ----
  const headRadius = headEnd
    ? THREE.MathUtils.clamp(head.distanceTo(headEnd) * 0.55, 0.08, 0.22)
    : Math.max(shoulderWidth * 0.25, 0.1);
  const headCenter = headEnd
    ? head.clone().add(headEnd).multiplyScalar(0.5)
    : head.clone().add(new THREE.Vector3(0, headRadius * 0.8, 0));
  parts.push({
    name: "head",
    node: b("Head"),
    shape: { type: "sphere", radius: headRadius },
    mass: m.head,
    bodyPosition: headCenter,
    bodyQuaternion: new THREE.Quaternion(),
    parent: "chest",
    joint: { type: "spherical", anchor: neck.clone() },
    ccd: true,
  });

  // ---- Arms (shoulder→elbow, elbow→wrist) ----
  parts.push(
    limbPart("upperArmL", b("LeftArm"), lShoulder, lElbow, armRadius, m.upperArm, "chest", lShoulder),
    limbPart("lowerArmL", b("LeftForeArm"), lElbow, lWrist, armRadius * 0.85, m.lowerArm, "upperArmL", lElbow),
    limbPart("upperArmR", b("RightArm"), rShoulder, rElbow, armRadius, m.upperArm, "chest", rShoulder),
    limbPart("lowerArmR", b("RightForeArm"), rElbow, rWrist, armRadius * 0.85, m.lowerArm, "upperArmR", rElbow),
  );

  // ---- Legs (hip→knee, knee→ankle) ----
  parts.push(
    limbPart("upperLegL", b("LeftUpLeg"), lHip, lKnee, legRadius, m.upperLeg, "pelvis", lHip),
    limbPart("lowerLegL", b("LeftLeg"), lKnee, lAnkle, legRadius * 0.8, m.lowerLeg, "upperLegL", lKnee),
    limbPart("upperLegR", b("RightUpLeg"), rHip, rKnee, legRadius, m.upperLeg, "pelvis", rHip),
    limbPart("lowerLegR", b("RightLeg"), rKnee, rAnkle, legRadius * 0.8, m.lowerLeg, "upperLegR", rKnee),
  );

  return parts;
}