import { Game } from "./game/Game";
import { MainMenu } from "./menu/MainMenu";
import { LoadoutMenu } from "./menu/LoadoutMenu";
import { MenuAudio } from "./menu/MenuAudio";
import { playerProfile } from "./menu/MenuConfig";
import { LobbyController } from "./network/LobbyController";
import { MultiplayerClient } from "./network/MultiplayerClient";
import { parseJoinRoomId } from "./network/MultiplayerConfig";

/**
 * Boot flow:
 *
 *   page load
 *   → minimal "BEANZO.IO / LOADING…" screen
 *   → Game (physics/map) + Main Menu (character/weapons/prairie) preload in parallel
 *   → Main Menu revealed with a fade (cursor visible, no pointer lock)
 *   → PLAY → short green transition → menu disposed → existing gameplay starts
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
  // Failures never block Beanzo.io: the overlay shows its own error screens.
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

    // GPU warm-up BEFORE the transition (no-op if multiplayer already ran
    // it): every weapon GLB loaded + every shader compiled while the menu
    // still covers the canvas — gameplay is fluid from the first frame.
    await game.warmUpRendering();

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
      // Animated space loading screen covers EVERYTHING while assets,
      // shaders and remote avatars are prepared (no frozen main menu).
      const loadingScreen = showMpLoadingScreen();
      try {
        // Character asset preload + bots off + server-assigned spawn applied.
        await game.enableMultiplayer(multiplayer);
        await enterGameplay();
      } finally {
        loadingScreen.dispose();
      }
      inMultiplayerGame = true;
      leaveBtn.classList.remove("hidden");
      loadoutBtn.classList.remove("hidden");
      loadoutHint.classList.remove("hidden");
    })();
  };

  // ---- LOADOUT (Escape menu, multiplayer only): replaces the solo bots
  // panel. Opens the same Loadout overlay as the Main Menu; the new
  // selection is applied on the player's NEXT RESPAWN (never mid-life).
  // Death itself stays fully automatic — no menu ever pops on respawn. ----
  const { button: loadoutBtn, hint: loadoutHint } = createLoadoutButton(overlay);
  let inGameLoadout: LoadoutMenu | null = null;
  loadoutBtn.addEventListener("click", (e) => {
    e.stopPropagation(); // never triggers the overlay's pointer-lock click
    if (!inGameLoadout) {
      const sounds = new MenuAudio();
      void sounds.preload(); // hover/click ticks only — no menu music
      inGameLoadout = new LoadoutMenu(sounds);
    }
    inGameLoadout.open();
  });

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

/**
 * Full-screen MULTIPLAYER loading screen with an animated prairie-night
 * background: two drifting firefly layers (different speeds → parallax),
 * a soft green meadow glow and a pulsing "ENTERING THE MATCH" label.
 * Shown while the match assets / shaders / avatars are prepared, then
 * faded out once gameplay is ready.
 */
function showMpLoadingScreen(): { dispose: () => void } {
  // One-time CSS (star drift, twinkle, label pulse, fade-out).
  if (!document.getElementById("mp-loading-styles")) {
    const style = document.createElement("style");
    style.id = "mp-loading-styles";
    style.textContent = `
@keyframes mp-load-drift {
  from { transform: translateY(0); }
  to { transform: translateY(-50%); }
}
@keyframes mp-load-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
@keyframes mp-load-dots {
  0% { content: ""; } 25% { content: "."; } 50% { content: ".."; } 75% { content: "..."; }
}
#mp-loading-screen { transition: opacity 0.5s ease; }
#mp-loading-screen .mp-load-dots::after {
  content: ""; animation: mp-load-dots 1.2s steps(4) infinite;
}
`;
    document.head.appendChild(style);
  }

  const root = document.createElement("div");
  root.id = "mp-loading-screen";
  root.style.cssText = [
    "position: fixed",
    "inset: 0",
    "z-index: 95",
    "overflow: hidden",
    "display: flex",
    "flex-direction: column",
    "align-items: center",
    "justify-content: center",
    "gap: 18px",
    // Prairie-night green gradient + meadow glows.
    "background:" +
      "radial-gradient(ellipse 60% 45% at 70% 25%, rgba(21, 94, 47, 0.35), transparent 70%)," +
      "radial-gradient(ellipse 50% 40% at 25% 75%, rgba(13, 62, 30, 0.4), transparent 70%)," +
      "linear-gradient(180deg, #030c06 0%, #08160c 55%, #030c06 100%)",
  ].join(";");

  // Two drifting firefly layers (box-shadow star fields, random each time).
  const makeStars = (count: number, size: number, duration: number, opacity: number) => {
    const shadows: string[] = [];
    for (let i = 0; i < count; i++) {
      const x = Math.round(Math.random() * 100);
      const y = Math.round(Math.random() * 200); // 200vh → seamless -50% loop
      const c = Math.random() < 0.25 ? "#bbf7d0" : "#f0fdf4";
      shadows.push(`${x}vw ${y}vh 0 ${c}`);
    }
    const layer = document.createElement("div");
    layer.style.cssText = [
      "position: absolute",
      "top: 0",
      "left: 0",
      "width: 100%",
      "height: 200vh",
      "pointer-events: none",
      `opacity: ${opacity}`,
      `animation: mp-load-drift ${duration}s linear infinite`,
    ].join(";");
    const dot = document.createElement("div");
    dot.style.cssText = [
      `width: ${size}px`,
      `height: ${size}px`,
      "border-radius: 50%",
      "background: transparent",
      `box-shadow: ${shadows.join(",")}`,
    ].join(";");
    layer.appendChild(dot);
    return layer;
  };
  root.appendChild(makeStars(110, 1, 60, 0.55)); // far layer — slow
  root.appendChild(makeStars(60, 2, 34, 0.9)); // near layer — faster

  const title = document.createElement("div");
  title.textContent = "ENTERING THE MATCH";
  title.style.cssText = [
    "position: relative",
    'font-family: "Luckiest Guy", cursive',
    "font-size: 24px",
    "font-weight: 400",
    "letter-spacing: 6px",
    "color: #dcfce7",
    "text-shadow: 0 0 24px rgba(74, 222, 128, 0.7)",
    "animation: mp-load-pulse 1.8s ease-in-out infinite",
  ].join(";");
  root.appendChild(title);

  const sub = document.createElement("div");
  sub.className = "mp-load-dots";
  sub.textContent = "LOADING";
  sub.style.cssText = [
    "position: relative",
    'font-family: "Baloo 2", sans-serif',
    "font-size: 15px",
    "font-weight: 600",
    "letter-spacing: 4px",
    "color: #86bd94",
  ].join(";");
  root.appendChild(sub);

  document.body.appendChild(root);

  return {
    dispose: () => {
      root.style.opacity = "0";
      setTimeout(() => root.remove(), 550); // matches the CSS transition
    },
  };
}

/** "LOADOUT" button + hint inside the Escape overlay (multiplayer only). */
function createLoadoutButton(overlay: HTMLElement): {
  button: HTMLButtonElement;
  hint: HTMLElement;
} {
  const btn = document.createElement("button");
  btn.id = "mp-loadout";
  btn.type = "button";
  btn.textContent = "LOADOUT";
  btn.classList.add("hidden");
  btn.style.cssText = [
    "margin-top: 26px",
    "padding: 12px 34px",
    "cursor: pointer",
    'font-family: "Luckiest Guy", cursive',
    "font-size: 13px",
    "font-weight: 400",
    "letter-spacing: 2.5px",
    "color: #f0fdf4",
    "background: rgba(22, 163, 74, 0.35)",
    "border: 1px solid rgba(187, 247, 208, 0.7)",
    "border-radius: 12px",
  ].join(";");
  overlay.appendChild(btn);

  const hint = document.createElement("div");
  hint.id = "mp-loadout-hint";
  hint.textContent = "Changes apply on your next respawn";
  hint.classList.add("hidden");
  hint.style.cssText = [
    "margin-top: 8px",
    'font-family: "Baloo 2", sans-serif',
    "font-size: 13px",
    "letter-spacing: 1.5px",
    "color: #86bd94",
  ].join(";");
  overlay.appendChild(hint);

  return { button: btn, hint };
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
    'font-family: "Luckiest Guy", cursive',
    "font-size: 13px",
    "font-weight: 400",
    "letter-spacing: 2.5px",
    "color: #dcfce7",
    "background: rgba(22, 163, 74, 0.2)",
    "border: 1px solid rgba(22, 163, 74, 0.55)",
    "border-radius: 12px",
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
    "background: rgba(4, 12, 7, 0.92)",
    'font-family: "Luckiest Guy", cursive',
  ].join(";");

  const title = document.createElement("div");
  title.textContent = "CONNECTION LOST";
  title.style.cssText =
    "font-size: 28px; font-weight: 400; letter-spacing: 5px; color: #fbbf24;";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "RETURN TO MENU";
  btn.style.cssText = [
    "padding: 13px 38px",
    "cursor: pointer",
    'font-family: "Luckiest Guy", cursive',
    "font-size: 13px",
    "font-weight: 400",
    "letter-spacing: 2.5px",
    "color: #dcfce7",
    "background: rgba(22, 163, 74, 0.25)",
    "border: 1px solid rgba(22, 163, 74, 0.6)",
    "border-radius: 12px",
  ].join(";");
  btn.addEventListener("click", () => window.location.assign("/"));

  root.appendChild(title);
  root.appendChild(btn);
  document.body.appendChild(root);
}

main();