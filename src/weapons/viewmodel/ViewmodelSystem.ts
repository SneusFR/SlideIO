import { ViewmodelSlideMotion } from "./ViewmodelSlideMotion";
import * as THREE from "three";
import { ViewmodelJumpMotion, type ViewmodelMotionInput } from "./ViewmodelJumpMotion";
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
    /** ADS trio — null for weapons without an aim pose (hammer). */
    aim: THREE.AnimationAction | null;
    raise: THREE.AnimationAction | null;
    lower: THREE.AnimationAction | null;
    inspect: THREE.AnimationAction | null;
    equip: THREE.AnimationAction | null;
    unequip: THREE.AnimationAction | null;
  } | null = null;
  /**
   * Priority ACTION clips of the equipped profile (attacks), one dedicated
   * AnimationAction per key — a LoopOnce and a LoopRepeat clip never share
   * an action.
   */
  private actionClips = new Map<string, THREE.AnimationAction>();
  /** Guards stale async equips (fast weapon switches / dispose). */
  private equipToken = 0;
  private disposed = false;

  // ---- Presentation state machine ----
  private state: "hold" | "run" | "raise" | "aim" | "lower" | "inspect" | "equip" | "action" = "hold";
  private current: THREE.AnimationAction | null = null;
  /** Called when the inspect clip ends OR is cancelled. */
  private onInspectDone: ((cancelled: boolean) => void) | null = null;
  /** Running priority action (attack) — see playAction(). */
  private activeAction: {
    key: string;
    action: THREE.AnimationAction;
    /** Invalidated (set to null) by cancelAction / a newer playAction. */
    onFinished: (() => void) | null;
    /** Fade used to go back to Hold/Run once the action ends. */
    exitFade: number;
  } | null = null;
  /** Equip transition end callback (real equip, not before every attack). */
  private onEquipDone: (() => void) | null = null;

  // ---- Cosmetic sway (never changes real fire direction) ----
  private bobPhase = 0;
  private bobAmount = 0;
  private recoil = 0;
  private readonly jumpMotion = new ViewmodelJumpMotion();
  private readonly slideMotion = new ViewmodelSlideMotion();

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
  async equip(
    profile: WeaponViewProfile,
    weaponRoot: THREE.Object3D,
    options: {
      /** Play the authored Equip clip first (REAL equip transition only). */
      playEquipClip?: boolean;
      /** Playback rate of the Equip clip (default 1 = authored speed). */
      equipTimeScale?: number;
      /** Fired when the Equip clip ends (or immediately without one). */
      onEquipped?: () => void;
    } = {},
  ): Promise<void> {
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
      const fp = profile.fpClips;
      this.actions = {
        hold: loop(fp.hold),
        run: loop(fp.run),
        aim: fp.aim ? loop(fp.aim) : null,
        raise: fp.raise ? once(fp.raise) : null,
        lower: fp.lower ? once(fp.lower) : null,
        inspect: fp.inspect ? once(fp.inspect) : null,
        equip: fp.equip ? once(fp.equip) : null,
        unequip: fp.unequip ? once(fp.unequip) : null,
      };
      this.actionClips.clear();
      if (profile.fpActions) {
        for (const [key, def] of Object.entries(profile.fpActions)) {
          this.actionClips.set(key, def.loop ? loop(def.clip) : once(def.clip));
        }
      }
      if (options.playEquipClip && this.actions.equip) {
        this.state = "equip";
        this.current = this.actions.equip;
        this.onEquipDone = options.onEquipped ?? null;
        // Sped-up equip (the clip is authored slower than the wanted
        // transition); the end test in update() reads the clip's local
        // time, so it stays exact at any rate.
        this.current.reset().setEffectiveTimeScale(Math.max(0.05, options.equipTimeScale ?? 1)).play();
      } else {
        this.state = "hold";
        this.current = this.actions.hold;
        this.onEquipDone = null;
        options.onEquipped?.();
        this.current.reset().play();
      }
      mixer.update(0);
    };

    if (this.weaponSocket && this.mixer) attach();
    else this.pendingAttach = attach;
  }

  /** True while the equipped profile has the ADS (aim) presentation. */
  get hasAim(): boolean {
    return !!this.actions?.aim;
  }

  /**
   * CURRENT weapon mount (Weapon_R × profile fpMount) of the equipped
   * weapon, or null. Read-only accessor for adapters that drive a
   * presentation object from the REAL animated socket (GoofyBasket held
   * ball) — never re-parent or re-scale it.
   */
  get mountObject(): THREE.Object3D | null {
    return this.mount;
  }

  /**
   * Camera-space presentation root (arms + weapon hang under it; bob /
   * recoil / jump / slide offsets move it as a whole). Cosmetic objects
   * that must move TOGETHER with the hands (the FP basketball) are
   * parented here — the authored FP curves are expressed in this space.
   */
  get swayRoot(): THREE.Object3D {
    return this.swayGroup;
  }

  /**
   * Phase clock of the arms presentation: the clip driving the arms right
   * now (name, local time, effective time scale, loop flag). The SAME clock
   * drives any cosmetic object synchronized with the arms (ball curves) —
   * there is never a second mixer advance.
   */
  presentationClock(): { clip: string | null; time: number; timeScale: number; loop: boolean; state: string } {
    const cur = this.current;
    if (!cur) return { clip: null, time: 0, timeScale: 1, loop: false, state: this.state };
    return {
      clip: cur.getClip().name,
      time: cur.time,
      timeScale: cur.getEffectiveTimeScale(),
      loop: cur.loop !== THREE.LoopOnce,
      state: this.state,
    };
  }

  /** True while a priority action (attack) is playing. */
  get acting(): boolean {
    return this.state === "action";
  }

  /** Key of the running priority action, or null. */
  get activeActionKey(): string | null {
    return this.activeAction?.key ?? null;
  }

  /**
   * PRIORITY ACTION API (attacks / smash phases). While an action runs,
   * Hold/Run/ADS never take the arms back per frame. A new action
   * replaces the running one immediately (its finish callback is
   * invalidated — a stale "Slam_Start ended → start Dive" can never fire
   * after the impact already started Slam_Land).
   *
   * @param key        profile fpActions key
   * @param startAt    entry time inside the clip (e.g. 0.10 s for Slam_Land)
   * @param fadeIn     blend from the current pose (0–0.03 s at a real impact)
   * @param onFinished for one-shot clips: fired when the clip ends (never
   *                   for loops; never after cancel / replacement)
   * Returns false when the key is unknown or no weapon is equipped.
   */
  playAction(
    key: string,
    options: { startAt?: number; fadeIn?: number; exitFade?: number; onFinished?: () => void } = {},
  ): boolean {
    const action = this.actionClips.get(key);
    if (!action || !this.mixer) return false;
    // A running inspection yields to any attack.
    if (this.state === "inspect") {
      const cb = this.onInspectDone;
      this.onInspectDone = null;
      cb?.(true);
    }
    if (this.activeAction) this.activeAction.onFinished = null; // invalidate
    const fadeIn = options.fadeIn ?? 0.1;
    action.reset();
    action.time = Math.max(0, options.startAt ?? 0);
    action.setEffectiveTimeScale(1).setEffectiveWeight(1);
    if (this.current && this.current !== action) {
      if (fadeIn > 0) this.current.fadeOut(fadeIn);
      else this.current.stop(); // hard cut at a real impact
    }
    if (fadeIn > 0) action.fadeIn(fadeIn);
    action.play();
    this.current = action;
    this.state = "action";
    this.activeAction = {
      key,
      action,
      onFinished: options.onFinished ?? null,
      exitFade: options.exitFade ?? 0.1,
    };
    return true;
  }

  /**
   * Cancel the running action (death / weapon switch / ragdoll / disable):
   * stale callbacks are dropped and the pose returns to Hold. `immediate`
   * = no fade (the caller detaches or hides right away).
   */
  cancelAction(immediate = false): void {
    if (!this.activeAction) return;
    this.activeAction.onFinished = null;
    this.activeAction = null;
    if (this.state === "action") {
      this.state = "hold";
      if (this.actions) this.transition(this.actions.hold, immediate ? 0 : 0.1);
    }
  }

  /**
   * Real UNEQUIP transition (0.30 s Unequip clip) then `onDone` — the
   * caller detaches / switches afterwards. Without an Unequip clip the
   * callback fires immediately. Never used between quick melee attacks.
   */
  playUnequip(onDone: () => void): boolean {
    const a = this.actions;
    if (!a?.unequip || !this.mixer) {
      onDone();
      return false;
    }
    if (this.activeAction) {
      this.activeAction.onFinished = null;
      this.activeAction = null;
    }
    if (this.onInspectDone) {
      const cb = this.onInspectDone;
      this.onInspectDone = null;
      cb(true);
    }
    this.transition(a.unequip, 0.06);
    this.state = "action"; // priority: nothing else takes the arms back
    this.activeAction = { key: "__unequip", action: a.unequip, onFinished: onDone, exitFade: 0 };
    return true;
  }

  /** Unequip: detach the weapon scene; the arms stay loaded and cached. */
  unequip(): void {
    this.equipToken++;
    this.pendingAttach = null;
    this.detachWeapon();
  }

  private detachWeapon(): void {
    this.jumpMotion.reset();
    this.slideMotion.reset();
    if (this.onInspectDone) {
      const cb = this.onInspectDone;
      this.onInspectDone = null;
      cb(true);
    }
    // Stale action / equip callbacks can never fire after a detach.
    if (this.activeAction) this.activeAction.onFinished = null;
    this.activeAction = null;
    this.onEquipDone = null;
    if (this.actions && this.mixer) {
      for (const a of Object.values(this.actions)) a?.stop();
      for (const a of this.actionClips.values()) a.stop();
      this.mixer.stopAllAction();
    }
    this.actionClips.clear();
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
    // An inspection never cancels an attack / equip transition in progress.
    if (this.state === "action" || this.state === "equip") return false;
    this.transition(this.actions.inspect, 0.08);
    this.state = "inspect";
    this.onInspectDone = onDone;
    return true;
  }

  /** Elapsed time of the running inspection clip (s), or -1. */
  get inspectTime(): number {
    return this.state === "inspect" && this.actions?.inspect ? this.actions.inspect.time : -1;
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

  /**
   * IMMEDIATE combat-pose restore (fire interrupting an inspection): stop
   * every arms action and pending fade, put Aim at full weight, align
   * `state`/`current` and evaluate the mixer + world matrices NOW — so the
   * caller can read weapon sockets this same frame without waiting for a
   * transition. The normal Hold → Raise → Aim path is untouched for every
   * other case. Fires the inspect callback (cancelled = true) if pending.
   */
  restoreCombatPoseNow(): void {
    const a = this.actions;
    if (!a || !this.mixer || !this.armsRoot) return;
    const cb = this.onInspectDone;
    this.onInspectDone = null;
    for (const action of Object.values(a)) action?.stop();
    // Weapons without an aim pose restore Hold instead.
    const combat = a.aim ?? a.hold;
    combat.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
    this.current = combat;
    this.state = a.aim ? "aim" : "hold";
    this.mixer.update(0);
    this.armsRoot.updateWorldMatrix(true, true);
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
    input: ViewmodelMotionInput & { running: boolean; speed: number; sliding?: boolean },
  ): void {
    const a = this.actions;
    if (a && this.mixer) {
      // ADS only exists when the profile ships the aim trio.
      const straight = input.straight && !!a.aim && !!a.raise && !!a.lower;
      // ---- State machine (authored Raise/Lower transitions for ADS) ----
      switch (this.state) {
        case "action": {
          // Priority action: nothing takes the arms back per frame. A
          // one-shot clip ending fires its callback ONCE, then the pose
          // returns to the REAL active locomotion state (hold / run).
          const act = this.activeAction;
          if (act) {
            const clip = act.action.getClip();
            const oneShot = act.action.loop === THREE.LoopOnce;
            if (oneShot && act.action.time >= clip.duration - 1e-4) {
              const cb = act.onFinished;
              this.activeAction = null;
              // The callback may CHAIN the next action (Charge_L1 → its
              // Charge_Hold loop, Slam_Start → Slam_Dive, Throw → Catch): it
              // runs FIRST so the chain blends directly from the finished
              // pose. Only when nothing was chained does the pose return to
              // the real locomotion state — a Hold fade-in/out in between
              // would pop the arms toward Hold for a few frames.
              cb?.();
              if (this.activeAction === null && this.state === "action") {
                this.state = input.running ? "run" : "hold";
                this.transition(input.running ? a.run : a.hold, act.exitFade);
              }
            }
          } else {
            this.state = "hold";
            this.transition(a.hold, 0.1);
          }
          break;
        }
        case "equip": {
          const eq = a.equip;
          if (!eq || eq.time >= eq.getClip().duration - 1e-4) {
            const cb = this.onEquipDone;
            this.onEquipDone = null;
            this.state = input.running ? "run" : "hold";
            this.transition(input.running ? a.run : a.hold, 0.1);
            cb?.();
          }
          break;
        }
        case "inspect": {
          const clip = a.inspect!.getClip();
          if (straight) {
            // CRITICAL interruption order (fire during inspection): cancel
            // arms inspect, restore the combat pose and evaluate the mixer
            // NOW — the caller reads TongueOrigin/sockets after update(),
            // never from the flipped inspection pose.
            this.cancelInspect();
            this.transition(a.raise!, 0.05);
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
          if (straight) {
            this.transition(a.raise!, 0.04);
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
          if (!straight) {
            this.transition(a.lower!, 0.03);
            this.state = "lower";
          } else if (a.raise!.time >= a.raise!.getClip().duration - 1e-4) {
            this.transition(a.aim!, 0.05);
            this.state = "aim";
          }
          break;
        case "aim":
          if (!straight) {
            this.transition(a.lower!, 0.03);
            this.state = "lower";
          }
          break;
        case "lower":
          if (straight) {
            this.transition(a.raise!, 0.03);
            this.state = "raise";
          } else if (a.lower!.time >= a.lower!.getClip().duration - 1e-4) {
            this.transition(input.running ? a.run : a.hold, 0.06);
            this.state = input.running ? "run" : "hold";
          }
          break;
      }
      // THE single per-frame advance of the shared arms mixer.
      this.mixer.update(dt);
    }

    // ---- Cosmetic sway: bob + recoil on the WHOLE group (arms + weapon
    // together — the grips never separate). Attack / inspect / equip
    // states suppress the run bob (the authored clip owns the motion).
    const bobTarget =
      input.running &&
      !input.straight &&
      this.state !== "inspect" &&
      this.state !== "action" &&
      this.state !== "equip"
        ? 1
        : 0;
    this.bobAmount += (bobTarget - this.bobAmount) * Math.min(1, dt * 8);
    this.bobPhase += dt * Math.min(input.speed, 14) * 1.35;
    this.recoil *= Math.exp(-10 * dt);
    const bob = this.bobAmount * 0.006;
    this.jumpMotion.update(dt, input);
    this.slideMotion.update(dt, !!input.sliding, input.speed, input.straight);
    this.swayGroup.position.set(
      Math.sin(this.bobPhase) * bob,
      -Math.abs(Math.cos(this.bobPhase)) * bob + this.recoil * 0.03 + this.jumpMotion.offsetY + this.slideMotion.offsetY,
      this.recoil * 0.05,
    );
    this.swayGroup.rotation.x = this.recoil * 0.05;
  }

  /**
   * WORLD point where a FP-rendered socket APPEARS on screen, expressed for
   * the GAME camera's projection. The FP pass draws arms + weapon with its
   * own 65° projection while world-scene effects (HexSniper tether…) are
   * drawn with the game camera (92° dynamic, ×4 ADS): the same 3D point
   * lands on different pixels. This keeps the view-space depth and rescales
   * x/y by the ratio of the two projection matrices, so the effect starts
   * exactly under the rendered socket. The FP camera is re-synced first
   * (the weapon update runs before the frame's FP sync — no one-frame lag).
   */
  socketWorldForGameCamera(
    socket: THREE.Object3D,
    gameCamera: THREE.Camera,
    out: THREE.Vector3,
  ): THREE.Vector3 {
    this.syncCamera(gameCamera); // also refreshes every FP child matrixWorld
    socket.getWorldPosition(out);
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    out.applyMatrix4(this.camera.matrixWorldInverse); // FP view space
    const fp = this.camera.projectionMatrix.elements;
    const gm = gameCamera.projectionMatrix.elements;
    // Perspective: e[0] = 1/(tan(fov/2)·aspect), e[5] = 1/tan(fov/2).
    if (gm[0] !== 0 && gm[5] !== 0) {
      out.x *= fp[0] / gm[0];
      out.y *= fp[5] / gm[5];
    }
    return out.applyMatrix4(gameCamera.matrixWorld); // back to WORLD
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
    if (fade <= 0) {
      // Hard cut (no zero-length fade interpolant): stop the outgoing
      // action, full weight on the incoming one right away.
      this.current?.stop();
      next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
    } else {
      next.reset().fadeIn(fade).play();
      if (this.current) this.current.fadeOut(fade);
    }
    this.current = next;
  }
}
