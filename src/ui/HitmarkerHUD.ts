import { HitZone } from "../combat/HitZone";
import { HitFeedbackConfig as hfc } from "../combat/HitFeedbackConfig";

/**
 * Crosshair-centered hitmarker (DOM/CSS, zero per-frame JS).
 *
 * Two clearly distinct pulses:
 *  - BODY: 4 small light-violet diagonal arms, quick punch + fade.
 *  - HEAD: intense violet arms pushed further out with a double-pulse and
 *    a small central flash — unmistakably different from a body hit.
 *
 * All animation ends at opacity 0, so nothing lingers and no update()
 * call is ever needed. `show()` retriggers via the classic reflow trick.
 */
export class HitmarkerHUD {
  private readonly root: HTMLDivElement;

  constructor() {
    this.root = document.createElement("div");
    this.root.id = "hitmarker";
    // Configurable durations → CSS variables (single source: HitFeedbackConfig).
    this.root.style.setProperty("--hm-body-dur", `${hfc.bodyHitmarkerDuration}s`);
    this.root.style.setProperty("--hm-head-dur", `${hfc.headshotHitmarkerDuration}s`);

    // 4 diagonal arms around the crosshair center.
    for (let i = 0; i < 4; i++) {
      const arm = document.createElement("div");
      arm.className = "hm-arm";
      arm.style.setProperty("--r", `${45 + i * 90}deg`);
      this.root.appendChild(arm);
    }
    // Central flash (headshot only — stays invisible for body hits).
    const center = document.createElement("div");
    center.className = "hm-center";
    this.root.appendChild(center);

    document.body.appendChild(this.root);
  }

  /** Duration override currently written to the CSS variables (null = the default lifetimes). */
  private overridden = false;

  /**
   * Pulse the hitmarker. Retriggers cleanly even mid-animation.
   * `durationSec` (optional) = a shorter lifetime for THIS pulse only (rapid-fire weapons: every ball restarts a
   * short tick); omitted = the default lifetimes of HitFeedbackConfig, restored if a previous pulse overrode them.
   */
  show(zone: HitZone, durationSec?: number): void {
    const head = zone === HitZone.HEAD;
    if (durationSec !== undefined) {
      this.root.style.setProperty(head ? "--hm-head-dur" : "--hm-body-dur", `${durationSec}s`);
      this.overridden = true;
    } else if (this.overridden) {
      this.root.style.setProperty("--hm-body-dur", `${hfc.bodyHitmarkerDuration}s`);
      this.root.style.setProperty("--hm-head-dur", `${hfc.headshotHitmarkerDuration}s`);
      this.overridden = false;
    }
    this.root.classList.remove("hm-body", "hm-head");
    void this.root.offsetWidth; // reflow → restart the CSS animations
    this.root.classList.add(head ? "hm-head" : "hm-body");
  }
}