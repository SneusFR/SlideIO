import { Game } from "./game/Game";

async function main(): Promise<void> {
  const container = document.getElementById("app")!;
  const overlay = document.getElementById("overlay")!;
  const overlayTitle = document.getElementById("overlay-title")!;

  overlayTitle.textContent = "LOADING…";
  const game = await Game.create(container);
  overlayTitle.textContent = "CLICK TO PLAY";

  overlay.addEventListener("click", () => {
    game.requestPointerLock();
  });

  // Show / hide the overlay based on pointer lock (Escape releases the mouse).
  document.addEventListener("pointerlockchange", () => {
    const locked = document.pointerLockElement === game.domElement;
    overlay.classList.toggle("hidden", locked);
  });

  game.start();
}

main();