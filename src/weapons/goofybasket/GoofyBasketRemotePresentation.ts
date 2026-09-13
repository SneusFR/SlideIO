import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createWeaponMount } from "../profiles/WeaponProfile";
import { GoofyBasketProfile, GOOFY_BALL, GOOFY_TIMING, goofyClipName, type GoofyClipKind } from "./GoofyBasketProfile";
import { instantiateGoofyBasket, createGoofyBasketPresentation } from "./GoofyBasketModel";
import { GoofyBasketBallDriver, type BallClipInfo } from "./GoofyBasketBallDriver";

/** Locomotion run clip the TP Run layer is retimed to (see PotatoCharacter). */
const RUN_GOOFY_DURATION = 0.8;

/** All TP clip kinds mapped to curves; composite / layer names resolve to their kind. */
const TP_KINDS: readonly GoofyClipKind[] = [
  "Hold", "Run", "Equip", "Unequip", "Charge_L1", "Charge_L2", "Charge_L3",
  "Charge_Hold_L1", "Charge_Hold_L2", "Charge_Hold_L3", "Throw_L1", "Throw_L2", "Throw_L3",
  "Catch", "Dribble_Start", "Dribble", "Dribble_Catch", "Inspect",
];

/**
 * THIRD-PERSON GoofyBasket presentation of ONE remote avatar (or bot):
 *   - an EMPTY mount anchor under Weapon_R (Weapon_R × tpMount — the real
 *     animated grip, ball scale included);
 *   - ONE cosmetic ball under the NORMALIZED glTF scene (the child of the
 *     wrapper `model`, carrying rotation Y = π and scale 2.693…) — the
 *     space of the authored TP curves; free portions × 0.88;
 *   - a ball driver fed by the avatar animation controller's clock.
 * Pure visuals: no physics, no damage. Flying projectiles are separate
 * world instances owned by the remote VFX controller.
 */
export class GoofyBasketRemotePresentation {
  readonly mount: THREE.Group;
  private ball: THREE.Object3D | null = null;
  private driver: GoofyBasketBallDriver | null = null;
  private readonly curveByClip = new Map<string, BallClipInfo>();
  private disposed = false;
  private readonly invParent = new THREE.Matrix4();
  private readonly gripM = new THREE.Matrix4();
  private readonly parentWorld = new THREE.Matrix4();
  private readonly floorProbe = new THREE.Vector3();

  constructor(
    gltf: GLTF,
    private readonly socket: THREE.Object3D,
    /** The normalized glTF scene (NOT the unscaled wrapper). */
    private readonly gltfScene: THREE.Object3D,
  ) {
    this.mount = createWeaponMount("GoofyBasketMount", GoofyBasketProfile.tpMount);
    socket.add(this.mount);
    for (const kind of TP_KINDS) {
      const name = goofyClipName("TP", kind);
      const info: BallClipInfo = { curve: name, kind, timeScale: 1 };
      this.curveByClip.set(name, info);
      this.curveByClip.set(`${name}_Layer`, info);
    }
    // Locomotion composites (PotatoCharacter): Run_Goofy body + retimed
    // dribble layer → the curve runs at the composite's rate; jump / dash /
    // slide composites hold the grip (no curve → ball in hand).
    this.curveByClip.set("Run_Goofy_GoofyBasket", {
      curve: goofyClipName("TP", "Run"),
      kind: "Run",
      timeScale: GOOFY_TIMING.dribbleLoop / RUN_GOOFY_DURATION,
    });
    this.curveByClip.set("Run_Goofy_GoofyBasket_Lower", { curve: null, kind: null, timeScale: 1 });
    this.ball = instantiateGoofyBasket(gltf, GOOFY_BALL.freePresentationScale);
    this.ball.visible = false;
    gltfScene.add(this.ball);
    void createGoofyBasketPresentation().then(({ presentation, library }) => {
      if (this.disposed || !this.ball) return;
      this.driver = new GoofyBasketBallDriver(
        "TP",
        presentation,
        library,
        this.ball,
        GOOFY_BALL.freePresentationScale,
        GOOFY_BALL.sourceRadiusMeters * GOOFY_BALL.freePresentationScale,
        (clip) => this.resolve(clip),
      );
    });
  }

  private resolve(clip: string): BallClipInfo {
    const direct = this.curveByClip.get(clip);
    if (direct) return direct;
    // Lower-body variants / masked composites never own the ball: held.
    return { curve: null, kind: null, timeScale: 1 };
  }

  /**
   * After the avatar mixer + world matrices: drive the ball. `floorWorldY`
   * = world height of the avatar's feet when grounded (the model root),
   * null while airborne / sliding.
   */
  update(dt: number, clock: { clip: string | null; time: number }, grounded: boolean): void {
    if (!this.driver || !this.ball) return;
    this.gltfScene.updateWorldMatrix(true, false);
    this.socket.updateWorldMatrix(true, false);
    this.mount.updateWorldMatrix(false, false);
    this.invParent.copy(this.gltfScene.matrixWorld).invert();
    this.gripM.multiplyMatrices(this.invParent, this.mount.matrixWorld); // grip in glTF-scene space
    this.parentWorld.copy(this.gltfScene.matrixWorld);
    let floorWorldY: number | null = null;
    if (grounded) {
      // The normalized scene's origin IS the feet (PotatoCharacter recenters it).
      this.floorProbe.setFromMatrixPosition(this.gltfScene.matrixWorld);
      floorWorldY = this.floorProbe.y;
    }
    this.driver.update(dt, { clip: clock.clip, time: clock.time, grip: this.gripM, parentToWorld: this.parentWorld, floorWorldY });
  }

  /** Death / respawn: hide the ball and drop gathers. */
  reset(): void {
    this.driver?.reset();
    if (this.ball) this.ball.visible = false;
  }

  dispose(): void {
    this.disposed = true;
    this.driver?.reset();
    this.ball?.removeFromParent();
    this.ball = null;
    this.mount.removeFromParent();
  }
}
