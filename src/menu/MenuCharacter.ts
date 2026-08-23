import * as THREE from "three";
import { GLTFLoader, GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  MenuSceneConfig as cfg,
  hammerAttachment,
  plasmaAttachment,
  WeaponAttachment,
} from "./MenuConfig";
// NOTE: the Meshy "Sprouty Smile" export filenames are mislabeled — the
// file named "Animation_Regular_Jump_withSkin.glb" actually contains the
// ALERT clip ("Armature|Alert|baselayer"). We select the animation by
// CLIP NAME, never by filename. This file also embeds the mesh +
// skeleton + textures, so it is the single GLB the menu needs for the
// character.
import characterAlertUrl from "../assets/Meshy_AI_Sprouty_Smile_biped_Animation_Regular_Jump_withSkin.glb?url";
import hammerUrl from "../assets/voidhammer_opt.glb?url";
import rifleUrl from "../assets/voidrifle_opt.glb?url";

/**
 * The Main Menu hero: full character playing the looping ALERT animation,
 * real hammer + Plasma Rifle GLBs attached to the hand bones and a goofy
 * stone-and-grass garden pedestal under the feet — all lit by a sunny
 * prairie studio setup (warm key + leafy rims + soft sky fill).
 *
 * Loaded ONCE (single GLTFLoader pass per asset), one AnimationMixer,
 * no shadow maps — a fake soft shadow disc sits on the platform instead.
 */
export class MenuCharacter {
  readonly group = new THREE.Group();

  private mixer: THREE.AnimationMixer | null = null;
  private characterRoot: THREE.Object3D | null = null;

  private readonly disposables: { dispose(): void }[] = [];

  private constructor() {}

  static async create(): Promise<MenuCharacter> {
    const mc = new MenuCharacter();
    const loader = new GLTFLoader();

    const [charGltf, hammerGltf, rifleGltf] = await Promise.all([
      loadGlb(loader, characterAlertUrl, "character (Alert)"),
      loadGlb(loader, hammerUrl, "hammer"),
      loadGlb(loader, rifleUrl, "plasma rifle"),
    ]);

    if (charGltf) mc.setupCharacter(charGltf, hammerGltf, rifleGltf);
    mc.setupPlatform();
    mc.setupLights();
    return mc;
  }

  // ------------------------------------------------------------------
  // Character + weapons
  // ------------------------------------------------------------------

  private setupCharacter(
    charGltf: GLTF,
    hammerGltf: GLTF | null,
    rifleGltf: GLTF | null,
  ): void {
    const model = charGltf.scene;

    // Normalize: feet on y=0, target height, facing the camera (+Z).
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const scale = cfg.characterHeight / Math.max(size.y, 1e-6);
    model.scale.setScalar(scale);
    box.setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= box.min.y;

    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        // Skinned bounds move with the animation; skip stale-culling pops.
        mesh.frustumCulled = false;
      }
    });

    this.characterRoot = model;
    this.group.add(model);

    // ---- ALERT animation (selected by clip name, looping forever) ----
    const clips = charGltf.animations ?? [];
    let alert = clips.find((c) => /alert/i.test(c.name)) ?? null;
    if (!alert) {
      console.error(
        `[MenuCharacter] Alert animation not found — available clips: ` +
          clips.map((c) => `"${c.name}"`).join(", "),
      );
      alert = clips[0] ?? null; // graceful fallback: first clip if any
    }
    if (alert) {
      this.mixer = new THREE.AnimationMixer(model);
      const action = this.mixer.clipAction(alert);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
    }

    // ---- Real weapon GLBs on the hand bones ----
    if (hammerGltf) this.attachWeapon(model, hammerGltf.scene, hammerAttachment, "hammer");
    if (rifleGltf) this.attachWeapon(model, rifleGltf.scene, plasmaAttachment, "plasma rifle");
  }

  /**
   * Parent a normalized weapon model to a skeleton bone so it follows the
   * Alert animation exactly. Offsets come from MenuConfig (easy tuning).
   */
  private attachWeapon(
    characterRoot: THREE.Object3D,
    weaponScene: THREE.Group,
    att: WeaponAttachment,
    label: string,
  ): void {
    const bone = characterRoot.getObjectByName(att.bone);
    if (!bone) {
      console.error(`[MenuCharacter] ${att.bone} bone not found — cannot attach ${label}`);
      return;
    }

    // Normalize the raw GLB: center on origin, uniform target size.
    const box = new THREE.Box3().setFromObject(weaponScene);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
    weaponScene.scale.setScalar(att.size / maxDim);
    box.setFromObject(weaponScene);
    const center = box.getCenter(new THREE.Vector3());
    weaponScene.position.sub(center);

    weaponScene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.frustumCulled = false; // moves with the animated bone
      }
    });

    // Wrapper carries the grip offset; the inner scene keeps normalization.
    const grip = new THREE.Group();
    grip.add(weaponScene);
    grip.position.copy(att.position);
    grip.rotation.copy(att.rotation);

    // The character root is uniformly scaled — compensate so the weapon's
    // configured size stays a true world size.
    const invScale = 1 / characterRoot.scale.x;
    grip.scale.setScalar(invScale);
    grip.position.multiplyScalar(invScale);

    bone.add(grip);
  }

  // ------------------------------------------------------------------
  // Platform + lights
  // ------------------------------------------------------------------

  /**
   * Goofy garden pedestal (like the reference mock): a wide stone rim,
   * a sandy flagstone top the character stands on, and a few chunky
   * grass tufts around the edge. Top face sits exactly at y = 0.
   */
  private setupPlatform(): void {
    const platform = new THREE.Group();

    // Stone rim (bottom, wider) — warm brown brick tone.
    const rimGeo = new THREE.CylinderGeometry(1.62, 1.74, 0.22, 36);
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0x8a6240,
      roughness: 0.95,
      metalness: 0.02,
    });
    this.disposables.push(rimGeo, rimMat);
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.position.y = -0.27;
    platform.add(rim);

    // Sandy flagstone top — the character stands on this.
    const topGeo = new THREE.CylinderGeometry(1.42, 1.56, 0.16, 36);
    const topMat = new THREE.MeshStandardMaterial({
      color: 0xd9bd8a,
      roughness: 0.9,
      metalness: 0.02,
    });
    this.disposables.push(topGeo, topMat);
    const top = new THREE.Mesh(topGeo, topMat);
    top.position.y = -0.08;
    platform.add(top);

    // Chunky grass tufts hugging the rim (flattened goofy spheres).
    const tuftGeo = new THREE.SphereGeometry(0.16, 10, 8);
    const tuftMat = new THREE.MeshStandardMaterial({
      color: 0x6fae35,
      roughness: 0.85,
      metalness: 0.0,
    });
    this.disposables.push(tuftGeo, tuftMat);
    const tuftCount = 9;
    for (let i = 0; i < tuftCount; i++) {
      const angle = (i / tuftCount) * Math.PI * 2 + 0.35;
      const radius = 1.58 + Math.sin(i * 12.9) * 0.06;
      const tuft = new THREE.Mesh(tuftGeo, tuftMat);
      tuft.position.set(
        Math.cos(angle) * radius,
        -0.12,
        Math.sin(angle) * radius,
      );
      const s = 0.8 + ((i * 7919) % 5) * 0.12;
      tuft.scale.set(s, s * 0.62, s);
      platform.add(tuft);
    }

    // Soft fake shadow under the feet (no shadow maps needed).
    const shadowTex = makeRadialTexture(128, [
      [0, "rgba(0, 0, 0, 0.45)"],
      [0.6, "rgba(0, 0, 0, 0.22)"],
      [1, "rgba(0, 0, 0, 0)"],
    ]);
    this.disposables.push(shadowTex);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      depthWrite: false,
    });
    this.disposables.push(shadowMat);
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.012;
    platform.add(shadow);

    this.group.add(platform);
  }

  /** Prairie studio: warm sunny key + leafy rims + soft sky fill. */
  private setupLights(): void {
    const key = new THREE.DirectionalLight(cfg.colors.keyLight, 2.3);
    key.position.set(2.2, 3.2, 3.5);
    this.group.add(key);

    const rim = new THREE.DirectionalLight(cfg.colors.accent, 2.2);
    rim.position.set(-2.5, 2.0, -3.0);
    this.group.add(rim);

    const rim2 = new THREE.DirectionalLight(cfg.colors.accentDeep, 1.2);
    rim2.position.set(3.0, 1.0, -2.5);
    this.group.add(rim2);

    // Daytime fill: pale sky from above, warm meadow bounce from below.
    const fill = new THREE.HemisphereLight(0xbfe3f5, 0x3a5a24, 0.85);
    this.group.add(fill);
  }

  // ------------------------------------------------------------------
  // Frame update / cleanup
  // ------------------------------------------------------------------

  update(dt: number, elapsed: number): void {
    this.mixer?.update(dt);

    // Micro "presence" sway on the whole character (breathing-scale).
    if (this.characterRoot) {
      this.characterRoot.rotation.y = Math.sin(elapsed * 0.22) * 0.035;
    }
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) m?.dispose();
      }
    });
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}

// ---------------------------------------------------------------------

function loadGlb(loader: GLTFLoader, url: string, label: string): Promise<GLTF | null> {
  return new Promise((resolve) => {
    loader.load(
      url,
      (gltf) => resolve(gltf),
      undefined,
      (err) => {
        console.error(`[MenuCharacter] failed to load ${label} GLB`, err);
        resolve(null);
      },
    );
  });
}

function makeRadialTexture(size: number, stops: [number, string][]): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [pos, color] of stops) grad.addColorStop(pos, color);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}