/**
 * AdSlot — reusable web-advertisement container for the menu.
 *
 * A NEUTRAL, clearly-labeled placeholder ("ADVERTISEMENT / 300 × 250")
 * that reserves a standard medium-rectangle ad area. It is intentionally
 * separate from the game UI language (flat, sober) so players read it as
 * an ad, not as a menu panel.
 *
 * Integrating a real provider later (AdSense or other):
 *   const slot = new AdSlot(anchorEl);
 *   slot.mountProvider(insElement);   // e.g. an <ins class="adsbygoogle">
 * The placeholder is removed automatically and the provider element owns
 * the reserved area. `hide()` collapses the slot when no ad is available.
 *
 * NO real ad credentials live here — this is structure only.
 */
export class AdSlot {
  private readonly root: HTMLDivElement;
  private readonly body: HTMLDivElement;

  constructor(anchor: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "ad-slot";
    this.root.setAttribute("aria-label", "Advertisement");

    const label = document.createElement("div");
    label.className = "ad-slot-label";
    label.textContent = "ADVERTISEMENT";
    this.root.appendChild(label);

    this.body = document.createElement("div");
    this.body.className = "ad-slot-body";
    this.body.innerHTML = `
      <div class="ad-slot-placeholder">
        <span class="ad-slot-ph-title">ADVERTISEMENT</span>
        <span class="ad-slot-ph-size">300 × 250</span>
      </div>
    `;
    this.root.appendChild(this.body);

    anchor.appendChild(this.root);
  }

  /** Replace the placeholder with a real provider element (AdSense…). */
  mountProvider(providerEl: HTMLElement): void {
    this.body.innerHTML = "";
    this.body.appendChild(providerEl);
    this.show();
  }

  /** Collapse the slot entirely (no ad available / ad blocked). */
  hide(): void {
    this.root.classList.add("hidden");
  }

  show(): void {
    this.root.classList.remove("hidden");
  }

  dispose(): void {
    this.root.remove();
  }
}