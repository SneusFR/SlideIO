import { playerProfile } from "./MenuConfig";
import { MenuAudio } from "./MenuAudio";

/**
 * DOM wiring for the Main Menu UI (buttons + player info).
 *
 * The markup lives in index.html (#main-menu) so it stays perfectly crisp
 * at any resolution; this class only fills the profile values, hooks the
 * hover/click sounds + press feedback, and forwards the single functional
 * action (PLAY). All other buttons are intentionally decorative for now.
 */
export class MenuUI {
  /** Fired once when PLAY is clicked. */
  onPlay: (() => void) | null = null;
  /** Fired every time LOADOUT is clicked (opens the loadout overlay). */
  onLoadout: (() => void) | null = null;
  /** Fired every time MULTIPLAYER is clicked (opens the lobby overlay). */
  onMultiplayer: (() => void) | null = null;

  private readonly root: HTMLElement;
  private playFired = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(private readonly sounds: MenuAudio) {
    this.root = document.getElementById("main-menu")!;

    // ---- Player profile (hardcoded config → DOM) ----
    setText("menu-player-name", playerProfile.name);
    setText("menu-player-level", `LVL ${playerProfile.level}`);
    setText("menu-player-currency", playerProfile.currency.toLocaleString("en-US"));
    const xpFill = document.getElementById("menu-xp-fill");
    if (xpFill) xpFill.style.width = `${Math.round(playerProfile.levelProgress * 100)}%`;

    // ---- Buttons: hover / click feedback on every entry ----
    const buttons = this.root.querySelectorAll<HTMLButtonElement>(".menu-btn");
    buttons.forEach((btn) => {
      // Hover sound only on the REAL pointerenter event (never per-frame).
      const onEnter = () => this.sounds.hover();
      btn.addEventListener("pointerenter", onEnter);
      this.cleanups.push(() => btn.removeEventListener("pointerenter", onEnter));

      // Press feedback (scale pulse handled in CSS via .pressed).
      const onDown = () => {
        btn.classList.remove("pressed");
        // Force a reflow so re-adding the class restarts the animation.
        void btn.offsetWidth;
        btn.classList.add("pressed");
      };
      btn.addEventListener("pointerdown", onDown);
      this.cleanups.push(() => btn.removeEventListener("pointerdown", onDown));

      const onClick = () => {
        this.sounds.click();
        if (btn.dataset.action === "play" && !this.playFired) {
          this.playFired = true;
          this.onPlay?.();
        } else if (btn.dataset.action === "loadout") {
          this.onLoadout?.();
        } else if (btn.dataset.action === "multiplayer") {
          this.onMultiplayer?.();
        }
        // EDITOR / SHOP / SETTINGS / CREDITS: visual only.
      };
      btn.addEventListener("click", onClick);
      this.cleanups.push(() => btn.removeEventListener("click", onClick));
    });
  }

  /** Fade the whole UI out (PLAY transition). */
  fadeOut(): void {
    this.root.classList.add("menu-fade-out");
  }

  reveal(): void {
    this.root.classList.remove("menu-hidden");
  }

  dispose(): void {
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
    this.root.remove();
  }
}

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}