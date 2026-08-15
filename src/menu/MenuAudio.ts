import { audio } from "../audio/AudioManager";

const MENU_MANIFEST: Record<string, string> = {
  menu_music: "/assets/audio/menu/menu_music_space_loop_01.mp3",
  ui_hover: "/assets/audio/ui/ui_hover_01.mp3",
  ui_click: "/assets/audio/ui/ui_click_01.mp3",
};

/**
 * Main Menu audio: melancholic space music (looped, faded in/out) and
 * short UI hover / click ticks. Plays through the shared AudioManager,
 * so the browser autoplay policy is respected — the music starts as soon
 * as the browser allows it (immediately when autoplay is permitted, or
 * on the first real user gesture otherwise).
 *
 * Robust against page refreshes: the start attempt NEVER gives up while
 * the menu is visible. It awaits AudioContext.resume() properly, retries
 * on a low-frequency timer, and hooks a wide set of gesture events in
 * the capture phase (so no stopPropagation in the UI can swallow them).
 */
export class MenuAudio {
  private musicHandle: ReturnType<typeof audio.loop> = null;
  private musicWanted = false;
  private retryTimer: number | null = null;
  private starting = false;
  private removeGestureHooks: (() => void) | null = null;
  private warnedOnce = false;

  /** Fetch + decode the menu sounds (cached — safe to call anytime). */
  preload(): Promise<void> {
    return audio.preload(MENU_MANIFEST);
  }

  /**
   * Request the ambience. Starts immediately if the browser allows it;
   * otherwise the first user gesture (click / key / touch) starts it.
   */
  startMusic(): void {
    this.musicWanted = true;
    this.installGestureHooks();
    void this.attemptStart();
    this.armRetry();
  }

  /** Called on user gestures — starts the music once audio is unlocked. */
  tryResume(): void {
    if (!this.musicWanted || this.musicHandle) return;
    void this.attemptStart();
    this.armRetry();
  }

  /**
   * One full start attempt: create/resume the AudioContext (awaited, so a
   * gesture-triggered resume is used while the activation is still valid),
   * make sure the buffer is decoded, then start the loop.
   */
  private async attemptStart(): Promise<void> {
    if (!this.musicWanted || this.musicHandle || this.starting) return;
    this.starting = true;
    try {
      const running = await audio.resume();
      await this.preload(); // no-op if already decoded; retries a failed fetch
      if (running) this.tryStartLoop();
    } catch {
      /* keep retrying — timer / next gesture will call us again */
    } finally {
      this.starting = false;
    }
    if (this.musicHandle) this.onMusicStarted();
  }

  private onMusicStarted(): void {
    this.clearRetry();
    this.removeGestureHooks?.();
    this.removeGestureHooks = null;
  }

  /**
   * Low-frequency retry while the menu is up. Never gives up: after a
   * refresh the tab may have no user activation yet, and the music must
   * still start on the first gesture whenever it happens.
   */
  private armRetry(): void {
    if (this.retryTimer !== null) return;
    let attempts = 0;
    this.retryTimer = window.setInterval(() => {
      if (!this.musicWanted || this.musicHandle) {
        this.clearRetry();
        return;
      }
      attempts++;
      void this.attemptStart();
      if (!this.warnedOnce && attempts === 40) {
        this.warnedOnce = true;
        console.info(
          `[MenuAudio] menu music is waiting for a user gesture ` +
            `(unlocked=${audio.unlocked}, decoded=${audio.has("menu_music")})`,
        );
      }
    }, 300);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      window.clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * Capture-phase listeners on every activation-granting event so the
   * resume() call runs inside the gesture (required by autoplay policy).
   * Removed automatically once the music is playing.
   */
  private installGestureHooks(): void {
    if (this.removeGestureHooks) return;
    const onGesture = () => this.tryResume();
    const events: (keyof WindowEventMap)[] = [
      "pointerdown",
      "pointerup",
      "mousedown",
      "touchend",
      "keydown",
      "click",
    ];
    for (const ev of events) {
      window.addEventListener(ev, onGesture, { capture: true, passive: true });
    }
    this.removeGestureHooks = () => {
      for (const ev of events) {
        window.removeEventListener(ev, onGesture, { capture: true });
      }
    };
  }

  private tryStartLoop(): boolean {
    if (!this.musicWanted || this.musicHandle) return true;
    if (!audio.unlocked || !audio.has("menu_music")) return false;
    this.musicHandle = audio.loop("menu_music", {
      bus: "ambience",
      volume: 0.85,
      fadeIn: 1.6, // gentle fade-in when the menu appears
    });
    return this.musicHandle !== null;
  }

  /** PLAY pressed → fade the music out smoothly (no hard cut). */
  fadeOutMusic(seconds = 0.8): void {
    this.musicWanted = false;
    this.clearRetry();
    this.removeGestureHooks?.();
    this.removeGestureHooks = null;
    this.musicHandle?.stop(seconds);
    this.musicHandle = null;
  }

  /** Hover tick — throttled so fast cursor sweeps can't spam it. */
  hover(): void {
    audio.play("ui_hover", {
      bus: "ui",
      volume: 0.4,
      rateVar: 0.04,
      throttleMs: 60,
      maxInstances: 3,
    });
  }

  click(): void {
    audio.play("ui_click", { bus: "ui", volume: 0.65, maxInstances: 2 });
  }

  dispose(): void {
    this.fadeOutMusic(0.4);
  }
}