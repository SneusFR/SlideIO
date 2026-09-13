import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ViewmodelSystem } from "./viewmodel/ViewmodelSystem";
import { loadFPPoseClips } from "./viewmodel/FPArmsRig";
import { BrickMaulProfile, BRICKMAUL_EYES, BRICKMAUL_TIMING } from "./brickmaul/BrickMaulProfile";
import { loadBrickMaulGltf, instantiateBrickMaul } from "./brickmaul/BrickMaulModel";
import { BrickMaulEyes } from "./brickmaul/BrickMaulEyes";

/** Per-frame locomotion snapshot handed by the Game (cosmetic only). */
export interface HammerViewmodelMotion {
  running: boolean;
  speed: number;
  grounded: boolean;
  verticalVelocity: number;
  jumpSequence: number;
  sliding: boolean;
}

/**
 * BRICK MAUL first-person adapter (r5) — a thin bridge between the hammer
 * gameplay (HammerWeapon / Game) and the COMMON ViewmodelSystem (shared
 * Potato arms, dedicated FP scene, single arms mixer).
 *
 * The weapon scene is mounted under the arms' Weapon_R socket through the
 * authored FP mount matrix (applied once, scale included). Every pose is an
 * authored clip of Potato_FP_BrickMaul.glb: Hold / Run / Equip / Unequip /
 * Inspect and the priority actions Whirlwind / Slam_Start / Slam_Dive /
 * Slam_Land. No camera-attached model, no procedural rotation, no forced
 * transparency or renderOrder: opaque arms + weapon keep real depth.
 *
 * OWNERSHIP: the Game decides WHEN the maul is the active FP presentation
 * (equip / hide) — an action ending returns to Hold/Run while the maul is
 * attached; it never hides itself from inside a clip.
 */
export class HammerViewmodel {
  /** Resolves once weapon + pose libraries are loaded (or failed) — used by
   *  the Game's GPU warm-up. Never rejects, never blocks forever. */
  readonly ready: Promise<void>;

  private weapon: THREE.Object3D | null = null;
  private eyes: BrickMaulEyes | null = null;
  /** True while the maul is attached to the shared arms (our presentation). */
  private attached = false;
  /** Guards stale async equips (fast slot switches while loading). */
  private equipToken = 0;
  /** Slam phase bookkeeping (real ground contact interrupts everything). */
  private slamPhase: "none" | "start" | "dive" | "land" = "none";
  private inspecting = false;

  constructor(private readonly viewmodel: ViewmodelSystem) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      const [gltf]: [GLTF, THREE.AnimationClip[]] = await Promise.all([
        loadBrickMaulGltf(),
        loadFPPoseClips(BrickMaulProfile.fpPosesUrl), // pre-cached for equip()
      ]);
      // One rendered FP instance (skeleton clone — geometry/materials
      // shared). Created once; equip/unequip only attach/detach it.
      this.weapon = instantiateBrickMaul(gltf);
      this.prepareViewmodelMaterials(this.weapon);
      this.eyes = new BrickMaulEyes(this.weapon, BRICKMAUL_EYES);
    } catch (err) {
      console.error("BrickMaul: failed to load the FP weapon / poses", err);
    }
  }

  /**
   * Opaque FP surfaces keep REAL depthTest/depthWrite inside the FP pass
   * (its single depth clear owns the depth story). Materials are cloned
   * per unique material so the shared TP instances keep the originals.
   */
  private prepareViewmodelMaterials(root: THREE.Object3D): void {
    const cloned = new Map<THREE.Material, THREE.Material>();
    const vmClone = (mat: THREE.Material): THREE.Material => {
      let copy = cloned.get(mat);
      if (!copy) {
        copy = mat.clone();
        copy.depthTest = true;
        copy.depthWrite = true;
        cloned.set(mat, copy);
      }
      return copy;
    };
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(vmClone)
        : vmClone(mesh.material);
    });
  }

  /** True while the maul is the attached FP presentation. */
  get visible(): boolean {
    return this.attached && this.viewmodel.visible;
  }

  /** True once the assets are usable (a failed load keeps this false). */
  get loaded(): boolean {
    return this.weapon !== null;
  }

  /** True while an attack / smash phase clip has the arms. */
  get acting(): boolean {
    return this.attached && this.viewmodel.acting;
  }

  /** True while the FP inspection plays. */
  get isInspecting(): boolean {
    return this.inspecting;
  }

  // ------------------------------------------------------------------
  // Equip / unequip — REAL presentation changes decided by the Game
  // ------------------------------------------------------------------

  /**
   * Attach the maul to the shared arms and make the FP pass visible.
   * `withClip` plays the Equip transition (slot switch; 0.65 s clip at
   * BRICKMAUL_TIMING.equipTimeScale ≈ 0.36 s effective); a melee
   * override from the primary skips it so the attack starts on its
   * gameplay event, never delayed.
   */
  equip(withClip: boolean, onEquipped?: () => void): Promise<void> {
    const token = ++this.equipToken;
    const run = async () => {
      await this.ready;
      if (token !== this.equipToken || !this.weapon) return;
      this.attached = true;
      this.slamPhase = "none";
      this.inspecting = false;
      this.eyes?.reset();
      await this.viewmodel.equip(BrickMaulProfile, this.weapon, {
        playEquipClip: withClip,
        equipTimeScale: BRICKMAUL_TIMING.equipTimeScale,
        onEquipped,
      });
      if (token !== this.equipToken) return;
      this.viewmodel.setVisible(true);
    };
    return run();
  }

  /**
   * Real UNEQUIP transition (0.30 s), then `onDone` — the Game detaches
   * and restores the primary presentation from there.
   */
  unequip(onDone: () => void): void {
    if (!this.attached) {
      onDone();
      return;
    }
    this.slamPhase = "none";
    this.inspecting = false;
    this.viewmodel.playUnequip(onDone);
  }

  /**
   * Detach immediately (death / ragdoll / weapon switch / end of a melee
   * override). Cancels actions, fades and stale callbacks. The shared arms
   * stay cached; the Game decides what presentation comes next.
   */
  hide(): void {
    this.equipToken++; // a pending equip() resolves to nothing
    this.slamPhase = "none";
    this.inspecting = false;
    this.pendingSwing = false; // deferred requests die with the presentation
    this.pendingSlam = false;
    if (!this.attached) return;
    this.attached = false;
    this.viewmodel.cancelAction(true);
    this.viewmodel.cancelInspect();
    this.viewmodel.unequip();
    this.viewmodel.setVisible(false);
    this.eyes?.reset();
  }

  // ------------------------------------------------------------------
  // Attack actions — start on their GAMEPLAY event (no Equip delay)
  // ------------------------------------------------------------------

  /**
   * Whirlwind: 1.35 s — the FP clip holds the maul out while the render
   * camera performs the three turns (BrickMaulWhirlwindCamera). Returns
   * true when the clip really started. When the maul is not attached yet
   * (attack launched from the primary slot: equip() still awaits the cached
   * assets), the request is REMEMBERED and started once, at the attack's
   * already-elapsed time, by the next update() — see resumePendingSwing.
   */
  startSwing(): boolean {
    this.inspecting = false;
    this.slamPhase = "none";
    if (!this.attached || !this.viewmodel.playAction("whirlwind", { fadeIn: 0.08, exitFade: 0.1 })) {
      this.pendingSwing = true;
      return false;
    }
    this.pendingSwing = false;
    this.eyes?.kick(1);
    return true;
  }

  /**
   * Deferred whirlwind entry (clips attached after the attack started).
   * `elapsed` = the attack clock as ALREADY advanced this frame; `dt` = the
   * advance the mixer is about to apply — the clip enters at
   * max(0, elapsed - dt) without fade so the single mixer.update(dt) brings
   * the pose exactly to `elapsed`. Invalidated by hide(), cancelActions(),
   * an ended attack or a stale equip token.
   */
  private pendingSwing = false;
  /** Slam anticipation requested before the clips were attached. */
  private pendingSlam = false;

  /**
   * Call ONCE per frame from the owner BEFORE update(): `whirlwindElapsed`
   * = HammerWeapon.whirlwindElapsedSeconds (already advanced this frame,
   * -1 when no whirlwind runs), `slamDiving` = the slam is still waiting
   * for its impact, `dt` = the mixer advance update() will apply.
   */
  resumePending(whirlwindElapsed: number, slamDiving: boolean, dt: number): void {
    if (this.pendingSwing) {
      if (whirlwindElapsed < 0) {
        this.pendingSwing = false; // the attack ended while loading: never replay
      } else if (this.attached) {
        const startAt = Math.max(0, whirlwindElapsed - dt);
        if (this.viewmodel.playAction("whirlwind", { startAt, fadeIn: 0, exitFade: 0.1 })) {
          this.pendingSwing = false;
          this.eyes?.kick(1);
        }
      }
    }
    if (this.pendingSlam) {
      if (!slamDiving) this.pendingSlam = false; // landed / reset while loading
      else if (this.attached) {
        this.pendingSlam = false;
        this.startSlam();
      }
    }
  }

  /**
   * Smash anticipation: Slam_Start (0.20 s) then Slam_Dive LOOP while the
   * physical descent lasts. The real contact (startSlamImpact) interrupts
   * either phase immediately and invalidates the Start→Dive callback.
   */
  startSlam(): void {
    this.inspecting = false;
    if (!this.attached) {
      this.pendingSlam = true; // started once the clips are attached
      return;
    }
    this.pendingSlam = false;
    this.slamPhase = "start";
    this.viewmodel.playAction("slamStart", {
      fadeIn: 0.08,
      onFinished: () => {
        // The system nulls this callback when the impact replaces the
        // action — this branch only runs while still descending.
        if (this.slamPhase !== "start") return;
        this.slamPhase = "dive";
        this.viewmodel.playAction("slamDive", { fadeIn: 0.06 });
      },
    });
    this.eyes?.kick(1);
  }

  /** REAL ground contact: enter Slam_Land at 0.10 s (0.72 s of recovery). */
  startSlamImpact(): void {
    this.pendingSlam = false; // a very short fall: the impact wins outright
    if (!this.attached) return;
    this.slamPhase = "land";
    this.viewmodel.playAction("slamLand", {
      startAt: BRICKMAUL_TIMING.slam.enterLandAt,
      fadeIn: 0.02, // never a floating strike
      exitFade: 0.1,
      onFinished: () => {
        if (this.slamPhase === "land") this.slamPhase = "none";
      },
    });
    this.eyes?.kick(1.5);
  }

  /** Death / switch / ragdoll: drop any action and return to Hold. */
  cancelActions(): void {
    this.slamPhase = "none";
    this.pendingSwing = false;
    this.pendingSlam = false;
    if (this.attached) this.viewmodel.cancelAction();
  }

  // ------------------------------------------------------------------
  // Inspection (F) — visual only, refused during an attack
  // ------------------------------------------------------------------

  /** Start FP_BrickMaul_Inspect (3.60 s). Returns false when refused. */
  startInspect(onDone?: (cancelled: boolean) => void): boolean {
    if (!this.attached || this.viewmodel.acting || this.inspecting) return false;
    const started = this.viewmodel.startInspect((cancelled) => {
      this.inspecting = false;
      onDone?.(cancelled);
    });
    this.inspecting = started;
    return started;
  }

  cancelInspect(): void {
    if (!this.inspecting) return;
    this.inspecting = false;
    this.viewmodel.cancelInspect();
  }

  /** Elapsed inspection time (s) for late-join replication, or -1. */
  get inspectTime(): number {
    return this.inspecting ? this.viewmodel.inspectTime : -1;
  }

  // ------------------------------------------------------------------
  // Per-frame
  // ------------------------------------------------------------------

  /**
   * Advance the shared arms mixer ONCE (the Game guarantees the maul is
   * the only owner calling it this frame), then the pupils AFTER the
   * mixer + world matrices.
   */
  update(dt: number, motion: HammerViewmodelMotion): void {
    if (!this.attached) return;
    this.viewmodel.update(dt, {
      straight: false, // no ADS on the maul
      running: motion.grounded && !motion.sliding && motion.speed > 1.5,
      sliding: motion.sliding,
      speed: motion.speed,
      grounded: motion.grounded,
      verticalVelocity: motion.verticalVelocity,
      jumpSequence: motion.jumpSequence,
    });
    if (this.eyes && this.weapon) {
      this.weapon.updateWorldMatrix(true, true);
      this.eyes.update(dt);
    }
  }
}
