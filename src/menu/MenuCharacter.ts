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
 * real hammer + Plasma Rifle GLBs attached to the hand bones, an energy
 * platform under the feet and thin holographic rings behind — all lit by
 * a small sci-fi studio setup (key + violet rim + cool fill).
 *
 * Loaded ONCE (single GLTFLoader pass per asset), one AnimationMixer,
 * no shadow maps — a fake soft shadow disc sits on the platform instead.
 */
export class MenuCharacter {
  readonly group = new THREE.Group();

  private mixer: THREE.AnimationMixer | null = null;
  private platformRings: THREE.Group | null = null;
  private holoRing: THREE.Group | null = null;
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
    mc.setupHoloRing();
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
  // Platform + rings + lights
  // ------------------------------------------------------------------

  private setupPlatform(): void {
    const platform = new THREE.Group();

    // Soft fake shadow under the feet (no shadow maps needed).
    const shadowTex = makeRadialTexture(128, [
      [0, "rgba(0, 0, 0, 0.55)"],
      [0.6, "rgba(0, 0, 0, 0.3)"],
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

    // Glowing violet disc.
    const glowTex = makeRadialTexture(256, [
      [0, "rgba(168, 85, 247, 0.35)"],
      [0.55, "rgba(124, 58, 237, 0.16)"],
      [0.8, "rgba(168, 85, 247, 0.30)"],
      [0.86, "rgba(168, 85, 247, 0.05)"],
      [1, "rgba(0, 0, 0, 0)"],
    ]);
    this.disposables.push(glowTex);
    const glowMat = new THREE.MeshBasicMaterial({
      map: glowTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.disposables.push(glowMat);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.006;
    platform.add(glow);

    // Concentric holographic line rings (rotate very slowly).
    this.platformRings = new THREE.Group();
    const ringDefs: [number, number, number][] = [
      // innerRadius, outerRadius, opacity
      [0.82, 0.845, 0.55],
      [1.05, 1.062, 0.32],
      [1.3, 1.315, 0.22],
    ];
    for (const [inner, outer, opacity] of ringDefs) {
      const geo = new THREE.RingGeometry(inner, outer, 72);
      const mat = new THREE.MeshBasicMaterial({
        color: cfg.colors.violetBright,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      this.disposables.push(geo, mat);
      const ring = new THREE.Mesh(geo, mat);
      ring.rotation.x = -Math.PI / 2;
      this.platformRings.add(ring);
    }
    this.platformRings.position.y = 0.02;
    platform.add(this.platformRings);

    this.group.add(platform);
  }

  /** Large, very thin sci-fi scanner circle behind the character. */
  private setupHoloRing(): void {
    this.holoRing = new THREE.Group();
    const defs: [number, number, number][] = [
      [1.55, 1.565, 0.16],
      [1.8, 1.81, 0.1],
    ];
    for (const [inner, outer, opacity] of defs) {
      const geo = new THREE.RingGeometry(inner, outer, 80);
      const mat = new THREE.MeshBasicMaterial({
        color: cfg.colors.violet,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      this.disposables.push(geo, mat);
      this.holoRing.add(new THREE.Mesh(geo, mat));
    }
    // Small arc accents for the "radar" feel.
    const arcGeo = new THREE.RingGeometry(1.68, 1.7, 80, 1, 0, Math.PI / 3);
    const arcMat = new THREE.MeshBasicMaterial({
      color: cfg.colors.violetBright,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.disposables.push(arcGeo, arcMat);
    this.holoRing.add(new THREE.Mesh(arcGeo, arcMat));

    this.holoRing.position.set(0, 1.05, -0.65);
    this.group.add(this.holoRing);
  }

  /** Sci-fi studio: soft key + violet rim + faint cool fill. No shadows. */
  private setupLights(): void {
    const key = new THREE.DirectionalLight(cfg.colors.keyLight, 2.1);
    key.position.set(2.2, 3.2, 3.5);
    this.group.add(key);

    const rim = new THREE.DirectionalLight(cfg.colors.violet, 3.2);
    rim.position.set(-2.5, 2.0, -3.0);
    this.group.add(rim);

    const rim2 = new THREE.DirectionalLight(cfg.colors.violetDeep, 1.6);
    rim2.position.set(3.0, 1.0, -2.5);
    this.group.add(rim2);

    const fill = new THREE.HemisphereLight(cfg.colors.fillLight, 0x0a0614, 0.55);
    this.group.add(fill);
  }

  // ------------------------------------------------------------------
  // Frame update / cleanup
  // ------------------------------------------------------------------

  update(dt: number, elapsed: number): void {
    this.mixer?.update(dt);

    // Extremely slow decorative rotations — never touches the Alert anim.
    if (this.platformRings) this.platformRings.rotation.z = elapsed * 0.08;
    if (this.holoRing) this.holoRing.rotation.z = -elapsed * 0.04;

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