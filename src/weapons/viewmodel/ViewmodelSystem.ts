import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { loadFPArmsGltf, loadFPPoseClips } from "./FPArmsRig";
import { WeaponViewProfile, createWeaponMount } from "../profiles/WeaponProfile";
import { HEX_FP_CAMERA } from "../profiles/HexSniperProfile";

/**
 * COMMON FIRST-PERSON VIEWMODEL SYSTEM (local player only).
 *
 * One arms rig (Potato_FP_CommonArms — a single instance), one arms
 * mixer, one weapon slot under the rig's Weapon_R socket, one dedicated
 * FP scene + FP camera and profile-driven pose clips. Weapons plug in
 * through a WeaponViewProfile + their own gameplay adapter; the system
 * mutualizes loading, rendering, transitions and lifecycle.
 *
 * RENDERING CONTRACT: the Game renders the world first, then calls
 * render() — ONE depth clear, then arms + weapon draw together into the
 * SAME depth buffer (opaque materials keep depthTest/depthWrite true, so
 * hands and weapon occlude each other correctly). World color is
 * preserved (autoClear disabled for the FP pass). No per-object
 * onBeforeRender clearDepth proxies, no depthTest=false overrides.
 *
 * COORDINATES: one single convention — the FP camera is placed at the
 * GAME camera's world pose every frame (its own FOV/near/far from the
 * profile reference: vertical FOV 65°, near 0.01, far 100). The arms rig
 * hangs under the FP camera (the GLB's FP_Viewmodel container already
 * carries the camera-space conversion — nothing is re-rotated here).
 */
export class ViewmodelSystem {
  /** Dedicated FP scene (arms + weapon + stable lights only). */
  readonly scene = new THREE.Scene();
  /** FP camera — follows the game camera pose, keeps its own projection. */
  readonly camera: THREE.PerspectiveCamera;
  /** Resolves once the arms rig is parsed and attached (GPU warm-up). */
  readonly ready: Promise<void>;

  /** Sway container (bob/recoil move arms + weapon TOGETHER — grips hold). */
  private readonly swayGroup = new THREE.Group();
  private armsRoot: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private weaponSocket: THREE.Object3D | null = null;

  // ---- Equipped weapon state ----
  private mount: THREE.Group | null = null;
  private weaponRoot: THREE.Object3D | null = null;
  private actions: {
    hold: THREE.AnimationAction;
    run: THREE.AnimationAction;
    aim: THREE.AnimationAction;
    raise: THREE.AnimationAction;
    lower: THREE.AnimationAction;
    inspect: THREE.AnimationAction | null;
  } | null = null;
  /** Guards stale async equips (fast weapon switches / dispose). */
  private equipToken = 0;
  private disposed = false;

  // ---- Presentation state machine ----
  private state: "hold" | "run" | "raise" | "aim" | "lower" | "inspect" = "hold";
  private current: THREE.AnimationAction | null = null;
  /** Called when the inspect clip ends OR is cancelled. */
  private onInspectDone: ((cancelled: boolean) => void) | null = null;

  // ---- Cosmetic sway (never changes real fire direction) ----
  private bobPhase = 0;
  private bobAmount = 0;
  private recoil = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(
      HEX_FP_CAMERA.verticalFovDegrees,
      aspect,
      HEX_FP_CAMERA.near,
      HEX_FP_CAMERA.far,
    );
    this.scene.add(this.camera);
    this.camera.add(this.swayGroup);
    this.swayGroup.visible = false;

    // STABLE lights: created once, never toggled with weapon visibility —
    // the FP light count never changes (no lit-material recompiles).
    const ambient = new THREE.AmbientLight(0xffffff, 1.1);
    const key = new THREE.DirectionalLight(0xfff2e0, 1.6);
    key.position.set(0.6, 1.0, 0.4);
    key.target.position.set(0, 0, -1);
    this.camera.add(key, key.target);
    this.scene.add(ambient);

    this.ready = this.loadArms();
  }

  private async loadArms(): Promise<void> {
    const gltf = await loadFPArmsGltf();
    if (this.disposed) return;
    // SkeletonUtils clone: the cached template stays pristine (geometry,
    // textures shared). ONE instance for the local player.
    const arms = skeletonClone(gltf.scene);
    arms.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.frustumCulled = false; // camera-locked: always on screen
        mesh.raycast = () => {}; // never a gameplay raycast target
      }
    });
    this.armsRoot = arms;
    this.swayGroup.add(arms);
    this.mixer = new THREE.AnimationMixer(arms);
    this.weaponSocket = arms.getObjectByName("Weapon_R") ?? null;
    if (!this.weaponSocket) throw new Error("FP arms rig: Weapon_R socket missing");
    // A weapon equip may already be waiting for the socket.
    this.pendingAttach?.();
    this.pendingAttach = null;
  }

  /** Deferred attach when equip resolves before the arms GLB does. */
  private pendingAttach: (() => void) | null = null;

  /**
   * Equip a weapon: attach ITS ALREADY-CLONED scene root under Weapon_R
   * through the profile's FP mount (matrix applied exactly once), and
   * load the profile's FP pose clips onto the common arms mixer.
   *
   * `weaponRoot` must be the instance the weapon's own controller renders
   * (e.g. HexSniperController.object) — the system NEVER re-clones it, so
   * a single mixer drives the weapon's internal skeleton.
   */
  async equip(profile: WeaponViewProfile, weaponRoot: THREE.Object3D): Promise<void> {
    const token = ++this.equipToken;
    const clips = await loadFPPoseClips(profile.fpPosesUrl);
    if (this.disposed || token !== this.equipToken) return;

    const attach = () => {
      if (this.disposed || token !== this.equipToken) return;
      const socket = this.weaponSocket;
      const mixer = this.mixer;
      if (!socket || !mixer) return;

      this.detachWeapon();
      this.weaponRoot = weaponRoot;
      this.mount = createWeaponMount(`${profile.id}Mount`, profile.fpMount);
      socket.add(this.mount);
      this.mount.add(weaponRoot); // whole scene, transforms preserved

      const byName = (name: string) => {
        const clip = clips.find((c) => c.name === name);
        if (!clip) throw new Error(`FP pose clip missing: ${name}`);
        return clip;
      };
      const loop = (name: string) => {
        const a = mixer.clipAction(byName(name));
        a.setLoop(THREE.LoopRepeat, Infinity);
        return a;
      };
      const once = (name: string) => {
        const a = mixer.clipAction(byName(name));
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
        return a;
      };
      this.actions = {
        hold: loop(profile.fpClips.hold),
        run: loop(profile.fpClips.run),
        aim: loop(profile.fpClips.aim),
        raise: once(profile.fpClips.raise),
        lower: once(profile.fpClips.lower),
        inspect: profile.fpClips.inspect ? once(profile.fpClips.inspect) : null,
      };
      this.state = "hold";
      this.current = this.actions.hold;
      this.current.reset().play();
      mixer.update(0);
    };

    if (this.weaponSocket && this.mixer) attach();
    else this.pendingAttach = attach;
  }

  /** Unequip: detach the weapon scene; the arms stay loaded and cached. */
  unequip(): void {
    this.equipToken++;
    this.pendingAttach = null;
    this.detachWeapon();
  }

  private detachWeapon(): void {
    if (this.onInspectDone) {
      const cb = this.onInspectDone;
      this.onInspectDone = null;
      cb(true);
    }
    if (this.actions && this.mixer) {
      for (const a of Object.values(this.actions)) a?.stop();
      this.mixer.stopAllAction();
    }
    this.actions = null;
    this.current = null;
    this.state = "hold";
    if (this.weaponRoot) this.weaponRoot.removeFromParent();
    this.weaponRoot = null;
    if (this.mount) this.mount.removeFromParent();
    this.mount = null;
  }

  setVisible(visible: boolean): void {
    // Only the sway group toggles — the FP lights keep a stable presence.
    this.swayGroup.visible = visible;
  }

  get visible(): boolean {
    return this.swayGroup.visible;
  }

  /** True while the affectionate inspection is playing. */
  get inspecting(): boolean {
    return this.state === "inspect";
  }

  /** True while the straight-weapon (aim) presentation is active. */
  get aimed(): boolean {
    return this.state === "aim" || this.state === "raise";
  }

  /**
   * Start the inspection arms clip (caller is responsible for starting
   * the weapon's own inspect clip THE SAME FRAME — same clock, same
   * normalized progression). Returns false when unavailable.
   */
  startInspect(onDone: (cancelled: boolean) => void): boolean {
    if (!this.actions?.inspect || this.state === "inspect") return false;
    this.transition(this.actions.inspect, 0.08);
    this.state = "inspect";
    this.onInspectDone = onDone;
    return true;
  }

  /** Cancel a running inspection (fire/ADS/move/switch/death/ragdoll). */
  cancelInspect(): void {
    if (this.state !== "inspect") return;
    const cb = this.onInspectDone;
    this.onInspectDone = null;
    this.state = "hold";
    if (this.actions) this.transition(this.actions.hold, 0.06);
    cb?.(true);
  }

  /** Add a cosmetic recoil kick (group motion — grips stay glued). */
  addRecoil(amount: number): void {
    this.recoil = Math.min(1, this.recoil + amount);
  }

  /**
   * Per-frame presentation. Priority (per the integration contract):
   * combat/ADS straight pose > inspection > run > hold. `straight` must
   * stay true through the WHOLE attack cycle (Extending/Pulling/
   * Retracting/Recovering/Biting AND bitePending) — not just ADS.
   */
  update(
    dt: number,
    input: { straight: boolean; running: boolean; speed: number },
  ): void {
    const a = this.actions;
    if (a && this.mixer) {
      // ---- State machine (authored Raise/Lower transitions for ADS) ----
      switch (this.state) {
        case "inspect": {
          const clip = a.inspect!.getClip();
          if (input.straight) {
            // CRITICAL interruption order (fire during inspection): cancel
            // arms inspect, restore the combat pose and evaluate the mixer
            // NOW — the caller reads TongueOrigin/sockets after update(),
            // never from the flipped inspection pose.
            this.cancelInspect();
            this.transition(a.raise, 0.05);
            this.state = "raise";
          } else if (a.inspect!.time >= clip.duration - 1e-4) {
            const cb = this.onInspectDone;
            this.onInspectDone = null;
            this.state = "hold";
            this.transition(a.hold, 0.12);
            cb?.(false);
          }
          break;
        }
        case "hold":
        case "run":
          if (input.straight) {
            this.transition(a.raise, 0.04);
            this.state = "raise";
          } else {
            const want = input.running ? "run" : "hold";
            if (want !== this.state) {
              this.transition(want === "run" ? a.run : a.hold, 0.14);
              this.state = want;
            }
            if (this.state === "run") {
              // Run playback follows real speed (clip authored for ~9 m/s).
              a.run.timeScale = THREE.MathUtils.clamp(input.speed / 9, 0.75, 1.6);
            }
          }
          break;
        case "raise":
          if (!input.straight) {
            this.transition(a.lower, 0.03);
            this.state = "lower";
          } else if (a.raise.time >= a.raise.getClip().duration - 1e-4) {
            this.transition(a.aim, 0.05);
            this.state = "aim";
          }
          break;
        case "aim":
          if (!input.straight) {
            this.transition(a.lower, 0.03);
            this.state = "lower";
          }
          break;
        case "lower":
          if (input.straight) {
            this.transition(a.raise, 0.03);
            this.state = "raise";
          } else if (a.lower.time >= a.lower.getClip().duration - 1e-4) {
            this.transition(input.running ? a.run : a.hold, 0.06);
            this.state = input.running ? "run" : "hold";
          }
          break;
      }
      this.mixer.update(dt);
    }

    // ---- Cosmetic sway: bob + recoil on the WHOLE group (arms + weapon
    // together — the grips never separate). Attack states suppress the
    // run bob (active attack takes precedence over locomotion sway).
    const bobTarget = input.running && !input.straight && this.state !== "inspect" ? 1 : 0;
    this.bobAmount += (bobTarget - this.bobAmount) * Math.min(1, dt * 8);
    this.bobPhase += dt * Math.min(input.speed, 14) * 1.35;
    this.recoil *= Math.exp(-10 * dt);
    const bob = this.bobAmount * 0.006;
    this.swayGroup.position.set(
      Math.sin(this.bobPhase) * bob,
      -Math.abs(Math.cos(this.bobPhase)) * bob + this.recoil * 0.03,
      this.recoil * 0.05,
    );
    this.swayGroup.rotation.x = this.recoil * 0.05;
  }

  /** Follow the FINAL game-camera pose (call after the game camera update). */
  syncCamera(gameCamera: THREE.Camera): void {
    // ONE convention: the FP camera lives in WORLD space at the game
    // camera's world pose, with its own projection (never both a
    // camera-relative scene AND a world camera).
    gameCamera.updateMatrixWorld();
    gameCamera.matrixWorld.decompose(
      this.camera.position,
      this.camera.quaternion,
      this.camera.scale,
    );
    this.camera.scale.set(1, 1, 1);
    this.camera.updateMatrixWorld(true);
  }

  /**
   * FP pass: ONE depth clear, then arms + weapon render together into the
   * world's color buffer. Call AFTER the world render; world color is
   * preserved (autoClear off for this pass).
   */
  render(renderer: THREE.WebGLRenderer): void {
    if (!this.swayGroup.visible) return;
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth(); // the single depth clear of the FP pass
    renderer.render(this.scene, this.camera);
    renderer.autoClear = prevAutoClear;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    this.equipToken++;
    this.pendingAttach = null;
    this.detachWeapon();
    if (this.mixer && this.armsRoot) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.armsRoot);
    }
    // Shared FP arms template resources stay cached (never disposed here).
  }

  private transition(next: THREE.AnimationAction, fade: number): void {
    if (!this.mixer) return;
    if (this.current === next) return;
    next.reset().fadeIn(fade).play();
    if (this.current) this.current.fadeOut(fade);
    this.current = next;
  }
}
