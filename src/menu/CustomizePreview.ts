import * as THREE from "three";
import { loadGoofyBasketGltf, instantiateGoofyBasket } from "../weapons/goofybasket/GoofyBasketModel";
import { GoofyBasketSkinSlot } from "../weapons/goofybasket/GoofyBasketSkinRuntime";

/**
 * 3D preview of the CUSTOMIZE menu (left "APERÇU" panel): a real ball
 * instance (same GLB, same skin runtime as the game) on a small turntable,
 * lit like the in-game FP pass, with a cosmetic charge slider.
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
  private raf: number | null = null;
  private running = false;
  private lastTime = 0;
  private clock = 0;
  private charge = 0;
  private autoRotate = true;
  private spinVelocity = 0;
  private loaded = false;
  private disposed = false;

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

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.01, 20);
    this.camera.position.set(0, 0.12, 1.55);
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
      // Instance clone (shared geometry + base materials). Sized so the ball
      // fills the panel: local radius 0.125 × 3.6 ≈ 0.45 m at 1.55 m.
      this.ball = instantiateGoofyBasket(gltf, 3.6);
      this.turntable.add(this.ball);
      this.skin.setTarget(this.ball);
      this.loaded = true;
    } catch (err) {
      console.error("Customize preview: ball load failed", err);
    }
  }

  /** Preview a skin id ("default" = base ball). */
  setSkin(skinId: string): void {
    this.skin.setSkin(skinId);
  }

  /** Cosmetic charge 0..1 (slider) — drives emissive boosts / aura intensity. */
  setCharge(charge01: number): void {
    this.charge = THREE.MathUtils.clamp(charge01, 0, 1);
  }

  /** Nudge the turntable (◄ / ► buttons). */
  spin(direction: -1 | 1): void {
    this.autoRotate = false;
    this.spinVelocity = direction * 6;
  }

  /** Back to the default framing + slow auto-rotation. */
  resetView(): void {
    this.turntable.rotation.set(0.18, 0, 0);
    this.spinVelocity = 0;
    this.autoRotate = true;
    this.charge = 0;
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
    // Gentle float like the in-game hold pose.
    this.turntable.position.y = Math.sin(this.clock * 1.6) * 0.012;

    if (this.loaded) {
      this.skin.update(this.clock, { charge: this.charge, visible: true, effectsEnabled: true });
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
    this.renderer.dispose();
  }
}

