import { Game } from "./game/Game";
import { MainMenu } from "./menu/MainMenu";

/**
 * Boot flow:
 *
 *   page load
 *   → minimal "SLIDE IO / LOADING…" screen
 *   → Game (physics/map) + Main Menu (character/weapons/space) preload in parallel
 *   → Main Menu revealed with a fade (cursor visible, no pointer lock)
 *   → PLAY → short violet transition → menu disposed → existing gameplay starts
 *
 * The Game instance is created up-front (its canvas sits hidden behind the
 * menu and nothing renders until start()), so PLAY can enter gameplay
 * instantly. Structured so a future GAME → MENU return only needs a new
 * MainMenu.create() — no page reload.
 */
async function main(): Promise<void> {
  const container = document.getElementById("app")!;
  const overlay = document.getElementById("overlay")!;
  const hud = document.getElementById("hud")!;
  const loading = document.getElementById("menu-loading")!;
  const menuRoot = document.getElementById("main-menu-root")!;

  // ---- Preload gameplay + menu together behind the loading screen ----
  const [game, menu] = await Promise.all([
    Game.create(container),
    MainMenu.create(menuRoot),
  ]);

  // ---- Reveal the Main Menu ----
  loading.classList.add("hidden");
  menu.start();

  // ---- PLAY → transition → gameplay ----
  menu.onPlay = async () => {
    // Short fade + violet flash (music fades out inside).
    await menu.beginPlayTransition();

    // Free menu resources: render loop, GPU buffers, DOM, listeners, music.
    menu.dispose();

    // Gameplay HUD becomes visible again; menu never renders behind the game.
    hud.classList.remove("menu-active");

    // Pointer lock overlay behaviour (Escape ↔ pause) — wired only now so
    // it never appears over the Main Menu.
    overlay.addEventListener("click", () => {
      game.requestPointerLock();
    });
    document.addEventListener("pointerlockchange", () => {
      const locked = document.pointerLockElement === game.domElement;
      overlay.classList.toggle("hidden", locked);
    });

    game.start();

    // The PLAY click keeps transient user activation for a few seconds —
    // enough to enter pointer lock right after the ~500 ms transition.
    game.requestPointerLock();
    setTimeout(() => {
      const locked = document.pointerLockElement === game.domElement;
      overlay.classList.toggle("hidden", locked);
    }, 400);
  };
}

main();