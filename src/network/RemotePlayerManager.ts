import * as THREE from "three";
import { GLTFLoader, GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { MovementConfig as moveCfg } from "../player/MovementConfig";
import { RemoteInterpolationConfig as icfg } from "./interpolation/RemoteInterpolationConfig";
import {
  SnapshotBuffer,
  SampledPlayerState,
  shortestAngleDelta,
} from "./interpolation/SnapshotBuffer";
import { NetworkClock } from "./interpolation/NetworkClock";
import { AdaptiveInterpolationDelay } from "./interpolation/AdaptiveInterpolationDelay";
import {
  RemotePlayerAnimationController,
  RemoteCharacterClips,
} from "./remote/RemotePlayerAnimationController";
import { NetworkMovementState, sanitizeNetworkMovementState } from "./NetworkMovementState";
import { RemoteWeaponController } from "./remote/RemoteWeaponController";
import type { NetworkPlayerInfo } from "./MultiplayerClient";
import { CombatConfig as cc } from "../combat/CombatConfig";
import { CorpseManager } from "../ragdoll/CorpseManager";
import { buildSkeletonRagdollParts } from "../ragdoll/SkeletonRagdollFactory";
// Character GLB (mesh + skeleton + "Alert" idle clip) — loaded ONCE, cloned
// per player. The run/jump/slide clips live in sibling GLBs (same skeleton).
//
// NOTE: the Meshy "Sprouty Smile" export FILENAMES are mislabeled — each
// file's actual clip was verified with scripts/inspect-glb.mjs and the
// clips are always selected by CLIP NAME, never by filename:
//   Regular_Jump_withSkin.glb → "Armature|Alert|baselayer"        (IDLE)
//   Walking_withSkin.glb      → "Armature|running|baselayer"      (RUN)
//   Running_withSkin.glb      → "Armature|Regular_Jump|baselayer" (JUMP)
//   Character_output.glb      → "Armature|slide_right|baselayer"  (SLIDE)
import characterUrl from "../assets/Meshy_AI_Sprouty_Smile_biped_Animation_Regular_Jump_withSkin.glb?url";
import runClipUrl from "../assets/Meshy_AI_Sprouty_Smile_biped_Animation_Walking_withSkin.glb?url";
import jumpClipUrl from "../assets/Meshy_AI_Sprouty_Smile_biped_Animation_Running_withSkin.glb?url";
import slideClipUrl from "../assets/Meshy_AI_Sprouty_Smile_biped_Character_output.glb?url";

/** Capsule center → feet distance (model root sits at the feet). */
const FEET_OFFSET = moveCfg.standHalfHeight + moveCfg.capsuleRadius;
/** Visual upscale of the character model (purely cosmetic — hitbox unchanged). */
const CHARACTER_SCALE = 1.25;
/** Visual character height (capsule height × cosmetic upscale). */
const CHARACTER_HEIGHT = FEET_OFFSET * 2 * CHARACTER_SCALE;
/** Top of the (scaled) model relative to the capsule center (feet at -FEET_OFFSET). */
const MODEL_TOP = CHARACTER_HEIGHT - FEET_OFFSET;
/** Raw GLB faces +Z; game convention: yaw = 0 → forward = -Z. */
const MODEL_YAW_OFFSET = Math.PI;
/** Nametag height above the capsule center (meters). */
const NAMETAG_HEIGHT = MODEL_TOP + 0.42;
/** Health bar height above the capsule center (just under the nametag). */
const HEALTHBAR_HEIGHT = MODEL_TOP + 0.24;
/** Health bar dimensions (meters). */
const HEALTHBAR_WIDTH = 0.62;
const HEALTHBAR_THICKNESS = 0.055;
/** Visual-only easing speed of the health bar fill (logic is never delayed). */
const HEALTHBAR_EASE = 10;

// ---- Recovery smoothing (visual error offset — see RemotePlayer.update) ----
/** Sampled-position jump (m) above which the recovery offset engages. */
const CORRECTION_MIN_JUMP = 0.35;
/** Exponential decay rate of the visual error offset (1/s). ~16 → the
 *  offset is fully resorbed in ≈150 ms — brief enough that the displayed
 *  position converges to the exact renderTime position the SERVER rewinds
 *  to (the shooter's view and the hit validation stay coherent). */
const CORRECTION_DECAY_RATE = 16;
/** Offsets below this magnitude are cleared (m). */
const CORRECTION_EPSILON = 0.02;

// ---- Anomaly detection thresholds (debug HUD + dev-only console) ----
/** Snapshot server-ts gap considered anomalous (ms). */
const ANOMALY_SNAP_GAP_MS = 100;
/** Extrapolation episode reported above this duration (ms). */
const ANOMALY_EXTRAP_MS = 60;
/** Max entries kept in the anomaly history (ring). */
const ANOMALY_HISTORY_MAX = 30;
/** Min interval between dev console anomaly logs (ms) — never spam. */
const ANOMALY_CONSOLE_THROTTLE_MS = 500;

// ---- Shared, cached character asset (load once → clone per player) ----
interface CharacterAsset {
  template: THREE.Object3D;
  clips: RemoteCharacterClips;
}
let cachedCharacter: Promise<CharacterAsset> | null = null;

/**
 * Shared "enemy readability" rim material (one instance for every remote
 * avatar): back faces of a duplicated skinned mesh, displaced along the
 * vertex normals, render as a light red glow hugging the animated
 * silhouette — same spirit as the solo bots' outline (BotModel), adapted
 * to a SKINNED mesh. Depth test stays ON → walls occlude it (no X-ray).
 */
let enemyRimMat: THREE.MeshBasicMaterial | null = null;
function getEnemyRimMaterial(): THREE.MeshBasicMaterial {
  if (!enemyRimMat) {
    enemyRimMat = new THREE.MeshBasicMaterial({
      color: cc.enemyOutlineColor,
      side: THREE.BackSide,
      toneMapped: false,
      transparent: true,
      opacity: 0.85,
    });
    // Inflate along the (bind-pose) normals BEFORE skinning: the offset
    // vertex then follows the bones exactly like the body vertex does.
    enemyRimMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\n\ttransformed += normal * ${cc.enemyOutlineThickness.toFixed(4)};`,
      );
    };
  }
  return enemyRimMat;
}

function loadCharacterAsset(): Promise<CharacterAsset> {
  if (cachedCharacter) return cachedCharacter;
  const loader = new GLTFLoader();
  cachedCharacter = Promise.all([
    loader.loadAsync(characterUrl),
    loader.loadAsync(runClipUrl),
    loader.loadAsync(jumpClipUrl),
    loader.loadAsync(slideClipUrl),
  ]).then(([gltf, runGltf, jumpGltf, slideGltf]: [GLTF, GLTF, GLTF, GLTF]) => {
    const model = gltf.scene;

    // Normalize ONCE on the template: target height, feet at local y = 0,
    // facing -Z at yaw 0. Clones inherit this for free.
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    model.scale.setScalar(CHARACTER_HEIGHT / Math.max(size.y, 1e-6));
    box.setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= box.min.y;
    model.rotation.y = MODEL_YAW_OFFSET;

    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        // Skinned bounds move with the animation; avoid stale-culling pops.
        mesh.frustumCulled = false;
      }
    });

    // ---- Enemy readability: light red glow rim on the TEMPLATE ----
    // A sibling SkinnedMesh per body part, bound to the SAME skeleton:
    // it follows every animation for free and SkeletonUtils.clone()
    // duplicates it per player (geometry + material stay shared). Every
    // remote player is an enemy in multi, so the rim is always on.
    const skinnedParts: THREE.SkinnedMesh[] = [];
    model.traverse((obj) => {
      const sm = obj as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh) skinnedParts.push(sm);
    });
    for (const src of skinnedParts) {
      const rim = new THREE.SkinnedMesh(src.geometry, getEnemyRimMaterial());
      rim.bind(src.skeleton, src.bindMatrix);
      rim.position.copy(src.position);
      rim.quaternion.copy(src.quaternion);
      rim.scale.copy(src.scale);
      rim.castShadow = false;
      rim.receiveShadow = false;
      rim.frustumCulled = false;
      // Purely visual: never a raycast target (hits are server-side anyway).
      rim.raycast = () => {};
      src.parent!.add(rim);
    }


    // Wrap in a container so the clone root is a plain, unrotated group.
    const template = new THREE.Group();
    template.add(model);

    // Real clips (inspected in the assets): "Armature|Alert|baselayer"
    // (idle), "Armature|running|baselayer" (run),
    // "Armature|Regular_Jump|baselayer" (jump) and
    // "Armature|slide_right|baselayer" (slide). Same skeleton — the clips
    // retarget onto every clone by bone name.
    const idle =
      gltf.animations?.find((c) => /alert|idle/i.test(c.name)) ?? gltf.animations?.[0];
    const run =
      runGltf.animations?.find((c) => /run/i.test(c.name)) ?? runGltf.animations?.[0];
    const jump =
      jumpGltf.animations?.find((c) => /jump/i.test(c.name)) ?? jumpGltf.animations?.[0];
    const slide =
      slideGltf.animations?.find((c) => /slide/i.test(c.name)) ?? slideGltf.animations?.[0];
    if (!idle || !run || !jump || !slide) throw new Error("Remote character clips missing");

    // The jump clip carries hips ROOT MOTION (the character rises inside
    // the clip). The avatar's actual jump arc already comes from the
    // NETWORK position — keeping both would double the motion and leave
    // the model floating above its capsule. Flatten the hips translation.
    // (Verified offline with scripts/inspect-glb-hips.mjs on the Sprouty
    // Smile export: Hips.translation is the ONLY animated position track
    // in the jump GLB — Y 27→60 cm, pinned to its first key 38.1 cm.
    // No Armature/Root-level position track exists.)
    stripHipsRootMotion(jump);
    // The slide clip travels ~1.9 m forward (baked hips X/Z motion) — the
    // network position provides the real travel, so flatten X/Z. The hips
    // Y is KEPT: it carries the crouch (drop to the ground) of the slide
    // pose itself, which must play on the spot.
    stripHipsRootMotion(slide, { keepY: true });

    const clips: RemoteCharacterClips = { idle, run, jump, slide };
    return { template, clips };
  });
  return cachedCharacter;
}

/**
 * Flatten the Hips translation track of a clip to its FIRST keyframe:
 * removes the baked root motion (vertical jump arc / forward travel)
 * while keeping every rotation — the character animates in place and the
 * NETWORK position provides the real trajectory.
 *
 * `keepY` preserves the vertical hips channel: used for clips where the
 * hips height IS the pose (slide crouch) rather than world travel.
 */
function stripHipsRootMotion(
  clip: THREE.AnimationClip,
  { keepY = false }: { keepY?: boolean } = {},
): void {
  for (const track of clip.tracks) {
    if (!/Hips\.position$/i.test(track.name)) continue;
    const values = track.values;
    for (let i = 3; i < values.length; i += 3) {
      values[i] = values[0];
      if (!keepY) values[i + 1] = values[1];
      values[i + 2] = values[2];
    }
  }
}

// ---------------------------------------------------------------------
// Network debug data shapes (consumed by the F1 NetworkDebugHUD)
// ---------------------------------------------------------------------

/** One timestamped anomaly entry (ring buffer — newest last). */
export interface NetworkAnomaly {
  /** Wall-clock ms (Date.now) — formatted by the HUD. */
  at: number;
  text: string;
}

/** Per-remote diagnostic values (one row per remote player in the HUD). */
export interface RemotePlayerNetDebug {
  id: string;
  name: string;
  pingMs: number;
  lastSeq: number;
  lastSeqGap: number;
  seqGapTotal: number;
  /** Age of the NEWEST stored snapshot vs estimated server now (ms). */
  snapshotAgeMs: number;
  /** Local wall-clock spacing between the last two stored snapshots (ms). */
  lastArrivalGapMs: number;
  /** Server-timestamp spacing between the last two snapshots (ms). */
  lastSnapGapMs: number;
  /** Decaying max of recent server-ts snapshot gaps (ms). */
  maxSnapGapMs: number;
  /** Smoothed snapshot receive rate (Hz). */
  rateHz: number;
  buffer: number;
  state: string;
  interpolating: boolean;
  extrapolating: boolean;
  extrapolatedMs: number;
  /** Magnitude of the ACTIVE visual recovery offset (m). */
  correctionM: number;
  rawY: number;
  interpY: number;
  visualY: number;
  vx: number;
  vy: number;
  vz: number;
}

/** Full report assembled per HUD refresh (never per frame when hidden). */
export interface NetworkDebugReport {
  remotePlayers: number;
  interpDelayMs: number;
  targetDelayMs: number;
  avgGapMs: number;
  maxGapMs: number;
  jitterMs: number;
  serverNow: number;
  renderTime: number;
  players: RemotePlayerNetDebug[];
  anomalies: NetworkAnomaly[];
}

/** Human-readable movement state (debug HUD). */
function movementStateName(s: NetworkMovementState): string {
  switch (s) {
    case NetworkMovementState.RUNNING: return "RUNNING";
    case NetworkMovementState.AIRBORNE: return "AIRBORNE";
    case NetworkMovementState.SLIDING: return "SLIDING";
    case NetworkMovementState.DASHING: return "DASHING";
    case NetworkMovementState.BURROWED: return "BURROWED";
    default: return "IDLE";
  }
}

/**
 * One remote player's visual representation (Phase 3):
 *
 *   RemotePlayerRoot (group @ interpolated capsule center, yaw only)
 *   ├── VisualCharacter (clone; AnimationController owns its mixer)
 *   └── Nametag sprite (follows the INTERPOLATED transform, never raw)
 *
 * NETWORK PUPPET — no physics body, no collision. Snapshots go into a
 * SnapshotBuffer; every render frame samples renderTime = serverNow −
 * interpolationDelay (remote players live slightly in the past — the
 * LOCAL player is NEVER interpolated/delayed).
 */
class RemotePlayer {
  readonly group = new THREE.Group();
  readonly buffer = new SnapshotBuffer();
  /** The skinned character clone (needed for the death-ragdoll snapshot). */
  readonly model: THREE.Object3D;
  extrapolating = false;
  /** SERVER-owned alive flag — a dead avatar is hidden, never standing. */
  alive = true;
  /** MOLE STRIKE: burrowed (movement state) — the avatar is hidden. */
  burrowed = false;
  /** Phase 5: the REAL equipped weapon GLB in this avatar's hand. */
  readonly weapons: RemoteWeaponController;
  /** Latest INTERPOLATED aim (drives remote beams; never raw packets). */
  lastYaw = 0;
  lastPitch = 0;

  // ---- Network instrumentation (per remote — fed on snapshot arrival) ----
  lastSeq = -1;
  lastSeqGap = 0;
  seqGapTotal = 0;
  lastArrivalAt = 0; // performance.now() of the last STORED snapshot
  lastArrivalGapMs = 0;
  lastSnapGapMs = 0;
  maxSnapGapMs = 0; // decaying max (decayed in update)
  rateHz = 0; // EMA of the snapshot receive rate
  lastExtrapolatedMs = 0;
  /** Extrapolation episode tracking (report once per episode, at the max). */
  private extrapEpisodeMaxMs = 0;
  private extrapEpisodeActive = false;

  private readonly anim: RemotePlayerAnimationController;
  private readonly sample: SampledPlayerState = {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    movementState: NetworkMovementState.IDLE,
    teleported: false,
    extrapolating: false,
    extrapolatedMs: 0,
  };
  /** Last sampled state (for debug rows without re-sampling). */
  lastSample: SampledPlayerState = { ...this.sample };
  private hasVisual = false;
  private nametagTexture: THREE.CanvasTexture | null = null;
  private nametagMaterial: THREE.SpriteMaterial | null = null;
  private debugMarker: THREE.Mesh | null = null;

  // ---- Recovery smoothing: brief visual error offset after a stall ----
  /** Displayed = sampled + offset; the offset decays to zero in ~150 ms. */
  private readonly correctionOffset = new THREE.Vector3();
  /** Sampled position of the PREVIOUS frame (discontinuity detection). */
  private readonly prevSampled = new THREE.Vector3();
  private hasPrevSampled = false;

  // ---- Server-driven health bar (Phase 4) ----
  private healthBarBg: THREE.Sprite | null = null;
  private healthBarFill: THREE.Sprite | null = null;
  /** Exact server ratio (target) vs eased display ratio (visual only). */
  private healthRatioTarget = 1;
  private healthRatioShown = 1;

  constructor(
    readonly sessionId: string,
    readonly name: string,
    asset: CharacterAsset,
    /** Anomaly sink (owned by the manager — ring buffer + dev console). */
    private readonly onAnomaly: (text: string) => void,
    /** Death hook: the manager snapshots a physical ragdoll corpse. */
    private readonly onDied: ((remote: RemotePlayer) => void) | null = null,
  ) {
    // SkeletonUtils clone: required for skinned meshes (shares geometry /
    // materials / textures with the cached template — cheap per player).
    const model = skeletonClone(asset.template);
    // The group's origin is the CAPSULE CENTER; the model root is the feet.
    model.position.y = -FEET_OFFSET;
    this.model = model;
    this.group.add(model);
    this.group.visible = false; // hidden until the first snapshot arrives

    this.anim = new RemotePlayerAnimationController(model, -FEET_OFFSET, asset.clips);
    this.weapons = new RemoteWeaponController(model);
    this.group.add(this.createNametag(name));
    this.createHealthBar();

    if (icfg.showNetworkDebugMarkers) {
      // DEV ONLY: red marker = latest RAW network position; the character
      // itself renders the interpolated position (visual proof it works).
      this.debugMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xff2244 }),
      );
    }
  }

  /**
   * Instrumentation: called for every STORED snapshot (never duplicates).
   * Detects sequence gaps (client send lost OR patch coalescing) and
   * abnormal server-ts spacing — the two signatures that distinguish
   * "the sender never sent" from "Colyseus merged two sends".
   */
  noteStoredSnapshot(seq: number, snapGapMs: number | null): void {
    const nowMs = performance.now();
    if (this.lastArrivalAt > 0) this.lastArrivalGapMs = nowMs - this.lastArrivalAt;
    this.lastArrivalAt = nowMs;
    if (this.lastArrivalGapMs > 0) {
      const instRate = 1000 / this.lastArrivalGapMs;
      this.rateHz = this.rateHz === 0 ? instRate : this.rateHz + (instRate - this.rateHz) * 0.1;
    }

    if (this.lastSeq >= 0 && seq > this.lastSeq + 1) {
      this.lastSeqGap = seq - this.lastSeq - 1;
      this.seqGapTotal += this.lastSeqGap;
      this.onAnomaly(`${this.name}: seq gap +${this.lastSeqGap} (→${seq})`);
    } else {
      this.lastSeqGap = 0;
    }
    this.lastSeq = seq;

    if (snapGapMs !== null && snapGapMs > 0) {
      this.lastSnapGapMs = snapGapMs;
      if (snapGapMs > this.maxSnapGapMs) this.maxSnapGapMs = snapGapMs;
      if (snapGapMs > ANOMALY_SNAP_GAP_MS) {
        this.onAnomaly(`${this.name}: snapshot gap ${Math.round(snapGapMs)}ms`);
      }
    }
  }

  /**
   * Apply the latest SERVER combat state (health + alive). The server value
   * is exact; only the bar's visual fill eases toward it.
   */
  setCombatState(health: number, maxHealth: number, isAlive: boolean): void {
    this.healthRatioTarget = maxHealth > 0 ? Math.max(0, Math.min(1, health / maxHealth)) : 0;

    if (this.alive && !isAlive) {
      // DEATH: snapshot a physical ragdoll corpse from the CURRENT animated
      // pose + interpolated velocity (momentum preserved), then hide the
      // avatar — a dead player never stays standing. The corpse is an
      // independent clone: the respawned avatar never teleports the body.
      if (this.group.visible) this.onDied?.(this);
      this.alive = false;
      this.group.visible = false;
    } else if (!this.alive && isAlive) {
      // RESPAWN (state backstop — the explicit event normally lands first).
      this.prepareRespawn();
    }
  }

  /**
   * Server respawn = legitimate TELEPORT: wipe the snapshot buffer so the
   * avatar can NEVER be interpolated from the death position to the new
   * spawn. It reappears exactly at the first post-respawn snapshot.
   */
  prepareRespawn(): void {
    this.buffer.clear();
    this.hasVisual = false;
    this.hasPrevSampled = false;
    this.correctionOffset.set(0, 0, 0);
    this.alive = true;
    this.group.visible = false; // shown again on the first fresh snapshot
    this.healthRatioShown = 1; // full bar instantly — no dead→full easing
    this.healthRatioTarget = 1;
  }

  /** Sample the buffer at renderTime (server ms) and drive visuals. */
  update(dt: number, renderTime: number): void {
    // Dead: stay hidden, don't animate — respawn resets everything.
    if (!this.alive) return;
    this.updateHealthBar(dt);
    this.weapons.update(dt);
    // Decaying max of snapshot gaps (a calm minute clears an old spike).
    this.maxSnapGapMs = Math.max(0, this.maxSnapGapMs - 20 * dt);

    if (!this.buffer.sample(renderTime, this.sample)) return;
    const s = this.sample;
    this.extrapolating = s.extrapolating;
    this.lastExtrapolatedMs = s.extrapolatedMs;
    // Copy for the debug HUD (cheap primitive copies, no allocation).
    Object.assign(this.lastSample, s);

    // ---- Extrapolation episode tracking (one anomaly per episode) ----
    if (s.extrapolating && s.extrapolatedMs > ANOMALY_EXTRAP_MS) {
      this.extrapEpisodeActive = true;
      if (s.extrapolatedMs > this.extrapEpisodeMaxMs) this.extrapEpisodeMaxMs = s.extrapolatedMs;
    } else if (this.extrapEpisodeActive && !s.extrapolating) {
      this.onAnomaly(`${this.name}: extrapolation ${Math.round(this.extrapEpisodeMaxMs)}ms`);
      this.extrapEpisodeActive = false;
      this.extrapEpisodeMaxMs = 0;
    }

    if (!this.hasVisual || s.teleported) {
      // First snapshot or teleport-distance jump (respawn / legitimate
      // relocation): SNAP instantly — never glide across the map.
      this.group.position.set(s.x, s.y, s.z);
      this.correctionOffset.set(0, 0, 0);
      this.hasVisual = true;
    } else {
      // ---- RECOVERY SMOOTHING (visual only, coherent with the rewind) --
      // After a data stall (freeze → burst) the sampled position can jump
      // several meters in one frame. Instead of a hard visual snap, keep a
      // small ERROR OFFSET that decays in ~150 ms: the avatar glides onto
      // its exact renderTime position. The offset engages ONLY on a real
      // discontinuity and never crosses the teleport threshold — respawns
      // and legitimate teleports still snap instantly above.
      if (this.hasPrevSampled) {
        const jumpX = s.x - this.prevSampled.x;
        const jumpY = s.y - this.prevSampled.y;
        const jumpZ = s.z - this.prevSampled.z;
        const jump = Math.sqrt(jumpX * jumpX + jumpY * jumpY + jumpZ * jumpZ);
        const speed = Math.sqrt(
          s.velocityX * s.velocityX + s.velocityY * s.velocityY + s.velocityZ * s.velocityZ,
        );
        // Expected per-frame travel + margin: anything far beyond it is a
        // timeline discontinuity (stall recovery / clock catch-up).
        const expected = Math.max(CORRECTION_MIN_JUMP, speed * dt * 4 + 0.25);
        if (jump > expected && jump < icfg.teleportThreshold) {
          this.correctionOffset.set(
            this.group.position.x - s.x,
            this.group.position.y - s.y,
            this.group.position.z - s.z,
          );
          this.onAnomaly(`${this.name}: correction ${jump.toFixed(1)}m`);
        } else if (jump >= icfg.teleportThreshold) {
          // Too large to smooth — snap (mirrors the teleport rule).
          this.correctionOffset.set(0, 0, 0);
        }
      }

      // Decay the offset toward zero (visual convergence to renderTime).
      if (this.correctionOffset.lengthSq() > 0) {
        const decay = Math.exp(-dt * CORRECTION_DECAY_RATE);
        this.correctionOffset.multiplyScalar(decay);
        if (this.correctionOffset.lengthSq() < CORRECTION_EPSILON * CORRECTION_EPSILON) {
          this.correctionOffset.set(0, 0, 0);
        }
      }

      this.group.position.set(
        s.x + this.correctionOffset.x,
        s.y + this.correctionOffset.y,
        s.z + this.correctionOffset.z,
      );
    }
    this.prevSampled.set(s.x, s.y, s.z);
    this.hasPrevSampled = true;

    // MOLE STRIKE: a burrowed player is UNDERGROUND — the whole avatar
    // (model + nametag + health bar) disappears; the position keeps
    // updating so the dirt trail VFX can follow the burrowing path.
    this.burrowed = s.movementState === NetworkMovementState.BURROWED;
    this.group.visible = this.hasVisual && !this.burrowed;

    // Yaw only on the root — the character NEVER tilts with pitch; the
    // sampled yaw is already shortest-arc interpolated (359°→1° = 2°).
    this.group.rotation.y = s.yaw;
    this.lastYaw = s.yaw;
    this.lastPitch = s.pitch;

    const horizontalSpeed = Math.hypot(s.velocityX, s.velocityZ);
    // Direction-aware locomotion: signed angle between the aim yaw and
    // the actual movement direction (0 = running straight forward).
    // Yaw convention: yaw = 0 → forward = -Z.
    let moveLocalYaw = 0;
    if (horizontalSpeed > 0.1) {
      const moveYaw = Math.atan2(-s.velocityX, -s.velocityZ);
      moveLocalYaw = shortestAngleDelta(s.yaw, moveYaw);
    }
    this.anim.update(dt, s.movementState, horizontalSpeed, s.velocityY, s.pitch, moveLocalYaw);

    if (this.debugMarker) {
      const newest = this.buffer.newest;
      if (newest) this.debugMarker.position.set(newest.x, newest.y, newest.z);
    }
  }

  /** Magnitude of the currently active recovery offset (m, debug HUD). */
  get correctionMagnitude(): number {
    return this.correctionOffset.length();
  }

  attachDebugMarker(scene: THREE.Scene): void {
    if (this.debugMarker) scene.add(this.debugMarker);
  }

  /** Remove from the scene. Shared template resources are NOT disposed. */
  dispose(scene: THREE.Scene): void {
    this.weapons.dispose();
    scene.remove(this.group);
    if (this.debugMarker) {
      scene.remove(this.debugMarker);
      this.debugMarker.geometry.dispose();
      (this.debugMarker.material as THREE.Material).dispose();
      this.debugMarker = null;
    }
    this.anim.dispose();
    this.buffer.clear();
    this.nametagTexture?.dispose();
    this.nametagMaterial?.dispose();
    this.nametagTexture = null;
    this.nametagMaterial = null;
    if (this.healthBarBg) (this.healthBarBg.material as THREE.Material).dispose();
    if (this.healthBarFill) (this.healthBarFill.material as THREE.Material).dispose();
    this.healthBarBg = null;
    this.healthBarFill = null;
  }

  /**
   * Small always-facing health bar under the nametag (same spirit as the
   * Bots' bars): dark background + colored fill.
   *
   * IMPORTANT: both sprites share the SAME centered position — sprites
   * billboard around their own anchor, so any parent-space X offset would
   * visually detach the fill from the background (looks like two separate
   * bars). The fill therefore shrinks symmetrically from the center.
   */
  private createHealthBar(): void {
    const bg = new THREE.Sprite(
      new THREE.SpriteMaterial({ color: 0x140a24, transparent: true, opacity: 0.72, depthWrite: false }),
    );
    bg.scale.set(HEALTHBAR_WIDTH, HEALTHBAR_THICKNESS, 1);
    bg.position.y = HEALTHBAR_HEIGHT;

    const fill = new THREE.Sprite(
      new THREE.SpriteMaterial({ color: 0x35e07c, transparent: true, opacity: 0.95, depthWrite: false }),
    );
    fill.scale.set(HEALTHBAR_WIDTH * 0.96, HEALTHBAR_THICKNESS * 0.68, 1);
    fill.position.y = HEALTHBAR_HEIGHT;
    // Tiny render-order nudge instead of a positional offset.
    bg.renderOrder = 1;
    fill.renderOrder = 2;

    this.healthBarBg = bg;
    this.healthBarFill = fill;
    this.group.add(bg, fill);
  }

  /** Ease the DISPLAYED fill toward the exact server ratio (visual only). */
  private updateHealthBar(dt: number): void {
    if (!this.healthBarFill) return;
    const target = this.healthRatioTarget;
    this.healthRatioShown += (target - this.healthRatioShown) * Math.min(1, dt * HEALTHBAR_EASE);
    if (Math.abs(this.healthRatioShown - target) < 0.002) this.healthRatioShown = target;
    this.healthBarFill.scale.x = Math.max(0.0001, HEALTHBAR_WIDTH * 0.96 * this.healthRatioShown);
    // Full bar → the background is fully covered (one single visible bar).
    this.healthBarFill.visible = this.healthRatioShown > 0.005;
    // Green → amber → red as HP drops (simple glanceable cue).
    const mat = this.healthBarFill.material as THREE.SpriteMaterial;
    const r = this.healthRatioShown;
    mat.color.setHex(r > 0.55 ? 0x35e07c : r > 0.25 ? 0xe0b23c : 0xe04848);
  }

  /** Small billboard nametag above the head (remote players only). */
  private createNametag(name: string): THREE.Sprite {
    const text = name.toUpperCase();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    const font = "700 44px Orbitron, sans-serif";
    ctx.font = font;
    const textWidth = Math.ceil(ctx.measureText(text).width);
    canvas.width = Math.max(64, textWidth + 36);
    canvas.height = 64;

    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(10, 6, 20, 0.55)";
    ctx.fillRect(0, 6, canvas.width, canvas.height - 12);
    ctx.fillStyle = "#e9d5ff";
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2);

    this.nametagTexture = new THREE.CanvasTexture(canvas);
    this.nametagTexture.colorSpace = THREE.SRGBColorSpace;
    this.nametagMaterial = new THREE.SpriteMaterial({
      map: this.nametagTexture,
      transparent: true,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(this.nametagMaterial);
    const height = 0.22;
    sprite.scale.set((canvas.width / canvas.height) * height, height, 1);
    sprite.position.y = NAMETAG_HEIGHT;
    return sprite;
  }
}

/**
 * Owns every remote player's avatar: join → clone + add, state → snapshot
 * buffer, leave → clean removal. The LOCAL player is always excluded.
 *
 * PHASE 3: remote transforms flow through SNAPSHOT INTERPOLATION —
 * network rate (~30 Hz) is fully decoupled from the render rate.
 *
 * INGESTION: sync() must be called from the PER-PATCH hook
 * (MultiplayerClient.onStatePatched) so every intermediate transform is
 * stored even when several patches arrive between two render frames.
 */
export class RemotePlayerManager {
  private readonly remotes = new Map<string, RemotePlayer>();
  private readonly clock = new NetworkClock();
  /** Measured snapshot rate + jitter → lowest SAFE interpolation delay. */
  private readonly adaptiveDelay = new AdaptiveInterpolationDelay();
  private asset: CharacterAsset | null = null;
  /** Latest ping per remote (from the synced state — HUD display only). */
  private readonly pings = new Map<string, number>();
  /** Death ragdoll sink (owned by the Game — optional in tests). */
  private corpses: CorpseManager | null = null;
  private readonly corpseVelocity = new THREE.Vector3();

  // ---- Anomaly history (ring buffer for the F1 debug HUD) ----
  private readonly anomalies: NetworkAnomaly[] = [];
  private lastAnomalyConsoleAt = 0;

  constructor(private readonly scene: THREE.Scene) {}

  /** Load + cache the character asset (call once before the game starts). */
  async preload(): Promise<void> {
    this.asset = await loadCharacterAsset();
  }

  /** Wire the death-ragdoll corpse sink (visual only — never authoritative). */
  setCorpseManager(corpses: CorpseManager | null): void {
    this.corpses = corpses;
  }

  /**
   * SERVER said this avatar died → snapshot an independent physical corpse:
   * SkeletonUtils clone of the posed model (bones keep their CURRENT local
   * transforms), placed at the avatar's world transform, simulated by a
   * Rapier ragdoll seeded with the interpolated network velocity. The
   * ragdoll is purely a visual/physical representation — the server's
   * combat state stays the single source of truth (K/D/A untouched).
   *
   * NOTE: the server does not broadcast the killing blow's knockback to
   * OTHER clients yet — the CorpseSpawnOptions.impact field is the ready
   * slot for it once the PLAYER_DIED event carries impulse + point.
   */
  private spawnRemoteCorpse(remote: RemotePlayer): void {
    if (!this.corpses) return;

    const corpseModel = skeletonClone(remote.model);
    // The corpse keeps the FULL living look: same Sprouty Smile skin, same
    // +25% scale (baked into the cloned model) and the same red rim glow —
    // the CorpseManager clones every material per corpse, so the fade-out
    // owns its own rim copy and never tints the living avatars.

    // Corpse root at the avatar's exact world transform (group = capsule
    // center; the model keeps its own feet offset inside).
    const corpseRoot = new THREE.Group();
    corpseRoot.position.copy(remote.group.position);
    corpseRoot.quaternion.copy(remote.group.quaternion);
    corpseRoot.add(corpseModel);
    corpseRoot.updateMatrixWorld(true);

    const parts = buildSkeletonRagdollParts(corpseRoot);
    if (!parts) return; // unexpected rig — skip silently (avatar just hides)

    this.corpseVelocity.set(
      remote.lastSample.velocityX,
      remote.lastSample.velocityY,
      remote.lastSample.velocityZ,
    );
    this.corpses.spawn(corpseRoot, parts, { velocity: this.corpseVelocity });
  }

  /**
   * Reconcile avatars with the latest network state: spawns joiners,
   * pushes fresh snapshots (stale sequences rejected in the buffer),
   * removes leavers. Keyed strictly by sessionId.
   *
   * Called on EVERY state patch (not per render frame) — duplicates are
   * rejected by the per-player sequence, so calling it more often only
   * improves capture, never corrupts it.
   */
  sync(players: NetworkPlayerInfo[], localSessionId: string | null): void {
    if (!this.asset) return;

    const seen = new Set<string>();
    for (const p of players) {
      if (p.id === localSessionId) continue; // never an avatar for yourself
      seen.add(p.id);
      this.pings.set(p.id, p.pingMs);

      let remote = this.remotes.get(p.id);
      if (!remote) {
        remote = new RemotePlayer(
          p.id,
          p.name,
          this.asset,
          (text) => this.pushAnomaly(text),
          (dead) => this.spawnRemoteCorpse(dead),
        );
        this.remotes.set(p.id, remote);
        this.scene.add(remote.group);
        remote.attachDebugMarker(this.scene);
      }

      // SERVER-owned combat state → avatar visibility + health bar.
      remote.setCombatState(p.health, p.maxHealth, p.isAlive);
      // SERVER-validated equipped weapon → real GLB in the hand.
      remote.weapons.setWeapon(p.weapon);

      // ts = SERVER timestamp of the transform (never raw client clocks).
      // Dead players push nothing: the server refuses their transforms and
      // the buffer is wiped at respawn (teleport, never interpolated).
      if (p.ts > 0 && p.isAlive) {
        const prevTs = remote.buffer.newest?.timestamp ?? null;
        const stored = remote.buffer.push(
          p.ts,
          p.seq,
          p.x,
          p.y,
          p.z,
          p.yaw,
          p.pitch,
          p.vx,
          p.vy,
          p.vz,
          sanitizeNetworkMovementState(p.state),
        );
        // Feed the clock + adaptive delay with REAL arrivals only (this
        // may run several times on the same state — duplicates return
        // false). A repeated stale ts must NEVER touch the clock (it
        // would drag the estimated server time backward — NetworkClock).
        if (stored) {
          this.clock.noteServerTimestamp(p.ts);
          this.adaptiveDelay.noteSnapshot(this.clock.now(), p.ts, prevTs);
          remote.noteStoredSnapshot(p.seq, prevTs !== null ? p.ts - prevTs : null);
        }
      }
    }

    // Leavers: remove avatar + nametag cleanly.
    for (const [id, remote] of this.remotes) {
      if (!seen.has(id)) {
        remote.dispose(this.scene);
        this.remotes.delete(id);
        this.pings.delete(id);
      }
    }
  }

  /** Per-frame: sample every buffer slightly in the past + animate. */
  update(dt: number): void {
    if (!this.clock.hasSync) return;
    // ADAPTIVE delay: as low as the measured jitter safely allows.
    const delayMs = this.adaptiveDelay.update(dt);
    const renderTime = this.clock.now() - delayMs;
    for (const remote of this.remotes.values()) remote.update(dt, renderTime);
  }

  /**
   * Server respawn event for one player: legitimate teleport — clear its
   * snapshot buffer and snap to the next fresh snapshot (never lerped).
   */
  notifyRespawn(sessionId: string): void {
    this.remotes.get(sessionId)?.prepareRespawn();
  }

  // ------------------------------------------------------------------
  // Phase 5 — accessors for the remote combat VFX controller
  // ------------------------------------------------------------------

  /**
   * INTERPOLATED pose of one remote avatar (capsule center + aim).
   * Returns false while the avatar is dead / not visible yet.
   */
  getPose(sessionId: string, out: { pos: THREE.Vector3; yaw: number; pitch: number }): boolean {
    const remote = this.remotes.get(sessionId);
    if (!remote || !remote.alive || !remote.group.visible) return false;
    out.pos.copy(remote.group.position);
    out.yaw = remote.lastYaw;
    out.pitch = remote.lastPitch;
    return true;
  }

  /**
   * INTERPOLATED capsule-center position even while the avatar mesh is
   * HIDDEN (MOLE STRIKE burrow) — drives the remote dirt-trail VFX.
   * Returns false when the player is dead / unknown / never seen.
   */
  getBurrowPosition(sessionId: string, out: THREE.Vector3): boolean {
    const remote = this.remotes.get(sessionId);
    if (!remote || !remote.alive || !remote.burrowed) return false;
    out.copy(remote.group.position);
    return true;
  }

  /** World position of the avatar's in-hand weapon (beam/tracer anchor). */
  getMuzzleWorldPosition(sessionId: string, out: THREE.Vector3): boolean {
    const remote = this.remotes.get(sessionId);
    if (!remote || !remote.alive || !remote.group.visible) return false;
    return remote.weapons.getMuzzleWorldPosition(out);
  }

  /** A confirmed melee action → real melee GLB in hand + swing anim. */
  triggerMeleeSwing(sessionId: string, weapon: string, kind: "sweep" | "slam"): void {
    this.remotes.get(sessionId)?.weapons.triggerMelee(weapon, kind);
  }

  /** Feed the shared server-clock estimate (e.g. from the LOCAL player ts). */
  noteServerTime(ts: number): void {
    if (ts > 0) this.clock.noteServerTimestamp(ts);
  }

  /** Estimated CURRENT server time (ms) — null before the first sync. */
  getServerNow(): number | null {
    return this.clock.hasSync ? this.clock.now() : null;
  }

  /**
   * VIEW TIME for lag-compensated weapon actions: the render timestamp
   * (server ms) at which remote players are DISPLAYED right now. Sent
   * with WEAPON_ACTION so the server rewinds to exactly what the shooter
   * saw. Null before the first server-time sync.
   */
  getRenderTimestamp(): number | null {
    if (!this.clock.hasSync) return null;
    return this.clock.now() - this.adaptiveDelay.delayMs;
  }

  get count(): number {
    return this.remotes.size;
  }

  /** Debug info (shown only when the debug HUD is active). */
  getDebugInfo(): {
    remotePlayers: number;
    snapshots: number;
    extrapolating: boolean;
    interpDelayMs: number;
  } {
    let snapshots = 0;
    let extrapolating = false;
    for (const r of this.remotes.values()) {
      snapshots += r.buffer.count;
      extrapolating = extrapolating || r.extrapolating;
    }
    return {
      remotePlayers: this.remotes.size,
      snapshots,
      extrapolating,
      interpDelayMs: Math.round(this.adaptiveDelay.delayMs),
    };
  }

  /**
   * Full diagnostic report for the F1 Network Debug HUD. Called at the
   * HUD refresh rate ONLY while the HUD is visible (never per frame).
   */
  getNetworkDebugReport(): NetworkDebugReport {
    const serverNow = this.clock.hasSync ? this.clock.now() : 0;
    const renderTime = serverNow - this.adaptiveDelay.delayMs;
    const players: RemotePlayerNetDebug[] = [];
    for (const r of this.remotes.values()) {
      const newest = r.buffer.newest;
      players.push({
        id: r.sessionId,
        name: r.name,
        pingMs: this.pings.get(r.sessionId) ?? 0,
        lastSeq: r.lastSeq,
        lastSeqGap: r.lastSeqGap,
        seqGapTotal: r.seqGapTotal,
        snapshotAgeMs: newest ? serverNow - newest.timestamp : -1,
        lastArrivalGapMs: r.lastArrivalGapMs,
        lastSnapGapMs: r.lastSnapGapMs,
        maxSnapGapMs: r.maxSnapGapMs,
        rateHz: r.rateHz,
        buffer: r.buffer.count,
        state: movementStateName(r.lastSample.movementState),
        interpolating: !r.extrapolating && r.buffer.count > 0,
        extrapolating: r.extrapolating,
        extrapolatedMs: r.lastExtrapolatedMs,
        correctionM: r.correctionMagnitude,
        rawY: newest?.y ?? 0,
        interpY: r.lastSample.y,
        visualY: r.group.position.y,
        vx: r.lastSample.velocityX,
        vy: r.lastSample.velocityY,
        vz: r.lastSample.velocityZ,
      });
    }
    return {
      remotePlayers: this.remotes.size,
      interpDelayMs: this.adaptiveDelay.delayMs,
      targetDelayMs: this.adaptiveDelay.targetDelayMs,
      avgGapMs: this.adaptiveDelay.averageGapMs,
      maxGapMs: this.adaptiveDelay.maxGapMs,
      jitterMs: this.adaptiveDelay.jitterMs,
      serverNow,
      renderTime,
      players,
      anomalies: this.anomalies,
    };
  }

  /** Ring-buffered anomaly sink + throttled DEV-ONLY console echo. */
  private pushAnomaly(text: string): void {
    this.anomalies.push({ at: Date.now(), text });
    if (this.anomalies.length > ANOMALY_HISTORY_MAX) this.anomalies.shift();
    if (import.meta.env.DEV) {
      const nowMs = performance.now();
      if (nowMs - this.lastAnomalyConsoleAt >= ANOMALY_CONSOLE_THROTTLE_MS) {
        this.lastAnomalyConsoleAt = nowMs;
        console.warn(`[NET] ${text}`);
      }
    }
  }

  dispose(): void {
    for (const remote of this.remotes.values()) remote.dispose(this.scene);
    this.remotes.clear();
    this.pings.clear();
    this.anomalies.length = 0;
  }
}