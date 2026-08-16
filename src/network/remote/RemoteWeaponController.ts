import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { NetworkWeaponId, isNetworkWeaponId } from "../../../shared/combat/NetworkWeapons";
// Real weapon GLBs (same optimized assets as the local viewmodels/menu).
import hammerUrl from "../../assets/voidhammer_opt.glb?url";
import rifleUrl from "../../assets/voidrifle_opt.glb?url";
import spearUrl from "../../assets/lance_opt.glb?url";
import obliterreurUrl from "../../assets/obliterreur_opt.glb?url";
import revolverUrl from "../../assets/revolver_opt.glb?url";

/** How a weapon GLB sits in a remote character's hand (menu-proven recipe). */
interface RemoteWeaponAttachment {
  url: string;
  bone: "RightHand" | "LeftHand";
  position: THREE.Vector3;
  rotation: THREE.Euler;
  /** Target world length of the longest dimension (meters). */
  size: number;
  /**
   * Extra MODEL-SPACE rotation baked into the normalized template
   * (e.g. flip a barrel that points the wrong way in the source GLB).
   */
  modelRotation?: THREE.Euler;
}

/**
 * Single tuning table for every remote in-hand weapon. Hammer + plasma
 * offsets are the exact values proven in the Main Menu character
 * (MenuConfig); the other three reuse the matching hand's grip.
 */
export const REMOTE_WEAPON_CONFIG: Record<NetworkWeaponId, RemoteWeaponAttachment> = {
  [NetworkWeaponId.HAMMER]: {
    url: hammerUrl,
    bone: "RightHand",
    position: new THREE.Vector3(0.02, 0.16, 0.05),
    rotation: new THREE.Euler(0.15, 0, -0.2),
    size: 1.05,
  },
  [NetworkWeaponId.PLASMA_RIFLE]: {
    url: rifleUrl,
    bone: "LeftHand",
    position: new THREE.Vector3(-0.02, 0.14, 0.06),
    rotation: new THREE.Euler(0.35, Math.PI / 2, 0.1),
    size: 0.95,
    // The rifle barrel runs along the model X axis — without this flip the
    // muzzle points BACKWARDS in the remote hand (reported in playtests).
    modelRotation: new THREE.Euler(0, Math.PI, 0),
  },
  [NetworkWeaponId.SPEAR]: {
    url: spearUrl,
    bone: "RightHand",
    position: new THREE.Vector3(0.02, 0.16, 0.05),
    rotation: new THREE.Euler(0.15, 0, -0.2),
    size: 1.7,
  },
  [NetworkWeaponId.REVOLVER]: {
    url: revolverUrl,
    bone: "RightHand",
    position: new THREE.Vector3(0.02, 0.14, 0.04),
    rotation: new THREE.Euler(0.15, 0, -0.2),
    size: 0.35,
  },
  [NetworkWeaponId.OBLITERREUR]: {
    url: obliterreurUrl,
    bone: "LeftHand",
    position: new THREE.Vector3(-0.02, 0.14, 0.06),
    rotation: new THREE.Euler(0.35, Math.PI / 2, 0.1),
    size: 1.0,
    // Same hand + same forward convention as the plasma rifle.
    modelRotation: new THREE.Euler(0, Math.PI, 0),
  },
};

// ---- Shared, cached weapon templates (load once → clone per player) ----
// Templates are pre-normalized (centered on origin, longest axis = size)
// so per-player attachment is a cheap clone + grip wrapper.
const templateCache = new Map<NetworkWeaponId, Promise<THREE.Group>>();

/** Load (once) the normalized template for a weapon; clones are cheap. */
export function loadRemoteWeaponTemplate(id: NetworkWeaponId): Promise<THREE.Group> {
  let cached = templateCache.get(id);
  if (cached) return cached;
  const att = REMOTE_WEAPON_CONFIG[id];
  cached = new GLTFLoader().loadAsync(att.url).then((gltf) => {
    const scene = gltf.scene;
    // Normalize ONCE: uniform target size, centered on the origin.
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
    scene.scale.setScalar(att.size / maxDim);
    // Optional model-space orientation fix — applied BEFORE centering so
    // the recentre below accounts for the rotated bounds.
    if (att.modelRotation) scene.rotation.copy(att.modelRotation);
    box.setFromObject(scene);
    const center = box.getCenter(new THREE.Vector3());
    scene.position.sub(center);
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.frustumCulled = false; // moves with the animated bone
      }
    });
    return scene;
  });
  templateCache.set(id, cached);
  return cached;
}

/**
 * Preload EVERY remote weapon template up front (multiplayer loading
 * screen). Without this, the first remote shot / melee swing / throw would
 * parse a multi-MB GLB on the main thread — a visible one-time stutter.
 */
export function preloadRemoteWeaponTemplates(): Promise<void> {
  return Promise.all(
    Object.values(NetworkWeaponId).map((id) => loadRemoteWeaponTemplate(id)),
  ).then(() => undefined);
}

/** Swing animation duration (procedural grip rotation, seconds). */
const SWING_DURATION = 0.35;
/** How long a melee weapon stays visible in the hand after an attack (s). */
const MELEE_OVERRIDE_DURATION = 0.9;

/**
 * Puts the REAL equipped weapon GLB in a remote player's hand (Phase 5).
 *
 *   - `setWeapon(id)` mirrors the SERVER-validated NetworkPlayer.weapon.
 *   - Melee attacks temporarily override the displayed weapon (a player
 *     holding the rifle still swings a real hammer) + a short procedural
 *     swing on the grip so remote melee reads clearly.
 *   - `getMuzzleWorldPosition` anchors remote beam/tracer starts.
 *
 * Pure visuals — no gameplay, no physics, no networking in here.
 */
export class RemoteWeaponController {
  /** SERVER-equipped weapon (from the synced schema). */
  private equipped: NetworkWeaponId = NetworkWeaponId.PLASMA_RIFLE;
  /** Temporary melee display override (sweep/slam visuals). */
  private overrideId: NetworkWeaponId | null = null;
  private overrideTimer = 0;
  /** Currently displayed weapon + its grip node (attached to a bone). */
  private displayed: NetworkWeaponId | null = null;
  private grip: THREE.Group | null = null;
  private baseRotation = new THREE.Euler();
  /** Guards stale async loads (fast weapon switches). */
  private loadToken = 0;
  private disposed = false;

  // Procedural swing state
  private swingTimer = -1;
  private swingKind: "sweep" | "slam" = "sweep";

  constructor(private readonly characterModel: THREE.Object3D) {}

  /** Mirror the server-synced weapon id (unknown strings are ignored). */
  setWeapon(raw: string): void {
    if (!isNetworkWeaponId(raw)) return;
    if (this.equipped === raw) return;
    this.equipped = raw;
    this.refreshDisplayed();
  }

  /**
   * A confirmed melee action: show the REAL melee weapon in the hand for a
   * short window and play a procedural swing on the grip.
   */
  triggerMelee(raw: string, kind: "sweep" | "slam"): void {
    if (!isNetworkWeaponId(raw)) return;
    this.overrideId = raw;
    this.overrideTimer = MELEE_OVERRIDE_DURATION;
    this.swingTimer = 0;
    this.swingKind = kind;
    this.refreshDisplayed();
  }

  /** Per-frame: override expiry + swing animation. */
  update(dt: number): void {
    if (this.overrideId) {
      this.overrideTimer -= dt;
      if (this.overrideTimer <= 0) {
        this.overrideId = null;
        this.swingTimer = -1;
        this.refreshDisplayed();
      }
    }

    if (this.swingTimer >= 0 && this.grip) {
      this.swingTimer += dt;
      const p = Math.min(this.swingTimer / SWING_DURATION, 1);
      const arc = Math.sin(p * Math.PI); // 0 → 1 → 0
      if (this.swingKind === "sweep") {
        // Horizontal-ish chop across the body.
        this.grip.rotation.set(
          this.baseRotation.x - arc * 1.35,
          this.baseRotation.y + arc * 0.55,
          this.baseRotation.z,
        );
      } else {
        // Overhead slam wind-up/descent.
        this.grip.rotation.set(
          this.baseRotation.x + arc * 1.7,
          this.baseRotation.y,
          this.baseRotation.z,
        );
      }
      if (p >= 1) {
        this.swingTimer = -1;
        this.grip.rotation.copy(this.baseRotation);
      }
    }
  }

  /**
   * World position of the displayed weapon's grip (beam/tracer anchor).
   * Requires up-to-date world matrices (the game updates them per frame).
   */
  getMuzzleWorldPosition(out: THREE.Vector3): boolean {
    if (!this.grip) return false;
    this.grip.getWorldPosition(out);
    return true;
  }

  /** Detach the current weapon. Shared template resources stay cached. */
  dispose(): void {
    this.disposed = true;
    this.detach();
  }

  // ------------------------------------------------------------------

  private refreshDisplayed(): void {
    const target = this.overrideId ?? this.equipped;
    if (this.displayed === target) return;
    const token = ++this.loadToken;
    void loadRemoteWeaponTemplate(target).then((template) => {
      // Stale async result (player switched again / controller disposed).
      if (this.disposed || token !== this.loadToken) return;
      this.detach();
      this.attach(target, template);
    });
  }

  /** Menu-proven attachment recipe (MenuCharacter.attachWeapon). */
  private attach(id: NetworkWeaponId, template: THREE.Group): void {
    const att = REMOTE_WEAPON_CONFIG[id];
    const bone = this.characterModel.getObjectByName(att.bone);
    if (!bone) {
      if (import.meta.env.DEV) {
        console.warn(`[RemoteWeapon] bone "${att.bone}" not found — cannot attach ${id}`);
      }
      return;
    }

    // Static meshes: a plain deep clone shares geometry/materials/textures.
    const weapon = template.clone(true);

    const grip = new THREE.Group();
    grip.add(weapon);
    grip.position.copy(att.position);
    grip.rotation.copy(att.rotation);

    // Compensate every ancestor scale (character normalization + armature)
    // so the configured size stays a true world size.
    let accumulated = 1;
    let node: THREE.Object3D | null = bone;
    while (node) {
      accumulated *= node.scale.x;
      if (node === this.characterModel) break;
      node = node.parent;
    }
    const inv = 1 / Math.max(Math.abs(accumulated), 1e-6);
    grip.scale.setScalar(inv);
    grip.position.multiplyScalar(inv);

    bone.add(grip);
    this.grip = grip;
    this.baseRotation.copy(att.rotation);
    this.displayed = id;
  }

  private detach(): void {
    if (!this.grip) return;
    this.grip.removeFromParent();
    this.grip = null;
    this.displayed = null;
  }
}