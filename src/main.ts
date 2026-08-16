import { Game } from "./game/Game";
import { MainMenu } from "./menu/MainMenu";
import { playerProfile } from "./menu/MenuConfig";
import { LobbyController } from "./network/LobbyController";
import { MultiplayerClient } from "./network/MultiplayerClient";
import { parseJoinRoomId } from "./network/MultiplayerConfig";

/**
 * Boot flow:
 *
 *   page load
 *   → minimal "SLIDE IO / LOADING…" screen
 *   → Game (physics/map) + Main Menu (character/weapons/space) preload in parallel
 *   → Main Menu revealed with a fade (cursor visible, no pointer lock)
 *   → PLAY → short violet transition → menu disposed → existing gameplay starts
 *
 * Multiplayer (Phase 2): the same Game instance powers both modes.
 *   MULTIPLAYER → lobby overlay → host clicks START GAME → server flips the
 *   room phase to PLAYING → EVERY client transitions Lobby → Game in-app
 *   (same map, 0 bots, server-assigned spawns, 20 Hz transform sync).
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

  // ---- Multiplayer client + lobby overlay ----
  // Failures never block SlideIO: the overlay shows its own error screens.
  const multiplayer = new MultiplayerClient();
  const lobby = new LobbyController(multiplayer, playerProfile.name);
  menu.onMultiplayer = () => lobby.open();

  // Invite link: /join/{roomId} → open the lobby overlay and auto-join.
  const inviteRoomId = parseJoinRoomId(window.location.pathname);
  if (inviteRoomId) {
    // Clean the URL so a refresh doesn't re-trigger the join.
    window.history.replaceState(null, "", "/");
    lobby.openWithInvite(inviteRoomId);
  }

  let inGame = false;
  let inMultiplayerGame = false;

  /**
   * Shared Menu → Game transition (solo PLAY and multiplayer START GAME):
   * violet fade, menu disposal, HUD swap, pointer-lock wiring, game loop.
   */
  const enterGameplay = async (): Promise<void> => {
    inGame = true;

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
      // Losing WINDOW FOCUS (Alt-Tab / clicking another window) also exits
      // pointer lock — keep the Escape overlay HIDDEN in that case so
      // side-by-side sessions stay fully visible. The overlay only appears
      // for an intentional Escape while the window is focused.
      overlay.classList.toggle("hidden", locked || !document.hasFocus());
    });
    // After a focus-loss unlock the overlay stays hidden — clicking the
    // game view directly re-locks the pointer and resumes play.
    container.addEventListener("click", () => {
      if (inGame && document.pointerLockElement !== game.domElement) {
        game.requestPointerLock();
      }
    });

    game.start();

    // The click keeps transient user activation for a few seconds — enough
    // to enter pointer lock right after the ~500 ms transition.
    game.requestPointerLock();
    setTimeout(() => {
      const locked = document.pointerLockElement === game.domElement;
      overlay.classList.toggle("hidden", locked);
    }, 400);
  };

  // ---- SOLO: PLAY → transition → gameplay (bots untouched) ----
  menu.onPlay = () => void enterGameplay();

  // ---- MULTIPLAYER: the SERVER decides the launch. Every client (host
  // included) reacts to the room phase flipping to PLAYING — the host's
  // click alone never starts anything locally. ----
  multiplayer.onPhaseChanged = (phase) => {
    if (phase !== "PLAYING" || inGame) return;
    void (async () => {
      lobby.close();
      // Character asset preload + bots off + server-assigned spawn applied.
      await game.enableMultiplayer(multiplayer);
      await enterGameplay();
      inMultiplayerGame = true;
      leaveBtn.classList.remove("hidden");
    })();
  };

  // ---- LEAVE GAME (Escape menu, multiplayer only): clean room leave →
  // remote avatars removed → back to the main menu (fresh app state). ----
  const leaveBtn = createLeaveButton(overlay);
  leaveBtn.addEventListener("click", (e) => {
    e.stopPropagation(); // never triggers the overlay's pointer-lock click
    void (async () => {
      inMultiplayerGame = false;
      game.disableMultiplayer();
      await multiplayer.leaveLobby(); // clean WebSocket leave, no brutal close
      window.location.assign("/"); // fresh boot back to the main menu
    })();
  });

  // ---- CONNECTION LOST: server/network dropped mid-game. Freeze the flow
  // and offer RETURN TO MENU (no silent "everything is fine" gameplay). ----
  const lobbyOnLeft = multiplayer.onLeft; // LobbyController's handler (Phase 1)
  multiplayer.onLeft = (intentional) => {
    lobbyOnLeft?.(intentional);
    if (inMultiplayerGame && !intentional) {
      inMultiplayerGame = false;
      game.disableMultiplayer();
      document.exitPointerLock();
      showConnectionLost();
    }
  };
}

/** "LEAVE GAME" button inside the Escape overlay (multiplayer only). */
function createLeaveButton(overlay: HTMLElement): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.id = "mp-leave-game";
  btn.type = "button";
  btn.textContent = "LEAVE GAME";
  btn.classList.add("hidden");
  btn.style.cssText = [
    "margin-top: 26px",
    "padding: 12px 34px",
    "cursor: pointer",
    'font-family: "Orbitron", sans-serif',
    "font-size: 13px",
    "font-weight: 600",
    "letter-spacing: 2.5px",
    "color: #e9d5ff",
    "background: rgba(124, 58, 237, 0.2)",
    "border: 1px solid rgba(124, 58, 237, 0.55)",
    "border-radius: 6px",
  ].join(";");
  overlay.appendChild(btn);
  return btn;
}

/** Full-screen CONNECTION LOST screen with a RETURN TO MENU action. */
function showConnectionLost(): void {
  if (document.getElementById("mp-connection-lost")) return;
  const root = document.createElement("div");
  root.id = "mp-connection-lost";
  root.style.cssText = [
    "position: fixed",
    "inset: 0",
    "z-index: 90",
    "display: flex",
    "flex-direction: column",
    "align-items: center",
    "justify-content: center",
    "gap: 26px",
    "background: rgba(7, 4, 15, 0.92)",
    'font-family: "Orbitron", sans-serif',
  ].join(";");

  const title = document.createElement("div");
  title.textContent = "CONNECTION LOST";
  title.style.cssText =
    "font-size: 28px; font-weight: 700; letter-spacing: 5px; color: #f0abfc;";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "RETURN TO MENU";
  btn.style.cssText = [
    "padding: 13px 38px",
    "cursor: pointer",
    'font-family: "Orbitron", sans-serif',
    "font-size: 13px",
    "font-weight: 600",
    "letter-spacing: 2.5px",
    "color: #e9d5ff",
    "background: rgba(124, 58, 237, 0.25)",
    "border: 1px solid rgba(124, 58, 237, 0.6)",
    "border-radius: 6px",
  ].join(";");
  btn.addEventListener("click", () => window.location.assign("/"));

  root.appendChild(title);
  root.appendChild(btn);
  document.body.appendChild(root);
}

main();