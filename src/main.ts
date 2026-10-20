import { Game } from "./game/Game";
import { LoadoutMenu } from "./menu/LoadoutMenu";
import { CustomizeMenu } from "./menu/CustomizeMenu";
import { MenuAudio } from "./menu/MenuAudio";
import { MenuOverlay } from "./menu/MenuOverlay";
import { LobbyBrowser } from "./menu/LobbyBrowser";
import { LobbyController } from "./network/LobbyController";
import { MultiplayerClient } from "./network/MultiplayerClient";
import { loadDisplayName, parseJoinRoomId } from "./network/MultiplayerConfig";
import { MatchEndController } from "./match/MatchEndController";
import { displayFrameMs, measureDisplayFrames } from "./ui/displayFrames";
import { bootMark, reportBoot } from "./ui/bootTimeline";
import { hudHost } from "./hud/host/HudHost";
import { startWeaponIcons, weaponIconsIdle } from "./menu/WeaponIconRenderer";
import { buildMapBvhsWhenIdle, flushMapBvhs } from "./world/MapBvh";
import { settingsStore } from "./settings/SettingsStore";
import { GraphicsController } from "./settings/GraphicsController";
import { snapRefreshRate, type AutoResult } from "./settings/GraphicsSettings";
import { SettingsPage, REOPEN_KEY } from "./menu/SettingsPage";
import { currentDisplayEnv, isWeakGpuName } from "./game/GraphicsQuality";

/**
 * Boot flow — "the menu is just an overlay on top of the game":
 *
 *   page load
 *   → ONE loading phase (physics WASM + map + NavGrid + every weapon GLB
 *     + full GPU shader warm-up — everything gameplay needs). Its steps
 *     overlap instead of waiting for each other: every file is requested at
 *     its start, the shaders compile in the browser's GPU process while the
 *     weapons are parsed, the HUD warm-up runs during that compile (where
 *     the browser compiles in parallel). The console line `[BOOT]` gives the
 *     time of each step (see ui/bootTimeline). The in-match HUD loads in
 *     its own document meanwhile (hud/host/HudHost: an isolated iframe, or
 *     this page as the fallback).
 *   → Main Menu revealed: the REAL map renders behind the UI with a slow
 *     cinematic orbit camera (same renderer/scene as gameplay — no
 *     duplicate scene, no second loading later)
 *   → CLICK TO PLAY → camera flies down to the player's eye → FPS
 *     controls active immediately. No second loading screen.
 *
 * PAUSE: pressing Escape in game reopens the SAME menu overlay
 * (CLICK TO RESUME + solo bots panel / multiplayer LEAVE GAME) —
 * there is no separate pause screen anymore.
 *
 * Multiplayer: the same Game instance powers both modes. CHANGE (server
 * panel) opens the lobby browser; create/join reuse the existing
 * LobbyController; the SERVER flips the room phase to PLAYING and every
 * client enters the match (assets are already warm → near-instant).
 */
async function main(): Promise<void> {
  // The HUD document (iframe) starts loading now, alongside the game's assets.
  hudHost.start();
  const container = document.getElementById("app")!;
  const loading = document.getElementById("menu-loading")!;
  bootMark("page");
  // The display's frame interval (the HUD warm-up's "drawn" tests rely on
  // it): measured now, while the loading screen mostly waits on downloads.
  void measureDisplayFrames();

  // ---- ONE loading phase: build + warm EVERYTHING now ----
  // The map, physics, nav grid, every weapon GLB and every shader are
  // ready before the menu appears — CLICK TO PLAY is then instant.
  const game = await Game.create(container);
  // GPU warm-up + HUD warm-up: the rare HUD effects (kill medal, combo,
  // vignettes, death card…) are drawn once, invisibly, before the loading
  // screen goes away — the first kill / hit / death never pays their
  // first-draw cost in game. Where the browser compiles shaders in
  // parallel, the HUD warm-up runs DURING the shader compile (see
  // Game.warmUpRendering, step 3a), otherwise right after the GPU warm-up.
  // (The weapon plates' paint shader is compiled by the HUD runtime itself.)
  await game.warmUpRendering((gpuBusy) => hudHost.warmUp(gpuBusy).then(() => bootMark("HUD")));

  // ---- Menu overlay over the live game renderer ----
  const sounds = new MenuAudio();
  void sounds.preload();
  const loadoutMenu = new LoadoutMenu(sounds);
  const customizeMenu = new CustomizeMenu(sounds);

  const multiplayer = new MultiplayerClient();
  const menu = new MenuOverlay(sounds, multiplayer);
  const lobby = new LobbyController(multiplayer, menu.playerName);
  const browser = new LobbyBrowser(multiplayer, sounds);

  // ---- Reveal: cinematic map preview + UI fade-in + menu music ----
  loading.classList.add("hidden");
  // Once faded out (0.5 s), take it out of the rendering for good: its logo
  // bob + pulse animations kept being restyled every frame for the whole
  // session (opacity 0 does not stop CSS animations).
  window.setTimeout(() => {
    loading.style.display = "none";
  }, 700);
  game.startMenuPreview();
  menu.reveal();
  sounds.startMusic();
  bootMark("menu");
  reportBoot();
  // Loadout / customize icon snapshots: once the menu is up (they are queued
  // since the menus were built — see WeaponIconRenderer), or right away when
  // one of those menus opens first.
  window.setTimeout(startWeaponIcons, 1200);
  // The map's raycast BVHs, one per idle slot of the menu (see MapBvh).
  buildMapBvhsWhenIdle();

  // ---- Menu wiring ----
  menu.onLoadout = () => {
    stopDetection(); // (defined below: these run on clicks, after main())
    startWeaponIcons();
    loadoutMenu.open();
  };
  // CUSTOMIZE: cosmetic skins (live 3D preview of the real ball). The
  // selection is persisted; the game re-reads it in applyLoadout() (match
  // entry / respawn / solo resume) — a skin change never resets a weapon.
  menu.onCustomize = () => {
    stopDetection(); // (defined below: these run on clicks, after main())
    startWeaponIcons();
    customizeMenu.open();
  };
  menu.onChangeLobby = () => browser.open();

  browser.onCreate = () => lobby.open();
  browser.onJoinByCode = () => lobby.open();
  browser.onJoin = (roomId) => lobby.openWithInvite(roomId);

  // Invite link: /join/{roomId} → open the lobby overlay and auto-join.
  const inviteRoomId = parseJoinRoomId(window.location.pathname);
  if (inviteRoomId) {
    // Clean the URL so a refresh doesn't re-trigger the join.
    window.history.replaceState(null, "", "/");
    lobby.openWithInvite(inviteRoomId);
  } else if (!lobby.resumePendingReturn()) {
    // (End-of-match return handled above: the page reloaded onto the voted
    // map and rejoins the same room with its seat token.)
    // CREATE LOBBY on another map: the host's page reloaded with that map
    // (single boot loading phase) → finish the creation now.
    lobby.resumePendingCreate();
  }

  let inGame = false;
  let entering = false;
  let inMultiplayerGame = false;

  // ---- SETTINGS PAGE (nav PARAMÈTRES, main menu and pause menu) ----
  // One settings record (src/settings/SettingsStore); the controller applies
  // every change to the game (live when possible) and runs the automatic
  // detection; the page edits the record.
  const store = settingsStore();
  const refreshHz = (): number => snapRefreshRate(1000 / displayFrameMs());
  const graphics = new GraphicsController(
    store,
    game,
    currentDisplayEnv,
    refreshHz,
    (crosshair) => hudHost.api.applyCrosshairSettings(crosshair),
    isWeakGpuName,
  );
  const settingsPage = new SettingsPage({
    store,
    controller: graphics,
    game,
    sounds,
    isInMatch: () => inGame,
    refreshHz,
    env: currentDisplayEnv,
  });
  settingsPage.onOpenChange = (open) => menu.setSettingsOpen(open);
  menu.onSettings = () => {
    startWeaponIcons();
    settingsPage.open();
  };
  // « Appliquer et recharger »: back on the page after the reload.
  try {
    if (sessionStorage.getItem(REOPEN_KEY)) {
      sessionStorage.removeItem(REOPEN_KEY);
      settingsPage.open("graphics");
    }
  } catch {
    /* no session storage */
  }
  // FIRST LAUNCH of a player who never chose (or a new GPU): the automatic
  // detection measures the menu's live map a few seconds after it appears —
  // once the menu's own start-up work (icon snapshots in a second WebGL
  // context) is over. PLAY, LOADOUT or CUSTOMIZE stop it (the player's
  // previous settings come back; it runs again at the next launch).
  graphics.subscribe((e) => {
    if (e.kind === "start" && e.reason === "first") {
      menu.showGraphicsToast("Réglage automatique des graphismes pour ce PC…", { busy: true });
    } else if (e.kind === "done" && e.reason === "first") {
      menu.showGraphicsToast(toastSummary(e.result), {
        action: () => settingsPage.open("graphics"),
        hideAfterMs: 10000,
      });
    } else if (e.kind === "cancelled") {
      menu.hideGraphicsToast();
    }
  });
  const stopDetection = (): void => {
    if (graphics.detecting) graphics.cancelDetection();
  };
  if (graphics.needsFirstDetection()) {
    void (async () => {
      await new Promise((r) => window.setTimeout(r, 2500));
      await weaponIconsIdle();
      // A menu overlay over the map (3D preview, icons) or the match: try again a bit later.
      for (let i = 0; i < 30; i++) {
        if (inGame || entering) return;
        if (!loadoutMenu.isOpen && !customizeMenu.isOpen) break;
        await new Promise((r) => window.setTimeout(r, 1000));
      }
      if (inGame || entering || loadoutMenu.isOpen || customizeMenu.isOpen) return;
      if (graphics.needsFirstDetection()) void graphics.runDetection("first");
    })();
  }

  /** `#hud.menu-active` (HUD document; mirrored on this page's <html>: #debug). */
  const setHudMenuActive = (on: boolean): void => hudHost.api.setDocClass("hud", "menu-active", on);
  /** `body.game-paused`: this page's own rules (#debug, #network-debug-hud) and the HUD document's. */
  const setGamePaused = (on: boolean): void => {
    document.body.classList.toggle("game-paused", on);
    hudHost.api.setDocClass("body", "game-paused", on);
  };

  // ---- END OF MATCH (5-minute FFA clock): end screen + next-map vote ----
  // While it is up, the pause menu never reopens and the HUD is hidden
  // (the end screen covers the frozen world).
  const matchEnd = new MatchEndController(game, multiplayer);
  matchEnd.onShown = () => {
    menu.hide();
    setGamePaused(false);
    setHudMenuActive(true);
  };
  matchEnd.onSoloReplay = () => setHudMenuActive(false);

  // Player card name tag: the persisted name (the lobby / menu rename save
  // it) — refreshed on every entry / resume, the HUD change-detects it.
  const syncPlayerName = (): void => game.setPlayerName(loadDisplayName() ?? menu.playerName);
  syncPlayerName();

  /**
   * Shared Menu → Game hand-off (solo PLAY and multiplayer START GAME).
   * Solo uses the cinematic camera flight; multiplayer skips it (the mp
   * loading screen covers the swap while remote avatars are prepared).
   * The menu is only HIDDEN — Escape brings it back as the pause menu.
   */
  const enterGameplay = async (withCameraFlight: boolean): Promise<void> => {
    inGame = true;
    // A detection still measuring the menu stops (the player's settings come back).
    stopDetection();
    settingsPage.close();
    // Raycast BVHs not built yet (PLAY right after the menu appeared): now,
    // before the camera flight — never during it.
    flushMapBvhs();

    sounds.fadeOutMusic(0.8);
    menu.fadeOut();
    browser.close();

    if (withCameraFlight) {
      // Cinematic camera flies down into the player's first-person eye.
      await game.beginMenuPlayTransition();
    } else {
      game.stopMenuPreview();
    }

    menu.hide();
    // Gameplay HUD becomes visible.
    syncPlayerName();
    setHudMenuActive(false);

    game.start();

    // The click keeps transient user activation for a few seconds — enough
    // to enter pointer lock right after the camera flight.
    game.requestPointerLock();
  };

  // ---- CLICK TO PLAY (first time) / CLICK TO RESUME (paused) ----
  menu.onPlay = () => {
    if (!inGame) {
      if (entering) return;
      entering = true;
      void enterGameplay(true);
    } else {
      // Resume: re-lock the pointer; the lock event hides the menu.
      game.requestPointerLock();
    }
  };

  // ---- ESCAPE ↔ PAUSE: losing pointer lock while focused reopens the
  // MAIN MENU as the pause menu (solo pauses internally; multiplayer
  // keeps running behind it — the server never pauses a match). ----
  document.addEventListener("pointerlockchange", () => {
    if (!inGame || matchEnd.isShowing || game.isMatchOver) return;
    const locked = document.pointerLockElement === game.domElement;
    if (locked) {
      menu.hide();
      syncPlayerName(); // a rename in the pause menu shows on the card
      // Back in the fight: reveal the gameplay HUD again.
      setGamePaused(false);
    } else if (document.hasFocus()) {
      menu.setPauseMode(true, inMultiplayerGame);
      menu.show();
      // Pause: EVERY in-game HUD element is hidden (CSS body.game-paused).
      setGamePaused(true);
    }
    // Focus-loss unlock (Alt-Tab): nothing appears — clicking the game
    // view re-locks directly (handler below).
  });

  // Clicking the world (any non-panel area — the menu root lets clicks
  // through) resumes the game instantly, Krunker-style.
  container.addEventListener("click", () => {
    if (matchEnd.isShowing || game.isMatchOver) return;
    if (inGame && document.pointerLockElement !== game.domElement) {
      game.requestPointerLock();
    }
  });

  // ---- LEAVE GAME (pause menu, multiplayer only): clean room leave →
  // remote avatars removed → back to the main menu (fresh app state). ----
  menu.onLeaveGame = () => {
    void (async () => {
      inMultiplayerGame = false;
      game.disableMultiplayer();
      await multiplayer.leaveLobby(); // clean WebSocket leave, no brutal close
      window.location.assign("/"); // fresh boot back to the main menu
    })();
  };

  // ---- MULTIPLAYER: the SERVER decides the launch. Every client (host
  // included) reacts to the room phase flipping to PLAYING — the host's
  // click alone never starts anything locally. ----
  multiplayer.onPhaseChanged = (phase) => {
    if (phase !== "PLAYING" || inGame) return;
    void (async () => {
      lobby.close();
      // Everything heavy is ALREADY warm (single boot loading phase) —
      // this screen only covers remote-avatar preparation (fast).
      const loadingScreen = showMpLoadingScreen();
      try {
        game.stopMenuPreview();
        await game.enableMultiplayer(multiplayer);
        inMultiplayerGame = true;
        await enterGameplay(false);
      } finally {
        loadingScreen.dispose();
      }
    })();
  };

  // ---- CONNECTION LOST: server/network dropped mid-game. Freeze the flow
  // and offer RETURN TO MENU (no silent "everything is fine" gameplay). ----
  const lobbyOnLeft = multiplayer.onLeft; // LobbyController's handler (Phase 1)
  multiplayer.onLeft = (intentional) => {
    lobbyOnLeft?.(intentional);
    // After the match the end screen owns the flow (reload onto the map).
    if (inMultiplayerGame && !intentional && !matchEnd.isShowing) {
      inMultiplayerGame = false;
      game.disableMultiplayer();
      document.exitPointerLock();
      showConnectionLost();
    }
  };
}

/** One line for the menu's toast after the first-launch detection. */
function toastSummary(result: AutoResult): string {
  if (result.limitedBy === "cpu") return "Graphismes réglés : c'est le processeur qui limite ce PC, le rendu reste beau.";
  if (result.belowTarget) {
    const fps = result.expectedFps !== null ? ` (environ ${result.expectedFps} i/s)` : "";
    return `Graphismes réglés au plus léger encore joli${fps}.`;
  }
  return `Graphismes réglés pour tenir ${result.targetFps} i/s.`;
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