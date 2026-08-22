import * as THREE from "three";
import { RagdollPartDef, RagdollShape } from "./RagdollController";

/**
 * Builds ragdoll part definitions for the PROCEDURAL low-poly bot model
 * (BotModel): the bot has no skinned skeleton — its "bones" are the part
 * groups/meshes tagged with `userData.ragdollPart` in BotModel:
 *
 *   torso (group: chest + head + visor + left arm)
 *   head  (mesh, child of torso — driven separately)
 *   armL  (mesh, child of torso)
 *   armR  (gun pivot group: right arm + rifle)
 *   legL / legR (groups)
 *
 * 6 rigid bodies jointed to the torso. Works on the LIVE bot model
 * (temporary knockdown ragdoll) AND on the corpse clone created by
 * BotModel.createCorpseVisual() (death ragdoll), because parts are looked
 * up by tag inside whatever root is provided.
 *
 * Shapes/offsets mirror the exact BotModel geometry (see its constructor).
 */

interface BotPartSpec {
  tag: string;
  shape: RagdollShape;
  /** Body center expressed in the part node's LOCAL space. */
  localOffset: THREE.Vector3;
  mass: number;
  parent?: string;
  /** Joint anchor in the part node's LOCAL space. */
  localAnchor?: THREE.Vector3;
  ccd?: boolean;
}

const SPECS: BotPartSpec[] = [
  {
    // Chest box (covers the torso; the head is its own body).
    tag: "torso",
    shape: { type: "box", hx: 0.26, hy: 0.3, hz: 0.15 },
    localOffset: new THREE.Vector3(0, 0.14, 0),
    mass: 40,
    ccd: true,
  },
  {
    tag: "head",
    shape: { type: "sphere", radius: 0.17 },
    localOffset: new THREE.Vector3(0, 0, 0),
    mass: 6,
    parent: "torso",
    // Neck: just under the head mesh center (head local y = 0.58 in torso).
    localAnchor: new THREE.Vector3(0, -0.15, 0),
    ccd: true,
  },
  {
    // Left arm mesh (0.11 × 0.4 × 0.11, pivot at its center).
    tag: "armL",
    shape: { type: "capsule", halfHeight: 0.13, radius: 0.07 },
    localOffset: new THREE.Vector3(0, 0, 0),
    mass: 4,
    parent: "torso",
    localAnchor: new THREE.Vector3(0, 0.2, 0), // shoulder end of the arm
  },
  {
    // Gun pivot: right arm + rifle extend along local -Z from the shoulder.
    tag: "armR",
    shape: { type: "box", hx: 0.07, hy: 0.08, hz: 0.3 },
    localOffset: new THREE.Vector3(0, -0.04, -0.3),
    mass: 6,
    parent: "torso",
    localAnchor: new THREE.Vector3(0, 0, 0), // shoulder pivot itself
  },
  {
    // Leg groups pivot at the hips; the box extends to local y ≈ -0.66.
    tag: "legL",
    shape: { type: "capsule", halfHeight: 0.22, radius: 0.09 },
    localOffset: new THREE.Vector3(0, -0.35, 0),
    mass: 10,
    parent: "torso",
    localAnchor: new THREE.Vector3(0, 0, 0), // hip pivot
  },
  {
    tag: "legR",
    shape: { type: "capsule", halfHeight: 0.22, radius: 0.09 },
    localOffset: new THREE.Vector3(0, -0.35, 0),
    mass: 10,
    parent: "torso",
    localAnchor: new THREE.Vector3(0, 0, 0),
  },
];

/**
 * Build the 6-body bot ragdoll from the CURRENT pose of `root` (either the
 * live bot model group or a corpse clone). Returns null if the tagged
 * parts are missing.
 */
export function buildBotRagdollParts(root: THREE.Object3D): RagdollPartDef[] | null {
  root.updateMatrixWorld(true);

  const byTag = new Map<string, THREE.Object3D>();
  root.traverse((obj) => {
    const tag = obj.userData?.ragdollPart as string | undefined;
    if (tag && !byTag.has(tag)) byTag.set(tag, obj);
  });

  const parts: RagdollPartDef[] = [];
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  for (const spec of SPECS) {
    const node = byTag.get(spec.tag);
    if (!node) return null;
    node.matrixWorld.decompose(pos, quat, scale);

    const bodyPosition = spec.localOffset.clone().applyQuaternion(quat).add(pos);
    const def: RagdollPartDef = {
      name: spec.tag,
      node,
      shape: spec.shape,
      mass: spec.mass,
      bodyPosition,
      bodyQuaternion: quat.clone(),
      ccd: spec.ccd,
    };
    if (spec.parent && spec.localAnchor) {
      def.parent = spec.parent;
      def.joint = {
        type: "spherical",
        anchor: spec.localAnchor.clone().applyQuaternion(quat).add(pos),
      };
    }
    parts.push(def);
  }
  return parts;
}