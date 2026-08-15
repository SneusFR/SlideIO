import * as THREE from "three";
import { MenuSceneConfig as cfg } from "./MenuConfig";
import { SpaceBackground } from "./SpaceBackground";
import { MenuCharacter } from "./MenuCharacter";
import { MenuAudio } from "./MenuAudio";
import { MenuUI } from "./MenuUI";
import { LoadoutMenu } from "./LoadoutMenu";

/**
 * The Main Menu scene: own renderer + scene + camera, fully independent
 * from the gameplay Game instance.
 *
 *   MainMenu
 *   ├── MenuUI          (HTML buttons / player info — crisp at any res)
 *   ├── MenuCharacter   (Alert anim + hammer + plasma + platform + rings)
 *   ├── SpaceBackground (stars / nebula / planet / dust, slow parallax)
 *   └── MenuAudio       (space ambience + UI ticks)
 *
 * PLAY → short fade + violet flash → dispose() frees the GPU resources,
 * removes DOM/listeners and stops the render loop before gameplay starts.
 */
export class MainMenu {
  /** Fired once when the PLAY transition should begin. */
  onPlay: (() => void) | null = null;

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private background: SpaceBackground;
  private character: MenuCharacter;
  private ui: MenuUI;
  private loadout: LoadoutMenu;
  readonly sounds: MenuAudio;

  private lastTime = 0;
  private elapsed = 0;
  private disposed = false;

  // Mouse parallax state (targets set by pointermove, smoothed per frame).
  private parallaxTargetX = 0;
  private parallaxTargetY = 0;
  private parallaxX = 0;
  private parallaxY = 0;

  private readonly cleanups: (() => void)[] = [];

  private constructor(
    private readonly root: HTMLElement,
    character: MenuCharacter,
    sounds: MenuAudio,
  ) {
    this.character = character;
    this.sounds = sounds;

    // ---- Renderer (menu-only; no shadow maps → cheap) ----
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false;
    this.renderer.domElement.id = "menu-canvas";
    root.appendChild(this.renderer.domElement);

    // ---- Scene ----
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x07040f);
    this.scene.fog = new THREE.FogExp2(0x0a0618, 0.012);

    this.background = new SpaceBackground();
    this.scene.add(this.background.group);

    // Character shifted right so the HTML nav owns the left third.
    this.character.group.position.x = cfg.characterOffsetX;
    this.scene.add(this.character.group);

    // ---- Camera ----
    this.camera = new THREE.PerspectiveCamera(
      cfg.camera.fov,
      window.innerWidth / window.innerHeight,
      0.1,
      300,
    );
    this.camera.position.copy(cfg.camera.position);
    this.camera.lookAt(
      cfg.camera.lookAt.x + cfg.characterOffsetX * 0.35,
      cfg.camera.lookAt.y,
      cfg.camera.lookAt.z,
    );

    // ---- UI ----
    this.ui = new MenuUI(sounds);
    this.ui.onPlay = () => this.onPlay?.();
    // LOADOUT overlay: opens on the nav button, closes back to the menu.
    this.loadout = new LoadoutMenu(sounds);
    this.ui.onLoadout = () => this.loadout.open();

    // ---- Events ----
    const onResize = () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);
    this.cleanups.push(() => window.removeEventListener("resize", onResize));

    const onPointerMove = (e: PointerEvent) => {
      this.parallaxTargetX = (e.clientX / window.innerWidth) * 2 - 1;
      this.parallaxTargetY = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", onPointerMove);
    this.cleanups.push(() => window.removeEventListener("pointermove", onPointerMove));

    // Autoplay policy: the music can only start after a real user gesture.
    const onGesture = () => this.sounds.tryResume();
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    this.cleanups.push(() => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
    });
  }

  /** Load everything the menu needs (character, weapons, sounds). */
  static async create(root: HTMLElement): Promise<MainMenu> {
    const sounds = new MenuAudio();
    // Audio preload never blocks the menu (decode requires a gesture-safe
    // context anyway); GLBs are the real payload we wait for.
    void sounds.preload();
    const character = await MenuCharacter.create();
    return new MainMenu(root, character, sounds);
  }

  /** Reveal the menu (after the loading screen) and start rendering. */
  start(): void {
    this.ui.reveal();
    this.sounds.startMusic();
    this.lastTime = performance.now();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private frame(): void {
    const now = performance.now();
    const dt = Math.min((now - this.lastTime) / 1000, 1 / 20);
    this.lastTime = now;
    this.elapsed += dt;

    // Smooth the mouse parallax (a few pixels/degrees at most).
    const k = 1 - Math.exp(-cfg.parallax.smoothing * dt);
    this.parallaxX += (this.parallaxTargetX - this.parallaxX) * k;
    this.parallaxY += (this.parallaxTargetY - this.parallaxY) * k;

    this.camera.position.x =
      cfg.camera.position.x + this.parallaxX * cfg.parallax.cameraShift;
    this.camera.position.y =
      cfg.camera.position.y - this.parallaxY * cfg.parallax.cameraShift * 0.6;

    this.background.update(this.elapsed, this.parallaxX, this.parallaxY);
    this.character.update(dt, this.elapsed);

    this.renderer.render(this.scene, this.camera);
  }

  /**
   * PLAY transition: UI fade + subtle violet flash + music fade-out.
   * Resolves when the screen is covered and gameplay may take over.
   */
  beginPlayTransition(): Promise<void> {
    this.sounds.fadeOutMusic(0.8);
    this.ui.fadeOut();

    const flash = document.getElementById("menu-play-flash");
    flash?.classList.add("active");

    return new Promise((resolve) => setTimeout(resolve, 520));
  }

  /** Free every menu resource: GPU, DOM, listeners, audio. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.renderer.setAnimationLoop(null);
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;

    this.character.dispose();
    this.background.dispose();
    this.ui.dispose();
    this.loadout.dispose();
    this.sounds.dispose();

    this.renderer.dispose();
    this.root.remove(); // removes the canvas + any leftover menu DOM
  }
}