/**
 * Interaction prompt (YARD terminals): a small bottom-center pill showing
 * "F — {label}" while an interactable is in reach. Pure DOM — created
 * lazily, hidden by default, zero per-frame cost while no prompt shows.
 * Labels come from the map export (French, UTF-8 — rendered verbatim).
 */
export class InteractHUD {
  private readonly root: HTMLDivElement;
  private readonly labelEl: HTMLSpanElement;
  private currentLabel: string | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.id = "interact-hud";
    this.root.style.cssText = [
      "position: fixed",
      "left: 50%",
      "bottom: 22vh",
      "transform: translateX(-50%)",
      "display: none",
      "align-items: center",
      "gap: 10px",
      "padding: 10px 18px",
      "border-radius: 14px",
      "background: rgba(10, 18, 12, 0.82)",
      "border: 1px solid rgba(154, 230, 90, 0.55)",
      "box-shadow: 0 0 18px rgba(154, 230, 90, 0.25)",
      'font-family: "Baloo 2", sans-serif',
      "font-size: 15px",
      "font-weight: 600",
      "letter-spacing: 1.5px",
      "color: #eaffdd",
      "pointer-events: none",
      "z-index: 30",
    ].join(";");

    const key = document.createElement("span");
    key.textContent = "F";
    key.style.cssText = [
      "display: inline-flex",
      "align-items: center",
      "justify-content: center",
      "min-width: 26px",
      "height: 26px",
      "border-radius: 8px",
      "background: rgba(154, 230, 90, 0.9)",
      "color: #10240c",
      'font-family: "Luckiest Guy", cursive',
      "font-size: 15px",
    ].join(";");
    this.root.appendChild(key);

    this.labelEl = document.createElement("span");
    this.root.appendChild(this.labelEl);
    document.body.appendChild(this.root);
  }

  /** Show the prompt for `label`, or hide it with null. Change-detected. */
  setPrompt(label: string | null): void {
    if (label === this.currentLabel) return;
    this.currentLabel = label;
    if (label) {
      this.labelEl.textContent = label;
      this.root.style.display = "flex";
    } else {
      this.root.style.display = "none";
    }
  }

  dispose(): void {
    this.root.remove();
  }
}
