import { MenuAudio } from "./MenuAudio";
import { AdSlot } from "./AdSlot";
import { playerProfile } from "./MenuConfig";
import type { MultiplayerClient } from "../network/MultiplayerClient";
import {
  MultiplayerConfig,
  generateGuestName,
  loadDisplayName,
  saveDisplayName,
} from "../network/MultiplayerConfig";
import {
  loadMapSelection,
  saveMapSelection,
  mapDisplayName,
  nextMapId,
} from "../world/MapSelection";

/** Ping dot colour classes (exactly one is set). */
const PING_TIERS = ["good", "ok", "bad", "off"] as const;

/** textContent write only when it changes (a rewrite re-lays out / repaints). */
function setTextIfChanged(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/**
 * MenuOverlay — the new Beanzo.io main menu: a pure DOM overlay rendered
 * ON TOP of the live game renderer (the map preview runs behind it).
 *
 * Owns all menu widgets:
 *   - profile card (top-left): editable guest name + level / XP / coins
 *   - nav bar (top-right): INVENTORY / SHOP / PARAMÈTRES (→ SettingsPage)
 *   - CLICK TO PLAY (center)
 *   - server panel (bottom-left): region / lobby / mode / live ping
 *   - LOADOUT + CUSTOMIZE (bottom-center)
 *   - AdSlot (right, under the nav)
 *
 * The SAME overlay doubles as the in-game PAUSE MENU: pressing Escape
 * brings it back (setPauseMode + show), with CLICK TO RESUME, the solo
 * BOTS panel and a LEAVE GAME action in multiplayer.
 *
 * All 3D rendering lives in Game (startMenuPreview) — this class never
 * touches Three.js.
 */
export class MenuOverlay {
  /** Fired when CLICK TO PLAY / CLICK TO RESUME is clicked. */
  onPlay: (() => void) | null = null;
  /** INVENTORY / LOADOUT → existing LoadoutMenu. */
  onLoadout: (() => void) | null = null;
  /** CUSTOMIZE → existing customization surface (LoadoutMenu today). */
  onCustomize: (() => void) | null = null;
  /** CHANGE (server panel) → compact lobby browser. */
  onChangeLobby: (() => void) | null = null;
  /** LEAVE GAME (pause menu, multiplayer only). */
  onLeaveGame: (() => void) | null = null;
  /** PARAMÈTRES (nav) → the settings page (main menu and pause menu alike). */
  onSettings: (() => void) | null = null;

  /** Current display name (persisted guest identity). */
  playerName: string;

  private readonly root: HTMLElement;
  private readonly adSlot: AdSlot;
  /** Live ping + lobby refresh timer — running only while the menu shows. */
  private pingTimer: number | null = null;
  /** Pending "asleep" switch once the hide fade is over (see sleep()). */
  private sleepTimer: number | null = null;
  private disposed = false;
  private readonly cleanups: (() => void)[] = [];
  /** First-launch graphics detection status (bottom of the menu). */
  private toast: HTMLElement | null = null;
  private toastTimer: number | null = null;

  constructor(
    private readonly sounds: MenuAudio,
    private readonly client: MultiplayerClient,
  ) {
    this.root = document.getElementById("main-menu")!;

    // ---- Identity: persisted display name (guest by default) ----
    const saved = loadDisplayName();
    this.playerName = saved ?? generateGuestName();
    if (!saved) saveDisplayName(this.playerName);

    // ---- Profile card ----
    this.setText("menu-player-name", this.playerName);
    this.setText("menu-player-level", `LVL ${playerProfile.level}`);
    this.setText(
      "menu-player-currency",
      playerProfile.currency.toLocaleString("en-US"),
    );
    const xpFill = document.getElementById("menu-xp-fill");
    if (xpFill) xpFill.style.width = `${Math.round(playerProfile.levelProgress * 100)}%`;
    const guestTag = document.getElementById("menu-profile-guest");
    if (guestTag) guestTag.classList.toggle("hidden", saved !== null);
    this.wireNameEditing();

    // ---- Server panel static labels ----
    this.setText("menu-region-value", MultiplayerConfig.serverRegion);
    this.setText("menu-map-value", mapDisplayName(loadMapSelection()));
    this.renderLobbyState();

    // ---- Ad slot (right column, under the nav) ----
    const adAnchor = document.getElementById("menu-ad-anchor")!;
    this.adSlot = new AdSlot(adAnchor);

    // ---- Buttons: sounds + actions ----
    this.wireButtons();
    this.wireClickToPlay();

    // ---- Live ping + lobby state (5 s, cheap) ----
    this.startLive();
  }

  // ------------------------------------------------------------- wiring

  private wireClickToPlay(): void {
    const cta = document.getElementById("menu-cta")!;
    const onEnter = () => this.sounds.hover();
    const onClick = () => {
      this.sounds.click();
      this.onPlay?.();
    };
    cta.addEventListener("pointerenter", onEnter);
    cta.addEventListener("click", onClick);
    this.cleanups.push(() => {
      cta.removeEventListener("pointerenter", onEnter);
      cta.removeEventListener("click", onClick);
    });
  }

  private wireButtons(): void {
    const buttons = this.root.querySelectorAll<HTMLButtonElement>("[data-menu]");
    buttons.forEach((btn) => {
      const onEnter = () => this.sounds.hover();
      btn.addEventListener("pointerenter", onEnter);
      this.cleanups.push(() => btn.removeEventListener("pointerenter", onEnter));

      const onClick = () => {
        this.sounds.click();
        switch (btn.dataset.menu) {
          case "inventory":
          case "loadout":
            this.onLoadout?.();
            break;
          case "customize":
            this.onCustomize?.();
            break;
          case "change-lobby":
            this.onChangeLobby?.();
            break;
          case "change-map": {
            // The map is loaded ONCE during the boot phase (same pattern
            // as the graphics preset): persist the next id, then reload.
            // Blocked while in a lobby — the room's map is fixed.
            if (this.client.isConnected) break;
            const next = nextMapId(loadMapSelection());
            saveMapSelection(next);
            this.setText("menu-map-value", `${mapDisplayName(next)} — RELOADING…`);
            setTimeout(() => window.location.reload(), 350);
            break;
          }
          case "leave":
            this.onLeaveGame?.();
            break;
          case "settings":
            this.onSettings?.();
            break;
          case "shop":
            // No shop system exists yet — the button shows "SOON".
            break;
        }
      };
      btn.addEventListener("click", onClick);
      this.cleanups.push(() => btn.removeEventListener("click", onClick));
    });
  }

  /** Inline name editing: click the pencil → input → Enter/blur saves. */
  private wireNameEditing(): void {
    const nameEl = document.getElementById("menu-player-name")!;
    const editBtn = document.getElementById("menu-name-edit")!;

    const startEdit = () => {
      this.sounds.click();
      const input = document.createElement("input");
      input.id = "menu-name-input";
      input.maxLength = MultiplayerConfig.maxNameLength;
      input.value = this.playerName;
      input.spellcheck = false;
      input.autocomplete = "off";
      nameEl.replaceWith(input);
      input.focus();
      input.select();

      const commit = () => {
        const name = input.value.trim().toUpperCase() || this.playerName;
        this.playerName = name.slice(0, MultiplayerConfig.maxNameLength);
        saveDisplayName(this.playerName);
        nameEl.textContent = this.playerName;
        input.replaceWith(nameEl);
        document.getElementById("menu-profile-guest")?.classList.add("hidden");
      };
      input.addEventListener("blur", commit, { once: true });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") input.blur();
        if (e.key === "Escape") {
          input.value = this.playerName;
          input.blur();
        }
      });
    };
    editBtn.addEventListener("click", startEdit);
    this.cleanups.push(() => editBtn.removeEventListener("click", startEdit));
  }

  // ------------------------------------------------------- live status

  /**
   * Live refresh (ping + lobby) every 5 s — only while the menu is on screen.
   * Hidden in game, it kept probing the server over HTTP and rewriting the
   * ping / lobby text every 5 s: style + layout passes of an invisible menu,
   * for nothing. Shown again → refreshed at once.
   */
  private startLive(): void {
    if (this.pingTimer !== null || this.disposed) return;
    this.pingTimer = window.setInterval(() => void this.refreshLive(), 5000);
    void this.refreshLive();
  }

  private stopLive(): void {
    if (this.pingTimer === null) return;
    window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** Ping + lobby occupancy refresh (connected RTT or HTTP probe). */
  private async refreshLive(): Promise<void> {
    let ping: number | null = null;
    if (this.client.isConnected && this.client.rttMs !== null) {
      ping = Math.round(this.client.rttMs);
    } else {
      ping = await this.client.probeLatency();
    }
    if (this.pingTimer === null) return; // hidden / disposed while probing

    const valueEl = document.getElementById("menu-ping-value");
    const dotEl = document.getElementById("menu-ping-dot");
    if (valueEl) setTextIfChanged(valueEl, ping !== null ? `${ping} ms` : "— ms");
    if (dotEl) {
      const tier = ping === null ? "off" : ping < 60 ? "good" : ping < 120 ? "ok" : "bad";
      // toggle(force) leaves the attribute alone when already in that state.
      for (const t of PING_TIERS) dotEl.classList.toggle(t, t === tier);
    }
    this.renderLobbyState();
  }

  /** Lobby row: joined room id + occupancy, or the solo default. */
  private renderLobbyState(): void {
    const lobbyEl = document.getElementById("menu-lobby-value");
    const subEl = document.getElementById("menu-mode-sub");
    if (!lobbyEl) return;
    if (this.client.isConnected && this.client.roomId) {
      const players = this.client.getPlayers().length;
      setTextIfChanged(lobbyEl, `${this.client.roomId} · ${players} in`);
      if (subEl) {
        setTextIfChanged(
          subEl,
          this.client.phase === "PLAYING"
            ? "Match in progress — go go go!"
            : "Waiting in lobby — host starts the match!",
        );
      }
    } else {
      setTextIfChanged(lobbyEl, "SOLO · VS BOTS");
      if (subEl) setTextIfChanged(subEl, "Every bean for themselves!");
    }
  }

  // ------------------------------------------------------------ states

  reveal(): void {
    this.wake();
    this.root.classList.remove("menu-hidden");
    this.startLive();
  }

  /** Show the menu again (Escape pause / return to menu). */
  show(): void {
    this.wake();
    this.root.classList.remove("menu-hidden", "menu-fade-out");
    this.startLive();
  }

  /** Hide the menu completely (opacity fade → visibility off → asleep). */
  hide(): void {
    this.root.classList.remove("menu-fade-out");
    this.root.classList.add("menu-hidden");
    this.hideGraphicsToast();
    this.stopLive();
    this.sleep();
  }

  /**
   * The settings page is up: the menu's own UI steps aside (the live map
   * stays visible next to the page, to see each change as it happens).
   */
  setSettingsOpen(open: boolean): void {
    this.root.parentElement?.classList.toggle("settings-open", open);
  }

  /**
   * Status of the automatic graphics detection (first launch): a small line at
   * the bottom of the menu. `action` turns it into a button (open the page);
   * `hideAfterMs` fades it out by itself.
   */
  showGraphicsToast(text: string, opts: { busy?: boolean; action?: () => void; hideAfterMs?: number } = {}): void {
    if (!this.toast) {
      this.toast = document.createElement("div");
      this.toast.id = "menu-gfx-toast";
      this.toast.setAttribute("role", "status");
      this.root.appendChild(this.toast);
    }
    const toast = this.toast;
    toast.textContent = "";
    const label = document.createElement("span");
    label.className = "gfx-toast-text";
    label.textContent = text;
    toast.appendChild(label);
    toast.classList.toggle("busy", opts.busy === true);
    if (opts.action) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gfx-toast-btn";
      btn.textContent = "Voir les réglages";
      const action = opts.action;
      btn.addEventListener("click", () => {
        this.sounds.click();
        this.hideGraphicsToast();
        action();
      });
      toast.appendChild(btn);
    }
    toast.classList.remove("hidden");
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer =
      opts.hideAfterMs !== undefined ? window.setTimeout(() => this.hideGraphicsToast(), opts.hideAfterMs) : null;
  }

  hideGraphicsToast(): void {
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = null;
    this.toast?.classList.add("hidden");
  }

  /**
   * Once the hide fade is over (0.35 s), the whole menu layer goes ASLEEP
   * (CSS #main-menu-root.menu-asleep: content-visibility hidden): invisible
   * already, it kept costing in game — its logo bob and CTA glow loops
   * restyled every frame, its content styled and laid out at every change.
   * Its rendering state is kept: woken up, it renders exactly as before.
   */
  private sleep(): void {
    if (this.sleepTimer !== null) window.clearTimeout(this.sleepTimer);
    this.sleepTimer = window.setTimeout(() => {
      this.sleepTimer = null;
      // Still hidden (a menu shown again in between is never put to sleep).
      if (this.root.classList.contains("menu-hidden")) {
        this.root.parentElement?.classList.add("menu-asleep");
      }
    }, 400);
  }

  private wake(): void {
    if (this.sleepTimer !== null) {
      window.clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    this.root.parentElement?.classList.remove("menu-asleep");
  }

  /** Fade the whole UI out (CLICK TO PLAY transition). */
  fadeOut(): void {
    this.root.classList.add("menu-fade-out");
  }

  /**
   * Switch between MAIN MENU and IN-GAME PAUSE MENU presentation:
   *   - CTA becomes CLICK TO RESUME;
   *   - CHANGE (lobby) is hidden mid-game;
   *   - LEAVE GAME appears (multiplayer only);
   *   - the solo BOTS panel appears (solo only).
   */
  setPauseMode(paused: boolean, isMultiplayer: boolean): void {
    const title = document.getElementById("menu-play-title");
    const sub = document.getElementById("menu-play-sub");
    if (title) title.textContent = paused ? "CLICK TO RESUME" : "CLICK TO PLAY";
    if (sub) {
      sub.innerHTML = paused
        ? `<span class="cta-sprout">🌿</span> BACK TO THE FIGHT, BEAN!`
        : `<span class="cta-sprout">🌱</span> JUMP RIGHT IN. NO WAITING.`;
    }

    // Lobby can't be changed mid-game.
    const change = this.root.querySelector<HTMLButtonElement>(
      '[data-menu="change-lobby"]',
    );
    if (change) change.style.display = paused ? "none" : "";

    // The map can't be changed mid-game either (it would reload the page).
    const changeMap = this.root.querySelector<HTMLButtonElement>(
      '[data-menu="change-map"]',
    );
    if (changeMap) changeMap.style.display = paused ? "none" : "";

    // LEAVE GAME: multiplayer pause only.
    const leave = this.root.querySelector<HTMLButtonElement>('[data-menu="leave"]');
    leave?.classList.toggle("hidden", !(paused && isMultiplayer));

    // Solo BOTS panel (existing BotsMenu wiring — applied instantly).
    this.root.classList.toggle("paused-solo", paused && !isMultiplayer);
  }

  dispose(): void {
    this.disposed = true;
    this.hideGraphicsToast();
    this.stopLive();
    if (this.sleepTimer !== null) window.clearTimeout(this.sleepTimer);
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
    this.adSlot.dispose();
    // Remove the whole menu layer (root container included).
    document.getElementById("main-menu-root")?.remove();
  }

  private setText(id: string, text: string): void {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
}