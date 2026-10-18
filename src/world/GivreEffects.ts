import * as THREE from "three";
import type { GivreMap } from "./GivreMap";
import { GivreConfig as givre } from "./GivreConfig";
import { givreData } from "./GivreData";
import { GivreHalos } from "./GivreHalos";
import { GivreSnow, type GivreSnowLevel } from "./GivreSnow";
import { GivreFootprints } from "./GivreFootprints";
import snowMaskUrl from "../assets/MAP/Givre/givre_neige_toits.png?url";
import footprintUrl from "../assets/MAP/Givre/givre_empreinte.png?url";

/**
 * GIVRE v3 client-only map effects — ONE instance per loaded map (same role
 * as YardEffects). Owns:
 *  - the SINGLE AnimationMixer playing the glb's 8 s loop (steam, smoke,
 *    garlands, banners, boiler, gauges, fans, beacon) + the per-frame copy
 *    of the animated puffs' matrices into their InstancedMesh;
 *  - the bulb halos (GivreHalos) and the boiler fire flicker (emissive of
 *    GIV_Feu, no live light);
 *  - the falling snow (GivreSnow, graphics option) and the snow footprints
 *    (GivreFootprints).
 * Nothing here touches physics or the network: no message, no server cost.
 *
 * Animation clock: in MULTIPLAYER the loop is aligned on the SERVER clock
 * (`syncToServerTime`, once the clock is synced), so every player sees the
 * valve's steam jet (5 s → 6.6 s, it hides part of the boiler room) at the
 * same moment. Solo: starts at 0.
 */
export class GivreEffects {
  readonly mixer: THREE.AnimationMixer | null;
  readonly halos: GivreHalos | null;
  readonly snow: GivreSnow | null;
  readonly footprints: GivreFootprints | null;

  private readonly loop = givre.animationLoopSeconds;
  private readonly instanced: GivreMap["animated"]["instanced"];
  private readonly root: THREE.Object3D;
  private readonly fire: THREE.MeshStandardMaterial | null;
  private readonly fireBase: number;
  private readonly rootInverse = new THREE.Matrix4();
  private readonly tmp = new THREE.Matrix4();
  /** Seconds since the map loaded (snow + footprints clock). */
  private time = 0;
  private serverSynced = false;
  private disposed = false;

  private constructor(
    map: GivreMap,
    snowMask: THREE.Texture | null,
    footprint: THREE.Texture | null,
    snowLevel: GivreSnowLevel,
  ) {
    const anim = map.animated;
    this.root = anim.root;
    this.instanced = anim.instanced;

    // ---- Single mixer: the glb's 8 s loop (LoopRepeat, linear keys) ----
    if (anim.clips.length > 0) {
      this.mixer = new THREE.AnimationMixer(anim.root);
      for (const clip of anim.clips) {
        this.mixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
      }
    } else {
      this.mixer = null;
    }

    // ---- Halos (647 sprites, ONE draw call) ----
    this.halos = givreData.halos ? new GivreHalos(givreData.halos, map.group, anim.nodes) : null;

    // ---- Boiler fire flicker (emissive only) ----
    this.fire = (map.materials.get("GIV_Feu") as THREE.MeshStandardMaterial | undefined) ?? null;
    this.fireBase = this.fire?.emissiveIntensity ?? 1;

    // ---- Falling snow + footprints ----
    this.snow = givreData.snow && snowMask ? new GivreSnow(givreData.snow, snowMask, snowLevel) : null;
    this.footprints =
      givreData.footprints && footprint && map.snowSurfaces.length > 0
        ? new GivreFootprints(givreData.footprints, footprint, map.snowSurfaces)
        : null;
    if (snowMask && !this.snow) snowMask.dispose();
    if (footprint && !this.footprints) footprint.dispose();

    this.copyInstances();
  }

  /** Loads the two small PNGs (snow mask + footprint) and builds everything. */
  static async create(map: GivreMap, snowLevel: GivreSnowLevel): Promise<GivreEffects> {
    const loader = new THREE.TextureLoader();
    const load = async (url: string, label: string): Promise<THREE.Texture | null> => {
      try {
        return await loader.loadAsync(url);
      } catch (err) {
        console.warn(`GivreEffects: ${label} failed to load — effect disabled`, err);
        return null;
      }
    };
    const [mask, foot] = await Promise.all([
      load(snowMaskUrl, "givre_neige_toits.png"),
      load(footprintUrl, "givre_empreinte.png"),
    ]);
    return new GivreEffects(map, mask, foot, snowLevel);
  }

  /** Scene objects that live outside map.group (snow + footprints). */
  get sceneObjects(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    if (this.snow) out.push(this.snow.points);
    if (this.footprints) out.push(this.footprints.mesh);
    return out;
  }

  /** Seconds since the map loaded — the footprints clock. */
  get now(): number {
    return this.time;
  }

  /** Current mixer time inside the loop (verification / debug). */
  get loopTime(): number {
    return this.mixer ? this.mixer.time % this.loop : 0;
  }

  /**
   * MULTIPLAYER: align the animation loop on the server clock. Called every
   * frame by the Game; a no-op once done or while the clock is not synced.
   */
  syncToServerTime(serverNowMs: number | null): void {
    if (this.serverSynced || serverNowMs === null || !this.mixer) return;
    this.serverSynced = true;
    this.mixer.setTime((serverNowMs / 1000) % this.loop);
    this.copyInstances();
    this.halos?.update();
  }

  /**
   * Every frame (also behind the menus — decorative only).
   * @param dt               frame delta (s)
   * @param camera           rendered camera (the snow box follows it)
   * @param viewportHeightPx canvas height in REAL pixels (renderer.domElement.height)
   */
  update(dt: number, camera: THREE.Camera, viewportHeightPx: number): void {
    if (this.disposed) return;
    this.time += dt;
    this.mixer?.update(dt);
    // Puff instances + garland halos are synced in afterMatrixUpdate(), once
    // the Game has refreshed the scene's world matrices (no second walk of
    // the glb hierarchy here).
    this.halos?.setViewportHeight(viewportHeightPx);
    this.updateFireFlicker();
    this.snow?.update(this.time, camera, viewportHeightPx);
    this.footprints?.update(this.time);
  }

  /**
   * Every frame, right AFTER the Game's scene.updateMatrixWorld(): the
   * animated nodes' world matrices are final → copy them into the puff
   * instances and the garland halos.
   */
  afterMatrixUpdate(): void {
    if (this.disposed) return;
    this.copyInstances(false);
    this.halos?.update();
  }

  /**
   * Frames WITHOUT the Game's per-frame scene matrix update (menu preview,
   * play-transition flight): refresh the animated subtree's matrices and
   * sync the puffs + halos right after update().
   */
  syncStandalone(): void {
    if (this.disposed) return;
    this.copyInstances(true);
    this.halos?.update();
  }

  /** Graphics option (live). */
  setSnowLevel(level: GivreSnowLevel): void {
    this.snow?.setLevel(level);
  }

  /** Animated puff matrices → their InstancedMesh (after the mixer). */
  private copyInstances(updateMatrices = true): void {
    if (this.instanced.length === 0) return;
    if (updateMatrices) this.root.updateMatrixWorld(); // animated node matrices up to date
    const parent = this.instanced[0].mesh.parent;
    if (parent) this.rootInverse.copy(parent.matrixWorld).invert();
    else this.rootInverse.identity();
    for (const { mesh, sources } of this.instanced) {
      for (let i = 0; i < sources.length; i++) {
        mesh.setMatrixAt(i, this.tmp.multiplyMatrices(this.rootInverse, sources[i].matrixWorld));
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * The fire glow is already in the baked light: this only flickers the
   * GIV_Feu emissive between 2 and 6 Hz, stronger on the loop's pulses
   * (1, 3, 5 and 7 s — the water-hammer knocks). Driven by the mixer clock
   * so it stays in phase with the animation (server-synced in multiplayer).
   */
  private updateFireFlicker(): void {
    const fire = this.fire;
    if (!fire) return;
    const t = this.mixer ? this.mixer.time : this.time;
    const loop = t % this.loop;
    const pulse = Math.max(0, 1 - Math.abs((loop % 2) - 1) / 0.25); // peaks at 1, 3, 5, 7 s
    const n =
      0.5 * Math.sin(t * 2 * Math.PI * 2.3) +
      0.3 * Math.sin(t * 2 * Math.PI * 5.7 + 1.3) +
      0.2 * Math.sin(t * 2 * Math.PI * 3.1 + 2.1);
    fire.emissiveIntensity = this.fireBase * (0.85 + 0.15 * n + 0.35 * pulse);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mixer?.stopAllAction();
    this.mixer?.uncacheRoot(this.root);
    this.halos?.dispose();
    this.snow?.dispose();
    this.footprints?.dispose();
    if (this.fire) this.fire.emissiveIntensity = this.fireBase;
  }
}

