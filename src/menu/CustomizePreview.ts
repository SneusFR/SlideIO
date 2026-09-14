import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { loadGoofyBasketGltf, instantiateGoofyBasket } from "../weapons/goofybasket/GoofyBasketModel";
import { GoofyBasketSkinSlot } from "../weapons/goofybasket/GoofyBasketSkinRuntime";
import { loadCharacterAsset, stripEnemyOutline, CHARACTER_HEIGHT } from "../characters/PotatoCharacter";
import { RemotePlayerAnimationController } from "../network/remote/RemotePlayerAnimationController";
import { NetworkMovementState } from "../network/NetworkMovementState";
import { CharacterOutfitSlot } from "../cosmetics/astronaut/AstronautRuntime";
import type { CharacterCosmeticsSelection } from "../../shared/combat/CharacterCosmetics";

type PreviewSubject = "ball" | "character";

/**
 * 3D preview of the CUSTOMIZE menu (left "APERÇU" panel): a real ball
 * instance (same GLB, same skin runtime as the game) on a small turntable
 * (auto-rotation + drag to spin), lit like the in-game FP pass.
 *
 * The preview owns its OWN renderer + canvas and only renders while the
 * menu is open (its render loop stops on hide) — it never touches the
 * game's renderer, FOV or tone mapping. The skin is applied on the preview
 * INSTANCE (never the shared template) through the shared skin library.
 */
export class CustomizePreview {
  readonly canvas: HTMLCanvasElement;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly turntable = new THREE.Group();
  private ball: THREE.Object3D | null = null;
  private readonly skin = new GoofyBasketSkinSlot({ context: "fp", quality: "high", seed: 17 });
  // ---- Character subject: a REAL Potato TP clone (same GLB, same clips,
  // same outfit runtime as the in-game avatars) on the same turntable. ----
  private readonly characterRoot = new THREE.Group();
  private character: THREE.Object3D | null = null;
  private characterAnim: RemotePlayerAnimationController | null = null;
  private readonly outfit = new CharacterOutfitSlot({ context: "tp" });
  private characterLoading = false;
  private subject: PreviewSubject = "ball";
  /** Camera pose per subject (the ball sits at the origin, the character stands on it). */
  private static readonly BALL_CAMERA = { pos: new THREE.Vector3(0, 0.18, 2.6), look: new THREE.Vector3(0, 0, 0) };
  private static readonly CHARACTER_CAMERA = {
    // Frames the whole 2.25 m character + helmet / backpack margins.
    pos: new THREE.Vector3(0, CHARACTER_HEIGHT * 0.58, CHARACTER_HEIGHT * 2.05),
    look: new THREE.Vector3(0, CHARACTER_HEIGHT * 0.5, 0),
  };
  private raf: number | null = null;
  private running = false;
  private lastTime = 0;
  private clock = 0;
  private autoRotate = true;
  private spinVelocity = 0;
  private loaded = false;
  private disposed = false;
  /** "EFFETS" toggle of the panel: aura / plasma on or off (materials stay). */
  private effectsEnabled = true;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "cz-preview-canvas";
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Same output pipeline as the game so the skins read identically.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Pulled back a bit so the ball (and its aura / plasma effects) breathes
    // inside the taller stage instead of filling it edge to edge.
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.01, 20);
    this.camera.position.set(0, 0.18, 2.6);
    this.camera.lookAt(0, 0, 0);

    // Warm key + cool fill + soft rim: reads "toy in the sun", like the icons.
    this.scene.add(new THREE.HemisphereLight(0xfff1d6, 0x3a2a1a, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(2.2, 3.0, 3.2);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xbfe0ff, 0.8);
    fill.position.set(-3, 0.6, -1.5);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xd8ffb0, 0.6);
    rim.position.set(0, -2, 2);
    this.scene.add(rim);

    this.turntable.rotation.x = 0.18;
    this.scene.add(this.turntable);
    // The character stands on the turntable origin (feet at y = 0); hidden
    // until the PERSONNAGE tab asks for it (lazy load on first request).
    this.characterRoot.visible = false;
    this.turntable.add(this.characterRoot);

    // Drag to rotate (pointer), auto-rotation resumes when idle.
    let dragging = false;
    let lastX = 0;
    this.canvas.addEventListener("pointerdown", (e) => {
      dragging = true;
      lastX = e.clientX;
      this.autoRotate = false;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      this.turntable.rotation.y += dx * 0.012;
      this.spinVelocity = dx * 0.4;
    });
    const stop = () => {
      dragging = false;
    };
    this.canvas.addEventListener("pointerup", stop);
    this.canvas.addEventListener("pointercancel", stop);

    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const gltf = await loadGoofyBasketGltf();
      if (this.disposed) return;
      // Instance clone (shared geometry + base materials). Local radius
      // 0.125 × 3.6 ≈ 0.45 m, framed with generous margin by the camera at 2.6 m.
      this.ball = instantiateGoofyBasket(gltf, 3.6);
      this.ball.visible = this.subject === "ball";
      this.turntable.add(this.ball);
      this.skin.setTarget(this.ball);
      this.loaded = true;
    } catch (err) {
      console.error("Customize preview: ball load failed", err);
    }
  }

  /**
   * Lazy character subject: SkeletonUtils clone of the REAL TP template
   * (already normalized to CHARACTER_HEIGHT — never rescaled here), driven
   * by the same animation controller as the avatars (idle pose). The enemy
   * contour hulls are stripped with the existing mechanism: the menu shows
   * the player's OWN bean, not an enemy.
   */
  private async loadCharacter(): Promise<void> {
    if (this.character || this.characterLoading) return;
    this.characterLoading = true;
    try {
      const asset = await loadCharacterAsset();
      if (this.disposed) return;
      const model = skeletonClone(asset.template);
      stripEnemyOutline(model);
      model.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.castShadow = false;
          mesh.frustumCulled = false;
        }
      });
      // Face the camera (+Z) at rest: the template faces -Z at yaw 0.
      model.rotation.y += Math.PI;
      this.character = model;
      this.characterRoot.add(model);
      // modelRestY = 0: the model root is the feet, on the turntable origin.
      this.characterAnim = new RemotePlayerAnimationController(model, 0, asset.clips);
      this.characterAnim.update(0, NetworkMovementState.IDLE, 0, 0, 0, 0);
      // Outfit handle on THIS clone; the wanted selection (if any) applies now.
      this.outfit.setTarget(model);
    } catch (err) {
      console.error("Customize preview: character load failed", err);
    } finally {
      this.characterLoading = false;
    }
  }

  /** Which subject the stage shows: the ball (weapon skins) or the character. */
  setSubject(subject: PreviewSubject): void {
    if (subject === this.subject && (subject !== "character" || this.character || this.characterLoading)) return;
    this.subject = subject;
    const cam = subject === "ball" ? CustomizePreview.BALL_CAMERA : CustomizePreview.CHARACTER_CAMERA;
    this.camera.position.copy(cam.pos);
    this.camera.lookAt(cam.look);
    // Flat turntable for the standing character (the tilt suits the ball).
    this.turntable.rotation.x = subject === "ball" ? 0.18 : 0.0;
    this.characterRoot.visible = subject === "character";
    if (this.ball) this.ball.visible = subject === "ball";
    if (subject === "character") void this.loadCharacter();
  }

  /**
   * Preview a character outfit selection (validated ids per slot). The
   * runtime replaces the previous handle atomically; an invalid / failed
   * outfit keeps the previous look (logged by the runtime).
   */
  setCharacterOutfit(selection: CharacterCosmeticsSelection): void {
    this.outfit.setSelection(selection);
  }

  /** Preview a skin id ("default" = base ball). */
  setSkin(skinId: string): void {
    this.skin.setSkin(skinId);
  }

  /** Show / hide the skin's ambient effects (aura, plasma…). */
  setEffectsEnabled(enabled: boolean): void {
    this.effectsEnabled = enabled;
  }

  /** Nudge the turntable by a fixed angle (‹ › arrows), then resume idle spin. */
  nudge(direction: -1 | 1): void {
    this.autoRotate = false;
    this.spinVelocity = direction * 5.5;
  }

  /** Start rendering (menu opened). Idempotent. */
  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastTime = performance.now();
    const frame = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(frame);
      this.tick();
    };
    this.raf = requestAnimationFrame(frame);
  }

  /** Stop rendering (menu closed) — no hidden GPU work behind the game. */
  stop(): void {
    this.running = false;
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  private tick(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.clock += dt;

    this.resize();
    if (this.autoRotate) this.turntable.rotation.y += dt * 0.55;
    else {
      this.turntable.rotation.y += this.spinVelocity * dt;
      this.spinVelocity *= Math.exp(-4 * dt);
      if (Math.abs(this.spinVelocity) < 0.02) {
        this.spinVelocity = 0;
        this.autoRotate = true;
      }
    }
    // Gentle float like the in-game hold pose (the character stays grounded).
    this.turntable.position.y = this.subject === "ball" ? Math.sin(this.clock * 1.6) * 0.012 : 0;

    if (this.loaded && this.subject === "ball") {
      // Idle hold pose (no charge): the skin's ambient effects only.
      this.skin.update(this.clock, { charge: 0, visible: true, effectsEnabled: this.effectsEnabled });
    }
    if (this.subject === "character" && this.characterAnim) {
      // Same idle clip as the in-game avatars (real skeleton, real clocks).
      this.characterAnim.update(dt, NetworkMovementState.IDLE, 0, 0, 0, 0);
    }
    this.renderer.render(this.scene, this.camera);
  }

  private resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const pr = this.renderer.getPixelRatio();
    if (this.canvas.width !== Math.floor(w * pr) || this.canvas.height !== Math.floor(h * pr)) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    // Restore the instance materials BEFORE dropping it (shared geometry /
    // base materials belong to the cached GLB template — never disposed).
    this.skin.dispose();
    this.ball?.removeFromParent();
    this.ball = null;
    // Outfit handle first (restores the clone's base geometry, frees its
    // private materials), then the mixer, then the clone itself. The shared
    // character template / library assets are never disposed here.
    this.outfit.dispose();
    this.characterAnim?.dispose();
    this.characterAnim = null;
    this.character?.removeFromParent();
    this.character = null;
    this.renderer.dispose();
  }
}

