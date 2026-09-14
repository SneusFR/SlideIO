import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { NetworkWeaponId, isNetworkWeaponId } from "../../../shared/combat/NetworkWeapons";
import { sanitizeWeaponSkin } from "../../../shared/combat/WeaponSkins";
import { createWeaponMount } from "../../weapons/profiles/WeaponProfile";
import { HexSniperProfile } from "../../weapons/profiles/HexSniperProfile";
import { loadHexSniperGltf } from "../../weapons/hexsniper/HexSniperModel";
import { HexSniperController } from "../../weapons/hexsniper/HexSniperController";
import { HexSniperConfig as hexCfg } from "../../weapons/hexsniper/HexSniperConfig";
import { markEnemyOutlineOccluder } from "../../characters/PotatoCharacter";
import { BrickMaulProfile, BRICKMAUL_EYES, BRICKMAUL_TIMING } from "../../weapons/brickmaul/BrickMaulProfile";
import { loadBrickMaulGltf, instantiateBrickMaul } from "../../weapons/brickmaul/BrickMaulModel";
import { BrickMaulEyes } from "../../weapons/brickmaul/BrickMaulEyes";
import { HEXSNIPER_PROFILE_ID } from "./RemotePlayerAnimationController";
import { GoofyBasketProfile, GOOFY_TIMING, type GoofyActionKey } from "../../weapons/goofybasket/GoofyBasketProfile";
import { loadGoofyBasketGltf } from "../../weapons/goofybasket/GoofyBasketModel";
import { GoofyBasketRemotePresentation } from "../../weapons/goofybasket/GoofyBasketRemotePresentation";
// Real weapon GLBs (same optimized assets as the local viewmodels/menu).
import rifleUrl from "../../assets/voidrifle_opt.glb?url";
import spearUrl from "../../assets/lance_opt.glb?url";
import obliterreurUrl from "../../assets/obliterreur_opt.glb?url";
import revolverUrl from "../../assets/revolver_opt.glb?url";
// Bass Blaster = PulseCarbine LOD1 (light version for weapons seen at
// a distance — see src/assets/PulseCarbine/README_FR.md).
import bassBlasterUrl from "../../assets/PulseCarbine/PulseCarbine_LOD1.glb?url";
import poisonUrl from "../../assets/Lance_poison_jeu.glb?url";

/**
 * How a legacy weapon GLB sits in a remote POTATO character's hand.
 * `bone` names are REAL Potato sockets: Weapon_R (child of Hand_R) and
 * Weapon_L (child of Hand_L) — the old Meshy RightHand/LeftHand names are
 * gone. Offsets/rotations were re-derived for the Potato grip axes (the
 * name mapping alone does not preserve the old local rotation bases).
 *
 * The HEX SNIPER is NOT in this table: it uses the authored TP mount from
 * WeaponProfile_HexSniper.json (whole animated scene, profile matrix, no
 * normalization) — see attachHexSniper below.
 */
interface RemoteWeaponAttachment {
  url: string;
  bone: "Weapon_R" | "Weapon_L";
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
export const REMOTE_WEAPON_CONFIG: Partial<Record<NetworkWeaponId, RemoteWeaponAttachment>> = {
  // HAMMER (Brick Maul) is NOT in this table anymore: it uses the authored
  // TP mount of WeaponProfile_BrickMaul.json + the profile's TP clips (see
  // attachBrickMaul) — no normalization, no procedural swing.
  [NetworkWeaponId.PLASMA_RIFLE]: {
    url: rifleUrl,
    bone: "Weapon_L",
    position: new THREE.Vector3(0, 0.02, -0.08),
    rotation: new THREE.Euler(0.05, 0, 0),
    size: 0.95,
    // The rifle barrel runs along the model X axis — without this flip the
    // muzzle points BACKWARDS in the remote hand (reported in playtests).
    modelRotation: new THREE.Euler(0, Math.PI, 0),
  },
  [NetworkWeaponId.SPEAR]: {
    url: spearUrl,
    bone: "Weapon_R",
    position: new THREE.Vector3(0, 0.1, 0),
    rotation: new THREE.Euler(0.15, 0, -0.2),
    size: 1.7,
  },
  [NetworkWeaponId.REVOLVER]: {
    url: revolverUrl,
    bone: "Weapon_R",
    position: new THREE.Vector3(0, 0.02, -0.04),
    rotation: new THREE.Euler(0.05, 0, 0),
    size: 0.35,
  },
  [NetworkWeaponId.OBLITERREUR]: {
    url: obliterreurUrl,
    bone: "Weapon_L",
    position: new THREE.Vector3(0, 0.02, -0.06),
    rotation: new THREE.Euler(0.05, 0, 0),
    size: 1.0,
    // Same hand + same forward convention as the plasma rifle.
    modelRotation: new THREE.Euler(0, Math.PI, 0),
  },
  [NetworkWeaponId.BASS_BLASTER]: {
    url: bassBlasterUrl,
    bone: "Weapon_L",
    position: new THREE.Vector3(0, 0.02, -0.06),
    rotation: new THREE.Euler(0.05, 0, 0),
    size: 0.75,
    // The PulseCarbine muzzle faces -X in the asset → rotate it to face
    // -Z like the rifle convention (barrel forward in the remote hand).
    modelRotation: new THREE.Euler(0, -Math.PI / 2, 0),
  },
  [NetworkWeaponId.POISON_SPRAYER]: {
    url: poisonUrl,
    bone: "Weapon_L",
    position: new THREE.Vector3(0, 0.02, -0.06),
    rotation: new THREE.Euler(0.05, 0, 0),
    size: 0.9,
    // The sprayer muzzle faces -X in the asset → rotate it to face -Z
    // like the rifle convention (barrel forward in the remote hand).
    modelRotation: new THREE.Euler(0, -Math.PI / 2, 0),
  },
};

// ---------------------------------------------------------------------
// HEX SNIPER — dedicated remote path (whole animated scene + TP mount)
// ---------------------------------------------------------------------

/**
 * The remote HexSniper NEVER goes through the legacy normalization above:
 * that path flattens the scene into a static clone (clone(true) breaks
 * SkinnedMesh bindings) and its bounding-box normalization would destroy
 * the authored mount. Instead the WHOLE animated scene (the pack's
 * canonical HexSniper_Weapon.glb — scene AND animations preserved) is
 * skeleton-cloned per instance and mounted under Weapon_R through the
 * authored TP matrix (WeaponProfile_HexSniper.json, applied once — the
 * weapon inherits the character's scale, no ancestor-scale cancelling).
 */
function loadRemoteHexSniper(): Promise<{
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}> {
  // Shared cache with the local viewmodel path (HexSniperModel) — one
  // fetch/parse for the whole game, whatever loads first.
  return loadHexSniperGltf().then((gltf) => ({
    scene: gltf.scene as THREE.Group,
    animations: gltf.animations,
  }));
}

// ---- Shared, cached weapon templates (load once → clone per player) ----
// Templates are pre-normalized (centered on origin, longest axis = size)
// so per-player attachment is a cheap clone + grip wrapper.
const templateCache = new Map<NetworkWeaponId, Promise<THREE.Group>>();

/** Load (once) the normalized template for a weapon; clones are cheap. */
export function loadRemoteWeaponTemplate(id: NetworkWeaponId): Promise<THREE.Group> {
  let cached = templateCache.get(id);
  if (cached) return cached;
  const att = REMOTE_WEAPON_CONFIG[id];
  if (!att) {
    // HEX_SNIPER: no static template — its dedicated animated path
    // (attachHexSniper) owns the loading. Never normalized here.
    return Promise.reject(new Error(`No static remote template for ${id}`));
  }
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
    // In-hand weapons mask the red enemy contour too (stencil ref 1),
    // so the outline never bleeds over a gun crossing the body edge.
    // Clones share these materials — one marking covers every instance.
    markEnemyOutlineOccluder(scene);
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
  const jobs: Promise<unknown>[] = Object.values(NetworkWeaponId)
    .filter((id) => REMOTE_WEAPON_CONFIG[id] !== undefined)
    .map((id) => loadRemoteWeaponTemplate(id));
  jobs.push(loadRemoteHexSniper()); // animated path (shared GLB cache)
  jobs.push(loadBrickMaulGltf()); // Brick Maul (profile path, shared cache)
  return Promise.all(jobs).then(() => undefined);
}

/** Swing animation duration (procedural grip rotation, seconds) — SPEAR only. */
const SWING_DURATION = 0.35;
/** How long the SPEAR stays visible in the hand after an attack (s). */
const MELEE_OVERRIDE_DURATION = 0.9;
/** Safety cap for a maul slam waiting for its impact event (s). */
const MAUL_SLAM_MAX_AIR = 6;
/** Extra grace after the last maul phase before the primary comes back (s). */
const MAUL_RESTORE_GRACE = 0.15;

/** Hammer visual phases replayed on a remote avatar (server-confirmed). */
type MaulPhase = "whirlwind" | "slamStart" | "slamDive" | "slamLand" | "inspect" | null;

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

  // ---- HEX SNIPER dedicated state (animated scene + authored TP mount) ----
  private hexWeapon: THREE.Object3D | null = null;
  private hexMount: THREE.Group | null = null;
  /** Kit visual controller (mixer + world tether) — one per remote instance. */
  private hexVisuals: HexSniperController | null = null;
  private hexMuzzle: THREE.Object3D | null = null;
  /**
   * Armed-presentation hook: fired with the PROFILE id of the attached
   * weapon ("hexsniper" two-hand set, "brickmaul" one-hand masked set) or
   * null when a legacy static weapon / nothing is displayed. Wired by
   * RemotePlayer to RemotePlayerAnimationController.setArmedProfile.
   */
  onArmedChanged: ((profileId: string | null) => void) | null = null;
  /**
   * Full-body TP action hook (Brick Maul phases / inspection): the avatar's
   * animation controller plays the profile clip with priority over the
   * locomotion. `kind` = profile action key | "inspect" | "equip" |
   * "unequip"; null = clear the override (back to the real locomotion).
   */
  onProfileAction:
    | ((
        kind: string | null,
        options: { startAt?: number; fadeIn?: number; timeScale?: number; onFinished?: () => void },
      ) => void)
    | null = null;

  // ---- BRICK MAUL dedicated state (profile mount + moving pupils) ----
  private maulWeapon: THREE.Object3D | null = null;
  private maulMount: THREE.Group | null = null;
  private maulEyes: BrickMaulEyes | null = null;
  /** Maul HELD on slot 2 (MELEE_SHOW) — persistent visual override. */
  private maulHeld = false;
  /** Current replayed maul phase + its authoritative start (local clock, s). */
  private maulPhase: MaulPhase = null;
  private maulPhaseTimer = 0;
  /** Remaining seconds of the temporary maul override (attack from primary). */
  private maulOverrideTimer = 0;
  /** True while the avatar is hidden/far: cosmetic eye work suspended. */
  private cosmeticSuspended = false;

  // ---- GOOFY BASKET dedicated state (profile mount + cosmetic TP ball) ----
  private basket: GoofyBasketRemotePresentation | null = null;
  /** Replayed basket phase (server-confirmed) + its elapsed clock (s). */
  private basketPhase: { kind: "throw"; level: 1 | 2 | 3 } | { kind: "catch" } | { kind: "inspect" } | null = null;
  private basketPhaseTimer = 0;
  /** Arms clock reader (wired by RemotePlayer: the avatar animation controller). */
  presentationClock: (() => { clip: string | null; time: number }) | null = null;
  /** Grounded state reader for the TP dribble floor fit (wired by RemotePlayer). */
  isGrounded: (() => boolean) | null = null;
  /** Local viewer position reader (TP skin aura distance budget). */
  viewerPosition: (() => THREE.Vector3 | null) | null = null;
  /** SERVER-replicated cosmetic skin of the equipped weapon ("default" = base). */
  private skinId = "default";

  // Procedural swing state (SPEAR legacy path only)
  private swingTimer = -1;
  private swingKind: "sweep" | "slam" = "sweep";

  constructor(
    private readonly characterModel: THREE.Object3D,
    /**
     * WORLD scene the remote HexSniper tether is drawn in (a world-space
     * stretched mesh between the creature's mouth and the tip — occluded
     * by walls like any world object). Null = tether parented under the
     * weapon (kit default; only used by tests without a scene).
     */
    private readonly effectsParent: THREE.Object3D | null = null,
  ) {}

  /**
   * Mirror the server-synced weapon id (unknown strings are ignored) and
   * its COSMETIC skin. A skin change ALONE never re-attaches the weapon
   * (no phase reset, no equip clip): the skin is swapped on the displayed
   * ball instance in place.
   */
  setWeapon(raw: string, rawSkin = "default"): void {
    if (!isNetworkWeaponId(raw)) return;
    const skin = sanitizeWeaponSkin(raw, rawSkin);
    const skinChanged = skin !== this.skinId;
    this.skinId = skin;
    if (this.equipped === raw) {
      if (skinChanged) this.basket?.setSkin(skin);
      return;
    }
    this.equipped = raw;
    this.refreshDisplayed();
  }

  /**
   * A confirmed melee action: show the REAL melee weapon in the hand for a
   * short window and play a procedural swing on the grip.
   */
  triggerMelee(raw: string, kind: "sweep" | "slam"): void {
    if (!isNetworkWeaponId(raw)) return;
    if (raw === NetworkWeaponId.HAMMER) {
      // Brick Maul: phases are replayed through the profile path (below).
      this.maulPhaseStart(kind === "sweep" ? "whirlwind" : "slamStart", 0);
      return;
    }
    this.overrideId = raw;
    this.overrideTimer = MELEE_OVERRIDE_DURATION;
    this.swingTimer = 0;
    this.swingKind = kind;
    this.refreshDisplayed();
  }

  // ---- BRICK MAUL visual replication (server-confirmed events) ----

  /** MELEE_SHOW / MELEE_HIDE: the maul is HELD (slot 2) or stowed again. */
  setMeleeHeld(held: boolean): void {
    if (this.maulHeld === held) return;
    this.maulHeld = held;
    if (held) {
      this.maulOverrideTimer = 0;
      this.pendingMaulEquipClip = true; // real Equip clip once attached
      this.refreshDisplayed();
    } else if (this.maulPhase === null || this.maulPhase === "inspect") {
      // Real Unequip (0.30 s) then the primary presentation comes back —
      // an attack phase in progress finishes first instead.
      this.maulPhase = null;
      this.maulOverrideTimer = BRICKMAUL_TIMING.unequip + MAUL_RESTORE_GRACE;
      this.onProfileAction?.("unequip", { fadeIn: 0.08 });
    }
  }

  /**
   * Start a maul phase at `elapsed` seconds into it (late arrivals resume
   * mid-clip). The maul override lasts until the REAL recovery ends:
   * whirlwind 1.35 s; slam = start → dive loop → land (0.72 s after the
   * impact event) — never a fixed 0.9 s.
   */
  maulPhaseStart(phase: Exclude<MaulPhase, null>, elapsed: number): void {
    const t = Math.max(0, elapsed);
    // A new attack always wins over an inspection; an inspection never
    // interrupts an attack in progress.
    if (phase === "inspect" && this.maulPhase !== null && this.maulPhase !== "inspect") return;
    this.maulPhase = phase;
    this.maulPhaseTimer = t;
    const T = BRICKMAUL_TIMING;
    switch (phase) {
      case "whirlwind":
        this.maulOverrideTimer = Math.max(0.05, T.whirlwind.duration - t) + MAUL_RESTORE_GRACE;
        break;
      case "slamStart":
      case "slamDive":
        this.maulOverrideTimer = MAUL_SLAM_MAX_AIR; // until the impact event
        break;
      case "slamLand":
        this.maulOverrideTimer = Math.max(0.05, T.slam.recoveryAfterGroundContact - t) + MAUL_RESTORE_GRACE;
        break;
      case "inspect":
        this.maulOverrideTimer = Math.max(0.05, T.inspect - t) + MAUL_RESTORE_GRACE;
        break;
    }
    this.refreshDisplayed();
    this.playMaulPhaseClip(phase, t);
  }

  /** Real slam impact (HAMMER_SLAM_IMPACT): Slam_Land at 0.10 s, hard cut. */
  maulSlamImpact(elapsed: number): void {
    this.maulPhaseStart("slamLand", BRICKMAUL_TIMING.slam.enterLandAt + Math.max(0, elapsed));
    this.maulEyes?.kick(1.5);
  }

  /** INSPECT_CANCEL / attack / death: stop the inspection replay. */
  maulInspectCancel(): void {
    if (this.maulPhase !== "inspect") return;
    this.maulPhase = null;
    this.onProfileAction?.(null, {});
    if (!this.maulHeld) this.maulOverrideTimer = MAUL_RESTORE_GRACE;
  }

  /** Death / ragdoll / respawn: drop every maul phase + stale callbacks. */
  maulReset(): void {
    this.maulPhase = null;
    this.maulPhaseTimer = 0;
    this.maulOverrideTimer = 0;
    this.pendingMaulEquipClip = false;
    this.onProfileAction?.(null, {});
    this.maulEyes?.reset();
    this.refreshDisplayed();
  }

  // ---- GOOFY BASKET visual replication (server-confirmed events) ----

  /**
   * BASKET_THROW: Throw_Ln resumed at `elapsed` (server `ts`), then the
   * Catch (new ball from above) — both as UPPER layers over the real legs.
   * A phase arriving late past the whole Throw lands straight in the Catch.
   */
  basketThrow(level: 1 | 2 | 3, elapsed: number): void {
    const def = GOOFY_TIMING.throws[level - 1];
    const t = Math.max(0, elapsed);
    if (t >= def.duration + GOOFY_TIMING.catch) return; // already over
    if (t >= def.duration) {
      this.basketPhaseStart({ kind: "catch" }, t - def.duration);
      return;
    }
    this.basketPhaseStart({ kind: "throw", level }, t);
  }

  /** INSPECT_START (weapon GOOFY_BASKET) → TP inspection layer resumed at `elapsed`. */
  basketInspectStart(elapsed: number): void {
    if (this.basketPhase !== null && this.basketPhase.kind !== "inspect") return; // a throw wins
    this.basketPhaseStart({ kind: "inspect" }, Math.max(0, elapsed));
  }

  basketInspectCancel(): void {
    if (this.basketPhase?.kind !== "inspect") return;
    this.basketPhase = null;
    this.onProfileAction?.(null, {});
  }

  /** Death / respawn: drop the replayed phase, hide the TP ball. */
  basketReset(): void {
    if (this.basketPhase !== null) this.onProfileAction?.(null, {});
    this.basketPhase = null;
    this.basketPhaseTimer = 0;
    this.basket?.reset();
  }

  private basketPhaseStart(phase: Exclude<typeof this.basketPhase, null>, elapsed: number): void {
    this.basketPhase = phase;
    this.basketPhaseTimer = elapsed;
    this.playBasketPhaseClip(phase, elapsed);
  }

  private playBasketPhaseClip(phase: Exclude<typeof this.basketPhase, null>, startAt: number): void {
    if (!this.basket) return; // replayed once attached (attachGoofyBasket)
    const kind: GoofyActionKey | "inspect" =
      phase.kind === "throw" ? GOOFY_TIMING.throws[phase.level - 1].kind : phase.kind === "catch" ? "Catch" : "inspect";
    this.onProfileAction?.(kind, {
      startAt,
      fadeIn: phase.kind === "catch" ? 0.03 : 0.06,
      onFinished: () => {
        if (this.basketPhase !== phase) return; // stale (replaced)
        if (phase.kind === "throw") {
          // Recovery done → the new ball comes from above (same cosmetic instance).
          this.basketPhaseStart({ kind: "catch" }, 0);
          return;
        }
        this.basketPhase = null;
      },
    });
  }

  /** Far / invisible avatars: suspend the cosmetic pupils, reset on resume. */
  setCosmeticSuspended(suspended: boolean): void {
    if (this.cosmeticSuspended === suspended) return;
    this.cosmeticSuspended = suspended;
    if (!suspended) this.maulEyes?.reset();
  }

  private pendingMaulEquipClip = false;

  /** True while the remote HOLDS the maul (slot 2 — MELEE_SHOW). */
  get meleeHeld(): boolean {
    return this.maulHeld;
  }

  /** True while the maul must be the displayed weapon. */
  private get maulWanted(): boolean {
    return this.maulHeld || this.maulPhase !== null || this.maulOverrideTimer > 0;
  }

  private playMaulPhaseClip(phase: Exclude<MaulPhase, null>, startAt: number): void {
    if (!this.maulWeapon) return; // replayed once attached (attachBrickMaul)
    if (phase !== "slamLand" && phase !== "inspect") this.maulEyes?.kick(1);
    this.onProfileAction?.(phase, {
      startAt,
      fadeIn: phase === "slamLand" ? 0.02 : 0.08,
      onFinished: () => {
        // Stale by construction if another phase replaced this one (the
        // animation controller nulls the callback on replacement).
        if (this.maulPhase !== phase) return;
        if (phase === "slamStart") {
          this.maulPhase = "slamDive";
          this.maulPhaseTimer = 0;
          this.onProfileAction?.("slamDive", { fadeIn: 0.06 });
          return;
        }
        this.maulPhase = null;
      },
    });
  }

  /** Per-frame: override expiry + swing animation + HexSniper idle. */
  update(dt: number): void {
    // HexSniper creature clips + world tether (visual controller — never a
    // re-simulation; the tip is fed by the remote combat VFX controller).
    this.hexVisuals?.update(dt);
    if (this.overrideId) {
      this.overrideTimer -= dt;
      if (this.overrideTimer <= 0) {
        this.overrideId = null;
        this.swingTimer = -1;
        this.refreshDisplayed();
      }
    }

    // Brick Maul: phase clock + override expiry (real recovery, not 0.9 s).
    if (this.maulPhase !== null) this.maulPhaseTimer += dt;
    if (this.basketPhase !== null) this.basketPhaseTimer += dt;
    if (this.maulOverrideTimer > 0) {
      this.maulOverrideTimer -= dt;
      if (this.maulOverrideTimer <= 0) {
        this.maulOverrideTimer = 0;
        if (this.maulPhase !== "slamDive" && this.maulPhase !== "slamStart") this.maulPhase = null;
        if (!this.maulWanted) this.refreshDisplayed(); // primary comes back
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
   * Cosmetic pass AFTER the avatar's character mixer (the pupils read the
   * weapon's animated world matrix). Suspended while the avatar is hidden
   * / far (see setCosmeticSuspended) — reset on resume.
   */
  updateCosmetics(dt: number): void {
    if (this.cosmeticSuspended) return;
    if (this.maulEyes && this.maulWeapon) {
      this.maulWeapon.updateWorldMatrix(true, true);
      this.maulEyes.update(dt);
    }
    // GoofyBasket TP ball: driven from the avatar's arm clock (same mixer).
    // The skin aura budget uses the local viewer distance (far = cut).
    if (this.basket && this.presentationClock) {
      this.basket.update(dt, this.presentationClock(), this.isGrounded?.() ?? true, this.viewerPosition?.() ?? null);
    }
  }

  /**
   * World position of the displayed weapon's grip (beam/tracer anchor).
   * Requires up-to-date world matrices (the game updates them per frame).
   */
  getMuzzleWorldPosition(out: THREE.Vector3): boolean {
    // HexSniper: the REAL TongueOrigin/Muzzle socket (matrices are fresh —
    // the game updates world matrices before remote VFX read anchors).
    if (this.hexMuzzle) {
      this.hexMuzzle.getWorldPosition(out);
      return true;
    }
    if (this.maulWeapon) {
      this.maulWeapon.getWorldPosition(out);
      return true;
    }
    if (this.basket) {
      this.basket.mount.getWorldPosition(out);
      return true;
    }
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
    // Priority: maul (held / attack phase / recovery) > spear override >
    // server-equipped primary.
    const target = this.maulWanted ? NetworkWeaponId.HAMMER : (this.overrideId ?? this.equipped);
    if (this.displayed === target) return;
    const token = ++this.loadToken;
    if (target === NetworkWeaponId.HAMMER) {
      // Brick Maul profile path: whole skinned scene + authored TP mount.
      void loadBrickMaulGltf()
        .then((gltf) => {
          if (this.disposed || token !== this.loadToken) return;
          this.detach();
          this.attachBrickMaul(gltf);
        })
        .catch((err) => {
          if (import.meta.env.DEV) console.warn("[RemoteWeapon] BrickMaul load failed", err);
        });
      return;
    }
    if (target === NetworkWeaponId.GOOFY_BASKET) {
      // GoofyBasket profile path: cosmetic TP ball + authored TP mount.
      void loadGoofyBasketGltf()
        .then((gltf) => {
          if (this.disposed || token !== this.loadToken) return;
          this.detach();
          this.attachGoofyBasket(gltf);
        })
        .catch((err) => {
          if (import.meta.env.DEV) console.warn("[RemoteWeapon] GoofyBasket load failed", err);
        });
      return;
    }
    if (target === NetworkWeaponId.HEX_SNIPER) {
      // Dedicated animated path: whole scene + clips, authored TP mount.
      void loadRemoteHexSniper().then(({ scene, animations }) => {
        if (this.disposed || token !== this.loadToken) return;
        this.detach();
        this.attachHexSniper(scene, animations);
      });
      return;
    }
    void loadRemoteWeaponTemplate(target).then((template) => {
      // Stale async result (player switched again / controller disposed).
      if (this.disposed || token !== this.loadToken) return;
      this.detach();
      this.attach(target, template);
    });
  }

  /**
   * HEX SNIPER remote attach: SkeletonUtils clone of the WHOLE weapon
   * scene (skinned creature intact) under the character's Weapon_R socket
   * through the authored TP mount matrix — the weapon inherits the
   * character scale (never cancelled). Its own mixer idles the creature;
   * the character's TP armed poses come from the animation controller
   * (setArmed on the avatar side).
   */
  private attachHexSniper(
    templateScene: THREE.Group,
    animations: THREE.AnimationClip[],
  ): void {
    const socket = this.characterModel.getObjectByName("Weapon_R");
    if (!socket) {
      if (import.meta.env.DEV) {
        console.warn(`[RemoteWeapon] Weapon_R socket not found — cannot attach HEX_SNIPER`);
      }
      return;
    }
    // The kit's VISUAL controller owns the creature: skeleton clone, the
    // single mixer for every clip (Idle / Tongue_Cast / Tongue_Hold /
    // Tongue_Return / Bite) and the stretched Tongue_Tether — reparented
    // into the WORLD scene so the remote tongue is a real world-space
    // tether (occluded by walls) driven by the server-confirmed events.
    // No gameplay here: HexSniperAttacks never runs for a remote player.
    let visuals: HexSniperController;
    try {
      visuals = new HexSniperController(
        { scene: templateScene, animations } as unknown as GLTF,
        { effectsParent: this.effectsParent, tongueWidthScale: hexCfg.tongueWidthScale },
      );
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[RemoteWeapon] HexSniper controller failed", err);
      return;
    }
    const weapon = visuals.object;
    const prepare = (root: THREE.Object3D) =>
      root.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.raycast = () => {}; // visual only — hitboxes own the raycasts
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          mesh.frustumCulled = false; // moves with the animated bone
        }
      });
    prepare(weapon);
    prepare(visuals.tether);

    // Stencil occluder like every held weapon (see the template path):
    // the enemy contour must never bleed over the sniper creature. The
    // materials are shared with the FP viewmodel (same GLB cache) —
    // harmless there: the FP pass runs AFTER the outline already drew.
    markEnemyOutlineOccluder(weapon);

    const mount = createWeaponMount("HexSniperMount", HexSniperProfile.tpMount);
    socket.add(mount);
    mount.add(weapon);

    this.hexVisuals = visuals;
    this.hexWeapon = weapon;
    this.hexMount = mount;
    this.hexMuzzle = visuals.tongueOrigin ?? visuals.muzzle ?? null;
    this.displayed = NetworkWeaponId.HEX_SNIPER;
    this.onArmedChanged?.(HEXSNIPER_PROFILE_ID);
  }

  /**
   * BRICK MAUL remote attach: SkeletonUtils clone of the COMPLETE weapon
   * scene (Pupil_L / Pupil_R graph intact) under Weapon_R through the
   * authored TP mount matrix (applied once, scale included — the weapon
   * INHERITS the character scale, never the legacy ancestor-scale cancel).
   * The avatar's animation controller switches to the "brickmaul" TP pose
   * set; a phase already in flight (late attach) is replayed at its
   * elapsed time; a real slot equip plays the Equip clip.
   */
  private attachBrickMaul(gltf: GLTF): void {
    const socket = this.characterModel.getObjectByName("Weapon_R");
    if (!socket) {
      if (import.meta.env.DEV) console.warn("[RemoteWeapon] Weapon_R socket not found — cannot attach HAMMER");
      return;
    }
    const weapon = instantiateBrickMaul(gltf);
    const mount = createWeaponMount("BrickMaulMount", BrickMaulProfile.tpMount);
    socket.add(mount);
    mount.add(weapon);

    this.maulWeapon = weapon;
    this.maulMount = mount;
    this.maulEyes = new BrickMaulEyes(weapon, BRICKMAUL_EYES);
    this.maulEyes.reset();
    this.displayed = NetworkWeaponId.HAMMER;
    this.onArmedChanged?.(BrickMaulProfile.id);

    if (this.maulPhase !== null) {
      // Late attach during an attack / inspection: resume at the elapsed time.
      this.playMaulPhaseClip(this.maulPhase, this.maulPhaseTimer);
    } else if (this.pendingMaulEquipClip) {
      // Same sped-up rate as the local FP arms (≈0.36 s effective).
      this.onProfileAction?.("equip", { fadeIn: 0.06, timeScale: BRICKMAUL_TIMING.equipTimeScale });
    }
    this.pendingMaulEquipClip = false;
  }

  /**
   * GOOFY BASKET remote attach: an empty mount under Weapon_R (authored TP
   * matrix, ball scale included) + ONE cosmetic ball under the NORMALIZED
   * glTF scene — resolved as the ancestor of Weapon_R that is a direct
   * child of the wrapper `characterModel` (scale 2.693…, yaw π), never the
   * wrapper itself. The avatar switches to the "goofybasket" TP pose set; a
   * phase in flight (late attach) resumes at its elapsed time.
   */
  private attachGoofyBasket(gltf: GLTF): void {
    const socket = this.characterModel.getObjectByName("Weapon_R");
    if (!socket) {
      if (import.meta.env.DEV) console.warn("[RemoteWeapon] Weapon_R socket not found — cannot attach GOOFY_BASKET");
      return;
    }
    let gltfScene: THREE.Object3D = socket;
    while (gltfScene.parent && gltfScene.parent !== this.characterModel) gltfScene = gltfScene.parent;
    if (gltfScene.parent !== this.characterModel) gltfScene = this.characterModel; // flat test hierarchies
    // Skin applied on THIS avatar's ball instance (server-replicated id).
    this.basket = new GoofyBasketRemotePresentation(gltf, socket, gltfScene, this.skinId);
    this.displayed = NetworkWeaponId.GOOFY_BASKET;
    this.onArmedChanged?.(GoofyBasketProfile.id);
    if (this.basketPhase !== null) this.playBasketPhaseClip(this.basketPhase, this.basketPhaseTimer);
    else this.onProfileAction?.("equip", { fadeIn: 0.06 });
  }

  // ---- HEX SNIPER remote tongue visuals (server-confirmed replay) ----

  hexTongueBegin(tip: THREE.Vector3): void {
    this.hexVisuals?.beginTongue(tip);
  }

  hexTongueSetEndpoint(tip: THREE.Vector3): void {
    this.hexVisuals?.setTongueEndpoint(tip);
  }

  hexTonguePull(): void {
    this.hexVisuals?.beginPull();
  }

  hexTongueEnd(): void {
    this.hexVisuals?.endTongue();
  }

  hexBite(): void {
    this.hexVisuals?.bite();
  }

  hexReset(): void {
    this.hexVisuals?.reset();
  }

  /** Menu-proven attachment recipe (legacy static weapons). */
  private attach(id: NetworkWeaponId, template: THREE.Group): void {
    const att = REMOTE_WEAPON_CONFIG[id];
    if (!att) return;
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
    // HexSniper animated path cleanup (per-instance mixer + mount).
    if (this.hexWeapon) {
      // The kit controller frees its mixer, skeleton clone, tether buffer
      // and removes both the weapon and the world tether from their parents.
      this.hexVisuals?.dispose();
      this.hexVisuals = null;
      this.hexWeapon.removeFromParent();
      this.hexWeapon = null;
      this.hexMount?.removeFromParent();
      this.hexMount = null;
      this.hexMuzzle = null;
      this.displayed = null;
      this.onArmedChanged?.(null);
    }
    // Brick Maul profile path cleanup: the instance's skeleton clone goes,
    // the shared geometry / materials stay cached. The avatar's pose set
    // returns to unarmed (or the next weapon's profile).
    if (this.maulWeapon) {
      this.maulWeapon.removeFromParent();
      this.maulWeapon = null;
      this.maulMount?.removeFromParent();
      this.maulMount = null;
      this.maulEyes = null;
      this.displayed = null;
      this.onProfileAction?.(null, {});
      this.onArmedChanged?.(null);
    }
    // GoofyBasket profile path cleanup: mount + cosmetic ball go (shared
    // geometry / materials stay cached); replayed phase dropped.
    if (this.basket) {
      this.basket.dispose();
      this.basket = null;
      this.basketPhase = null;
      this.displayed = null;
      this.onProfileAction?.(null, {});
      this.onArmedChanged?.(null);
    }
    if (!this.grip) return;
    this.grip.removeFromParent();
    this.grip = null;
    this.displayed = null;
  }
}