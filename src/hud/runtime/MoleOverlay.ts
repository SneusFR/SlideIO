/**
 * MOLE STRIKE fullscreen brown "underground" vignette, shown while the player
 * is burrowed (moved out of killstreaks/mole/MoleStrikeVFX: the game drives
 * its opacity, `mole.opacity`). It belongs to the HUD document: z-index 14
 * puts it between #hud (10) and the damage numbers (21) / hitmarker (22),
 * which an overlay left in the game page could not be once the HUD is one
 * iframe there. Same element, same injected style, same throttled write.
 */
export class MoleOverlay {
  private readonly el: HTMLElement;
  private lastOpacity = -1;

  constructor() {
    injectOverlayStyles();
    this.el = document.createElement("div");
    this.el.className = "mole-overlay";
    document.body.appendChild(this.el);
  }

  /** 0..1, written only when the shown value (1/100 steps) changes. */
  setOverlayOpacity(opacity: number): void {
    const o = Math.round(opacity * 100) / 100;
    if (o === this.lastOpacity) return;
    this.lastOpacity = o;
    this.el.style.opacity = String(o);
  }
}

let overlayStylesInjected = false;

function injectOverlayStyles(): void {
  if (overlayStylesInjected) return;
  overlayStylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .mole-overlay {
      position: fixed;
      inset: 0;
      z-index: 14;
      pointer-events: none;
      opacity: 0;
      background:
        radial-gradient(ellipse at center,
          rgba(60, 38, 16, 0.25) 0%,
          rgba(46, 28, 10, 0.65) 60%,
          rgba(30, 17, 5, 0.92) 100%);
      transition: opacity 0.05s linear;
    }
  `;
  document.head.appendChild(style);
}
