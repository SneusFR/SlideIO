import * as THREE from "three";
import type RAPIER_API from "@dimforge/rapier3d-compat";
import { PhysicsWorld, RAPIER, CollisionGroups } from "../physics/PhysicsWorld";
import { RagdollConfig as rc } from "./RagdollConfig";

/**
 * Simple physical primitives only (no trimesh per limb):
 * capsules for limbs, sphere for the head, boxes for torso/pelvis parts.
 */
export type RagdollShape =
  | { type: "capsule"; halfHeight: number; radius: number }
  | { type: "sphere"; radius: number }
  | { type: "box"; hx: number; hy: number; hz: number };

/** Joint connecting a part to its parent part (anchors in WORLD space). */
export interface RagdollJointDef {
  /**
   * NOTE: the Rapier compat JS build exposes no cone/twist limits, so the
   * runtime uses SPHERICAL joints everywhere; human-plausible motion is
   * enforced through strong angular damping + hard angular velocity clamps
   * (see RagdollConfig). The field is kept for future engine upgrades.
   */
  type: "spherical";
  /** World-space anchor point captured from the CURRENT pose. */
  anchor: THREE.Vector3;
}

/**
 * One simulated body of the ragdoll, mapped onto one visual node
 * (a skeleton Bone for skinned characters, a part Object3D for the
 * procedural bot model). Everything is captured from the LIVE pose so the
 * physical body starts EXACTLY where the animation left the character —
 * no T-pose, no snap, no teleport.
 */
export interface RagdollPartDef {
  name: string;
  /** Visual node driven by this rigid body while the ragdoll is active. */
  node: THREE.Object3D;
  shape: RagdollShape;
  mass: number;
  /** Body world transform at activation (captured from the pose). */
  bodyPosition: THREE.Vector3;
  bodyQuaternion: THREE.Quaternion;
  /** Parent part name — the joint connects this part to it. */
  parent?: string;
  joint?: RagdollJointDef;
  /** Enable CCD (fast key parts: pelvis / torso / head). */
  ccd?: boolean;
}

export type RagdollMode = "TEMPORARY" | "DEATH";

/** Generic impact description handed over by the combat system. */
export interface RagdollImpact {
  /** Knockback expressed as a velocity delta (m/s) — same convention as
   *  Combatant.applyImpulse, so weapons need no unit conversion. */
  impulse: THREE.Vector3;
  /** World impact point (optional — a plausible one is synthesized). */
  point?: THREE.Vector3 | null;
}

export interface RagdollActivationOptions {
  mode: RagdollMode;
  /** Character velocity at the moment of activation (momentum transfer). */
  velocity: THREE.Vector3;
  /** Optional hit that triggered the ragdoll (adds impulse + spin). */
  impact?: RagdollImpact | null;
}

interface RagdollPart {
  def: RagdollPartDef;
  body: RAPIER_API.RigidBody;
  collider: RAPIER_API.Collider;
  /** Node transform relative to the body (constant rigid offset). */
  offsetPos: THREE.Vector3;
  offsetQuat: THREE.Quaternion;
  /** Node LOCAL transform saved at activation — restored on recovery. */
  restPos: THREE.Vector3;
  restQuat: THREE.Quaternion;
  debugMesh: THREE.Mesh | null;
}

// Module-level scratch (controllers never run concurrently within a frame).
const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _m3 = new THREE.Matrix4();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _s1 = new THREE.Vector3();

let debugMaterial: THREE.MeshBasicMaterial | null = null;
function getDebugMaterial(): THREE.MeshBasicMaterial {
  if (!debugMaterial) {
    debugMaterial = new THREE.MeshBasicMaterial({
      color: 0x22ff88,
      wireframe: true,
      toneMapped: false,
      depthTest: false,
    });
  }
  return debugMaterial;
}

/**
 * Generic, reusable ragdoll: turns a posed character (skinned skeleton OR
 * procedural part hierarchy) into a set of Rapier dynamic bodies connected
 * by joints, keeps the visuals glued to the simulation every frame, and
 * reports when a temporary ragdoll has settled enough to recover.
 *
 *   Animated character → activate(parts, {velocity, impact})
 *   → rigid bodies spawned AT the current pose (zero visual discontinuity)
 *   → momentum + hit impulse transferred
 *   → update(dt) writes body transforms back into the bones/parts
 *   → TEMPORARY: shouldRecover() → deactivate() + restorePose()
 *   → DEATH: simulated until the CorpseManager disposes it.
 *
 * Collision groups: ragdoll bodies collide with the WORLD only — never
 * with character capsules (corpses can't block doorways) and never with
 * each other (no self-collision explosions between jointed limbs).
 */
export class RagdollController {
  private readonly parts: RagdollPart[] = [];
  private readonly byName = new Map<string, RagdollPart>();
  private readonly joints: RAPIER_API.ImpulseJoint[] = [];
  private root: THREE.Object3D | null = null;
  private debugGroup: THREE.Group | null = null;
  /** Debug: one line per part (body center → center + linear velocity). */
  private debugVelLines: THREE.LineSegments | null = null;

  active = false;
  mode: RagdollMode = "TEMPORARY";
  /** Seconds since activation. */
  elapsed = 0;
  /** True once a NaN / runaway body was detected (caller should dispose). */
  corrupted = false;

  constructor(
    private readonly physics: PhysicsWorld,
    /** Scene used ONLY for the optional debug drawing. */
    private readonly debugScene: THREE.Scene | null = null,
  ) {}

  // ------------------------------------------------------------------
  // Activation — animation → physics with zero visual discontinuity
  // ------------------------------------------------------------------

  /**
   * Build the physical skeleton from the CURRENT pose and hand the body
   * over to Rapier. `visualRoot` is the character root whose world matrix
   * chain contains every part node.
   */
  activate(
    visualRoot: THREE.Object3D,
    defs: RagdollPartDef[],
    options: RagdollActivationOptions,
  ): void {
    if (this.active) this.deactivate();
    this.root = visualRoot;
    this.mode = options.mode;
    this.elapsed = 0;
    this.corrupted = false;

    const world = this.physics.world;

    // ---- Bodies + colliders, created exactly at the captured pose ----
    for (const def of defs) {
      const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(def.bodyPosition.x, def.bodyPosition.y, def.bodyPosition.z)
        .setRotation({
          x: def.bodyQuaternion.x,
          y: def.bodyQuaternion.y,
          z: def.bodyQuaternion.z,
          w: def.bodyQuaternion.w,
        })
        .setLinearDamping(rc.linearDamping)
        .setAngularDamping(rc.angularDamping)
        .setGravityScale(rc.gravityScale)
        .setCcdEnabled(rc.ccdOnKeyParts && !!def.ccd);
      const body = world.createRigidBody(bodyDesc);
      body.setLinvel(
        { x: options.velocity.x, y: options.velocity.y, z: options.velocity.z },
        true,
      );

      let colDesc: RAPIER_API.ColliderDesc;
      const s = def.shape;
      if (s.type === "capsule") colDesc = RAPIER.ColliderDesc.capsule(s.halfHeight, s.radius);
      else if (s.type === "sphere") colDesc = RAPIER.ColliderDesc.ball(s.radius);
      else colDesc = RAPIER.ColliderDesc.cuboid(s.hx, s.hy, s.hz);
      colDesc
        .setMass(def.mass)
        .setFriction(rc.friction)
        .setRestitution(rc.restitution)
        .setCollisionGroups(CollisionGroups.RAGDOLL);
      const collider = world.createCollider(colDesc, body);

      // Rigid node↔body offset (constant): nodeWorld = bodyWorld * offset.
      def.node.updateWorldMatrix(true, false);
      _m1.copy(def.node.matrixWorld);
      // Strip the (uniform) scale so the offset stays a rigid transform.
      _m1.decompose(_v1, _q1, _s1);
      _q2.copy(def.bodyQuaternion).invert();
      const offsetQuat = _q2.clone().multiply(_q1);
      const offsetPos = _v1.clone().sub(def.bodyPosition).applyQuaternion(_q2);

      const part: RagdollPart = {
        def,
        body,
        collider,
        offsetPos,
        offsetQuat,
        restPos: def.node.position.clone(),
        restQuat: def.node.quaternion.clone(),
        debugMesh: null,
      };
      this.parts.push(part);
      this.byName.set(def.name, part);
    }

    // ---- Joints (spherical, contacts between linked bodies disabled) ----
    for (const part of this.parts) {
      const def = part.def;
      if (!def.parent || !def.joint) continue;
      const parent = this.byName.get(def.parent);
      if (!parent) continue;
      const a1 = worldPointToBodyLocal(parent.body, def.joint.anchor, _v1);
      const a2 = worldPointToBodyLocal(part.body, def.joint.anchor, _v2);
      const data = RAPIER.JointData.spherical(
        { x: a1.x, y: a1.y, z: a1.z },
        { x: a2.x, y: a2.y, z: a2.z },
      );
      const joint = this.physics.world.createImpulseJoint(data, parent.body, part.body, true);
      joint.setContactsEnabled(false);
      this.joints.push(joint);
    }

    this.active = true;

    // ---- Momentum + hit impulse transfer ----
    if (options.impact) this.applyImpact(options.impact);

    // Debug view (dev tuning only — off by default, `?ragdollDebug=1`).
    if (rc.debugDraw && this.debugScene) {
      this.createDebugMeshes();
      // Part inventory: node (bone) names, masses and shapes — the fast
      // way to check proportions/orientations while tuning.
      // eslint-disable-next-line no-console
      console.table(
        defs.map((d) => ({
          part: d.name,
          bone: d.node.name,
          shape: d.shape.type,
          mass: d.mass,
          parent: d.parent ?? "-",
          ccd: !!d.ccd,
        })),
      );
    }

    // First visual sync right away: the body IS at the captured pose, so
    // this is a no-op visually — it just primes the node offsets.
    this.syncVisuals();
  }

  // ------------------------------------------------------------------
  // Impacts
  // ------------------------------------------------------------------

  /**
   * Transfer a combat hit into the simulation:
   *  1. UNIFORM momentum: every body gains the full impulse as a velocity
   *     delta (impulse × bodyMass) — the character-level knockback (m/s)
   *     is preserved exactly, like the capsule version did.
   *  2. SPIN kick: an extra impulse applied AT the impact point on the
   *     nearest body, producing the natural rotation of the hit.
   */
  applyImpact(impact: RagdollImpact): void {
    if (!this.active || this.parts.length === 0) return;
    const imp = impact.impulse;
    if (imp.lengthSq() < 1e-6) return;

    for (const part of this.parts) {
      part.body.applyImpulse(
        { x: imp.x * part.def.mass, y: imp.y * part.def.mass, z: imp.z * part.def.mass },
        true,
      );
    }

    // Pick the body closest to the impact point (or the torso-ish root).
    let hit = this.parts[0];
    if (impact.point) {
      let best = Infinity;
      for (const part of this.parts) {
        const t = part.body.translation();
        const d =
          (t.x - impact.point.x) ** 2 + (t.y - impact.point.y) ** 2 + (t.z - impact.point.z) ** 2;
        if (d < best) {
          best = d;
          hit = part;
        }
      }
    }

    // Impact point: the real one when known, otherwise a plausible point
    // slightly above the center of mass and against the hit direction —
    // enough offset to tumble the body forward with the blow.
    const t = hit.body.translation();
    if (impact.point) {
      _v1.copy(impact.point);
    } else {
      _v2.copy(imp).normalize();
      _v1.set(
        t.x - _v2.x * rc.impactPointBackOffset,
        t.y + rc.impactPointUpOffset,
        t.z - _v2.z * rc.impactPointBackOffset,
      );
    }
    const k = hit.def.mass * rc.impactSpinBoost;
    hit.body.applyImpulseAtPoint(
      { x: imp.x * k, y: imp.y * k, z: imp.z * k },
      { x: _v1.x, y: _v1.y, z: _v1.z },
      true,
    );
  }

  // ------------------------------------------------------------------
  // Per-frame update (AFTER physics.step)
  // ------------------------------------------------------------------

  update(_dt: number): void {
    if (!this.active) return;
    this.elapsed += _dt;
    this.clampAndValidate();
    if (this.corrupted) return;
    this.syncVisuals();
    if (this.debugGroup) this.syncDebugMeshes();
  }

  /** Root (pelvis) world position. */
  getRootPosition(out: THREE.Vector3): THREE.Vector3 {
    if (this.parts.length === 0) return out.set(0, 0, 0);
    const t = this.parts[0].body.translation();
    return out.set(t.x, t.y, t.z);
  }

  /** Root (pelvis) linear velocity. */
  getRootVelocity(out: THREE.Vector3): THREE.Vector3 {
    if (this.parts.length === 0) return out.set(0, 0, 0);
    const v = this.parts[0].body.linvel();
    return out.set(v.x, v.y, v.z);
  }

  /**
   * TEMPORARY ragdolls: true when the body has been down long enough AND
   * has physically settled (pelvis linear + angular velocity thresholds),
   * or when the hard timeout expired (body stuck / resting on an edge).
   */
  get shouldRecover(): boolean {
    if (!this.active || this.mode !== "TEMPORARY") return false;
    if (this.elapsed < rc.temporaryMinDuration) return false;
    if (this.elapsed >= rc.temporaryMaxDuration) return true;
    const root = this.parts[0];
    const lv = root.body.linvel();
    const av = root.body.angvel();
    const lin = Math.hypot(lv.x, lv.y, lv.z);
    const ang = Math.hypot(av.x, av.y, av.z);
    return lin < rc.recoveryLinearVelocity && ang < rc.recoveryAngularVelocity;
  }

  // ------------------------------------------------------------------
  // Deactivation / recovery
  // ------------------------------------------------------------------

  /**
   * Restore the node LOCAL transforms captured at activation (rest pose of
   * the moment the ragdoll started). Used at recovery — the animation
   * system takes over again and blends from there.
   */
  restorePose(): void {
    for (const part of this.parts) {
      part.def.node.position.copy(part.restPos);
      part.def.node.quaternion.copy(part.restQuat);
    }
  }

  /** Remove every physical object. Visual nodes are left as-is. */
  deactivate(): void {
    const world = this.physics.world;
    for (const joint of this.joints) {
      try {
        world.removeImpulseJoint(joint, true);
      } catch {
        /* already removed with a body */
      }
    }
    this.joints.length = 0;
    for (const part of this.parts) {
      world.removeCollider(part.collider, false);
      world.removeRigidBody(part.body);
      if (part.debugMesh) {
        part.debugMesh.removeFromParent();
        part.debugMesh.geometry.dispose();
      }
      part.debugMesh = null;
    }
    if (this.debugVelLines) {
      this.debugVelLines.geometry.dispose();
      (this.debugVelLines.material as THREE.Material).dispose();
      this.debugVelLines = null;
    }
    if (this.debugGroup) {
      this.debugGroup.removeFromParent();
      this.debugGroup = null;
    }
    this.parts.length = 0;
    this.byName.clear();
    this.root = null;
    this.active = false;
  }

  dispose(): void {
    this.deactivate();
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /** Hard safeties: velocity clamps + NaN detection (never into space). */
  private clampAndValidate(): void {
    for (const part of this.parts) {
      const t = part.body.translation();
      if (!Number.isFinite(t.x) || !Number.isFinite(t.y) || !Number.isFinite(t.z)) {
        this.corrupted = true;
        return;
      }
      const lv = part.body.linvel();
      const lin = Math.hypot(lv.x, lv.y, lv.z);
      if (lin > rc.maxLinearVelocity) {
        const s = rc.maxLinearVelocity / lin;
        part.body.setLinvel({ x: lv.x * s, y: lv.y * s, z: lv.z * s }, true);
      }
      const av = part.body.angvel();
      const ang = Math.hypot(av.x, av.y, av.z);
      if (ang > rc.maxAngularVelocity) {
        const s = rc.maxAngularVelocity / ang;
        part.body.setAngvel({ x: av.x * s, y: av.y * s, z: av.z * s }, true);
      }
    }
  }

  /**
   * Physics → visuals: write each body's world transform back into its
   * node. Parts are ordered ancestors-first; after each write the node's
   * subtree world matrices are refreshed so the NEXT part computes its
   * local transform against up-to-date parent matrices. The skinned mesh
   * (or part meshes) therefore follow the simulation exactly.
   */
  private syncVisuals(): void {
    if (!this.root) return;
    this.root.updateMatrixWorld(true);

    for (const part of this.parts) {
      const node = part.def.node;
      const parent = node.parent;
      if (!parent) continue;

      const t = part.body.translation();
      const r = part.body.rotation();
      _q1.set(r.x, r.y, r.z, r.w);

      // Target node world transform = bodyWorld * (constant rigid offset).
      _v1.copy(part.offsetPos).applyQuaternion(_q1);
      _v1.x += t.x;
      _v1.y += t.y;
      _v1.z += t.z;
      _q2.copy(_q1).multiply(part.offsetQuat);
      _m1.compose(_v1, _q2, UNIT_SCALE);

      // Node local = inv(parentWorld) * targetWorld. The decomposed scale
      // is DISCARDED (the original local scale is kept) so uniform model
      // scaling and skin binding stay exact.
      _m2.copy(parent.matrixWorld).invert();
      _m3.multiplyMatrices(_m2, _m1);
      _m3.decompose(_v2, _q1, _v3);
      node.position.copy(_v2);
      node.quaternion.copy(_q1);
      node.updateWorldMatrix(false, true);
    }
  }

  private createDebugMeshes(): void {
    if (!this.debugScene) return;
    this.debugGroup = new THREE.Group();
    this.debugGroup.renderOrder = 999;
    for (const part of this.parts) {
      const s = part.def.shape;
      let geo: THREE.BufferGeometry;
      if (s.type === "capsule") geo = new THREE.CapsuleGeometry(s.radius, s.halfHeight * 2, 3, 8);
      else if (s.type === "sphere") geo = new THREE.SphereGeometry(s.radius, 8, 6);
      else geo = new THREE.BoxGeometry(s.hx * 2, s.hy * 2, s.hz * 2);
      const mesh = new THREE.Mesh(geo, getDebugMaterial());
      mesh.frustumCulled = false;
      part.debugMesh = mesh;
      this.debugGroup.add(mesh);
    }

    // Linear velocity vectors: one segment per part (updated every frame).
    const velGeo = new THREE.BufferGeometry();
    velGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(this.parts.length * 6), 3),
    );
    this.debugVelLines = new THREE.LineSegments(
      velGeo,
      new THREE.LineBasicMaterial({ color: 0xffcc33, toneMapped: false, depthTest: false }),
    );
    this.debugVelLines.frustumCulled = false;
    this.debugVelLines.renderOrder = 999;
    this.debugGroup.add(this.debugVelLines);

    this.debugScene.add(this.debugGroup);
  }

  private syncDebugMeshes(): void {
    const velAttr = this.debugVelLines?.geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute | undefined;

    for (let i = 0; i < this.parts.length; i++) {
      const part = this.parts[i];
      const t = part.body.translation();
      const r = part.body.rotation();
      if (part.debugMesh) {
        part.debugMesh.position.set(t.x, t.y, t.z);
        part.debugMesh.quaternion.set(r.x, r.y, r.z, r.w);
      }
      if (velAttr) {
        // Segment: body center → center + linvel × 0.1 (100 ms of travel).
        const v = part.body.linvel();
        velAttr.setXYZ(i * 2, t.x, t.y, t.z);
        velAttr.setXYZ(i * 2 + 1, t.x + v.x * 0.1, t.y + v.y * 0.1, t.z + v.z * 0.1);
      }
    }
    if (velAttr) velAttr.needsUpdate = true;
  }
}

const UNIT_SCALE = new THREE.Vector3(1, 1, 1);

/** World point → a rigid body's local space. */
function worldPointToBodyLocal(
  body: RAPIER_API.RigidBody,
  point: THREE.Vector3,
  out: THREE.Vector3,
): THREE.Vector3 {
  const t = body.translation();
  const r = body.rotation();
  _q1.set(r.x, r.y, r.z, r.w).invert();
  out.set(point.x - t.x, point.y - t.y, point.z - t.z).applyQuaternion(_q1);
  return out;
}