import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ViewmodelSystem } from "../viewmodel/ViewmodelSystem";
import { loadFPPoseClips } from "../viewmodel/FPArmsRig";
import {
  GoofyBasketProfile,
  GOOFY_BALL,
  GOOFY_TIMING,
  goofyClipName,
  type GoofyActionKey,
  type GoofyClipKind,
} from "./GoofyBasketProfile";
import {
  createGoofyBasketPresentation,
  instantiateGoofyBasket,
  loadGoofyBasketGltf,
} from "./GoofyBasketModel";
import { GoofyBasketBallDriver, type BallClipInfo } from "./GoofyBasketBallDriver";
import type { BasketSample } from "./GoofyBasketPresentation";
import { GoofyBasketSkinSlot } from "./GoofyBasketSkinRuntime";

/** Per-frame locomotion snapshot handed by the Game (cosmetic only). */
export interface GoofyViewmodelMotion {
  speed: number;
  grounded: boolean;
  verticalVelocity: number;
  jumpSequence: number;
  sliding: boolean;
  dashing: boolean;
  /** World Y of the floor under the player when grounded, else null. */
  floorWorldY: number | null;
}

/** Presentation phase requested by the weapon controller. */
export type GoofyPhase =
  | { kind: "idle" }
  | { kind: "charge"; level: 1 | 2 | 3 }
  | { kind: "throw"; level: 1 | 2 | 3; startAt: number }
  | { kind: "catch"; startAt: number };

/** FP clip name → ball curve of the same name (identical naming in the JSON). */
const FP_KINDS: readonly GoofyClipKind[] = [
  "Hold", "Run", "Equip", "Unequip", "Charge_L1", "Charge_L2", "Charge_L3",
  "Charge_Hold_L1", "Charge_Hold_L2", "Charge_Hold_L3", "Throw_L1", "Throw_L2", "Throw_L3",
  "Catch", "Dribble_Start", "Dribble", "Dribble_Catch", "Inspect",
];

/**
 * GOOFY BASKET first-person adapter: bridges the weapon gameplay
 * (GoofyBasketWeapon / Game) and the COMMON ViewmodelSystem (shared Potato
 * arms, single arms mixer) + drives the ONE cosmetic FP ball.
 *
 * The ball is NOT mounted under Weapon_R: it lives under the viewmodel's
 * sway root (camera space, the space of the authored FP curves) so bob /
 * recoil / jump / slide offsets move hands and ball TOGETHER. While the
 * authored sample says `attached`, the ball takes the REAL animated grip
 * (Weapon_R × fpMount converted to that space — full matrix, scale
 * included); free portions take the curve (× 0.88); interruptions gather.
 *
 * Phase requests carry a generation: a phase asked during the async equip
 * is applied once the clips are attached, resumed at its elapsed time, and
 * a stale request never replays a finished phase.
 */
export class GoofyBasketViewmodel {
  readonly ready: Promise<void>;
  /** Cosmetic notifications (audio): dribble contact / release / catch. */
  onBallEvent: ((sample: Readonly<BasketSample>, kind: GoofyClipKind | null) => void) | null = null;

  private ball: THREE.Object3D | null = null;
  private driver: GoofyBasketBallDriver | null = null;
  private attached = false;
  private equipToken = 0;
  private inspecting = false;
  /** Current phase + monotonic generation (stale async callbacks die). */
  private phase: GoofyPhase = { kind: "idle" };
  private phaseGen = 0;
  private phaseClock = 0;
  /** Dribble presentation state (grounded locomotion only). */
  private dribble: "none" | "start" | "run" | "catch" = "none";
  private readonly curveByClip = new Map<string, BallClipInfo>();
  /** Cosmetic skin of the ONE FP ball (high quality — applied on the instance). */
  private readonly skin = new GoofyBasketSkinSlot({ context: "fp", quality: "high" });
  /** Cosmetic clock for the skin effects (owner loop — no extra RAF). */
  private skinClock = 0;

  // Scratch
  private readonly gripM = new THREE.Matrix4();
  private readonly invSway = new THREE.Matrix4();
  private readonly parentWorld = new THREE.Matrix4();

  constructor(private readonly viewmodel: ViewmodelSystem) {
    for (const kind of FP_KINDS) {
      const name = goofyClipName("FP", kind);
      this.curveByClip.set(name, { curve: name, kind, timeScale: 1 });
    }
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      const [gltf, , curves]: [GLTF, THREE.AnimationClip[], Awaited<ReturnType<typeof createGoofyBasketPresentation>>] =
        await Promise.all([loadGoofyBasketGltf(), loadFPPoseClips(GoofyBasketProfile.fpPosesUrl), createGoofyBasketPresentation()]);
      // ONE FP ball instance under the sway root (camera space). Free scale
      // 0.88 is applied by the driver; the grip uses the full mount matrix.
      this.ball = instantiateGoofyBasket(gltf, GOOFY_BALL.freePresentationScale);
      this.prepareViewmodelMaterials(this.ball);
      this.ball.visible = false;
      this.viewmodel.swayRoot.add(this.ball);
      // Skin on the INSTANCE (never the shared template): the pack clones
      // the per-instance materials again and shares only its textures.
      this.skin.setTarget(this.ball);
      this.driver = new GoofyBasketBallDriver(
        "FP",
        curves.presentation,
        curves.library,
        this.ball,
        GOOFY_BALL.freePresentationScale,
        GOOFY_BALL.sourceRadiusMeters * GOOFY_BALL.freePresentationScale,
        (clip) => this.curveByClip.get(clip) ?? { curve: null, kind: null, timeScale: 1 },
      );
      this.driver.onStateChange = (sample, kind) => this.onBallEvent?.(sample, kind);
    } catch (err) {
      console.error("GoofyBasket: failed to load the FP ball / poses", err);
    }
  }

  /** Opaque FP surfaces keep real depth inside the FP pass (materials cloned per instance). */
  private prepareViewmodelMaterials(root: THREE.Object3D): void {
    const cloned = new Map<THREE.Material, THREE.Material>();
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const apply = (mat: THREE.Material): THREE.Material => {
        let copy = cloned.get(mat);
        if (!copy) {
          copy = mat.clone();
          copy.depthTest = true;
          copy.depthWrite = !copy.transparent;
          cloned.set(mat, copy);
        }
        return copy;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(apply) : apply(mesh.material);
    });
  }

  get loaded(): boolean {
    return this.ball !== null;
  }

  get isAttached(): boolean {
    return this.attached;
  }

  get isInspecting(): boolean {
    return this.inspecting;
  }

  /** True while the ball is visually away from the hand (dribble bounce / gather). */
  get ballFree(): boolean {
    return this.driver?.isFree ?? false;
  }

  /** Cosmetic skin of the FP ball (validated id; "default" = base ball). */
  setSkin(skinId: string): void {
    this.skin.setSkin(skinId);
  }

  get skinId(): string {
    return this.skin.skinId;
  }

  /**
   * Cosmetic per-frame pass for the skin effects — called by the weapon
   * controller EVERY frame (even while another owner holds the arms) so a
   * hidden ball never keeps a ghost aura: `visible` follows the ball flag
   * exactly (hidden after the release, during the Catch descent, etc.).
   */
  updateSkin(dt: number, charge01: number): void {
    this.skinClock += dt;
    this.skin.update(this.skinClock, {
      charge: charge01,
      visible: this.attached && this.ball !== null && this.ball.visible && this.viewmodel.visible,
      effectsEnabled: true,
    });
  }

  /** Full teardown (session end): restore the ball materials before dropping it. */
  dispose(): void {
    this.skin.dispose();
    this.ball?.removeFromParent();
    this.ball = null;
    this.driver = null;
  }


  // ------------------------------------------------------------------
  // Equip / hide (ownership decided by the Game)
  // ------------------------------------------------------------------

  /**
   * Attach the clips to the shared arms. The "weapon root" mounted under
   * Weapon_R is an EMPTY anchor: it materializes the authored mount
   * (Weapon_R × fpMount) the ball follows while held; the ball itself
   * stays under the sway root. `withClip` plays the real Equip transition.
   */
  async equip(withClip: boolean): Promise<void> {
    const token = ++this.equipToken;
    await this.ready;
    if (token !== this.equipToken || !this.ball) return;
    this.inspecting = false;
    this.dribble = "none";
    this.driver?.reset();
    const anchor = new THREE.Group();
    anchor.name = "GoofyBasketGripAnchor";
    await this.viewmodel.equip(GoofyBasketProfile, anchor, { playEquipClip: withClip });
    if (token !== this.equipToken) return;
    this.attached = true;
    this.viewmodel.setVisible(true);
    // A phase requested during the async equip resumes at its elapsed time.
    this.applyPhase(this.phase, this.phaseClock);
  }

  /** Detach (weapon switch / death / mole strike): ball hidden, callbacks dropped. */
  hide(): void {
    this.equipToken++;
    this.phaseGen++;
    this.attached = false;
    this.inspecting = false;
    this.dribble = "none";
    this.phase = { kind: "idle" };
    this.phaseClock = 0;
    this.driver?.reset();
    if (this.ball) this.ball.visible = false;
    this.viewmodel.unequip();
    this.viewmodel.setVisible(false);
  }

  /** Real Unequip transition (0.30 s) then `onDone` — the ball stays in hand meanwhile. */
  playUnequip(onDone: () => void): void {
    this.cancelPhase();
    if (!this.attached) {
      onDone();
      return;
    }
    this.viewmodel.playUnequip(onDone);
  }

  // ------------------------------------------------------------------
  // Phases (owned by the weapon controller)
  // ------------------------------------------------------------------

  /**
   * Request a presentation phase. Applied now when attached, otherwise
   * once the clips are attached (resumed at the elapsed time). A new phase
   * invalidates the callbacks of the previous one.
   */
  setPhase(phase: GoofyPhase): void {
    this.phase = phase;
    this.phaseClock = phase.kind === "throw" || phase.kind === "catch" ? phase.startAt : 0;
    this.phaseGen++;
    if (this.attached) this.applyPhase(phase, this.phaseClock);
  }

  /** Back to the locomotion presentation (charge cancelled / sequence done). */
  cancelPhase(): void {
    if (this.phase.kind === "idle") return;
    this.phase = { kind: "idle" };
    this.phaseClock = 0;
    this.phaseGen++;
    if (this.attached && this.viewmodel.acting) this.viewmodel.cancelAction();
  }

  get currentPhase(): GoofyPhase {
    return this.phase;
  }

  private applyPhase(phase: GoofyPhase, elapsed: number): void {
    const gen = this.phaseGen;
    switch (phase.kind) {
      case "idle":
        if (this.viewmodel.acting && this.viewmodel.activeActionKey !== "__unequip") this.viewmodel.cancelAction();
        return;
      case "charge": {
        // Transition clip of the level, then its authored loop. No mandatory
        // pause: the controller may request the next level / the throw at
        // any time (the transition simply blends from the current pose).
        this.inspecting = false;
        this.viewmodel.cancelInspect();
        const level = phase.level;
        const transition = `Charge_L${level}` as GoofyActionKey;
        const loop = `Charge_Hold_L${level}` as GoofyActionKey;
        const duration = GOOFY_TIMING.charge[level - 1];
        if (elapsed >= duration) {
          this.viewmodel.playAction(loop, { fadeIn: 0.08 });
        } else {
          this.viewmodel.playAction(transition, {
            startAt: elapsed,
            fadeIn: level === 1 ? 0.08 : 0.05,
            onFinished: () => {
              if (gen !== this.phaseGen) return; // stale (level changed / thrown)
              this.viewmodel.playAction(loop, { fadeIn: 0.06 });
            },
          });
        }
        return;
      }
      case "throw": {
        this.inspecting = false;
        this.viewmodel.cancelInspect();
        const def = GOOFY_TIMING.throws[phase.level - 1];
        if (elapsed >= def.duration) {
          // Late arrival past the whole Throw: straight into the Catch.
          this.phase = { kind: "catch", startAt: elapsed - def.duration };
          this.applyPhase(this.phase, elapsed - def.duration);
          return;
        }
        this.viewmodel.playAction(def.kind, {
          startAt: elapsed,
          fadeIn: 0.06,
          exitFade: 0.05,
          onFinished: () => {
            if (gen !== this.phaseGen) return;
            // Recovery done → a NEW ball comes from above (same cosmetic instance).
            this.phase = { kind: "catch", startAt: 0 };
            this.phaseClock = 0;
            this.applyPhase(this.phase, 0);
          },
        });
        return;
      }
      case "catch": {
        if (elapsed >= GOOFY_TIMING.catch) {
          this.phase = { kind: "idle" };
          this.applyPhase(this.phase, 0);
          return;
        }
        this.viewmodel.playAction("Catch", {
          startAt: elapsed,
          fadeIn: 0.03,
          exitFade: 0.1,
          onFinished: () => {
            if (gen !== this.phaseGen) return;
            this.phase = { kind: "idle" };
            this.phaseClock = 0;
          },
        });
        return;
      }
    }
  }

  // ------------------------------------------------------------------
  // Inspection (F) — visual only, refused during a phase
  // ------------------------------------------------------------------

  /** FP_GoofyBasket_Inspect (2.74 s, three dribbles). Returns false when refused. */
  startInspect(onDone?: (cancelled: boolean) => void): boolean {
    if (!this.attached || this.viewmodel.acting || this.inspecting || this.phase.kind !== "idle") return false;
    const started = this.viewmodel.startInspect((cancelled) => {
      this.inspecting = false;
      onDone?.(cancelled);
    });
    this.inspecting = started;
    if (started) this.dribble = "none"; // the inspection owns the ball meanwhile
    return started;
  }

  cancelInspect(): void {
    if (!this.inspecting) return;
    this.inspecting = false;
    this.viewmodel.cancelInspect();
  }

  get inspectTime(): number {
    return this.inspecting ? this.viewmodel.inspectTime : -1;
  }

  /**
   * Interrupt a free ball NOW (charge / throw entry while dribbling): the
   * ball gathers toward the moving grip over `GOOFY_TIMING.gather`.
   */
  gatherBall(): void {
    this.driver?.gatherNow(GOOFY_TIMING.gather);
  }


  // ------------------------------------------------------------------
  // Per-frame (the Game guarantees we are the only owner this frame)
  // ------------------------------------------------------------------

  /**
   * Advance the shared arms mixer ONCE, then drive the ball from the same
   * clock. Dribble presentation: grounded ordinary locomotion enters by
   * Dribble_Start then Run (its dribble); stopping goes through
   * Dribble_Catch; jump / slide / dash / phases interrupt immediately (the
   * driver gathers the displayed ball toward the hand).
   */
  update(dt: number, motion: GoofyViewmodelMotion): void {
    if (!this.attached || !this.driver) return;
    const running = motion.grounded && !motion.sliding && !motion.dashing && motion.speed > 1.5;
    const disturbed = !motion.grounded || motion.sliding || motion.dashing;
    if (this.phase.kind !== "idle") this.phaseClock += dt;

    // ---- Dribble entry / exit (only while no phase / inspection owns the arms) ----
    // NOTE: the dribble's OWN actions (Dribble_Start / Dribble_Catch) make
    // the system "acting" — they must never count as an interruption.
    const activeKey = this.viewmodel.activeActionKey;
    const dribbleActing = activeKey === "Dribble_Start" || activeKey === "Dribble_Catch";
    const free = this.phase.kind === "idle" && !this.inspecting && (!this.viewmodel.acting || dribbleActing);
    if (free && !disturbed) {
      if (running && this.dribble === "none") {
        this.dribble = "start";
        this.viewmodel.playAction("Dribble_Start", {
          fadeIn: 0.08,
          exitFade: 0.06,
          onFinished: () => {
            if (this.dribble === "start") this.dribble = "run"; // Run takes over
          },
        });
      } else if (!running && this.dribble === "run") {
        // Ordinary stop: the authored regular exit (0.26 s) toward the hold.
        this.dribble = "catch";
        this.viewmodel.playAction("Dribble_Catch", {
          fadeIn: 0.06,
          exitFade: 0.08,
          onFinished: () => {
            if (this.dribble === "catch") this.dribble = "none";
          },
        });
      }
    } else if (this.dribble !== "none" && (disturbed || !free)) {
      // Jump / slide / dash / phase: the dribble stops at the REAL state
      // change; a running Dribble_Start / Catch action is cancelled and the
      // ball gathers from its displayed pose (never a teleport).
      if (this.viewmodel.acting && this.phase.kind === "idle" && !this.inspecting) this.viewmodel.cancelAction();
      this.dribble = "none";
      this.driver.gatherNow(GOOFY_TIMING.gather);
    } else if (this.dribble === "run" && !this.viewmodel.acting && this.viewmodel.presentationClock().state !== "run") {
      this.dribble = "none"; // Run left for another reason (hold after a fade)
    }

    this.viewmodel.update(dt, {
      straight: false,
      running,
      sliding: motion.sliding,
      speed: motion.speed,
      grounded: motion.grounded,
      verticalVelocity: motion.verticalVelocity,
      jumpSequence: motion.jumpSequence,
    });

    // ---- Ball from the same clock, after the mixer + world matrices ----
    const sway = this.viewmodel.swayRoot;
    sway.updateWorldMatrix(true, true);
    const mount = this.viewmodel.mountObject;
    let grip: THREE.Matrix4 | null = null;
    if (mount) {
      this.invSway.copy(sway.matrixWorld).invert();
      this.gripM.multiplyMatrices(this.invSway, mount.matrixWorld); // grip in sway (camera) space
      grip = this.gripM;
    }
    const clock = this.viewmodel.presentationClock();
    this.parentWorld.copy(sway.matrixWorld);
    this.driver.update(dt, {
      clip: clock.clip,
      time: clock.time,
      grip,
      parentToWorld: this.parentWorld,
      // FP curves are camera-space: the real floor cannot be matched to the
      // authored camera floor when the view pitches — the ground fit only
      // applies to the TP presentation. Airborne / slide states gather.
      floorWorldY: null,
    });
  }
}
