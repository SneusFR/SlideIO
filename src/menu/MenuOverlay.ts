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
  detectQualityLevel,
  loadQualityMode,
  saveQualityMode,
  QualityMode,
  loadFpsCapMode,
  saveFpsCapMode,
  resolveMaxFps,
  presetMaxFps,
  FpsCapMode,
} from "../game/GraphicsQuality";
import { audio, type AudioBus } from "../audio/AudioManager";
import {
  applyCrosshairSettings,
  loadCrosshairSettings,
  saveCrosshairSettings,
  DEFAULT_CROSSHAIR,
  type CrosshairSettings,
} from "../ui/CrosshairSettings";
import {
  loadMapSelection,
  saveMapSelection,
  mapDisplayName,
  nextMapId,
} from "../world/MapSelection";

/**
 * MenuOverlay — the new Beanzo.io main menu: a pure DOM overlay rendered
 * ON TOP of the live game renderer (the map preview runs behind it).
 *
 * Owns all menu widgets:
 *   - profile card (top-left): editable guest name + level / XP / coins
 *   - nav bar (top-right): INVENTORY / SHOP / SETTINGS
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
  /** FPS LIMIT changed: effective maxFps (Infinity = uncapped) — live. */
  onFpsCapChange: ((maxFps: number) => void) | null = null;

  /** Current display name (persisted guest identity). */
  playerName: string;

  private readonly root: HTMLElement;
  private readonly adSlot: AdSlot;
  private pingTimer: number | null = null;
  private settingsOpen = false;
  private readonly cleanups: (() => void)[] = [];

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
    this.wireSettings();
    this.wireClickToPlay();

    // ---- Live ping + lobby state (5 s, cheap) ----
    const tick = () => void this.refreshLive();
    void this.refreshLive();
    this.pingTimer = window.setInterval(tick, 5000);
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
            this.toggleSettings();
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

  /** Small SETTINGS popover: the real graphics quality cycle. */
  private wireSettings(): void {
    const pop = document.getElementById("menu-settings-pop")!;
    const qualityBtn = document.getElementById("menu-quality-btn") as HTMLButtonElement;

    const label = (mode: QualityMode): string =>
      mode === "AUTO"
        ? `GRAPHICS: AUTO (${detectQualityLevel()})`
        : `GRAPHICS: ${mode}`;
    qualityBtn.textContent = label(loadQualityMode());

    const onQuality = () => {
      this.sounds.click();
      const order: QualityMode[] = ["AUTO", "LOW", "HIGH"];
      const next = order[(order.indexOf(loadQualityMode()) + 1) % order.length];
      saveQualityMode(next);
      qualityBtn.textContent = `${label(next)} — RELOADING…`;
      // Renderer settings (MSAA) are fixed at context creation → reload.
      setTimeout(() => window.location.reload(), 350);
    };
    qualityBtn.addEventListener("click", onQuality);
    this.cleanups.push(() => qualityBtn.removeEventListener("click", onQuality));

    // FPS LIMIT: pure loop pacing — applies LIVE (no reload), persisted.
    // AUTO follows the preset (LOW → 60, HIGH → uncapped); 60 forces the
    // cap (fixes unstable-rAF laptops); OFF uncaps 120/240 Hz displays.
    const fpsBtn = document.getElementById("menu-fps-btn") as HTMLButtonElement;
    const fpsLabel = (mode: FpsCapMode): string => {
      if (mode === "AUTO") {
        const auto = resolveMaxFps(presetMaxFps(), "AUTO");
        return `FPS LIMIT: AUTO (${Number.isFinite(auto) ? auto : "OFF"})`;
      }
      return `FPS LIMIT: ${mode}`;
    };
    fpsBtn.textContent = fpsLabel(loadFpsCapMode());

    const onFpsCap = () => {
      this.sounds.click();
      const order: FpsCapMode[] = ["AUTO", "60", "OFF"];
      const next = order[(order.indexOf(loadFpsCapMode()) + 1) % order.length];
      saveFpsCapMode(next);
      fpsBtn.textContent = fpsLabel(next);
      this.onFpsCapChange?.(resolveMaxFps(presetMaxFps(), next));
    };
    fpsBtn.addEventListener("click", onFpsCap);
    this.cleanups.push(() => fpsBtn.removeEventListener("click", onFpsCap));

    this.wireVolumeSliders(pop);
    this.wireCrosshairSettings();

    // Click outside closes the popover.
    const onDocClick = (e: MouseEvent) => {
      if (!this.settingsOpen) return;
      const target = e.target as HTMLElement;
      if (pop.contains(target) || target.closest('[data-menu="settings"]')) return;
      this.toggleSettings(false);
    };
    document.addEventListener("click", onDocClick);
    this.cleanups.push(() => document.removeEventListener("click", onDocClick));
  }

  /**
   * AUDIO sliders (Main / Weapon / Music / Ambiance): each range input
   * carries a data-volume-bus attribute mapping straight onto an
   * AudioManager bus. Values apply live and persist via setUserVolume.
   */
  private wireVolumeSliders(pop: HTMLElement): void {
    // Buses that follow a slider's primary bus: weapon IMPACT sounds
    // (hammer hits, explosions…) live on the "impacts" bus but belong to
    // the WEAPON VOLUME slider from the player's point of view.
    const linkedBuses: Partial<Record<AudioBus, AudioBus[]>> = {
      weapons: ["impacts"],
    };

    const sliders = pop.querySelectorAll<HTMLInputElement>("input[data-volume-bus]");
    sliders.forEach((slider) => {
      const bus = slider.dataset.volumeBus as AudioBus;
      const valueEl = document.getElementById(`${slider.id}-value`);

      const render = (v: number) => {
        slider.value = String(Math.round(v * 100));
        if (valueEl) valueEl.textContent = `${Math.round(v * 100)}%`;
      };
      render(audio.getUserVolume(bus));

      const onInput = () => {
        const v = Number(slider.value) / 100;
        audio.setUserVolume(bus, v);
        for (const linked of linkedBuses[bus] ?? []) audio.setUserVolume(linked, v);
        if (valueEl) valueEl.textContent = `${slider.value}%`;
      };
      // A soft click on release gives instant audible feedback of the
      // new level (skipped for buses no UI sound plays through).
      const onChange = () => {
        if (bus === "master" || bus === "ui") this.sounds.click();
      };
      slider.addEventListener("input", onInput);
      slider.addEventListener("change", onChange);
      this.cleanups.push(() => {
        slider.removeEventListener("input", onInput);
        slider.removeEventListener("change", onChange);
      });
    });
  }

  /**
   * CROSSHAIR section: shape toggle (DOT ↔ CROSS), size slider (50–250%)
   * and color picker (+ RESET to white). Applied LIVE on the #crosshair
   * element (pure CSS variables — see CrosshairSettings.ts) and persisted
   * to localStorage on every change.
   */
  private wireCrosshairSettings(): void {
    const shapeBtn = document.getElementById("menu-ch-shape-btn") as HTMLButtonElement | null;
    const sizeSlider = document.getElementById("menu-ch-size") as HTMLInputElement | null;
    const sizeValue = document.getElementById("menu-ch-size-value");
    const colorInput = document.getElementById("menu-ch-color") as HTMLInputElement | null;
    const colorReset = document.getElementById("menu-ch-color-reset") as HTMLButtonElement | null;
    if (!shapeBtn || !sizeSlider || !colorInput || !colorReset) return;

    let settings: CrosshairSettings = loadCrosshairSettings();

    const render = () => {
      shapeBtn.textContent = `SHAPE: ${settings.shape}`;
      sizeSlider.value = String(Math.round(settings.scale * 100));
      if (sizeValue) sizeValue.textContent = `${Math.round(settings.scale * 100)}%`;
      colorInput.value = settings.color;
    };
    const commit = () => {
      applyCrosshairSettings(settings);
      saveCrosshairSettings(settings);
    };
    render();
    // Boot-time apply: the saved crosshair is live before the first match.
    applyCrosshairSettings(settings);

    const onShape = () => {
      this.sounds.click();
      settings = { ...settings, shape: settings.shape === "DOT" ? "CROSS" : "DOT" };
      render();
      commit();
    };
    const onSize = () => {
      settings = { ...settings, scale: Number(sizeSlider.value) / 100 };
      if (sizeValue) sizeValue.textContent = `${sizeSlider.value}%`;
      commit();
    };
    const onColor = () => {
      settings = { ...settings, color: colorInput.value };
      commit();
    };
    const onReset = () => {
      this.sounds.click();
      settings = { ...settings, color: DEFAULT_CROSSHAIR.color };
      render();
      commit();
    };

    shapeBtn.addEventListener("click", onShape);
    sizeSlider.addEventListener("input", onSize);
    colorInput.addEventListener("input", onColor);
    colorReset.addEventListener("click", onReset);
    this.cleanups.push(() => {
      shapeBtn.removeEventListener("click", onShape);
      sizeSlider.removeEventListener("input", onSize);
      colorInput.removeEventListener("input", onColor);
      colorReset.removeEventListener("click", onReset);
    });
  }

  private toggleSettings(force?: boolean): void {
    const pop = document.getElementById("menu-settings-pop")!;
    this.settingsOpen = force ?? !this.settingsOpen;
    pop.classList.toggle("hidden", !this.settingsOpen);
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

  /** Ping + lobby occupancy refresh (connected RTT or HTTP probe). */
  private async refreshLive(): Promise<void> {
    let ping: number | null = null;
    if (this.client.isConnected && this.client.rttMs !== null) {
      ping = Math.round(this.client.rttMs);
    } else {
      ping = await this.client.probeLatency();
    }
    if (this.pingTimer === null) return; // disposed while probing

    const valueEl = document.getElementById("menu-ping-value");
    const dotEl = document.getElementById("menu-ping-dot");
    if (valueEl) valueEl.textContent = ping !== null ? `${ping} ms` : "— ms";
    if (dotEl) {
      dotEl.classList.remove("good", "ok", "bad", "off");
      if (ping === null) dotEl.classList.add("off");
      else if (ping < 60) dotEl.classList.add("good");
      else if (ping < 120) dotEl.classList.add("ok");
      else dotEl.classList.add("bad");
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
      lobbyEl.textContent = `${this.client.roomId} · ${players} in`;
      if (subEl) {
        subEl.textContent =
          this.client.phase === "PLAYING"
            ? "Match in progress — go go go!"
            : "Waiting in lobby — host starts the match!";
      }
    } else {
      lobbyEl.textContent = "SOLO · VS BOTS";
      if (subEl) subEl.textContent = "Every bean for themselves!";
    }
  }

  // ------------------------------------------------------------ states

  reveal(): void {
    this.root.classList.remove("menu-hidden");
  }

  /** Show the menu again (Escape pause / return to menu). */
  show(): void {
    this.root.classList.remove("menu-hidden", "menu-fade-out");
  }

  /** Hide the menu completely (opacity fade → visibility off). */
  hide(): void {
    this.root.classList.remove("menu-fade-out");
    this.root.classList.add("menu-hidden");
    this.toggleSettings(false);
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
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
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