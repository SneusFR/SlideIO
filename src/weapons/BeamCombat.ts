import * as THREE from "three";
import { Combatant } from "../combat/Combatant";
import { HitZone } from "../combat/HitZone";
import { TrainingTarget } from "../targets/TrainingTarget";

/** Result of a beam raycast, written in place (no allocations). */
export class BeamCastResult {
  hit = false;
  readonly point = new THREE.Vector3();
  readonly normal = new THREE.Vector3();
  combatant: Combatant | null = null;
  trainingTarget: TrainingTarget | null = null;
  /** Zone of the combatant hit (BODY unless a HEAD-tagged mesh was struck). */
  hitZone: HitZone = HitZone.BODY;
}

/** Walk up the parent chain to find the entity a mesh belongs to. */
function resolveCombatant(object: THREE.Object3D): Combatant | null {
  let o: THREE.Object3D | null = object;
  while (o) {
    const c = o.userData.combatant as Combatant | undefined;
    if (c) return c;
    o = o.parent;
  }
  return null;
}

/**
 * Resolve the anatomical zone of the struck mesh: walk up from the hit
 * object looking for a `userData.hitZone` tag, stopping at the combatant
 * root (a head tag never leaks to another entity). Default = BODY.
 */
function resolveHitZone(object: THREE.Object3D): HitZone {
  let o: THREE.Object3D | null = object;
  while (o) {
    const z = o.userData.hitZone as HitZone | undefined;
    if (z) return z;
    if (o.userData.combatant) break; // combatant root reached — stop
    o = o.parent;
  }
  return HitZone.BODY;
}

function resolveTrainingTarget(object: THREE.Object3D): TrainingTarget | null {
  let o: THREE.Object3D | null = object;
  while (o) {
    const t = o.userData.trainingTarget as TrainingTarget | undefined;
    if (t) return t;
    o = o.parent;
  }
  return null;
}

/**
 * Shared beam raycast used by BOTH the player's Plasma Rifle and every bot
 * rifle. The beam is blocked by the first solid thing hit; hits belonging to
 * `owner` are skipped (a rifle can never damage its own wielder).
 * The weapon itself is perfectly accurate — imprecision comes only from
 * where the shooter is aiming.
 */
export function castBeam(
  raycaster: THREE.Raycaster,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  range: number,
  hittables: THREE.Object3D[],
  owner: Combatant | null,
  out: BeamCastResult,
): void {
  raycaster.set(origin, direction);
  raycaster.far = range;

  out.hit = false;
  out.combatant = null;
  out.trainingTarget = null;
  out.hitZone = HitZone.BODY;

  const hits = raycaster.intersectObjects(hittables, true);
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const combatant = resolveCombatant(h.object);
    if (combatant && combatant === owner) continue; // never hit yourself
    if (combatant && !combatant.health.alive) continue; // corpses don't block

    out.hit = true;
    out.point.copy(h.point);
    if (h.face) {
      out.normal.copy(h.face.normal).transformDirection(h.object.matrixWorld);
    } else {
      out.normal.copy(direction).negate();
    }
    out.combatant = combatant;
    out.hitZone = combatant ? resolveHitZone(h.object) : HitZone.BODY;
    out.trainingTarget = combatant ? null : resolveTrainingTarget(h.object);
    return;
  }

  // Nothing hit: beam ends at max range.
  out.point.copy(direction).multiplyScalar(range).add(origin);
  out.normal.copy(direction).negate();
}