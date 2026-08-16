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
import {
  RemotePlayerAnimationController,
  RemoteCharacterClips,
} from "./remote/RemotePlayerAnimationController";
import { NetworkMovementState, sanitizeNetworkMovementState } from "./NetworkMovementState";
import { RemoteWeaponController } from "./remote/RemoteWeaponController";
import type { NetworkPlayerInfo } from "./MultiplayerClient";
// Character GLB (mesh + skeleton + "Alert" idle clip) — loaded ONCE, cloned
// per player. The run/jump clips live in sibling GLBs (same skeleton).
import characterUrl from "../assets/Meshy_AI_Neon_Void_Sentinel_biped_Animation_Running_withSkin.glb?url";
import runClipUrl from "../assets/Meshy_AI_Neon_Void_Sentinel_biped_Animation_Walking_withSkin.glb?url";
import jumpClipUrl from "../assets/Meshy_AI_Neon_Void_Sentinel_biped_Animation_Regular_Jump_withSkin.glb?url";

/** Capsule center → feet distance (model root sits at the feet). */
const FEET_OFFSET = moveCfg.standHalfHeight + moveCfg.capsuleRadius;
/** Visual character height (matches the local capsule: 2 × feetOffset). */
const CHARACTER_HEIGHT = FEET_OFFSET * 2;
/** Raw GLB faces +Z; game convention: yaw = 0 → forward = -Z. */
const MODEL_YAW_OFFSET = Math.PI;
/** Nametag height above the capsule center (meters). */
const NAMETAG_HEIGHT = FEET_OFFSET + 0.42;
/** Health bar height above the capsule center (just under the nametag). */
const HEALTHBAR_HEIGHT = FEET_OFFSET + 0.24;
/** Health bar dimensions (meters). */
const HEALTHBAR_WIDTH = 0.62;
const HEALTHBAR_THICKNESS = 0.055;
/** Visual-only easing speed of the health bar fill (logic is never delayed). */
const HEALTHBAR_EASE = 10;

// ---- Shared, cached character asset (load once → clone per player) ----
interface CharacterAsset {
  template: THREE.Object3D;
  clips: RemoteCharacterClips;
}
let cachedCharacter: Promise<CharacterAsset> | null = null;

function loadCharacterAsset(): Promise<CharacterAsset> {
  if (cachedCharacter) return cachedCharacter;
  const loader = new GLTFLoader();
  cachedCharacter = Promise.all([
    loader.loadAsync(characterUrl),
    loader.loadAsync(runClipUrl),
    loader.loadAsync(jumpClipUrl),
  ]).then(([gltf, runGltf, jumpGltf]: [GLTF, GLTF, GLTF]) => {
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

    // Wrap in a container so the clone root is a plain, unrotated group.
    const template = new THREE.Group();
    template.add(model);

    // Real clips (inspected in the assets): "Armature|Alert|baselayer"
    // (idle), "Armature|running|baselayer" (run) and
    // "Armature|Regular_Jump|baselayer" (jump). Same skeleton — the clips
    // retarget onto every clone by bone name. The frozen slide pose is a
    // cheap CLONE sharing the keyframe data (distinct action only).
    const idle =
      gltf.animations?.find((c) => /alert|idle/i.test(c.name)) ?? gltf.animations?.[0];
    const run =
      runGltf.animations?.find((c) => /run/i.test(c.name)) ?? runGltf.animations?.[0];
    const jump =
      jumpGltf.animations?.find((c) => /jump/i.test(c.name)) ?? jumpGltf.animations?.[0];
    if (!idle || !run || !jump) throw new Error("Remote character clips missing");

    // The jump clip carries hips ROOT MOTION (the character rises inside
    // the clip). The avatar's actual jump arc already comes from the
    // NETWORK position — keeping both would double the motion and leave
    // the model floating above its capsule. Flatten the hips translation.
    stripHipsRootMotion(jump);

    const clips: RemoteCharacterClips = {
      idle,
      run,
      jump,
      slidePose: run.clone(),
    };
    return { template, clips };
  });
  return cachedCharacter;
}

/**
 * Flatten the Hips translation track of a clip to its FIRST keyframe:
 * removes the baked root motion (vertical jump arc / forward travel)
 * while keeping every rotation — the character animates in place and the
 * NETWORK position provides the real trajectory.
 */
function stripHipsRootMotion(clip: THREE.AnimationClip): void {
  for (const track of clip.tracks) {
    if (!/Hips\.position$/i.test(track.name)) continue;
    const values = track.values;
    for (let i = 3; i < values.length; i += 3) {
      values[i] = values[0];
      values[i + 1] = values[1];
      values[i + 2] = values[2];
    }
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
  };
  private hasVisual = false;
  private nametagTexture: THREE.CanvasTexture | null = null;
  private nametagMaterial: THREE.SpriteMaterial | null = null;
  private debugMarker: THREE.Mesh | null = null;

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
  ) {
    // SkeletonUtils clone: required for skinned meshes (shares geometry /
    // materials / textures with the cached template — cheap per player).
    const model = skeletonClone(asset.template);
    // The group's origin is the CAPSULE CENTER; the model root is the feet.
    model.position.y = -FEET_OFFSET;
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
   * Apply the latest SERVER combat state (health + alive). The server value
   * is exact; only the bar's visual fill eases toward it.
   */
  setCombatState(health: number, maxHealth: number, isAlive: boolean): void {
    this.healthRatioTarget = maxHealth > 0 ? Math.max(0, Math.min(1, health / maxHealth)) : 0;

    if (this.alive && !isAlive) {
      // DEATH: hide the avatar — a dead player never stays standing.
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
    if (!this.buffer.sample(renderTime, this.sample)) return;
    const s = this.sample;
    this.extrapolating = s.extrapolating;

    if (!this.hasVisual || s.teleported) {
      // First snapshot or teleport-distance jump (respawn / anomaly):
      // SNAP — never lerp across the map for seconds.
      this.group.position.set(s.x, s.y, s.z);
      this.hasVisual = true;
    } else {
      this.group.position.set(s.x, s.y, s.z);
    }

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
 * network rate (~20 Hz) is fully decoupled from the render rate.
 */
export class RemotePlayerManager {
  private readonly remotes = new Map<string, RemotePlayer>();
  private readonly clock = new NetworkClock();
  private asset: CharacterAsset | null = null;

  constructor(private readonly scene: THREE.Scene) {}

  /** Load + cache the character asset (call once before the game starts). */
  async preload(): Promise<void> {
    this.asset = await loadCharacterAsset();
  }

  /**
   * Reconcile avatars with the latest network state: spawns joiners,
   * pushes fresh snapshots (stale sequences rejected in the buffer),
   * removes leavers. Keyed strictly by sessionId.
   */
  sync(players: NetworkPlayerInfo[], localSessionId: string | null): void {
    if (!this.asset) return;

    const seen = new Set<string>();
    for (const p of players) {
      if (p.id === localSessionId) continue; // never an avatar for yourself
      seen.add(p.id);

      let remote = this.remotes.get(p.id);
      if (!remote) {
        remote = new RemotePlayer(p.id, p.name, this.asset);
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
        this.clock.noteServerTimestamp(p.ts);
        remote.buffer.push(
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
      }
    }

    // Leavers: remove avatar + nametag cleanly.
    for (const [id, remote] of this.remotes) {
      if (!seen.has(id)) {
        remote.dispose(this.scene);
        this.remotes.delete(id);
      }
    }
  }

  /** Per-frame: sample every buffer slightly in the past + animate. */
  update(dt: number): void {
    if (!this.clock.hasSync) return;
    const renderTime = this.clock.now() - icfg.interpolationDelayMs;
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

  get count(): number {
    return this.remotes.size;
  }

  /** Debug info (shown only when the debug HUD is active). */
  getDebugInfo(): { remotePlayers: number; snapshots: number; extrapolating: boolean } {
    let snapshots = 0;
    let extrapolating = false;
    for (const r of this.remotes.values()) {
      snapshots += r.buffer.count;
      extrapolating = extrapolating || r.extrapolating;
    }
    return { remotePlayers: this.remotes.size, snapshots, extrapolating };
  }

  dispose(): void {
    for (const remote of this.remotes.values()) remote.dispose(this.scene);
    this.remotes.clear();
  }
}