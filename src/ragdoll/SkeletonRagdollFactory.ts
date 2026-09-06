import * as THREE from "three";
import { RagdollPartDef, RagdollShape } from "./RagdollController";
import { RagdollConfig as rc } from "./RagdollConfig";

/**
 * Builds ragdoll part definitions from the REAL Potato character skeleton
 * (inspected in the pack — scripts/inspect-potato.mjs):
 *
 *   Root → Hips → Spine → Spine_1 → Chest → Neck → Head → Plant_Root/Tip
 *   Chest → Shoulder_L/R → UpperArm_L/R → LowerArm_L/R → Hand_L/R
 *   Hips → UpperLeg_L/R → LowerLeg_L/R → Foot_L/R
 *
 * 11 rigid bodies (quality/performance compromise):
 *   pelvis (Hips), chest (Chest), head (Head),
 *   upper+lower arms ×2, upper+lower legs ×2.
 *
 * Intermediate bones (Spine, Spine_1, Neck, shoulders, hands, feet, the
 * plant and the cosmetic sockets Head_Socket/Face_Socket/Back_Socket)
 * keep their pose-local transforms and simply follow their driven
 * ancestors — sockets stay anchored to their parent in ragdoll too.
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
  "Spine_1",
  "Chest",
  "Neck",
  "Head",
  "UpperArm_L",
  "LowerArm_L",
  "Hand_L",
  "UpperArm_R",
  "LowerArm_R",
  "Hand_R",
  "UpperLeg_L",
  "LowerLeg_L",
  "Foot_L",
  "UpperLeg_R",
  "LowerLeg_R",
  "Foot_R",
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
  const spine01 = worldPos(b("Spine_1"));
  const neck = worldPos(b("Neck"));
  const head = worldPos(b("Head"));
  // No head-tip helper bone exists on the Potato rig (and the plant leaf
  // must NEVER stand in for one — it would stretch the head body up the
  // sprout): the head radius derives from the shoulder width instead.
  const headEnd: THREE.Vector3 | null = null;

  const lShoulder = worldPos(b("UpperArm_L"));
  const lElbow = worldPos(b("LowerArm_L"));
  const lWrist = worldPos(b("Hand_L"));
  const rShoulder = worldPos(b("UpperArm_R"));
  const rElbow = worldPos(b("LowerArm_R"));
  const rWrist = worldPos(b("Hand_R"));

  const lHip = worldPos(b("UpperLeg_L"));
  const lKnee = worldPos(b("LowerLeg_L"));
  const lAnkle = worldPos(b("Foot_L"));
  const rHip = worldPos(b("UpperLeg_R"));
  const rKnee = worldPos(b("LowerLeg_R"));
  const rAnkle = worldPos(b("Foot_R"));

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

  // ---- Chest (the Chest bone drives the whole upper torso) ----
  const chestCenter = spine01.clone().add(neck).multiplyScalar(0.5);
  const chestUp = neck.clone().sub(spine01);
  parts.push({
    name: "chest",
    node: b("Chest"),
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
    limbPart("upperArmL", b("UpperArm_L"), lShoulder, lElbow, armRadius, m.upperArm, "chest", lShoulder),
    limbPart("lowerArmL", b("LowerArm_L"), lElbow, lWrist, armRadius * 0.85, m.lowerArm, "upperArmL", lElbow),
    limbPart("upperArmR", b("UpperArm_R"), rShoulder, rElbow, armRadius, m.upperArm, "chest", rShoulder),
    limbPart("lowerArmR", b("LowerArm_R"), rElbow, rWrist, armRadius * 0.85, m.lowerArm, "upperArmR", rElbow),
  );

  // ---- Legs (hip→knee, knee→ankle) ----
  parts.push(
    limbPart("upperLegL", b("UpperLeg_L"), lHip, lKnee, legRadius, m.upperLeg, "pelvis", lHip),
    limbPart("lowerLegL", b("LowerLeg_L"), lKnee, lAnkle, legRadius * 0.8, m.lowerLeg, "upperLegL", lKnee),
    limbPart("upperLegR", b("UpperLeg_R"), rHip, rKnee, legRadius, m.upperLeg, "pelvis", rHip),
    limbPart("lowerLegR", b("LowerLeg_R"), rKnee, rAnkle, legRadius * 0.8, m.lowerLeg, "upperLegR", rKnee),
  );

  return parts;
}