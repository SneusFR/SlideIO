import { SpearWeapon } from "../weapons/SpearWeapon";

/**
 * Minimal SPEAR RUSH availability indicator (bottom-right, above the dash
 * indicator). Same sober futuristic language as the other HUD chips:
 * "READY" in violet when available, a countdown while cooling down.
 * Self-contained: creates its own DOM + styles, and only touches the DOM
 * when the displayed text/state actually changes.
 */
export class SpearHUD {
  private readonly root: HTMLElement;
  private readonly valueEl: HTMLElement;
  private lastText = "";
  private lastReady: boolean | null = null;
  private visible = false;

  constructor() {
    // Row inside the ATTACKS card (bottom-right column) — the card owns
    // the chrome, this element only lays out label + readiness value.
    const style = document.createElement("style");
    style.textContent = `
      #spear-hud {
        display: none;
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-family: "Baloo 2", "Segoe UI", sans-serif;
        letter-spacing: 0.14em;
        user-select: none;
        pointer-events: none;
      }
      #spear-hud .spear-hud-label {
        font-size: 10px;
        color: rgba(216, 180, 254, 0.65);
        text-shadow: 0 0 6px rgba(168, 85, 247, 0.5);
      }
      #spear-hud .spear-hud-value {
        font-size: 13px;
        font-weight: 700;
        color: #d8b4fe;
        text-shadow: 0 0 12px rgba(168, 85, 247, 0.65);
        transition: color 0.15s ease;
      }
      #spear-hud .spear-hud-value.cooling {
        color: rgba(148, 130, 180, 0.75);
        text-shadow: none;
      }
    `;
    document.head.appendChild(style);

    this.root = document.createElement("div");
    this.root.id = "spear-hud";
    const label = document.createElement("div");
    label.className = "spear-hud-label";
    label.textContent = "SPEAR RUSH";
    this.valueEl = document.createElement("div");
    this.valueEl.className = "spear-hud-value";
    this.root.appendChild(label);
    this.root.appendChild(this.valueEl);
    (document.getElementById("attack-rows") ?? document.body).appendChild(this.root);
  }

  /** Show/hide the whole chip (hidden when the lance is not equipped). */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.root.style.display = visible ? "flex" : "none";
  }

  update(spear: SpearWeapon): void {
    if (!this.visible) return;

    const remaining = spear.rushCooldownRemaining;
    const ready = remaining <= 0 && !spear.isRushing;
    const text = spear.isRushing
      ? "ACTIVE"
      : ready
        ? "READY"
        : `${remaining.toFixed(1)}s`;

    if (text !== this.lastText) {
      this.lastText = text;
      this.valueEl.textContent = text;
    }
    if (ready !== this.lastReady) {
      this.lastReady = ready;
      this.valueEl.classList.toggle("cooling", !ready);
    }
  }
}